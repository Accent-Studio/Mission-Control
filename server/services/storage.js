// Conversations and attachments on the System page: what Claude and Mission Control keep on this PC, by type and by
// project, and moving the ones picked to the Recycle Bin. Nothing here is deleted by itself; the Temp folder panel
// (temp.js) is the other half, for builds and scratch files.
//
//   code       code conversations (~/.claude/projects), by project: the transcript and its folder of helper agents
//   chat       plain chats
//   pictures, documents, files   what was attached to a message (.data/uploads), by file type
//   previews   pictures taken out of transcripts to show them (.data/imgcache): made again when needed
//   hubcopies  other PCs' code conversations read here (.data/hub-cache): fetched again from the hub when opened
//   logs       Mission Control's logs (.data/logs)
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { recycle } from '../lib/recycle.js';
import { invalidate } from '../lib/cache.js';
import { markRewritten } from './hubSync.js';
import { allSessionRows, deleteSessions, sessionFiles, sessionIdleMs } from './sessions.js';
import { getProject } from './catalog.js';
import { isSessionBusy } from './runs.js';

export const TYPES = {
  code: 'Code conversations',
  chat: 'Chats',
  pictures: 'Pictures you attached',
  documents: 'Documents you attached',
  files: 'Other files you attached',
  previews: 'Picture previews',
  hubcopies: "Other PCs' conversations",
  logs: 'Logs',
};
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const IMG_DIR = path.join(DATA_DIR, 'imgcache');
const HUB_CACHE = path.join(DATA_DIR, 'hub-cache');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PICTURE = /\.(png|jpe?g|gif|webp|bmp|heic|avif|svg)$/i;
const DOCUMENT = /\.(pdf|docx?|odt|rtf|txt|md|csv|tsv|xlsx?|ods|pptx?|odp|json|html?)$/i;
const BUSY_MS = 2 * 60e3; // as the single delete: a conversation written in the last 2 minutes is in use
const CACHE_MS = 60e3;

const fail = (status, message) => Object.assign(new Error(message), { status });

// { bytes, files, newest } of a file or a folder (links are not followed).
function measure(p) {
  const out = { bytes: 0, files: 0, newest: 0 };
  const walk = (q) => {
    let st;
    try { st = fs.lstatSync(q); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(q); } catch { return; }
      for (const n of names) walk(path.join(q, n));
    } else {
      out.bytes += st.size;
      out.files++;
      out.newest = Math.max(out.newest, st.mtimeMs);
    }
  };
  walk(p);
  return out;
}
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

async function scan() {
  const items = [];
  for (const row of await allSessionRows()) {
    const f = sessionFiles(row.id);
    if (!f) continue;
    const m = measure(f.file);
    if (f.sidecar) { const s = measure(f.sidecar); m.bytes += s.bytes; m.files += s.files; }
    const p = row.kind === 'code' && row.project ? getProject(row.project) : null;
    items.push({ type: row.kind === 'chat' ? 'chat' : 'code', id: row.id, name: row.title || 'Untitled', project: row.kind === 'chat' ? null : (p && p.name) || 'No project', bytes: m.bytes, lastAt: row.lastAt || iso(m.newest), archived: !!row.archived, pinned: !!row.pinned });
  }
  let ups = [];
  try { ups = fs.readdirSync(UPLOAD_DIR).filter((d) => UUID_RE.test(d)); } catch { /* none yet */ }
  for (const d of ups) {
    const dir = path.join(UPLOAD_DIR, d);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    const m = measure(dir);
    const name = names[0] || d;
    items.push({ type: PICTURE.test(name) ? 'pictures' : DOCUMENT.test(name) ? 'documents' : 'files', id: 'u:' + d, name, project: null, bytes: m.bytes, lastAt: iso(m.newest) });
  }
  for (const [type, dir, name] of [['previews', IMG_DIR, 'All picture previews (made again when a conversation is opened)'], ['hubcopies', HUB_CACHE, "All copies of other PCs' conversations (fetched again from the hub when opened)"]]) {
    const m = measure(dir);
    if (m.files) items.push({ type, id: type, name: `${name}, ${m.files} files`, project: null, bytes: m.bytes, lastAt: iso(m.newest) });
  }
  const logs = (dir, rel = '') => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) logs(path.join(dir, e.name), r);
      else if (e.isFile()) { const m = measure(path.join(dir, e.name)); items.push({ type: 'logs', id: 'l:' + r, name: r, project: null, bytes: m.bytes, lastAt: iso(m.newest) }); }
    }
  };
  logs(LOG_DIR);
  return items;
}

