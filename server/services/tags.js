// Automatic project tags for Claude Code sessions.
// Almost every conversation is started from the workspace root, so the cwd says nothing about the project it is
// about. Instead the tool calls tell: every absolute path in a tool_use input (file_path, path, notebook_path, cwd,
// the Glob pattern, drive paths inside a Bash or PowerShell command) is attributed to the catalog project whose
// folder is its longest prefix (aliases and Git-Bash /v/... paths included). Edits and writes weigh 3, reads and
// commands 1, searches 0.5. The main transcript and the subagent transcripts (<session>/subagents/agent-*.jsonl)
// of one session are added together.
// Cost: transcripts are tens of MB, so each file is streamed once in chunks, only lines holding a tool_use are
// parsed, and the result per file (size, mtime, scanned-to offset, counts per folder prefix) is cached in memory and in
// .data/session-tags.json. Counts are kept per folder prefix and turned into projects when tags are computed, so a
// new project or alias applies to old sessions without a rescan. A grown file is scanned from where the last scan stopped. Everything runs in the
// background and yields to the event loop between chunks.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { loadCatalog } from './catalog.js';
import { publish } from '../lib/events.js';

const FILE = path.join(DATA_DIR, 'session-tags.json');
const CACHE_VERSION = 2; // v2: counts per normalized folder prefix, not per project (v1 caches are scanned again once)
const KEY_DEPTH = 6; // path segments kept in a count key (drive included)
const KEY_DEPTH_LOW = 3; // a file with more keys than MAX_KEYS keeps only this many segments for new keys
const MAX_KEYS = 2000;
const CHUNK = 4 * 1024 * 1024;
const MAX_LINE = 16 * 1024 * 1024; // a longer line is skipped (it is not a tool call)
const MAX_AGENT_FILES = 3000; // most subagent files read per session
const RECENT_MS = 30 * 60 * 1000; // sessions touched this recently get their subagent folder looked at on every pass
const TICK_MS = 10 * 1000;
const START_DELAY_MS = 1500;
const SAVE_EVERY_MS = 10 * 1000;
const SHARE_MIN = 0.15;
const PATHS_MIN = 20;
const WEIGHT_MIN = 1; // less than this much touched weight (one read) is not enough for any tag
const MAX_TAGS = 3;
const PUBLISH_DELAY_MS = 1500;
const PROGRESS_EVERY_MS = 4000;

const MARK = Buffer.from('"type":"tool_use"');
const EMPTY = Buffer.alloc(0);

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SEARCH_TOOLS = new Set(['Glob', 'Grep']);
const SKIP_TOOLS = new Set(['Agent', 'Task', 'SubagentHandback']);
const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'cwd'];

const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s"'`<>|;&()*?]*/g;
const GIT_PATH_RE = /(?<![\w.:/\\])\/([A-Za-z])\/[^\s"'`<>|;&()*?]+/g; // /d/dev/x as written by Git Bash

// ---- State ----

const fileState = new Map(); // relative path (forward slashes) -> { s: size, m: mtimeMs, c: scanned-to offset, k: { folder prefix: [weight, paths] } }
const sessions = new Map(); // session id -> { rel, agents: [rel], mainM, listed, ready, auto, shares }
let projectsDir = '';
let listFiles = null;
let running = false;
let started = false;
let dirty = false;
let lastSave = 0;
let loaded = false;
let lastPass = { ms: 0, sessions: 0, at: 0, scannedBytes: 0 };
let pendingIds = new Set();
let publishTimer = null;

// ---- Cache file ----

function loadCache() {
  if (loaded) return;
  loaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
    if (!j || j.v !== CACHE_VERSION || !j.files || typeof j.files !== 'object') return;
    for (const [rel, st] of Object.entries(j.files)) {
      if (st && Number.isFinite(st.s) && Number.isFinite(st.m) && Number.isFinite(st.c) && st.k && typeof st.k === 'object') fileState.set(rel, st);
    }
  } catch {
    // no cache yet, or unreadable: everything is scanned again
  }
}

function saveCache() {
  dirty = false;
  lastSave = Date.now();
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const files = {};
    for (const [rel, st] of fileState) files[rel] = st;
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, files }));
    fs.renameSync(tmp, FILE);
  } catch {
    // best effort: the next pass tries again
    dirty = true;
  }
}

