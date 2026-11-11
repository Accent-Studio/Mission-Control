// Settings shared by every PC, such as the panel layouts: kept here in .data/shared.json and in step with the hub
// (services/hubShared.js is the hub side). One value per key, the newest wins, whole.
//
//   a change here   the page saves it (PUT /api/shared/:key); a moment later it goes up to the hub
//   the doorbell    when the hub rings, this PC picks up what changed since it last looked, and tells its pages
//                   (event "shared"), so a layout saved on one PC shows on the other
//   no hub          the value stays here, and goes up at the next ring
//
//   .data/shared.json   { cursor, items: { key: { value, at, by } }, sent: { key: at the hub has } }
import path from 'node:path';
import { DATA_DIR, MACHINE_NAME } from '../config.js';
import { publish } from '../lib/events.js';
import { readJson, writeJson } from '../lib/jsonStore.js';
import { hubCall, hubLinked, onHubRing } from './hubSync.js';
import { SHARED_KEY_RE, SHARED_MAX } from './hubShared.js';

const FILE = path.join(DATA_DIR, 'shared.json');
const SOON_MS = Number(process.env.MC_SHARED_SYNC_MS) > 0 ? Number(process.env.MC_SHARED_SYNC_MS) : 1000;
const RETRY_MS = 60e3;

const fail = (status, message) => Object.assign(new Error(message), { status });

let state = null;
function st() {
  if (state) return state;
  const r = readJson(FILE, 'shared');
  const v = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
  state = { cursor: Number(v.cursor) || 0, items: v.items && typeof v.items === 'object' ? v.items : {}, sent: v.sent && typeof v.sent === 'object' ? v.sent : {} };
  return state;
}
const save = () => writeJson(FILE, state, { pretty: false });

// { value, at, by } or { value: null, at: null } when nothing was saved yet
export function getShared(key) {
  if (!SHARED_KEY_RE.test(key)) throw fail(400, 'A key is lower case letters, digits and dashes');
  const it = st().items[key];
  return it ? { value: it.value, at: it.at, by: it.by } : { value: null, at: null, by: null };
}

export function setShared(key, value) {
  if (!SHARED_KEY_RE.test(key)) throw fail(400, 'A key is lower case letters, digits and dashes');
  if (value === undefined || JSON.stringify(value).length > SHARED_MAX) throw fail(400, 'Send { value }, at most 2 MB');
  const s = st();
  // a second save in the same millisecond still counts as newer
  let at = new Date().toISOString();
  const prev = s.items[key];
  if (prev && Date.parse(prev.at) >= Date.parse(at)) at = new Date(Date.parse(prev.at) + 1).toISOString();
  s.items[key] = { value, at, by: MACHINE_NAME };
  save();
  publish('shared', { key, at, by: MACHINE_NAME });
  soon();
  return { at, by: MACHINE_NAME };
}

async function push() {
  const s = st();
  for (const [key, it] of Object.entries(s.items)) {
    if (s.sent[key] === it.at) continue;
    const r = await hubCall('PUT', `/api/hub/shared/${key}`, { json: { value: it.value, at: it.at } });
    if (r.status !== 200) throw fail(r.status, `the hub answered ${r.status}`);
    s.sent[key] = it.at; // kept or not: a newer one there comes down with the pull
    save();
  }
}

async function pull() {
  const s = st();
  const r = await hubCall('GET', '/api/hub/shared', { query: { since: s.cursor } });
  if (r.status !== 200 || !r.json || typeof r.json.items !== 'object') throw fail(r.status, `the hub answered ${r.status}`);
  for (const [key, it] of Object.entries(r.json.items)) {
    if (!SHARED_KEY_RE.test(key) || !it || typeof it.at !== 'string') continue;
    const here = s.items[key];
    s.sent[key] = it.at;
    if (here && Date.parse(here.at) >= Date.parse(it.at)) continue; // this PC's is newer: it goes up
    s.items[key] = { value: it.value, at: it.at, by: it.by || null };
    publish('shared', { key, at: it.at, by: it.by || null });
  }
  s.cursor = Number(r.json.rev) || s.cursor;
  save();
}

let chain = Promise.resolve();
let failedAt = 0;
export function syncShared() {
  if (!hubLinked()) return Promise.resolve(false);
  chain = chain.catch(() => {}).then(async () => {
    await push();
    await pull();
    failedAt = 0;
    return true;
  }).catch((err) => {
    if (!failedAt) console.error('[shared-sync]', err.message);
    failedAt = Date.now();
    return false;
  });
  return chain;
}

let soonT = null;
function soon() {
  clearTimeout(soonT);
  soonT = setTimeout(syncShared, SOON_MS);
  if (soonT.unref) soonT.unref();
}

onHubRing(() => syncShared());
setInterval(() => {
  if (failedAt && hubLinked()) syncShared();
}, RETRY_MS).unref();
