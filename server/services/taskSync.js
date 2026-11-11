// The PC side of the shared task list: this PC's tasks and targets (services/tasks.js) go to the hub, and the other PCs'
// come back (services/hubTasks.js is the hub side). It runs only with a link to the hub (services/hubSync.js).
//
//   a change here   a moment later, the records that changed since the hub last had them go up
//   the doorbell    when the hub rings (anything changed there), this PC picks up what changed since it last looked
//   no hub          everything stays here, and goes up at the next ring
// What the hub last had of each record is kept in .data/task-sync.json: { cursor, sent: { 'task:<uid>': 'updated|id' } }.
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { onPublish } from '../lib/events.js';
import { readJson, writeJson } from '../lib/jsonStore.js';
import { hubCall, hubLinked, onHubRing } from './hubSync.js';
import { forgetGone, syncIn, syncOut } from './tasks.js';

const STATE_FILE = path.join(DATA_DIR, 'task-sync.json');
const SOON_MS = Number(process.env.MC_TASK_SYNC_MS) > 0 ? Number(process.env.MC_TASK_SYNC_MS) : 1500;
const RETRY_MS = 60e3;
const CHUNK = 2000;

let state = null;
function st() {
  if (state) return state;
  const r = readJson(STATE_FILE, 'task-sync');
  const v = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
  state = { cursor: Number(v.cursor) || 0, sent: v.sent && typeof v.sent === 'object' ? v.sent : {} };
  return state;
}
const saveState = () => writeJson(STATE_FILE, state, { pretty: false });
const keyOf = (x) => `${x.kind}:${x.rec.uid}`;
const markOf = (rec) => `${rec.updated}|${rec.id}`;

function waiting() {
  const out = syncOut();
  if (!out) return null;
  return { keys: out.keys, items: out.items.filter((x) => st().sent[keyOf(x)] !== markOf(x.rec)) };
}

let quiet = false; // true while the hub's changes are put in: that save is not a change to send back
function take(items, keys, renames) {
  quiet = true;
  try {
    syncIn(items, keys, renames);
  } finally {
    quiet = false;
  }
}

async function push() {
  const w = waiting();
  if (!w || !w.items.length) return;
  for (let i = 0; i < w.items.length; i += CHUNK) {
    const part = w.items.slice(i, i + CHUNK);
    const r = await hubCall('POST', '/api/hub/tasks', { json: { items: part, keys: w.keys } });
    if (r.status !== 200 || !r.json) throw Object.assign(new Error(`the hub answered ${r.status}`), { status: r.status });
    const renamed = new Map((r.json.renames || []).map((x) => [`${x.kind}:${x.uid}`, x.to]));
    for (const x of part) st().sent[keyOf(x)] = markOf({ ...x.rec, id: renamed.get(keyOf(x)) || x.rec.id });
    if (renamed.size) take([], null, r.json.renames);
    forgetGone(part.filter((x) => x.rec.deleted).map((x) => x.rec.uid));
    saveState();
  }
}

async function pull() {
  const r = await hubCall('GET', '/api/hub/tasks', { query: { since: st().cursor } });
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.items)) throw Object.assign(new Error(`the hub answered ${r.status}`), { status: r.status });
  if (r.json.items.length || r.json.keys) take(r.json.items, r.json.keys);
  for (const x of r.json.items) if (x && x.rec && x.rec.uid) st().sent[keyOf(x)] = markOf(x.rec);
  st().cursor = Number(r.json.rev) || st().cursor;
  saveState();
}

let chain = Promise.resolve();
let failedAt = 0;
export function syncTasks() {
  if (!hubLinked()) return Promise.resolve(false);
  const next = chain.catch(() => {}).then(async () => {
    await push();
    await pull();
    failedAt = 0;
    return true;
  });
  chain = next.catch((err) => {
    if (!failedAt) console.error('[task-sync]', err.message);
    failedAt = Date.now();
    return false;
  });
  return chain;
}

let soonT = null;
function soon() {
  clearTimeout(soonT);
  soonT = setTimeout(syncTasks, SOON_MS);
  if (soonT.unref) soonT.unref();
}

onPublish((type) => {
  if (type === 'tasks' && !quiet) soon();
});
onHubRing(() => syncTasks());
// what could not go up (no hub) goes at the next ring; this catches a hub that came back without ringing
setInterval(() => {
  if (failedAt && hubLinked()) syncTasks();
}, RETRY_MS).unref();