// ---- Paths to projects ----

function projectMap() {
  const map = new Map(); // normalized folder -> project id
  for (const p of loadCatalog()) {
    if (!p || !p.id || !p.folder) continue;
    const add = (f) => {
      const n = normPath(f);
      if (n && !map.has(n)) map.set(n, p.id);
    };
    add(p.folder);
    for (const a of Array.isArray(p.aliases) ? p.aliases : []) if (typeof a === 'string' && a) add(a);
  }
  return map;
}

// Lower case, one backslash as separator, no trailing separator, /v/x turned into v:\x. Empty when not absolute.
function normPath(p) {
  let s = String(p || '');
  if (/^\/[A-Za-z]\//.test(s)) s = s[1] + ':' + s.slice(2);
  else if (!/^[A-Za-z]:[\\/]/.test(s)) return '';
  return s.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

// Longest-prefix match on a separator boundary: walks up from the full path.
function projectOf(p, map) {
  let s = normPath(p);
  if (!s) return null;
  for (;;) {
    const id = map.get(s);
    if (id) return id;
    const cut = s.lastIndexOf('\\');
    if (cut < 3) return null; // down to the drive
    s = s.slice(0, cut);
  }
}

// ---- Reading tool calls ----

// Counts one path under its folder prefix (the first KEY_DEPTH segments of the normalized path).
function addPath(acc, p, w) {
  const n = normPath(p);
  if (!n) return;
  const segs = n.split('\\');
  if (segs.length < 2) return; // a bare drive
  let key = segs.slice(0, KEY_DEPTH).join('\\');
  let e = acc[key];
  if (!e && Object.keys(acc).length >= MAX_KEYS) {
    key = segs.slice(0, KEY_DEPTH_LOW).join('\\');
    e = acc[key];
  }
  if (!e) e = acc[key] = [0, 0];
  e[0] += w;
  e[1] += 1;
}

function commandPaths(cmd) {
  const found = new Set();
  for (const m of cmd.matchAll(WIN_PATH_RE)) found.add(m[0]);
  for (const g of cmd.matchAll(GIT_PATH_RE)) found.add(g[1].toUpperCase() + ':' + g[0].slice(2));
  return found;
}

function countCall(name, input, acc) {
  if (SKIP_TOOLS.has(name) || !input || typeof input !== 'object') return;
  const w = WRITE_TOOLS.has(name) ? 3 : SEARCH_TOOLS.has(name) ? 0.5 : 1;
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v !== 'string' || !v) continue;
    addPath(acc, v, w);
  }
  if (name === 'Glob' && typeof input.pattern === 'string') addPath(acc, input.pattern, w);
  if (typeof input.command === 'string' && input.command) {
    for (const p of commandPaths(input.command)) {
      addPath(acc, p, w);
    }
  }
}

function handleLine(line, acc) {
  if (line.charCodeAt(0) !== 123) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return; // half-written or damaged line
  }
  const content = o && o.message && o.message.content;
  if (!Array.isArray(content)) return;
  for (const b of content) if (b && b.type === 'tool_use' && typeof b.name === 'string') countCall(b.name, b.input, acc);
}

function processBlock(block, acc) {
  let p = block.indexOf(MARK);
  while (p >= 0) {
    const ls = block.lastIndexOf(10, p) + 1;
    let le = block.indexOf(10, p);
    if (le < 0) le = block.length;
    if (le - ls <= MAX_LINE) handleLine(block.toString('utf8', ls, le), acc);
    p = le + 1 < block.length ? block.indexOf(MARK, le + 1) : -1;
  }
}

const yieldLoop = () => new Promise((r) => setImmediate(r));

