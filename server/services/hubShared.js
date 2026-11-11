// Settings the PCs share through the hub, such as the panel layouts (services/sharedSync.js is a PC's side): one value per
// key, the newest wins. Each change rings the doorbell, so every PC that is on picks it up at once; a PC that was off
// picks it up when it comes back.
//
//   .data/hub/shared.json   { rev, items: { key: { value, at, by, rev } } }
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, writeJson } from '../lib/jsonStore.js';
import { ring } from './hub.js';

const FILE = path.join(DATA_DIR, 'hub', 'shared.json');
export const SHARED_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SHARED_MAX = 2 * 1024 * 1024; // one value, as JSON

const fail = (status, message) => Object.assign(new Error(message), { status });

let store = null;
function load() {
  if (store) return store;
  const r = readJson(FILE, 'hub-shared');
  const v = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
  store = { rev: Number(v.rev) || 0, items: v.items && typeof v.items === 'object' ? v.items : {} };
  return store;
}

// What changed after `since`: { rev, items: { key: { value, at, by } } }
export function sharedSince(since) {
  const s = load();
  const n = Number(since) || 0;
  const items = {};
  for (const [k, it] of Object.entries(s.items)) if (it.rev > n) items[k] = { value: it.value, at: it.at, by: it.by };
  return { rev: s.rev, items };
}

// A PC's value for `key`, kept when it is newer than the hub's. { kept, at, by }: what the hub has now.
export function putShared(key, body, m) {
  if (!SHARED_KEY_RE.test(key)) throw fail(400, 'A key is lower case letters, digits and dashes');
  if (!body || typeof body.at !== 'string' || !Number.isFinite(Date.parse(body.at)) || body.value === undefined) throw fail(400, 'Send { value, at }');
  if (JSON.stringify(body.value).length > SHARED_MAX) throw fail(413, 'That value is too big');
  const s = load();
  const cur = s.items[key];
  if (cur && Date.parse(cur.at) >= Date.parse(body.at)) return { kept: false, at: cur.at, by: cur.by };
  s.rev += 1;
  s.items[key] = { value: body.value, at: body.at, by: String((m && m.name) || 'PC').slice(0, 40), rev: s.rev };
  writeJson(FILE, s, { pretty: false });
  ring();
  return { kept: true, at: body.at, by: s.items[key].by };
}
