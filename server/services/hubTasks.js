// The hub's copy of the task list (services/tasks.js), shared by the PCs (services/taskSync.js is the PC side). Only on
// the hub. Kept in .data/hub/tasks.json.
//
// A record is a task or a target, known by its uid (the same on every PC) and shown by its id (MC-12, TG-3). A PC posts
// the records it changed; the newer `updated` wins, and the two logs are put together. A record deleted on a PC stays
// here as { uid, id, deleted, updated }, so the other PCs delete it too.
// Two PCs that each made MC-24 while the hub was out of reach: the hub keeps the first one it got, gives the second the
// next free number, and says so in its answer (renames). Its PC then renumbers it.
// Every change takes the next number (rev); a PC asks for what changed since the number it last saw.
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, writeJson } from '../lib/jsonStore.js';
import { ring } from './hub.js';
import { mergeLogs } from './tasks.js';

const FILE = path.join(DATA_DIR, 'hub', 'tasks.json');
const KINDS = new Set(['task', 'target']);
const MAX_ITEMS = 50000;
const MAX_POST = 5000;

const fail = (status, message) => Object.assign(new Error(message), { status });

let db = null; // { rev, keys: { projectId: 'MC' }, items: { 'task:<uid>': { kind, rev, rec } } }
function load() {
  if (db) return db;
  const r = readJson(FILE, 'hub-tasks');
  if (!r.ok) throw fail(503, 'The hub could not read its task list just now. Try again in a moment.');
  const v = r.value && typeof r.value === 'object' ? r.value : {};
  db = { rev: Number(v.rev) || 0, keys: v.keys && typeof v.keys === 'object' ? v.keys : {}, items: v.items && typeof v.items === 'object' ? v.items : {} };
  return db;
}

const numOf = (id) => Number(String(id).split('-').pop()) || 0;
const prefixOf = (id) => String(id).replace(/-\d+$/, '');

// The next free id with the same letters: one past the highest the hub has.
function nextId(kind, id) {
  const p = prefixOf(id);
  let n = 0;
  for (const x of Object.values(db.items)) if (x.kind === kind && prefixOf(x.rec.id) === p) n = Math.max(n, numOf(x.rec.id));
  return `${p}-${n + 1}`;
}

const valid = (x) => x && KINDS.has(x.kind) && x.rec && typeof x.rec === 'object' && typeof x.rec.uid === 'string' && x.rec.uid.length <= 64
  && typeof x.rec.id === 'string' && /^[A-Za-z0-9]{1,8}-\d{1,9}$/.test(x.rec.id) && typeof x.rec.updated === 'string';

// A PC's changed records: { items: [{ kind, rec }], keys }. Answers { rev, renames: [{ kind, uid, from, to }] }.
export function postTasks({ items, keys } = {}) {
  const d = load();
  if (!Array.isArray(items) || items.length > MAX_POST) throw fail(400, 'items must be a list');
  const renames = [];
  let changed = false;
  for (const x of items) {
    if (!valid(x)) continue;
    const k = `${x.kind}:${x.rec.uid}`;
    const cur = d.items[k];
    if (cur && !(x.rec.updated > cur.rec.updated)) continue; // the hub's is as new or newer
    if (!cur && Object.keys(d.items).length >= MAX_ITEMS) throw fail(409, 'too many tasks on the hub');
    let id = cur ? cur.rec.id : x.rec.id; // an id the hub gave stays
    if (!cur && !x.rec.deleted && Object.values(d.items).some((y) => y.kind === x.kind && !y.rec.deleted && y.rec.id === id)) {
      id = nextId(x.kind, id);
      renames.push({ kind: x.kind, uid: x.rec.uid, from: x.rec.id, to: id });
    }
    const rec = x.rec.deleted ? { uid: x.rec.uid, id, deleted: true, updated: x.rec.updated } : { ...x.rec, id };
    if (x.kind === 'task' && !rec.deleted) rec.log = mergeLogs(cur && cur.rec.log, x.rec.log);
    d.items[k] = { kind: x.kind, rev: ++d.rev, rec };
    changed = true;
  }
  for (const [pid, key] of Object.entries(keys && typeof keys === 'object' ? keys : {})) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9]{1,8}$/.test(key) || d.keys[pid]) continue;
    d.keys[pid] = key;
    changed = true;
  }
  if (changed) {
    writeJson(FILE, d, { pretty: false });
    ring();
  }
  return { rev: d.rev, renames };
}

// What changed since `since`: { rev, keys, items: [{ kind, rec }] }.
export function tasksSince(since = 0) {
  const d = load();
  const s = Number(since) || 0;
  return { rev: d.rev, keys: d.keys, items: Object.values(d.items).filter((x) => x.rev > s).sort((a, b) => a.rev - b.rev).map((x) => ({ kind: x.kind, rec: x.rec })) };
}