// Streams bytes [from, to) of a file and adds the paths of its tool calls to acc. Returns the offset up to which
// whole lines were read (the next scan starts there).
async function scanRange(file, from, to, acc) {
  const fh = await fs.promises.open(file, 'r');
  try {
    let pos = from;
    let carry = EMPTY;
    let carryStart = from;
    let consumed = from;
    let skipping = false; // inside a line longer than MAX_LINE
    while (pos < to) {
      const len = Math.min(CHUNK, to - pos);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead);
      let data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let dataStart = carry.length ? carryStart : pos;
      pos += bytesRead;
      if (skipping) {
        const nl = data.indexOf(10);
        if (nl < 0) {
          carry = EMPTY;
          carryStart = pos;
          await yieldLoop();
          continue;
        }
        data = data.subarray(nl + 1);
        dataStart += nl + 1;
        skipping = false;
      }
      const lastNl = data.lastIndexOf(10);
      if (lastNl >= 0) {
        processBlock(data.subarray(0, lastNl + 1), acc);
        consumed = dataStart + lastNl + 1;
        carry = data.subarray(lastNl + 1);
        carryStart = consumed;
      } else {
        carry = data;
        carryStart = dataStart;
      }
      if (carry.length > MAX_LINE) {
        carry = EMPTY;
        carryStart = pos;
        skipping = true;
      }
      await yieldLoop();
    }
    return consumed;
  } finally {
    await fh.close();
  }
}

// ---- One file, cached ----