let cache = null; // { at, items }
// { types: { key: label }, items: [{ type, id, name, project, bytes, lastAt, archived?, pinned? }], at }
export async function getStorage({ fresh = false } = {}) {
  if (fresh || !cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), items: await scan() };
  return { types: TYPES, items: cache.items, at: new Date(cache.at).toISOString() };
}

// Moves the items picked on the page to the Recycle Bin: [{ type, id }]. Each one is looked up again here (a path never
// comes from the page). A conversation in use is skipped. Resolves { done: n, bytes, failed: [{ id, name, error }] }.
export async function deleteItems(list) {
  if (!Array.isArray(list) || !list.length) throw fail(400, 'Pick at least one item');
  if (list.length > 5000) throw fail(400, 'At most 5000 items at once');
  const known = new Map((await getStorage({ fresh: true })).items.map((x) => [x.type + '\n' + x.id, x]));
  const failed = [];
  const sessions = [];
  const paths = [];
  const byPath = new Map();
  for (const want of list) {
    const it = want && known.get(want.type + '\n' + want.id);
    if (!it) { failed.push({ id: want && want.id, name: null, error: 'Not found any more' }); continue; }
    if (it.type === 'code' || it.type === 'chat') {
      if (isSessionBusy(it.id)) { failed.push({ id: it.id, name: it.name, error: 'Claude is using it' }); continue; }
      const idle = await sessionIdleMs(it.id);
      if (idle !== null && idle < BUSY_MS) { failed.push({ id: it.id, name: it.name, error: 'It was active in the last 2 minutes' }); continue; }
      sessions.push(it);
      continue;
    }
    const p = it.id.startsWith('u:') ? path.join(UPLOAD_DIR, it.id.slice(2))
      : it.type === 'previews' ? IMG_DIR
      : it.type === 'hubcopies' ? HUB_CACHE
      : it.id.startsWith('l:') ? path.join(LOG_DIR, ...it.id.slice(2).split('/'))
      : null;
    if (!p || !path.resolve(p).startsWith(path.resolve(DATA_DIR) + path.sep)) { failed.push({ id: it.id, name: it.name, error: 'Not a file Mission Control keeps' }); continue; }
    paths.push(p);
    byPath.set(p, it);
  }
  let done = 0;
  let bytes = 0;
  if (sessions.length) {
    const r = await deleteSessions(sessions.map((x) => x.id));
    const ok = new Set(r.done);
    for (const it of sessions) if (ok.has(it.id)) { done++; bytes += it.bytes; }
    for (const f of r.failed) failed.push({ id: f.id, name: (sessions.find((x) => x.id === f.id) || {}).name || null, error: f.error });
  }
  if (paths.length) {
    const r = await recycle(paths);
    for (const p of r.done) { done++; bytes += byPath.get(p).bytes; }
    for (const f of r.failed) failed.push({ id: byPath.get(f.path).id, name: byPath.get(f.path).name, error: f.error });
  }
  cache = null;
  return { done, bytes, failed };
}

// ---- Shrink: a conversation without its heavy parts ----
//
// Most of a big code conversation is screenshots that tools sent back (a browser, Blender, ComfyUI...), and Claude Code
// keeps each one twice: in the tool result, and in its own copy of the result (toolUseResult). Shrink takes out the parts
// picked on the page (SHRINK_PARTS) from the conversation and from its helper agents' conversations, and keeps everything
// else: every message, answer and step stays, in order, so the conversation still opens and can go on. What is taken out
// becomes a short note. The old files go to the Recycle Bin, so a shrink can be undone there.
import { SHRINK_PARTS, shrinkText } from '../lib/shrink.js';
export { SHRINK_PARTS, shrinkText };

function jsonlFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}
const sum = (o) => Object.values(o).reduce((n, x) => n + x, 0);
const partsOf = (opts) => Object.fromEntries(Object.keys(SHRINK_PARTS).filter((k) => opts && opts[k] === true).map((k) => [k, true]));

// Rewrites one file: { saved (bytes), old (the original, moved aside) } or null when nothing was taken out. The new file
// takes the old one's place in one rename; the old one waits as <name>.big until it goes to the Recycle Bin.
function shrinkFile(file, opts) {
  const st = fs.statSync(file);
  const r = shrinkText(fs.readFileSync(file, 'utf8'), opts);
  if (!sum(r.saved)) return null;
  const tmp = file + '.shrink';
  fs.writeFileSync(tmp, r.text);
  const old = file + '.big';
  fs.renameSync(file, old);
  fs.renameSync(tmp, file);
  fs.utimesSync(file, st.atime, st.mtime); // still "last used" when it was
  return { saved: st.size - fs.statSync(file).size, old };
}

// The conversations picked on the page that may be shrunk: [{ it, files }], and the ones refused into `failed`.
async function shrinkable(list, failed) {
  if (!Array.isArray(list) || !list.length) throw fail(400, 'Pick at least one conversation');
  const known = new Map((await getStorage()).items.filter((x) => x.type === 'code').map((x) => [x.type + '\n' + x.id, x]));
  const out = [];
  for (const want of list) {
    const it = want && known.get(want.type + '\n' + want.id);
    if (!it) { failed.push({ id: want && want.id, name: null, error: 'Only code conversations can be shrunk' }); continue; }
    const f = sessionFiles(it.id);
    if (!f) { failed.push({ id: it.id, name: it.name, error: 'Not found any more' }); continue; }
    out.push({ it, f, files: [f.file, ...(f.sidecar ? jsonlFiles(f.sidecar) : [])] });
  }
  return out;
}

// What each part would save in the conversations picked: { parts: { part: label }, could: { part: bytes }, bytes (now) }.
export async function shrinkEstimate(list) {
  const could = {};
  let bytes = 0;
  for (const x of await shrinkable(list, [])) {
    bytes += x.it.bytes;
    for (const file of x.files) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const r = shrinkText(text, {}, { measureOnly: true });
      for (const [k, v] of Object.entries(r.could)) could[k] = (could[k] || 0) + v;
    }
  }
  return { parts: SHRINK_PARTS, could, bytes };
}

// Shrinks the conversations picked on the page: items [{ type, id }], opts { part: true }. One in use is skipped.
// Resolves { done: n, bytes (saved), failed: [{ id, name, error }] }.
export async function shrinkItems(list, options = { toolPictures: true }) {
  const opts = partsOf(options);
  if (!Object.keys(opts).length) throw fail(400, 'Pick at least one thing to take out');
  const failed = [];
  const olds = [];
  let done = 0;
  let bytes = 0;
  for (const { it, f, files } of await shrinkable(list, failed)) {
    if (isSessionBusy(it.id)) { failed.push({ id: it.id, name: it.name, error: 'Claude is using it' }); continue; }
    const idle = await sessionIdleMs(it.id);
    if (idle !== null && idle < BUSY_MS) { failed.push({ id: it.id, name: it.name, error: 'It was active in the last 2 minutes' }); continue; }
    try {
      let any = false;
      for (const file of files) {
        const r = shrinkFile(file, opts);
        if (!r) continue;
        any = true;
        bytes += r.saved;
        olds.push(r.old);
        if (file === f.file) markRewritten(it.id); // the hub's copy is swapped for the smaller one
      }
      if (any) done++;
    } catch (err) {
      failed.push({ id: it.id, name: it.name, error: err.message });
    }
  }
  const r = await recycle(olds);
  for (const x of r.failed) console.error('[storage] the old copy stays next to the new one:', x.path, x.error);
  invalidate('sessions:scan');
  cache = null;
  return { done, bytes, failed };
}
