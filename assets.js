// Equipment tracked one by one (label printers, laptops / desktops): the list itself, repairs that can
// take parts out of inventory, a full change history, and CSV exports. One instance per kind in
// public/asset-kinds.js. Printers keep the files, API paths and field names of the first version.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function createAssetKind(K, ctx) {
  const { DATA_DIR, newId, str, int, isDate, csv, stamp, loadList, saveList, getItems, saveItems, addLog, broadcast } = ctx;
  const LIST_FILE = path.join(DATA_DIR, K.files.list);
  const REPAIRS_FILE = path.join(DATA_DIR, K.files.repairs);
  const LOG_FILE = path.join(DATA_DIR, K.files.log);
  const ID = K.idField, NAME = K.nameField, REMOVED = K.removedField;

  let list = loadList(LIST_FILE);
  let repairs = loadList(REPAIRS_FILE);
  let history = [];
  try {
    history = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
  const byName = (b) => str(b && b.by, 80);

  /* ---------- Fields ---------- */
  const FIELD_LABELS = {};
  for (const f of K.fields) FIELD_LABELS[f.key] = f.hist || f.label.replace(/ \(optional\)$/i, '');
  function fieldsFrom(b) {
    const out = {};
    for (const f of K.fields) {
      let v = str(b[f.key], f.max || 80);
      if (f.type === 'select' && v && !f.options.includes(v)) throw badRequest(`${f.label} must be one of: ${f.options.join(', ')}.`);
      if (f.type === 'date' && v && !isDate(v)) throw badRequest(`${f.label} must be a date.`);
      out[f.key] = v;
    }
    return out;
  }
  const REPAIR_LABELS = { date: 'Date', type: 'Repair type', doneBy: 'Done by', parts: 'Other parts', cost: 'Cost', notes: 'Notes',
    inventoryParts: 'Parts from inventory', moved: K.Label };
  function repairFields(b) {
    const cost = b.cost === '' || b.cost == null ? null : Math.round(Number(b.cost) * 100) / 100;
    return { date: str(b.date, 10), type: str(b.type, 80), doneBy: str(b.doneBy, 80), parts: str(b.parts, 300),
      cost: Number.isFinite(cost) && cost >= 0 ? cost : null, notes: str(b.notes, 2000) };
  }

  /* ---------- Barcode codes (PR-0001, PC-0001...) ---------- */
  function nextCode() {
    let max = 0;
    for (const x of list) { const n = Number(String(x.code || '').slice(K.prefix.length)); if (n > max) max = n; }
    return K.prefix + String(max + 1).padStart(4, '0');
  }
  if (list.some((x) => !x.code)) {
    for (const x of [...list].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) if (!x.code) x.code = nextCode();
    saveList(LIST_FILE, list);
  }

  /* ---------- History ---------- */
  function addEvent(e) {
    const ev = Object.assign({ id: newId(), at: Date.now() }, e);
    history.push(ev);
    fs.appendFileSync(LOG_FILE, JSON.stringify(ev) + '\n');
    return ev;
  }
  const ev = (asset, extra) => Object.assign({ [ID]: asset.id, [NAME]: asset.name }, extra);
  const partsLabel = (l) => (l || []).map((x) => `${x.qty} x ${x.itemName}`).join(', ');
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
  const repairDetails = (r) => Object.keys(REPAIR_LABELS).filter((k) => k !== 'moved')
    .map((k) => ({ field: k, label: REPAIR_LABELS[k], from: '', to: k === 'inventoryParts' ? partsLabel(r[k]) : (r[k] == null ? '' : String(r[k])) }))
    .filter((c) => c.to);
  // Records that existed before history tracking get their starting entries once.
  {
    const seen = new Set(history.map((e) => e.type + ':' + (e.repairId || e[ID])));
    let added = 0;
    const back = (e) => { addEvent(Object.assign({ backfilled: true }, e)); added++; };
    for (const x of list) if (!seen.has('created:' + x.id)) {
      back(ev(x, { at: x.createdAt || Date.now(), type: 'created', summary: `${K.Label} added as ${x.name}`,
        changes: diff({}, x, FIELD_LABELS) }));
    }
    for (const r of repairs) if (!seen.has('repair-logged:' + r.id)) {
      back({ at: r.createdAt || Date.now(), [ID]: r[ID], [NAME]: r[NAME], repairId: r.id, type: 'repair-logged',
        summary: `Repair logged: ${repairSummary(r)}`, changes: repairDetails(r), by: r.doneBy || '' });
    }
    if (added) history.sort((a, b) => a.at - b.at);
  }

  /* ---------- Parts taken from inventory ---------- */
  // Every quantity is checked before anything changes, so a repair either saves with all its
  // parts taken out of stock, or not at all.
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
  function applyParts(oldParts, newMap, { person, note, repairId, device }) {
    const items = getItems();
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
        delta: -delta, after: item.qty, person, note: delta > 0 ? note.take : note.back, device, repairId });
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

  const csvChange = (c) => (c.from && c.to ? `${c.label}: ${c.from} -> ${c.to}` : c.to ? `${c.label}: ${c.to}` : `${c.label}: ${c.from} (removed)`);
  const csvReply = (send, res, rows, name) => send(res, 200, '﻿' + csv(rows), { 'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}-${stamp()}.csv"` });

  /* ---------- Routes ---------- */
  // Returns true when it handled the request.
  async function handle(req, res, url, { send, fail, readJSON, device }) {
    const p = url.pathname, m = req.method, dev = device(req);
    let match;
    const idRe = (base) => new RegExp('^' + base.replace(/\//g, '\\/') + '\\/([a-f0-9]{16})$');

    if (p === K.api.history && m === 'GET') {
      const id = str(url.searchParams.get('id'));
      send(res, 200, id ? history.filter((e) => e[ID] === id) : history); return true;
    }
    if (p === K.api.historyCsv && m === 'GET') {
      const id = str(url.searchParams.get('id'));
      const rows = history.filter((e) => !id || e[ID] === id).slice().reverse();
      csvReply(send, res, [['Date', 'Time', K.Label, 'Event', 'Changes', 'By', 'Device']].concat(rows.map((e) => {
        const d = new Date(e.at);
        return [d.toLocaleDateString(), d.toLocaleTimeString(), e[NAME], e.summary, (e.changes || []).map(csvChange).join('; '), e.by || '', e.device || ''];
      })), `${K.api.csvName}-history`);
      return true;
    }

    if (p === K.api.list && m === 'GET') { send(res, 200, list); return true; }
    if (p === K.api.list && m === 'POST') {
      const b = await readJSON(req);
      const f = fieldsFrom(b);
      if (!f.name) { fail(res, 400, `Give the ${K.label} a name.`); return true; }
      const now = Date.now();
      const x = Object.assign({ id: newId(), code: nextCode() }, f, { createdAt: now, updatedAt: now });
      list.push(x); saveList(LIST_FILE, list);
      addEvent(ev(x, { type: 'created', summary: `${K.Label} added as ${x.name} (${x.code})`, changes: diff({}, f, FIELD_LABELS), by: byName(b), device: dev }));
      broadcast();
      send(res, 201, x); return true;
    }
    if ((match = p.match(idRe(K.api.list)))) {
      const x = list.find((y) => y.id === match[1]);
      if (!x) { fail(res, 404, `That ${K.label} no longer exists.`); return true; }
      if (m === 'PUT') {
        const b = await readJSON(req);
        const f = fieldsFrom(b);
        if (!f.name) { fail(res, 400, `Give the ${K.label} a name.`); return true; }
        const changes = diff(x, f, FIELD_LABELS);
        if (changes.length) {
          const renamed = changes.find((c) => c.field === 'name');
          addEvent({ [ID]: x.id, [NAME]: f.name, type: 'edited', changes, by: byName(b), device: dev,
            summary: renamed ? `Renamed from ${renamed.from} to ${renamed.to}` + (changes.length > 1 ? ' and other details changed' : '')
              : `Changed ${changes.map((c) => c.label.toLowerCase()).join(', ')}` });
        }
        Object.assign(x, f, { updatedAt: Date.now() });
        for (const r of repairs) if (r[ID] === x.id) r[NAME] = x.name;
        saveList(LIST_FILE, list); saveList(REPAIRS_FILE, repairs); broadcast();
        send(res, 200, x); return true;
      }
      if (m === 'DELETE') {
        // Repair history is kept, still labelled with the name.
        list = list.filter((y) => y !== x);
        addEvent(ev(x, { type: 'removed', summary: `${K.Label} removed`, changes: [], by: str(url.searchParams.get('by'), 80), device: dev }));
        for (const r of repairs) if (r[ID] === x.id) r[REMOVED] = true;
        saveList(LIST_FILE, list); saveList(REPAIRS_FILE, repairs); broadcast();
        send(res, 200, { ok: true }); return true;
      }
    }

    if (p === K.api.repairs && m === 'GET') { send(res, 200, repairs); return true; }
    if (p === K.api.repairs && m === 'POST') {
      const b = await readJSON(req);
      const x = list.find((y) => y.id === String(b[ID]));
      if (!x) { fail(res, 400, `Choose which ${K.label} was repaired.`); return true; }
      const f = repairFields(b);
      if (!isDate(f.date)) { fail(res, 400, 'Enter the date of the repair.'); return true; }
      if (!f.type) { fail(res, 400, 'Choose the type of repair.'); return true; }
      const now = Date.now(), id = newId();
      const inventoryParts = applyParts([], partsMap(b.inventoryParts), { person: f.doneBy, repairId: id, device: dev,
        note: { take: `Used to repair ${x.name}: ${f.type}` } });
      const r = Object.assign({ id, [ID]: x.id, [NAME]: x.name }, f, { inventoryParts, createdAt: now, updatedAt: now, device: dev });
      repairs.push(r); saveList(REPAIRS_FILE, repairs);
      addEvent(ev(x, { repairId: r.id, type: 'repair-logged', summary: `Repair logged: ${repairSummary(r)}`, changes: repairDetails(r), by: r.doneBy, device: dev }));
      broadcast();
      send(res, 201, r); return true;
    }
    if ((match = p.match(idRe(K.api.repairs)))) {
      const r = repairs.find((y) => y.id === match[1]);
      if (!r) { fail(res, 404, 'That repair record no longer exists.'); return true; }
      if (m === 'PUT') {
        const b = await readJSON(req);
        const f = repairFields(b);
        if (!isDate(f.date)) { fail(res, 400, 'Enter the date of the repair.'); return true; }
        if (!f.type) { fail(res, 400, 'Choose the type of repair.'); return true; }
        const x = list.find((y) => y.id === String(b[ID]));
        const name = x ? x.name : r[NAME];
        const before = Object.assign({}, r, { inventoryParts: (r.inventoryParts || []).map((y) => Object.assign({}, y)) });
        if (b.inventoryParts !== undefined) {
          r.inventoryParts = applyParts(r.inventoryParts, partsMap(b.inventoryParts), { person: f.doneBy, repairId: r.id, device: dev,
            note: { take: `Used to repair ${name}: ${f.type}`, back: `Put back after editing the ${name} repair` } });
        }
        if (x) { r[ID] = x.id; r[NAME] = x.name; r[REMOVED] = false; }
        Object.assign(r, f, { updatedAt: Date.now() });
        const changes = diff(before, Object.assign({}, f, b.inventoryParts !== undefined ? { inventoryParts: r.inventoryParts } : {}), REPAIR_LABELS);
        const who = byName(b) || r.doneBy;
        if (before[ID] !== r[ID]) {
          changes.push({ field: 'moved', label: K.Label, from: before[NAME], to: r[NAME] });
          addEvent({ [ID]: before[ID], [NAME]: before[NAME], repairId: r.id, type: 'repair-moved',
            summary: `Repair (${repairSummary(r)}) moved to ${r[NAME]}`, changes, by: who, device: dev });
        }
        if (changes.length) {
          addEvent({ [ID]: r[ID], [NAME]: r[NAME], repairId: r.id, type: 'repair-edited',
            summary: before[ID] !== r[ID] ? `Repair moved here from ${before[NAME]}: ${repairSummary(r)}` : `Repair edited: ${repairSummary(r)}`,
            changes, by: who, device: dev });
        }
        saveList(REPAIRS_FILE, repairs); broadcast();
        send(res, 200, r); return true;
      }
      if (m === 'DELETE') {
        const returned = url.searchParams.get('returnParts') === '1' && (r.inventoryParts || []).length;
        if (returned) {
          // Put back only parts whose item still exists.
          const items = getItems();
          const keep = (r.inventoryParts || []).filter((y) => !items.some((i) => i.id === y.itemId));
          applyParts(r.inventoryParts, new Map(keep.map((y) => [y.itemId, y.qty])), { person: r.doneBy, repairId: r.id, device: dev,
            note: { back: `Put back: ${r[NAME]} repair record was deleted` } });
        }
        repairs = repairs.filter((y) => y !== r); saveList(REPAIRS_FILE, repairs);
        addEvent({ [ID]: r[ID], [NAME]: r[NAME], repairId: r.id, type: 'repair-deleted',
          summary: `Repair deleted: ${repairSummary(r)} (${r.date})` + (returned ? '. Parts put back in inventory' : ''),
          changes: repairDetails(r).map((c) => ({ field: c.field, label: c.label, from: c.to, to: '' })),
          by: str(url.searchParams.get('by'), 80), device: dev });
        broadcast();
        send(res, 200, { ok: true }); return true;
      }
    }
    if (p === K.api.repairsCsv && m === 'GET') {
      const id = str(url.searchParams.get('id')), type = str(url.searchParams.get('type'));
      const rows = repairs.filter((r) => (!id || r[ID] === id) && (!type || r.type === type))
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
      const extra = K.fields.filter((f) => f.key !== 'name' && f.key !== 'notes');
      csvReply(send, res, [['Date', K.Label, `${K.Label} code`].concat(extra.map((f) => FIELD_LABELS[f.key]),
        ['Repair type', 'Done by', 'Parts from inventory', 'Other parts', 'Cost', 'Notes'])].concat(rows.map((r) => {
        const x = list.find((y) => y.id === r[ID]) || {};
        return [r.date, r[NAME], x.code || ''].concat(extra.map((f) => x[f.key] || ''), [r.type, r.doneBy,
          (r.inventoryParts || []).map((y) => `${y.qty} x ${y.itemName} (${y.itemCode})`).join('; '), r.parts, r.cost == null ? '' : r.cost, r.notes]);
      })), `${K.api.csvName}-repairs`);
      return true;
    }
    return false;
  }

  // Called from the shared "labels printed" route.
  function markLabelsPrinted(ids, dev) {
    const now = Date.now();
    let n = 0;
    for (const x of list) if (ids.has(x.id)) {
      x.labelPrintedAt = now; n++;
      addEvent(ev(x, { type: 'label-printed', summary: `Label printed (${x.code})`, changes: [], device: dev }));
    }
    if (n) saveList(LIST_FILE, list);
    return n;
  }

  return { K, handle, markLabelsPrinted };
};