// Brings the cached counts of one transcript up to date. Returns the bytes scanned (0 when nothing was needed).
// The first bytes of a file, as a fingerprint of which transcript it is. null when unreadable.
async function headOf(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const b = Buffer.alloc(128);
    const { bytesRead } = await fh.read(b, 0, 128, 0);
    return b.toString('base64', 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function syncFile(rel, file, size, mtimeMs) {
  const st = fileState.get(rel);
  if (st && st.s === size && st.m === mtimeMs) return 0;
  let from = 0;
  let acc = {};
  // Only a file that only grew is continued: a shorter file, or one whose first bytes changed, was replaced.
  const head = await headOf(file);
  if (head === null) return 0;
  if (st && size >= st.c && st.h === head) {
    from = st.c;
    for (const [id, v] of Object.entries(st.k)) acc[id] = [v[0], v[1]];
  }
  let consumed;
  try {
    consumed = await scanRange(file, from, size, acc);
  } catch {
    return 0; // unreadable or vanished: try again next pass
  }
  fileState.set(rel, { s: size, m: mtimeMs, c: consumed, h: head, k: acc });
  dirty = true;
  return size - from;
}

const relOf = (file) => path.relative(projectsDir, file).split(path.sep).join('/');

function listAgents(e) {
  const dir = path.join(path.dirname(e.file), e.id, 'subagents');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl') || !n.startsWith('agent-')) continue;
    if (out.length >= MAX_AGENT_FILES) break;
    const file = path.join(dir, n);
    try {
      const s = fs.statSync(file);
      if (s.isFile()) out.push({ rel: relOf(file), file, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // vanished
    }
  }
  return out;
}

// ---- Counts to tags ----

function compute(rels, map) {
  const total = {};
  const cache = new Map();
  for (const rel of rels) {
    const st = fileState.get(rel);
    if (!st) continue;
    for (const [key, v] of Object.entries(st.k)) {
      let id = cache.get(key);
      if (id === undefined) {
        id = projectOf(key, map);
        cache.set(key, id);
      }
      if (!id) continue;
      const t = total[id] || (total[id] = [0, 0]);
      t[0] += v[0];
      t[1] += v[1];
    }
  }
  let sum = 0;
  for (const v of Object.values(total)) sum += v[0];
  const shares = {};
  const list = [];
  for (const [id, v] of Object.entries(total)) {
    const share = sum > 0 ? Math.round((v[0] / sum) * 1000) / 1000 : 0;
    shares[id] = share;
    if (v[0] >= WEIGHT_MIN && (share >= SHARE_MIN || v[1] >= PATHS_MIN)) list.push({ projectId: id, share, n: v[1] });
  }
  list.sort((a, b) => b.share - a.share || b.n - a.n || a.projectId.localeCompare(b.projectId));
  const auto = list.slice(0, MAX_TAGS).map((t) => ({ projectId: t.projectId, source: 'auto', share: t.share }));
  return { auto, shares };
}

function noteChange(id) {
  pendingIds.add(id);
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    const ids = [...pendingIds];
    pendingIds = new Set();
    publish('sessions.changed', { id: ids.length === 1 ? ids[0] : undefined, ids: ids.slice(0, 100), tags: true });
  }, PUBLISH_DELAY_MS);
  publishTimer.unref();
}

async function syncSession(e, map, mapSig, now) {
  const rel = relOf(e.file);
  let rec = sessions.get(e.id);
  if (!rec) {
    rec = { rel, agents: [], mainM: null, sig: '', listed: false, ready: false, auto: [], shares: {} };
    sessions.set(e.id, rec);
  }
  let bytes = await syncFile(rel, e.file, e.size, e.mtimeMs);
  const relist = !rec.listed || rec.mainM !== e.mtimeMs || now - e.mtimeMs < RECENT_MS;
  if (relist) {
    const agents = listAgents(e);
    rec.agents = agents.map((a) => a.rel);
    for (const a of agents) bytes += await syncFile(a.rel, a.file, a.size, a.mtimeMs);
    rec.listed = true;
  }
  rec.mainM = e.mtimeMs;
  if (!rec.ready || bytes > 0 || rec.sig !== mapSig) {
    const was = rec.auto.map((t) => t.projectId).join(',');
    const c = compute([rel, ...rec.agents], map);
    const first = !rec.ready;
    rec.auto = c.auto;
    rec.shares = c.shares;
    rec.ready = true;
    rec.sig = mapSig;
    // The first result of a session is not a change: the list showed no tags and a pending flag until now,
    // and the first pass would otherwise announce every session.
    if (!first && was !== c.auto.map((t) => t.projectId).join(',')) noteChange(e.id);
  }
  return bytes;
}

// One pass over all sessions, newest first. Concurrent calls share nothing: a second call returns at once.
export async function runPass() {
  if (running || !listFiles) return lastPass;
  running = true;
  const t0 = Date.now();
  let bytes = 0;
  let count = 0;
  try {
    loadCache();
    const entries = await listFiles();
    const map = projectMap();
    const mapSig = [...map].map(([k, v]) => `${k}=${v}`).sort().join('|');
    const seen = new Set();
    const firstPass = lastPass.at === 0;
    let lastProgress = Date.now();
    for (const e of entries) {
      seen.add(relOf(e.file));
      try {
        bytes += await syncSession(e, map, mapSig, Date.now());
      } catch {
        // one unreadable session must not stop the others
      }
      count++;
      if (dirty && Date.now() - lastSave > SAVE_EVERY_MS) saveCache();
      // A long first pass shows its progress: the list replaces "pending" with tags as they come in.
      if (firstPass && Date.now() - lastProgress > PROGRESS_EVERY_MS) {
        lastProgress = Date.now();
        publish('sessions.changed', { tags: true });
      }
    }
    // Forget sessions that were deleted, and the cached counts of their files.
    const live = new Set(entries.map((e) => e.id));
    for (const id of [...sessions.keys()]) if (!live.has(id)) sessions.delete(id);
    const keep = new Set();
    for (const rec of sessions.values()) {
      keep.add(rec.rel);
      for (const a of rec.agents) keep.add(a);
    }
    for (const rel of [...fileState.keys()]) {
      if (!keep.has(rel)) {
        fileState.delete(rel);
        dirty = true;
      }
    }
    if (dirty) saveCache();
    lastPass = { ms: Date.now() - t0, sessions: count, at: Date.now(), scannedBytes: bytes };
    if (firstPass) console.log(`[tags] first pass: ${count} sessions, ${(bytes / 1048576).toFixed(0)} MB scanned, ${lastPass.ms} ms`);
    if (firstPass && count) publish('sessions.changed', { tags: true });
  } finally {
    running = false;
  }
  return lastPass;
}

// ---- Public API ----

// opts.listFiles: async () => [{ id, file, size, mtimeMs }] (the session transcripts, newest first)
// opts.projectsDir: the folder those files live under (cache keys are relative to it)
export function startTagScanner(opts) {
  listFiles = opts.listFiles;
  projectsDir = opts.projectsDir;
  if (started) return;
  started = true;
  const first = setTimeout(() => {
    runPass().catch(() => {});
    const iv = setInterval(() => runPass().catch(() => {}), TICK_MS);
    iv.unref();
  }, START_DELAY_MS);
  first.unref();
}

// What the scanner knows about one session: { ready, auto: [tag], shares: { projectId: share } }.
export function autoTagsOf(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec || !rec.ready) return { ready: false, auto: [], shares: {} };
  return { ready: true, auto: rec.auto, shares: rec.shares };
}

export function tagStatus() {
  let ready = 0;
  for (const r of sessions.values()) if (r.ready) ready++;
  return { sessions: sessions.size, ready, running, lastPass, files: fileState.size };
}
