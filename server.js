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

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOADS = path.join(DATA_DIR, 'uploads');
const PUBLIC = path.join(__dirname, 'public');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const LOG_FILE = path.join(DATA_DIR, 'activity.jsonl');
const PRINTERS_FILE = path.join(DATA_DIR, 'printers.json');
const PRINTER_LOG_FILE = path.join(DATA_DIR, 'printer-history.jsonl');
const REPAIRS_FILE = path.join(DATA_DIR, 'repairs.json');
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

/* ---------- Label printers and their repair history ---------- */
function loadList(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return []; } }
function saveList(file, list) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(list, null, 2)); fs.renameSync(tmp, file); }
let printers = loadList(PRINTERS_FILE);
let repairs = loadList(REPAIRS_FILE);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const byName = (b) => str(b && b.by, 80);
function printerFields(b) {
  return { name: str(b.name, 80), model: str(b.model, 80), serial: str(b.serial, 80), location: str(b.location, 80), notes: str(b.notes, 1000) };
}
function repairFields(b) {
  const cost = b.cost === '' || b.cost == null ? null : Math.round(Number(b.cost) * 100) / 100;
  return { date: str(b.date, 10), type: str(b.type, 80), doneBy: str(b.doneBy, 80), parts: str(b.parts, 300),
    cost: Number.isFinite(cost) && cost >= 0 ? cost : null, notes: str(b.notes, 2000) };
}

