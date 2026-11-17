// PIN login, sessions and lockouts for the Rack Inventory Kiosk.
//
// Each request is identified by up to three keys:
//   mac:<address>  the device's MAC, looked up from the server's ARP table (same local network only)
//   ip:<address>   the connection's IP address
//   dev:<id>       a long-lived device cookie set in the browser
// Four wrong PINs in a row from any of those keys locks ALL of them for 30 minutes, so
// clearing cookies or changing IP does not get around a lockout.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_ATTEMPTS = Number(process.env.MAX_PIN_ATTEMPTS) || 4;
const LOCK_MS = (Number(process.env.LOCKOUT_MINUTES) || 30) * 60 * 1000;
const SESSION_MS = (Number(process.env.SESSION_HOURS) || 24) * 60 * 60 * 1000;
const DEVICE_COOKIE_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PIN_RE = /^\d{4,8}$/;

let CONFIG_FILE, SECURITY_FILE;
let config = {};          // { pinHash, pinSalt }
let failures = {};        // key -> { count, lockedUntil }
let sessions = {};        // sha256(token) -> { expires, deviceId }

function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const readJSON = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

function saveSecurity() { writeJSON(SECURITY_FILE, { failures, sessions }); }
function prune() {
  const now = Date.now();
  for (const [k, f] of Object.entries(failures)) if (f.lockedUntil && f.lockedUntil < now) delete failures[k];
  for (const [k, s] of Object.entries(sessions)) if (s.expires < now) delete sessions[k];
}

