#!/usr/bin/env node
// Rack Inventory Kiosk server. No dependencies: just Node.js 18+.
// Data lives in ./data (or DATA_DIR): items.json, activity.jsonl and uploads/.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const auth = require('./auth');
const ASSET_KINDS = require('./public/asset-kinds');
const createAssetKind = require('./assets');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOADS = path.join(DATA_DIR, 'uploads');
const PUBLIC = path.join(__dirname, 'public');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const LOG_FILE = path.join(DATA_DIR, 'activity.jsonl');
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_JSON = 100 * 1024;

fs.mkdirSync(UPLOADS, { recursive: true });

/* ---------- Command-line tools ---------- */
const args = process.argv.slice(2);
if (args[0] === '--set-pin') {
  auth.initPaths(DATA_DIR);
  try { auth.setPin(String(args[1] || '')); console.log('PIN updated. Devices that are already logged in stay logged in.'); process.exit(0); }
  catch (e) { console.error(e.message + '  Usage: node server.js --set-pin 1234'); process.exit(1); }
}
if (args[0] === '--unlock') {
  auth.initPaths(DATA_DIR); auth.unlockAll();
  console.log('All lockouts cleared. Restart the server if it is running.'); process.exit(0);
}

/* ---------- Storage ---------- */
let items = [];
let log = [];
try { items = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
try {
  log = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
} catch (e) { if (e.code !== 'ENOENT') throw e; }

const newId = () => crypto.randomBytes(8).toString('hex');

function loadList(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return []; } }
function saveList(file, list) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(list, null, 2)); fs.renameSync(tmp, file); }
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/* ---------- Barcodes: every item gets a short code like RK-0001 ---------- */
const CODE_PREFIX = 'RK-';
function nextCode() {
  let max = 0;
  for (const i of items) { const n = Number(String(i.code || '').slice(CODE_PREFIX.length)); if (n > max) max = n; }
  return CODE_PREFIX + String(max + 1).padStart(4, '0');
}
// Give items created before barcodes existed a code of their own.
if (items.some((i) => !i.code)) {
  for (const i of [...items].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) if (!i.code) i.code = nextCode();
  fs.writeFileSync(ITEMS_FILE, JSON.stringify(items, null, 2));
}
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}
function saveItems() {
  const tmp = ITEMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, ITEMS_FILE);
}
function addLog(entry) {
  const e = Object.assign({ id: newId(), at: Date.now() }, entry);
  log.push(e);
  fs.appendFileSync(LOG_FILE, JSON.stringify(e) + '\n');
  return e;
}

/* ---------- Live updates (Server-Sent Events) ---------- */
const clients = new Set();
function broadcast() {
  for (const res of clients) if (!res.writableEnded) res.write('event: change\ndata: {}\n\n');
}
setInterval(() => { for (const res of clients) if (!res.writableEnded) res.write(': ping\n\n'); }, 25000).unref();

/* ---------- Helpers ---------- */
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers));
  res.end(data);
}
const fail = (res, status, msg) => send(res, status, { error: msg });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Upload is too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const buf = await readBody(req, MAX_JSON);
  try { return JSON.parse(buf.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Request body must be JSON.'), { status: 400 }); }
}
// Items below their minimum.
function orderList() {
  return items.filter((i) => i.minQty != null && i.qty < i.minQty)
    .sort((a, b) => a.name.localeCompare(b.name));
}
const badReq = (msg) => Object.assign(new Error(msg), { status: 400 });
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : NaN; };
const device = (req) => (req.who ? (req.who.mac ? `${req.who.ip} (${req.who.mac})` : req.who.ip) : '');