/* ---------- Barcodes: every item gets a short code like RK-0001 ---------- */
const CODE_PREFIX = 'RK-';
function nextCode() {
  let max = 0;
  for (const i of items) { const n = Number(String(i.code || '').slice(CODE_PREFIX.length)); if (n > max) max = n; }
  return CODE_PREFIX + String(max + 1).padStart(4, '0');
}
// Label printers get their own codes (PR-0001...), so a label stuck on a printer opens its repair history.
function nextPrinterCode() {
  let max = 0;
  for (const x of printers) { const n = Number(String(x.code || '').slice(3)); if (n > max) max = n; }
  return 'PR-' + String(max + 1).padStart(4, '0');
}
if (printers.some((x) => !x.code)) {
  for (const x of [...printers].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) if (!x.code) x.code = nextPrinterCode();
  saveList(PRINTERS_FILE, printers);
}
/* ---------- Printer history: every change to a printer and its repairs ---------- */
let printerLog = [];
try {
  printerLog = fs.readFileSync(PRINTER_LOG_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
} catch (e) { if (e.code !== 'ENOENT') throw e; }
function addPrinterEvent(e) {
  const ev = Object.assign({ id: newId(), at: Date.now() }, e);
  printerLog.push(ev);
  fs.appendFileSync(PRINTER_LOG_FILE, JSON.stringify(ev) + '\n');
  return ev;
}
const PRINTER_LABELS = { name: 'Name', model: 'Model', serial: 'Serial number', location: 'Location', notes: 'Notes' };
const REPAIR_LABELS = { date: 'Date', type: 'Repair type', doneBy: 'Done by', parts: 'Other parts', cost: 'Cost', notes: 'Notes', inventoryParts: 'Parts from inventory', printer: 'Printer' };
const partsLabel = (list) => (list || []).map((x) => `${x.qty} x ${x.itemName}`).join(', ');
function diff(before, after, labels) {
  const out = [];
  for (const k of Object.keys(labels)) {
    if (!(k in after)) continue;
    let a = before[k], b = after[k];
    if (k === 'inventoryParts') { a = partsLabel(a); b = partsLabel(b); }
    a = a == null ? '' : String(a); b = b == null ? '' : String(b);
    if (a !== b) out.push({ field: k, label: labels[k], from: a, to: b });
  }
  return out;
}
const repairSummary = (r) => [r.type, r.doneBy && `by ${r.doneBy}`].filter(Boolean).join(' ');
const repairDetails = (r) => Object.keys(REPAIR_LABELS).filter((k) => k !== 'printer')
  .map((k) => ({ field: k, label: REPAIR_LABELS[k], from: '', to: k === 'inventoryParts' ? partsLabel(r[k]) : (r[k] == null ? '' : String(r[k])) }))
  .filter((c) => c.to);
// Printers and repairs that existed before history tracking get their starting entries once.
{
  const seen = new Set(printerLog.map((e) => e.type + ':' + (e.repairId || e.printerId)));
  let added = 0;
  const back = (e) => { addPrinterEvent(Object.assign({ backfilled: true }, e)); added++; };
  for (const x of printers) if (!seen.has('created:' + x.id)) {
    back({ at: x.createdAt || Date.now(), printerId: x.id, printerName: x.name, type: 'created', summary: `Printer added as ${x.name}`,
      changes: Object.keys(PRINTER_LABELS).filter((k) => x[k]).map((k) => ({ field: k, label: PRINTER_LABELS[k], from: '', to: x[k] })) });
  }
  for (const r of repairs) if (!seen.has('repair-logged:' + r.id)) {
    back({ at: r.createdAt || Date.now(), printerId: r.printerId, printerName: r.printerName, repairId: r.id, type: 'repair-logged',
      summary: `Repair logged: ${repairSummary(r)}`, changes: repairDetails(r), by: r.doneBy || '' });
  }
  if (added) printerLog.sort((a, b) => a.at - b.at);
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
// Items below their minimum, with how many to order to get back up to the maximum (or the minimum when no maximum is set).
function orderList() {
  return items.filter((i) => i.minQty != null && i.qty < i.minQty)
    .map((i) => Object.assign({}, i, { orderQty: (i.maxQty != null ? i.maxQty : i.minQty) - i.qty }))
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
    const item = Object.assign({ id: newId(), code: nextCode(), name, mro: str(b.mro, 80), unit: str(b.unit, 30) || 'pcs', qty }, levels, { image: null, createdAt: now, updatedAt: now });
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
    let n = 0, np = 0;
    for (const i of items) if (ids.has(i.id)) { i.labelPrintedAt = now; n++; }
    for (const x of printers) if (ids.has(x.id)) {
      x.labelPrintedAt = now; np++;
      addPrinterEvent({ printerId: x.id, printerName: x.name, type: 'label-printed', summary: `Label printed (${x.code})`, changes: [], device: device(req) });
    }
    if (n) saveItems();
    if (np) saveList(PRINTERS_FILE, printers);
    if (n || np) broadcast();
    n += np;
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

  /* ----- Label printers ----- */
  if (p === '/api/printer-history' && m === 'GET') {
    const pid = str(url.searchParams.get('printer'));
    return send(res, 200, pid ? printerLog.filter((e) => e.printerId === pid) : printerLog);
  }
  if (p === '/api/export/printer-history.csv' && m === 'GET') {
    const pid = str(url.searchParams.get('printer'));
    const rows = printerLog.filter((e) => !pid || e.printerId === pid).slice().reverse();
    const out = [['Date', 'Time', 'Printer', 'Event', 'Changes', 'By', 'Device']].concat(rows.map((e) => {
      const d = new Date(e.at);
      return [d.toLocaleDateString(), d.toLocaleTimeString(), e.printerName, e.summary,
        (e.changes || []).map((c) => c.from && c.to ? `${c.label}: ${c.from} -> ${c.to}` : c.to ? `${c.label}: ${c.to}` : `${c.label}: ${c.from} (removed)`).join('; '),
        e.by || '', e.device || ''];
    }));
    return send(res, 200, '﻿' + csv(out), { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="printer-history-${stamp()}.csv"` });
  }
  if (p === '/api/printers' && m === 'GET') return send(res, 200, printers);
  if (p === '/api/printers' && m === 'POST') {
    req.body = await readJSON(req);
    const f = printerFields(req.body);
    if (!f.name) return fail(res, 400, 'Give the printer a name, like "Front desk Dymo".');
    const now = Date.now();
    const pr = Object.assign({ id: newId(), code: nextPrinterCode() }, f, { createdAt: now, updatedAt: now });
    printers.push(pr); saveList(PRINTERS_FILE, printers);
    addPrinterEvent({ printerId: pr.id, printerName: pr.name, type: 'created', summary: `Printer added as ${pr.name} (${pr.code})`,
      changes: diff({}, f, PRINTER_LABELS), by: byName(req.body), device: device(req) });
    broadcast();
    return send(res, 201, pr);
  }
  if ((match = p.match(/^\/api\/printers\/([a-f0-9]{16})$/))) {
    const pr = printers.find((x) => x.id === match[1]);
    if (!pr) return fail(res, 404, 'That printer no longer exists.');
    if (m === 'PUT') {
      const b = await readJSON(req);
      const f = printerFields(b);
      if (!f.name) return fail(res, 400, 'Give the printer a name.');
      const changes = diff(pr, f, PRINTER_LABELS);
      if (changes.length) {
        const renamed = changes.find((c) => c.field === 'name');
        addPrinterEvent({ printerId: pr.id, printerName: f.name, type: 'edited', changes, by: byName(b), device: device(req),
          summary: renamed ? `Renamed from ${renamed.from} to ${renamed.to}` + (changes.length > 1 ? ' and other details changed' : '')
            : `Changed ${changes.map((c) => c.label.toLowerCase()).join(', ')}` });
      }
      Object.assign(pr, f, { updatedAt: Date.now() });
      for (const r of repairs) if (r.printerId === pr.id) r.printerName = pr.name;
      saveList(PRINTERS_FILE, printers); saveList(REPAIRS_FILE, repairs); broadcast();
      return send(res, 200, pr);
    }
    if (m === 'DELETE') {
      // Repair history is kept, still labelled with the printer's name.
      printers = printers.filter((x) => x !== pr);
      addPrinterEvent({ printerId: pr.id, printerName: pr.name, type: 'removed', summary: 'Printer removed', changes: [],
        by: str(url.searchParams.get('by'), 80), device: device(req) });
      for (const r of repairs) if (r.printerId === pr.id) r.printerRemoved = true;
      saveList(PRINTERS_FILE, printers); saveList(REPAIRS_FILE, repairs); broadcast();
      return send(res, 200, { ok: true });
    }
  }

  /* ----- Repairs ----- */
  // Parts taken from inventory for a repair. Every quantity is checked before anything changes,
  // so a repair either saves with all its parts taken out of stock, or not at all.
  const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
  function partsMap(raw) {
    const map = new Map();
    if (raw == null) return map;
    if (!Array.isArray(raw) || raw.length > 50) throw badRequest('Parts list is not valid.');
    for (const x of raw) {
      const id = String(x && x.itemId || ''), q = int(x && x.qty);
      if (!/^[a-f0-9]{16}$/.test(id) || !(q >= 1 && q <= 100000)) throw badRequest('Each part needs an item and a quantity of 1 or more.');
      map.set(id, (map.get(id) || 0) + q);
    }
    return map;
  }
  function applyParts(oldParts, newMap, { person, note, repairId }) {
    const oldMap = new Map((oldParts || []).map((x) => [x.itemId, x.qty]));
    const changes = [];
    for (const id of new Set([...oldMap.keys(), ...newMap.keys()])) {
      const delta = (newMap.get(id) || 0) - (oldMap.get(id) || 0); // > 0 takes more out, < 0 puts back
      if (!delta) continue;
      const item = items.find((i) => i.id === id);
      if (!item) {
        const old = (oldParts || []).find((x) => x.itemId === id);
        throw badRequest(`${old ? old.itemName : 'A part'} is no longer in inventory, so its quantity can't be changed.`);
      }
      if (delta > 0 && item.qty < delta) throw Object.assign(new Error(`Only ${item.qty} ${item.unit} of ${item.name} on hand.`), { status: 409 });
      changes.push({ item, delta });
    }
    if (changes.some((c) => c.delta > 0) && !person) throw badRequest('Enter who did the repair. They are recorded as taking the parts.');
    for (const { item, delta } of changes) {
      item.qty -= delta; item.updatedAt = Date.now();
      addLog({ itemId: item.id, itemCode: item.code, itemName: item.name, type: delta > 0 ? 'take' : 'return', qty: Math.abs(delta),
        delta: -delta, after: item.qty, person, note: delta > 0 ? note.take : note.back, device: device(req), repairId });
    }
    if (changes.length) saveItems();
    const parts = [];
    for (const [id, qty] of newMap) {
      const item = items.find((i) => i.id === id);
      const old = (oldParts || []).find((x) => x.itemId === id);
      parts.push(item ? { itemId: id, itemCode: item.code, itemName: item.name, unit: item.unit, qty } : old);
    }
    return parts;
  }

  if (p === '/api/repairs' && m === 'GET') return send(res, 200, repairs);
  if (p === '/api/repairs' && m === 'POST') {
    const b = await readJSON(req);
    const pr = printers.find((x) => x.id === String(b.printerId));
    if (!pr) return fail(res, 400, 'Choose which printer was repaired.');
    const f = repairFields(b);
    if (!isDate(f.date)) return fail(res, 400, 'Enter the date of the repair.');
    if (!f.type) return fail(res, 400, 'Choose the type of repair.');
    const now = Date.now();
    const id = newId();
    const inventoryParts = applyParts([], partsMap(b.inventoryParts), { person: f.doneBy, repairId: id,
      note: { take: `Used to repair ${pr.name}: ${f.type}` } });
    const r = Object.assign({ id, printerId: pr.id, printerName: pr.name }, f, { inventoryParts, createdAt: now, updatedAt: now, device: device(req) });
    repairs.push(r); saveList(REPAIRS_FILE, repairs);
    addPrinterEvent({ printerId: pr.id, printerName: pr.name, repairId: r.id, type: 'repair-logged', summary: `Repair logged: ${repairSummary(r)}`,
      changes: repairDetails(r), by: r.doneBy, device: device(req) });
    broadcast();
    return send(res, 201, r);
  }
  if ((match = p.match(/^\/api\/repairs\/([a-f0-9]{16})$/))) {
    const r = repairs.find((x) => x.id === match[1]);
    if (!r) return fail(res, 404, 'That repair record no longer exists.');
    if (m === 'PUT') {
      const b = await readJSON(req);
      const f = repairFields(b);
      if (!isDate(f.date)) return fail(res, 400, 'Enter the date of the repair.');
      if (!f.type) return fail(res, 400, 'Choose the type of repair.');
      const pr = printers.find((x) => x.id === String(b.printerId));
      const name = pr ? pr.name : r.printerName;
      const before = Object.assign({}, r, { inventoryParts: (r.inventoryParts || []).map((x) => Object.assign({}, x)) });
      if (b.inventoryParts !== undefined) {
        r.inventoryParts = applyParts(r.inventoryParts, partsMap(b.inventoryParts), { person: f.doneBy, repairId: r.id,
          note: { take: `Used to repair ${name}: ${f.type}`, back: `Put back after editing the ${name} repair` } });
      }
      if (pr) { r.printerId = pr.id; r.printerName = pr.name; r.printerRemoved = false; }
      Object.assign(r, f, { updatedAt: Date.now() });
      const changes = diff(before, Object.assign({}, f, b.inventoryParts !== undefined ? { inventoryParts: r.inventoryParts } : {}), REPAIR_LABELS);
      const who = byName(b) || r.doneBy;
      if (before.printerId !== r.printerId) {
        changes.push({ field: 'printer', label: 'Printer', from: before.printerName, to: r.printerName });
        addPrinterEvent({ printerId: before.printerId, printerName: before.printerName, repairId: r.id, type: 'repair-moved',
          summary: `Repair (${repairSummary(r)}) moved to ${r.printerName}`, changes, by: who, device: device(req) });
      }
      if (changes.length) {
        addPrinterEvent({ printerId: r.printerId, printerName: r.printerName, repairId: r.id, type: 'repair-edited',
          summary: before.printerId !== r.printerId ? `Repair moved here from ${before.printerName}: ${repairSummary(r)}` : `Repair edited: ${repairSummary(r)}`,
          changes, by: who, device: device(req) });
      }
      saveList(REPAIRS_FILE, repairs); broadcast();
      return send(res, 200, r);
    }
    if (m === 'DELETE') {
      if (url.searchParams.get('returnParts') === '1' && (r.inventoryParts || []).length) {
        // Put back only parts whose item still exists.
        const keep = (r.inventoryParts || []).filter((x) => !items.some((i) => i.id === x.itemId));
        applyParts(r.inventoryParts, new Map(keep.map((x) => [x.itemId, x.qty])), { person: r.doneBy, repairId: r.id,
          note: { back: `Put back: ${r.printerName} repair record was deleted` } });
      }
      repairs = repairs.filter((x) => x !== r); saveList(REPAIRS_FILE, repairs);
      const returned = url.searchParams.get('returnParts') === '1' && (r.inventoryParts || []).length;
      addPrinterEvent({ printerId: r.printerId, printerName: r.printerName, repairId: r.id, type: 'repair-deleted',
        summary: `Repair deleted: ${repairSummary(r)} (${r.date})` + (returned ? '. Parts put back in inventory' : ''),
        changes: repairDetails(r).map((c) => ({ field: c.field, label: c.label, from: c.to, to: '' })),
        by: str(url.searchParams.get('by'), 80), device: device(req) });
      broadcast();
      return send(res, 200, { ok: true });
    }
  }
  if (p === '/api/export/repairs.csv' && m === 'GET') {
    const pid = str(url.searchParams.get('printer')), type = str(url.searchParams.get('type'));
    const rows = repairs.filter((r) => (!pid || r.printerId === pid) && (!type || r.type === type))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    const out = [['Date', 'Printer', 'Printer code', 'Model', 'Serial', 'Repair type', 'Done by', 'Parts from inventory', 'Other parts', 'Cost', 'Notes']].concat(rows.map((r) => {
      const pr = printers.find((x) => x.id === r.printerId) || {};
      return [r.date, r.printerName, pr.code || '', pr.model || '', pr.serial || '', r.type, r.doneBy,
        (r.inventoryParts || []).map((x) => `${x.qty} x ${x.itemName} (${x.itemCode})`).join('; '), r.parts, r.cost == null ? '' : r.cost, r.notes];
    }));
    return send(res, 200, '\ufeff' + csv(out), { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="printer-repairs-${stamp()}.csv"` });
  }

  if (p === '/api/export/order.csv' && m === 'GET') {
    const rows = orderList();
    const out = [['MRO number', 'Item', 'Barcode', 'On hand', 'Minimum', 'Maximum', 'Order quantity', 'Unit']].concat(
      rows.map((x) => [x.mro || '', x.name, x.code, x.qty, x.minQty, x.maxQty == null ? '' : x.maxQty, x.orderQty, x.unit]));
    return send(res, 200, '\ufeff' + csv(out), { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="order-${stamp()}.csv"` });
  }
  if (p === '/api/export/inventory.csv' && m === 'GET') {
    const rows = [['Barcode', 'MRO number', 'Item', 'On hand', 'Unit', 'Minimum', 'Maximum', 'Status', 'Last updated']].concat(
      [...items].sort((a, b) => a.name.localeCompare(b.name)).map((i) => [i.code, i.mro || '', i.name, i.qty, i.unit, i.minQty == null ? '' : i.minQty, i.maxQty == null ? '' : i.maxQty,
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