function hashPin(pin, salt) { return crypto.scryptSync(pin, salt, 32).toString('hex'); }
function setPin(pin) {
  if (!PIN_RE.test(pin)) throw new Error('PIN must be 4 to 8 digits.');
  const salt = crypto.randomBytes(16).toString('hex');
  config.pinSalt = salt;
  config.pinHash = hashPin(pin, salt);
  writeJSON(CONFIG_FILE, config);
}
function checkPin(pin) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin) || !config.pinHash) return false;
  const a = Buffer.from(hashPin(pin, config.pinSalt), 'hex');
  const b = Buffer.from(config.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function init(dataDir, { onFirstPin } = {}) {
  CONFIG_FILE = path.join(dataDir, 'config.json');
  SECURITY_FILE = path.join(dataDir, 'security.json');
  config = readJSON(CONFIG_FILE) || {};
  const sec = readJSON(SECURITY_FILE) || {};
  failures = sec.failures || {};
  sessions = sec.sessions || {};
  prune();
  if (process.env.KIOSK_PIN) {
    if (!checkPin(process.env.KIOSK_PIN)) setPin(process.env.KIOSK_PIN);
  } else if (!config.pinHash) {
    const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    setPin(pin);
    if (onFirstPin) onFirstPin(pin);
  }
  setInterval(() => { prune(); saveSecurity(); }, 60 * 1000).unref();
}

/* ---------- Identifying the device ---------- */
function clientIp(req) {
  let ip = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  ip = ip || req.socket.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}
const isLocal = (ip) => ip === '127.0.0.1' || ip === '::1';

const macCache = new Map(); // ip -> { mac, at }
function lookupMac(ip) {
  return new Promise((resolve) => {
    if (!ip || isLocal(ip) || ip.includes(':')) return resolve(null);
    const hit = macCache.get(ip);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return resolve(hit.mac);
    const done = (mac) => {
      mac = mac && /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(mac) && !/^(00[:-]){5}00$/.test(mac) ? mac.toLowerCase().replace(/-/g, ':') : null;
      macCache.set(ip, { mac, at: Date.now() });
      resolve(mac);
    };
    if (process.platform === 'linux') {
      fs.readFile('/proc/net/arp', 'utf8', (err, txt) => {
        if (err) return done(null);
        const row = txt.split('\n').map((l) => l.trim().split(/\s+/)).find((c) => c[0] === ip);
        done(row ? row[3] : null);
      });
    } else {
      execFile('arp', process.platform === 'win32' ? ['-a', ip] : ['-n', ip], { timeout: 1500 }, (err, out) => {
        const m = String(out || '').match(/([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}/i);
        // macOS prints octets without leading zeros (e.g. 0:1a:2b...)
        done(m ? m[0].split(/[:-]/).map((o) => o.padStart(2, '0')).join(':') : null);
      });
    }
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookie(name, value, maxAgeMs) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

// Works out who is asking. Adds a device cookie to the response when the browser has none.
async function identify(req, res) {
  const cookies = parseCookies(req);
  let deviceId = /^[A-Za-z0-9_-]{20,64}$/.test(cookies.kiosk_device || '') ? cookies.kiosk_device : null;
  if (!deviceId) {
    deviceId = token();
    res.setHeader('Set-Cookie', [cookie('kiosk_device', deviceId, DEVICE_COOKIE_MS)]);
  }
  const ip = clientIp(req);
  const mac = await lookupMac(ip);
  const keys = ['dev:' + deviceId];
  if (ip) keys.push('ip:' + ip);
  if (mac) keys.push('mac:' + mac);
  return { ip, mac, deviceId, keys, sessionToken: cookies.kiosk_session || null };
}

function lockState(keys) {
  const now = Date.now();
  let until = 0, count = 0;
  for (const k of keys) {
    const f = failures[k];
    if (!f) continue;
    if (f.lockedUntil && f.lockedUntil > now) until = Math.max(until, f.lockedUntil);
    count = Math.max(count, f.count || 0);
  }
  return { lockedUntil: until || null, attemptsLeft: Math.max(0, MAX_ATTEMPTS - count) };
}

function session(who) {
  if (!who.sessionToken) return null;
  const s = sessions[sha(who.sessionToken)];
  if (!s || s.expires < Date.now()) return null;
  return s;
}

/* ---------- Route handlers ---------- */
// Returns true when it handled the request.
async function handleAuthRoute(req, res, url, { send, fail, readJSON, onEvent }) {
  const p = url.pathname;
  if (!p.startsWith('/api/auth/')) return false;
  const who = await identify(req, res);

  if (p === '/api/auth/status' && req.method === 'GET') {
    const st = lockState(who.keys);
    send(res, 200, { loggedIn: !!session(who), lockedUntil: st.lockedUntil, attemptsLeft: st.attemptsLeft,
      maxAttempts: MAX_ATTEMPTS, lockMinutes: LOCK_MS / 60000, now: Date.now() });
    return true;
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const st = lockState(who.keys);
    if (st.lockedUntil) {
      send(res, 423, { error: 'Too many wrong PINs. This device is locked.', lockedUntil: st.lockedUntil, now: Date.now() });
      return true;
    }
    const b = await readJSON(req);
    if (checkPin(String(b.pin || ''))) {
      for (const k of who.keys) delete failures[k];
      const t = token();
      sessions[sha(t)] = { expires: Date.now() + SESSION_MS, deviceId: who.deviceId };
      saveSecurity();
      const prev = res.getHeader('Set-Cookie') || [];
      res.setHeader('Set-Cookie', [].concat(prev, cookie('kiosk_session', t, SESSION_MS)));
      send(res, 200, { ok: true });
      return true;
    }
    return wrongPin(res, who, { send, onEvent });
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    if (who.sessionToken) delete sessions[sha(who.sessionToken)];
    saveSecurity();
    const prev = res.getHeader('Set-Cookie') || [];
    res.setHeader('Set-Cookie', [].concat(prev, cookie('kiosk_session', '', 0)));
    send(res, 200, { ok: true });
    return true;
  }

  if (p === '/api/auth/change-pin' && req.method === 'POST') {
    if (!session(who)) { fail(res, 401, 'Log in first.'); return true; }
    const st = lockState(who.keys);
    if (st.lockedUntil) { send(res, 423, { error: 'Too many wrong PINs. This device is locked.', lockedUntil: st.lockedUntil, now: Date.now() }); return true; }
    const b = await readJSON(req);
    if (!checkPin(String(b.current || ''))) return wrongPin(res, who, { send, onEvent });
    const next = String(b.next || '');
    if (!PIN_RE.test(next)) { fail(res, 400, 'New PIN must be 4 to 8 digits.'); return true; }
    setPin(next);
    // Log out every other device; this one stays in.
    const mine = sha(who.sessionToken);
    for (const k of Object.keys(sessions)) if (k !== mine) delete sessions[k];
    for (const k of who.keys) delete failures[k];
    saveSecurity();
    if (onEvent) onEvent('pin-changed', who);
    send(res, 200, { ok: true });
    return true;
  }

  fail(res, 404, 'Unknown route.');
  return true;
}

function wrongPin(res, who, { send, onEvent }) {
  const now = Date.now();
  let locked = false;
  for (const k of who.keys) {
    const f = failures[k] || (failures[k] = { count: 0, lockedUntil: null });
    f.count += 1;
    if (f.count >= MAX_ATTEMPTS) locked = true;
  }
  if (locked) {
    const until = now + LOCK_MS;
    for (const k of who.keys) failures[k] = { count: MAX_ATTEMPTS, lockedUntil: until };
    // End any session held by this device too.
    for (const [k, s] of Object.entries(sessions)) if (s.deviceId === who.deviceId) delete sessions[k];
    saveSecurity();
    if (onEvent) onEvent('lockout', who);
    send(res, 423, { error: `Wrong PIN ${MAX_ATTEMPTS} times. This device is locked for ${LOCK_MS / 60000} minutes.`, lockedUntil: until, now });
    return true;
  }
  saveSecurity();
  const left = lockState(who.keys).attemptsLeft;
  send(res, 401, { error: `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before a ${LOCK_MS / 60000}-minute lockout.`, attemptsLeft: left });
  return true;
}

// Gate for every other protected route. Returns the identity when allowed, or null after replying.
async function requireSession(req, res, { send }) {
  const who = await identify(req, res);
  const st = lockState(who.keys);
  if (st.lockedUntil) { send(res, 423, { error: 'This device is locked.', lockedUntil: st.lockedUntil, now: Date.now() }); return null; }
  const s = session(who);
  if (!s) { send(res, 401, { error: 'Enter the PIN to continue.', loginRequired: true }); return null; }
  return who;
}

function unlockAll() {
  const sec = readJSON(SECURITY_FILE) || {};
  writeJSON(SECURITY_FILE, { failures: {}, sessions: sec.sessions || {} });
}

module.exports = { init, setPin, handleAuthRoute, requireSession, unlockAll, PIN_RE, initPaths(dataDir) {
  CONFIG_FILE = path.join(dataDir, 'config.json');
  SECURITY_FILE = path.join(dataDir, 'security.json');
  config = readJSON(CONFIG_FILE) || {};
} };