function csv(rows) {
  return rows.map((r) => r.map((v) => {
    if (v == null) return '';
    if (typeof v === 'number') return String(v);
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running formulas
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n') + '\r\n';
}
const TYPE_LABEL = { take: 'Taken', return: 'Returned', restock: 'Restocked', adjust: 'Count corrected', add: 'New item', remove: 'Item removed',
  lockout: 'Device locked out', 'pin-changed': 'PIN changed' };
const stamp = () => new Date().toISOString().slice(0, 10);

function filterLog(q) {
  const text = str(q.get('q')).toLowerCase();
  const type = str(q.get('type'));
  const from = Number(q.get('from')) || null;
  const to = Number(q.get('to')) || null;
  return log.filter((e) => (!type || e.type === type) && (!from || e.at >= from) && (!to || e.at < to) &&
    (!text || [e.person, e.itemName, e.itemCode, e.note].join(' ').toLowerCase().includes(text)));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.json': 'application/json' };
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

function serveFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': cache || 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}
function removeImage(item) {
  if (item && item.image) fs.unlink(path.join(UPLOADS, path.basename(item.image.split('?')[0])), () => {});
}

/* ---------- Routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const m = req.method;
  let match;

  if (await auth.handleAuthRoute(req, res, url, { send, fail, readJSON, onEvent: securityEvent })) return;
  if (p.startsWith('/api/') || p.startsWith('/uploads/')) {
    req.who = await auth.requireSession(req, res, { send });
    if (!req.who) return;
  }

  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    res.on('error', () => clients.delete(res));
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/items' && m === 'GET') return send(res, 200, items);
  if (p === '/api/log' && m === 'GET') {
    const limit = Math.min(5000, int(url.searchParams.get('limit')) || 1000);
    return send(res, 200, log.slice(-limit).reverse());
  }

  // Minimum and maximum on hand drive the order report. Blank means not set.
  function stockLevels(b) {
    const lv = (v) => (v === '' || v == null ? null : int(v));
    const minQty = lv(b.minQty), maxQty = lv(b.maxQty);
    if ((minQty !== null && !(minQty >= 0)) || (maxQty !== null && !(maxQty >= 0))) throw badReq('Minimum and maximum must be whole numbers, 0 or more.');
    if (minQty !== null && maxQty !== null && maxQty < minQty) throw badReq('Maximum must be at least the minimum.');
    return { minQty, maxQty };
  }
  if (p === '/api/items' && m === 'POST') {
    const b = await readJSON(req);
    const name = str(b.name);
    if (!name) return fail(res, 400, 'Item name is required.');
    const levels = stockLevels(b);
    const qty = Math.max(0, int(b.qty) || 0);
    const now = Date.now();
    const item = Object.assign({ id: newId(), code: nextCode(), name, mro: str(b.mro, 80), partNumber: str(b.partNumber, 80), unit: str(b.unit, 30) || 'pcs', qty }, levels, { image: null, createdAt: now, updatedAt: now });
    items.push(item); saveItems();
    addLog({ itemId: item.id, itemCode: item.code, itemName: name, type: 'add', qty, delta: qty, after: qty, person: str(b.person, 80), note: 'Item added', device: device(req) });
    broadcast();
    return send(res, 201, item);
  }

  if ((match = p.match(/^\/api\/items\/([a-f0-9]{16})$/))) {
    const item = items.find((i) => i.id === match[1]);
    if (!item) return fail(res, 404, 'That item no longer exists.');
    if (m === 'PUT') {
      const b = await readJSON(req);
      const name = str(b.name);
      if (!name) return fail(res, 400, 'Item name is required.');
      const before = item.qty;
      if (b.minQty !== undefined || b.maxQty !== undefined) Object.assign(item, stockLevels(b));
      if (b.mro !== undefined) item.mro = str(b.mro, 80);
      if (b.partNumber !== undefined) item.partNumber = str(b.partNumber, 80);
      item.name = name;
      item.unit = str(b.unit, 30) || 'pcs';
      if (b.qty !== undefined) item.qty = Math.max(0, int(b.qty) || 0);
      item.updatedAt = Date.now();
      saveItems();
      if (item.qty !== before) {
        addLog({ itemId: item.id, itemCode: item.code, itemName: item.name, type: 'adjust', qty: Math.abs(item.qty - before), delta: item.qty - before,
          after: item.qty, person: str(b.person, 80), note: `Count corrected from ${before} to ${item.qty}`, device: device(req) });
      }
      broadcast();
      return send(res, 200, item);
    }
    if (m === 'DELETE') {
      items = items.filter((i) => i !== item); saveItems(); removeImage(item);
      addLog({ itemId: item.id, itemCode: item.code, itemName: item.name, type: 'remove', qty: item.qty, delta: 0, after: null, person: '', note: 'Item removed', device: device(req) });
      broadcast();
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/labels-printed' && m === 'POST') {
    const b = await readJSON(req);
    const ids = new Set(Array.isArray(b.ids) ? b.ids.map(String) : []);
    const now = Date.now();
    let n = 0;
    for (const i of items) if (ids.has(i.id)) { i.labelPrintedAt = now; n++; }
    if (n) saveItems();
    for (const a of assetKinds) n += a.markLabelsPrinted(ids, device(req));
    if (n) broadcast();
    return send(res, 200, { updated: n });
  }

  if ((match = p.match(/^\/api\/items\/([a-f0-9]{16})\/image$/)) && m === 'POST') {
    const item = items.find((i) => i.id === match[1]);
    if (!item) return fail(res, 404, 'That item no longer exists.');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_EXT[type];
    if (!ext) return fail(res, 415, 'Photos must be JPEG, PNG, WebP or GIF.');
    const buf = await readBody(req, MAX_IMAGE);
    if (!buf.length) return fail(res, 400, 'The photo was empty.');
    const file = item.id + '-' + Date.now() + ext;
    fs.writeFileSync(path.join(UPLOADS, file), buf);
    removeImage(item);
    item.image = '/uploads/' + file;
    item.updatedAt = Date.now();
    saveItems(); broadcast();
    return send(res, 200, item);
  }

  if ((match = p.match(/^\/api\/items\/([a-f0-9]{16})\/transactions$/)) && m === 'POST') {
    const item = items.find((i) => i.id === match[1]);
    if (!item) return fail(res, 404, 'That item no longer exists.');
    const b = await readJSON(req);
    const type = ['take', 'return', 'restock'].includes(b.type) ? b.type : null;
    const qty = int(b.qty);
    const person = str(b.person, 80);
    if (!type) return fail(res, 400, 'Choose take, return or restock.');
    if (!(qty >= 1)) return fail(res, 400, 'Quantity must be 1 or more.');
    if (!person) return fail(res, 400, 'Enter your name.');
    const next = type === 'take' ? item.qty - qty : item.qty + qty;
    if (next < 0) return fail(res, 409, `Only ${item.qty} on hand.`);
    item.qty = next; item.updatedAt = Date.now(); saveItems();
    const entry = addLog({ itemId: item.id, itemCode: item.code, itemName: item.name, type, qty, delta: type === 'take' ? -qty : qty, after: next,
      person, note: str(b.note, 300), device: device(req) });
    broadcast();
    return send(res, 200, { item, entry });
  }

  /* ----- Equipment tracked one by one (printers, laptops / desktops) ----- */
  for (const a of assetKinds) if (await a.handle(req, res, url, { send, fail, readJSON, device })) return;

  if (p === '/api/export/order.csv' && m === 'GET') {
    const rows = orderList();
    const out = [['MRO number', 'Part number', 'Item', 'Barcode', 'On hand', 'Minimum', 'Maximum', 'Unit']].concat(
      rows.map((x) => [x.mro || '', x.partNumber || '', x.name, x.code, x.qty, x.minQty, x.maxQty == null ? '' : x.maxQty, x.unit]));
    return send(res, 200, '\ufeff' + csv(out), { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="order-${stamp()}.csv"` });
  }
  if (p === '/api/export/inventory.csv' && m === 'GET') {
    const rows = [['Barcode', 'MRO number', 'Part number', 'Item', 'On hand', 'Unit', 'Minimum', 'Maximum', 'Status', 'Last updated']].concat(
      [...items].sort((a, b) => a.name.localeCompare(b.name)).map((i) => [i.code, i.mro || '', i.partNumber || '', i.name, i.qty, i.unit, i.minQty == null ? '' : i.minQty, i.maxQty == null ? '' : i.maxQty,
        i.qty <= 0 ? 'Out' : i.minQty != null && i.qty < i.minQty ? 'Below minimum' : 'In stock',
        new Date(i.updatedAt).toLocaleString()]));
    return send(res, 200, '﻿' + csv(rows), { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inventory-${stamp()}.csv"` });
  }
  if (p === '/api/export/activity.csv' && m === 'GET') {
    const rows = filterLog(url.searchParams).slice().reverse();
    const out = [['Date', 'Time', 'Person', 'Action', 'Quantity', 'Change', 'Item', 'Barcode', 'Left after', 'Note', 'Device']].concat(rows.map((e) => {
      const d = new Date(e.at);
      return [d.toLocaleDateString(), d.toLocaleTimeString(), e.person || '', TYPE_LABEL[e.type] || e.type, Math.abs(e.qty || 0),
        typeof e.delta === 'number' ? e.delta : '', e.itemName || '', e.itemCode || '', e.after == null ? '' : e.after, e.note || '', e.device || ''];
    }));
    return send(res, 200, '﻿' + csv(out), { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inventory-activity-${stamp()}.csv"` });
  }

  if (p.startsWith('/api/')) return fail(res, 404, 'Unknown API route.');

  if (m === 'GET' && p.startsWith('/uploads/')) {
    const name = path.basename(p);
    if (!/^[a-f0-9]{16}-\d+\.(jpg|png|webp|gif)$/.test(name)) return fail(res, 404, 'Not found');
    return serveFile(res, path.join(UPLOADS, name), 'public, max-age=31536000, immutable');
  }
  if (m === 'GET') {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return fail(res, 404, 'Not found');
    return serveFile(res, file);
  }
  return fail(res, 405, 'Method not allowed');
}

const assetKinds = Object.values(ASSET_KINDS).map((K) => createAssetKind(K, {
  DATA_DIR, newId, str, int, isDate, csv, stamp, loadList, saveList, addLog, broadcast, saveItems, getItems: () => items,
}));

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) fail(res, err.status || 500, err.status ? err.message : 'Server error. Check the server console.');
    if (!err.status) console.error(err);
  });
});

function securityEvent(type, who) {
  const where = who.mac ? `${who.ip} (${who.mac})` : who.ip;
  addLog({ itemId: null, itemName: '', type, qty: 0, delta: 0, after: null, person: '',
    note: type === 'lockout' ? 'Locked for wrong PIN attempts' : 'Kiosk PIN was changed; other devices were logged out', device: where });
  console.log(`[security] ${TYPE_LABEL[type]} from ${where || 'unknown device'}`);
  if (type === 'pin-changed') { for (const c of clients) c.end(); clients.clear(); }
  broadcast();
}

auth.init(DATA_DIR, { onFirstPin: (pin) => {
  console.log('\n  ==================================================');
  console.log(`   First run. Your kiosk PIN is: ${pin}`);
  console.log('   Change it in the app (Activity > Change PIN)');
  console.log('   or run:  node server.js --set-pin 1234');
  console.log('  ==================================================\n');
} });

server.listen(PORT, HOST, () => {
  console.log(`Rack Inventory Kiosk running. Data folder: ${DATA_DIR}`);
  console.log(`  On this machine:   http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  On your network:   ${u}`);
});
