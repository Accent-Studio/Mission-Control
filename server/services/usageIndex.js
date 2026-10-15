// Hourly token usage per Claude Code session, for the Usage page.
// Every transcript (<projects>/<dir>/<uuid>.jsonl) and every subagent transcript below <uuid>/subagents (agent-*.jsonl,
// also inside workflow folders) is read once, incrementally: a file that only grew is continued from the byte offset of its
// last complete line, so a pass over unchanged files is a handful of stat calls.
// Cost: transcripts add up to GBs, so nothing is JSON.parsed unless it has to be. Only assistant lines are parsed (they
// carry the usage block). User lines and all other lines are read with byte markers: the timestamp, and for a user line
// whether it is a typed prompt. Reading is chunked, whole lines only, and yields to the event loop after every chunk and file.
// The result per file (offset, hourly totals, the last message ids counted) is kept in memory and in .data/usage-index.json.
// It is kept per file, so one file can be dropped and read again alone. A deleted transcript keeps its data (usage history
// must survive a deleted conversation), it is only marked gone.
// One API response is written as several lines (one per content block) that repeat the message id and the usage. Each
// message id is counted once, and when a later line of the same id has bigger numbers only the increase is added.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME, DATA_DIR } from '../config.js';

// MC_CLAUDE_HOME points the scan at another folder (used by tests, so nothing real is touched).
const HOME = process.env.MC_CLAUDE_HOME ? path.resolve(process.env.MC_CLAUDE_HOME) : CLAUDE_HOME;
const PROJECTS_DIR = path.join(HOME, 'projects');
const FILE = path.join(DATA_DIR, 'usage-index.json');
const VERSION = 2; // a different version in the file means everything is read again (2: prompts the user did not type left out)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 2 * 1024 * 1024;
const MAX_LINE = 48 * 1024 * 1024; // a longer line is skipped (a typed prompt can carry up to 30MB of pasted files)
const MAX_PARSE = 16 * 1024 * 1024; // an assistant line longer than this is not parsed (it counts for active time only)
const MAX_SUB_DEPTH = 4; // folders below <uuid>/subagents that are searched for agent files
const GAP_MS = 5 * 60 * 1000; // a longer pause between two lines is not active time
const HOUR_MS = 3600 * 1000;
const RECENT_MAX = 64; // message ids remembered per file
const USER_TYPE_WITHIN = 700; // "type":"user" sits in the first bytes of a user line, a later match is a nested one
const CONTENT_STRING_WITHIN = 700;
const START_DELAY_MS = 5000;
const TICK_MS = 2 * 60 * 1000;
const SAVE_EVERY_MS = 10 * 1000;

const M_TS = Buffer.from('"timestamp":"');
const M_ASSISTANT = Buffer.from('"type":"assistant"');
const M_USER = Buffer.from('"type":"user"');
const M_TOOL_RESULT_USE = Buffer.from('"toolUseResult"');
const M_TOOL_RESULT = Buffer.from('"type":"tool_result"');
const M_META = Buffer.from('"isMeta":true');
const M_CONTENT_STRING = Buffer.from('"content":"');
const M_TEXT_BLOCK = Buffer.from('"type":"text"');
const M_CWD = Buffer.from('"cwd":"');
// Not typed by the user, though written as a user line: a finished background task, a helper's report, a compact summary,
// a system message, an interrupt note (see userKinds.js, which sorts the same records for the Talk page).
const M_ORIGIN = Buffer.from('"origin":{"kind":"');
const M_HUMAN = Buffer.from('human"');
const M_COMPACT_SUMMARY = Buffer.from('"isCompactSummary":true');
const M_SYSTEM_SOURCE = Buffer.from('"promptSource":"system"');
const M_TASK_STRING = Buffer.from('"content":"<task-notification>');
const M_INTERRUPT = Buffer.from('[Request interrupted');
const M_LOCAL_OUTPUT = Buffer.from('"content":"<local-command-'); // what a slash command printed ("Compacted")
const M_BASH_OUTPUT = Buffer.from('"content":"<bash-');
const M_IMAGE_BLOCK = Buffer.from('"type":"image"'); // a prompt that is only a picture is still a prompt
// A message the user sent while Claude was answering is not a user line but this attachment (userKinds.js, isQueuedCommand).
const M_QUEUED = Buffer.from('"attachment":{"type":"queued_command"');
const M_QUEUED_TASK = Buffer.from('"prompt":"<task-notification>');
const EMPTY = Buffer.alloc(0);

// ---- State ----

// relative path (forward slashes) -> { sid, sub, dir, cwd, size, off, mtimeMs, lastTs, firstTs, hd, recent, h, gone? }
// h: { hourKey: { a: activeMs, u: prompts, t: toolCalls, m: { model: [req, in, out, cacheRead, cacheWrite5m, cacheWrite1h, ms] } } }
// recent: [[messageId, in, out, cacheRead, cacheWrite5m, cacheWrite1h]] (the tuple already counted for that id)
let files = new Map();
let loaded = false;
let dirty = false;
let lastSave = 0;
let started = false;
let passPromise = null;
let lastPass = { at: 0, ms: 0, bytes: 0 };
let firstPassDone = false;

const yieldLoop = () => new Promise((r) => setImmediate(r));

// ---- State file ----

function loadState() {
  if (loaded) return;
  loaded = true;
  files = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
    if (!j || j.version !== VERSION || !j.files || typeof j.files !== 'object') return;
    for (const [rel, st] of Object.entries(j.files)) {
      if (st && typeof st.sid === 'string' && Number.isFinite(st.off) && Number.isFinite(st.size) && st.h && typeof st.h === 'object') {
        if (!Array.isArray(st.recent)) st.recent = [];
        files.set(rel, st);
      }
    }
  } catch {
    // no state yet, or unreadable: everything is read again
  }
}

// Temp file in the same folder, then rename, so a crash never leaves half a file.
function saveState() {
  dirty = false;
  lastSave = Date.now();
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const obj = {};
    for (const [rel, st] of files) obj[rel] = st;
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, files: obj }));
    fs.renameSync(tmp, FILE);
  } catch {
    // best effort: the next pass tries again
    dirty = true;
  }
}

// ---- Finding the files ----

// The agent transcripts below one session's subagents folder (workflow runs add folders inside it).
function walkAgents(dir, depth, out, failed) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') failed.push(dir);
    return;
  }
  for (const d of names) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (depth < MAX_SUB_DEPTH) walkAgents(full, depth + 1, out, failed);
    } else if (d.name.startsWith('agent-') && d.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

const relOf = (file) => path.relative(PROJECTS_DIR, file).split(path.sep).join('/');

// All transcript files, newest first. `failed` lists folders that could not be read (their files are not marked gone).
async function listTranscripts() {
  const entries = [];
  const failed = [];
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null; // no projects folder right now: nothing is marked gone
  }
  const add = (file, sid, sub, dir) => {
    try {
      const s = fs.statSync(file);
      if (s.isFile()) entries.push({ rel: relOf(file), file, sid, sub, dir, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // vanished
    }
  };
  for (const d of dirs) {
    const dirPath = path.join(PROJECTS_DIR, d.name);
    let names;
    try {
      names = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      failed.push(dirPath);
      continue;
    }
    for (const n of names) {
      if (n.isDirectory()) {
        if (!UUID_RE.test(n.name)) continue;
        const agents = [];
        walkAgents(path.join(dirPath, n.name, 'subagents'), 0, agents, failed);
        for (const f of agents) add(f, n.name.toLowerCase(), true, d.name);
      } else if (n.name.endsWith('.jsonl') && UUID_RE.test(n.name.slice(0, -6))) {
        add(path.join(dirPath, n.name), n.name.slice(0, -6).toLowerCase(), false, d.name);
      }
    }
    await yieldLoop();
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { entries, failed: failed.map(relOf) };
}

// ---- Reading lines ----

// Finds the first occurrence of a marker at or after a position, and remembers it, so asking for the next line does not
// search the block again until the line has moved past the remembered match. Positions only ever move forward.
class Finder {
  constructor(marker) {
    this.marker = marker;
    this.pos = -2;
  }
  reset() {
    this.pos = -2;
  }
  at(block, from) {
    if (this.pos === -2 || (this.pos !== -1 && this.pos < from)) this.pos = block.indexOf(this.marker, from);
    return this.pos;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function hourRec(ctx, ts) {
  const key = String(Math.floor(ts / HOUR_MS));
  if (ctx.lastKey === key) return ctx.lastRec;
  const h = ctx.st.h;
  let rec = h[key];
  if (!rec) rec = h[key] = { a: 0, u: 0, t: 0, m: {} };
  ctx.lastKey = key;
  ctx.lastRec = rec;
  return rec;
}

function modelTuple(rec, model) {
  let t = rec.m[model];
  if (!t) t = rec.m[model] = [0, 0, 0, 0, 0, 0, 0];
  return t;
}

// Active time: the gap to the previous timestamped line of the same file counts when it is at most 5 minutes, and goes to
// the hour of the later line (and to `model` when the later line is an assistant line).
function activity(ctx, ts, model) {
  const st = ctx.st;
  if (!(ts > 0)) return;
  if (!st.firstTs || ts < st.firstTs) st.firstTs = ts;
  if (st.lastTs > 0 && ts > st.lastTs) {
    const gap = ts - st.lastTs;
    if (gap <= GAP_MS) {
      const rec = hourRec(ctx, ts);
      rec.a += gap;
      if (model) modelTuple(rec, model)[6] += gap;
    }
  }
  if (!(ts <= st.lastTs)) st.lastTs = ts;
}

// The token numbers of one usage block as [in, out, cacheRead, cacheWrite5m, cacheWrite1h].
function usageTuple(u) {
  const total = num(u.cache_creation_input_tokens);
  let w5 = total;
  let w1 = 0;
  const cc = u.cache_creation;
  if (cc && typeof cc === 'object') {
    const a = num(cc.ephemeral_5m_input_tokens);
    const b = num(cc.ephemeral_1h_input_tokens);
    if (a + b > 0) {
      w5 = a;
      w1 = b;
    }
  }
  return [num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), w5, w1];
}

function onAssistant(ctx, o) {
  const st = ctx.st;
  const msg = o.message;
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  const model = msg && typeof msg.model === 'string' ? msg.model : '';
  const usage = msg && msg.usage && typeof msg.usage === 'object' ? msg.usage : null;
  const counted = !!model && model !== '<synthetic>' && model !== '__proto__';
  if (!st.cwd && typeof o.cwd === 'string' && o.cwd) st.cwd = o.cwd;
  activity(ctx, ts, counted && usage ? model : '');
  if (!counted || !(ts > 0)) return;
  const rec = hourRec(ctx, ts);
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) if (b && b.type === 'tool_use') rec.t += 1;
  }
  if (!usage) return;
  const cur = usageTuple(usage);
  const id = typeof msg.id === 'string' && msg.id ? msg.id : typeof o.requestId === 'string' ? o.requestId : '';
  const t = modelTuple(rec, model);
  let prev = id ? ctx.recent.get(id) : undefined;
  if (prev) {
    // A later line of a response already counted: only an increase is added.
    ctx.recent.delete(id);
    const next = prev.slice();
    for (let i = 0; i < 5; i++) {
      if (cur[i] > prev[i]) {
        t[i + 1] += cur[i] - prev[i];
        next[i] = cur[i];
      }
    }
    ctx.recent.set(id, next);
    return;
  }
  t[0] += 1;
  for (let i = 0; i < 5; i++) t[i + 1] += cur[i];
  if (id) {
    ctx.recent.set(id, cur);
    if (ctx.recent.size > RECENT_MAX) ctx.recent.delete(ctx.recent.keys().next().value);
  }
}

const inLine = (finder, block, ls, le) => {
  const p = finder.at(block, ls);
  return p >= 0 && p < le ? p : -1;
};

// The line names an origin other than the human (a task notification, a helper's report).
function notHuman(f, block, ls, le) {
  const o = inLine(f.origin, block, ls, le);
  return o >= 0 && !block.subarray(o + M_ORIGIN.length, o + M_ORIGIN.length + M_HUMAN.length).equals(M_HUMAN);
}

// A typed prompt: a user line that is not meta, has no tool result, whose content is a string or holds a text block, and
// that the user wrote (not a notice, a summary or an interrupt note). Decided from byte markers, so a user line (tool
// outputs, pasted images) is never parsed. Text the user typed is escaped in the JSON, so it never matches a marker.
function isPrompt(f, block, ls, le) {
  if (inLine(f.meta, block, ls, le) >= 0) return false;
  if (inLine(f.toolUse, block, ls, le) >= 0) return false;
  if (inLine(f.toolResult, block, ls, le) >= 0) return false;
  if (notHuman(f, block, ls, le) || inLine(f.compact, block, ls, le) >= 0 || inLine(f.sysSource, block, ls, le) >= 0) return false;
  if (inLine(f.taskString, block, ls, le) >= 0 || inLine(f.interrupt, block, ls, le) >= 0) return false;
  if (inLine(f.localOutput, block, ls, le) >= 0 || inLine(f.bashOutput, block, ls, le) >= 0) return false;
  const c = f.contentString.at(block, ls);
  if (c >= 0 && c < le && c - ls < CONTENT_STRING_WITHIN) return true;
  return inLine(f.textBlock, block, ls, le) >= 0 || inLine(f.image, block, ls, le) >= 0;
}

function readCwd(block, p, le) {
  let q = p + M_CWD.length;
  const start = q;
  while (q < le) {
    const c = block[q];
    if (c === 92) q += 2;
    else if (c === 34) break;
    else q++;
  }
  if (q >= le) return '';
  try {
    return JSON.parse('"' + block.toString('utf8', start, q) + '"');
  } catch {
    return '';
  }
}

// Handles every complete line of one block of bytes.
function processBlock(ctx, block) {
  const st = ctx.st;
  const f = ctx.finders;
  for (const k of Object.keys(f)) f[k].reset();
  let ls = 0;
  while (ls < block.length) {
    const le = block.indexOf(10, ls);
    if (le < 0) break;
    const lineStart = ls;
    ls = le + 1;
    if (le - lineStart < 2) continue;

    const up = f.user.at(block, lineStart);
    const isUser = up >= 0 && up < le && up - lineStart < USER_TYPE_WITHIN;
    if (!isUser) {
      const ap = f.assistant.at(block, lineStart);
      if (ap >= 0 && ap < le && le - lineStart <= MAX_PARSE) {
        let o = null;
        try {
          o = JSON.parse(block.toString('utf8', lineStart, le));
        } catch {
          // damaged line: falls through to the timestamp marker
        }
        if (o && o.type === 'assistant') {
          onAssistant(ctx, o);
          continue;
        }
      }
    }

    const tp = f.ts.at(block, lineStart);
    const ts = tp >= 0 && tp < le ? Date.parse(block.latin1Slice(tp + M_TS.length, tp + M_TS.length + 24)) : NaN;
    activity(ctx, ts, '');
    const queued = !isUser && (() => {
      const q = inLine(f.queued, block, lineStart, le);
      return q >= 0 && q - lineStart < USER_TYPE_WITHIN && !notHuman(f, block, lineStart, le) && inLine(f.queuedTask, block, lineStart, le) < 0;
    })();
    if ((isUser && isPrompt(f, block, lineStart, le)) || queued) {
      const when = ts > 0 ? ts : st.lastTs;
      // Prompts of a subagent are written by Claude, not typed: only the main thread counts them.
      if (when > 0 && !st.sub) hourRec(ctx, when).u += 1;
      if (!st.cwd) {
        const cp = f.cwd.at(block, lineStart);
        if (cp >= 0 && cp < le) st.cwd = readCwd(block, cp, le);
      }
    }
  }
}

function newContext(st) {
  return {
    st,
    recent: new Map(st.recent.map((r) => [r[0], r.slice(1)])),
    lastKey: '',
    lastRec: null,
    finders: {
      ts: new Finder(M_TS),
      assistant: new Finder(M_ASSISTANT),
      user: new Finder(M_USER),
      toolUse: new Finder(M_TOOL_RESULT_USE),
      toolResult: new Finder(M_TOOL_RESULT),
      meta: new Finder(M_META),
      contentString: new Finder(M_CONTENT_STRING),
      textBlock: new Finder(M_TEXT_BLOCK),
      cwd: new Finder(M_CWD),
      origin: new Finder(M_ORIGIN),
      compact: new Finder(M_COMPACT_SUMMARY),
      sysSource: new Finder(M_SYSTEM_SOURCE),
      taskString: new Finder(M_TASK_STRING),
      interrupt: new Finder(M_INTERRUPT),
      localOutput: new Finder(M_LOCAL_OUTPUT),
      bashOutput: new Finder(M_BASH_OUTPUT),
      image: new Finder(M_IMAGE_BLOCK),
      queued: new Finder(M_QUEUED),
      queuedTask: new Finder(M_QUEUED_TASK),
    },
  };
}

function storeRecent(ctx) {
  const out = [];
  for (const [id, t] of ctx.recent) out.push([id, ...t]);
  ctx.st.recent = out;
}

// ---- One file ----

function blankState(e) {
  return { sid: e.sid, sub: e.sub, dir: e.dir, cwd: '', size: 0, off: 0, mtimeMs: 0, lastTs: 0, firstTs: 0, hd: '', recent: [], h: {} };
}

function wipe(st) {
  st.cwd = '';
  st.off = 0;
  st.size = 0;
  st.lastTs = 0;
  st.firstTs = 0;
  st.recent = [];
  st.h = {};
}

// Streams the bytes from st.off to `size` and counts every complete line. st.off follows the data after every block, so a
// save in the middle of a long file is consistent. Returns the bytes read.
async function readFrom(e, st, size) {
  const fh = await fs.promises.open(e.file, 'r');
  let read = 0;
  try {
    const hb = Buffer.alloc(128);
    const { bytesRead } = await fh.read(hb, 0, 128, 0);
    const hd = hb.toString('base64', 0, bytesRead);
    // The first bytes say which transcript it is: a different start means the file was replaced.
    if (st.off > 0 && st.hd !== hd) wipe(st);
    st.hd = hd;
    if (size < st.off) wipe(st);

    const ctx = newContext(st);
    let pos = st.off;
    let carry = EMPTY;
    let carryStart = pos;
    let skipping = false; // inside a line longer than MAX_LINE
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(len);
      const r = await fh.read(buf, 0, len, pos);
      if (!r.bytesRead) break;
      read += r.bytesRead;
      const chunk = buf.subarray(0, r.bytesRead);
      let data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let dataStart = carry.length ? carryStart : pos;
      pos += r.bytesRead;
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
        st.off = dataStart;
      }
      const lastNl = data.lastIndexOf(10);
      if (lastNl >= 0) {
        processBlock(ctx, data.subarray(0, lastNl + 1));
        st.off = dataStart + lastNl + 1;
        storeRecent(ctx);
        dirty = true;
        carry = data.subarray(lastNl + 1);
        carryStart = st.off;
      } else {
        carry = data;
        carryStart = dataStart;
      }
      if (carry.length > MAX_LINE) {
        carry = EMPTY;
        carryStart = pos;
        skipping = true;
      }
      if (dirty && Date.now() - lastSave > SAVE_EVERY_MS) saveState();
      await yieldLoop();
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return read;
}

async function syncFile(e) {
  let st = files.get(e.rel);
  if (!st) {
    st = blankState(e);
    files.set(e.rel, st);
    dirty = true;
  }
  if (st.gone) {
    delete st.gone;
    dirty = true;
  }
  if (st.size === e.size && st.mtimeMs === e.mtimeMs) return 0;
  // A file that got shorter was replaced: its data is dropped and it is read again from the start.
  if (e.size < st.size || e.size < st.off) {
    wipe(st);
    dirty = true;
  }
  let read = 0;
  try {
    read = await readFrom(e, st, e.size);
  } catch {
    return 0; // unreadable or vanished: tried again next pass
  }
  st.size = e.size;
  st.mtimeMs = e.mtimeMs;
  st.dir = e.dir;
  dirty = true;
  return read;
}

// ---- Passes ----

async function pass() {
  const t0 = Date.now();
  let bytes = 0;
  loadState();
  const listing = await listTranscripts();
  if (listing) {
    const seen = new Set();
    for (const e of listing.entries) {
      seen.add(e.rel);
      try {
        bytes += await syncFile(e);
      } catch {
        // one unreadable file must not stop the others
      }
      if (dirty && Date.now() - lastSave > SAVE_EVERY_MS) saveState();
      await yieldLoop();
    }
    // A transcript that is gone keeps its numbers. Files below a folder that could not be read are not judged.
    for (const [rel, st] of files) {
      if (seen.has(rel) || st.gone) continue;
      if (listing.failed.some((p) => rel.startsWith(p + '/'))) continue;
      st.gone = true;
      dirty = true;
    }
  }
  if (dirty) saveState();
  lastPass = { at: Date.now(), ms: Date.now() - t0, bytes };
  firstPassDone = true;
}

// ---- Public API ----

// One pass now. Resolves when it is done. A pass already running is not started twice: the caller waits for that one.
export function runUsagePass() {
  if (passPromise) return passPromise;
  passPromise = pass()
    .catch(() => {})
    .finally(() => {
      passPromise = null;
    });
  return passPromise;
}

// The first pass after 5 seconds, then one every 2 minutes. The timers do not keep the process alive.
export function startUsageIndex() {
  if (started) return;
  started = true;
  const first = setTimeout(() => {
    runUsagePass();
    const iv = setInterval(() => runUsagePass(), TICK_MS);
    iv.unref();
  }, START_DELAY_MS);
  first.unref();
}

// Totals merged per session id. `m` holds the models of the main thread, `sm` those of the subagent files (same tuple
// [requests, input, output, cacheRead, cacheWrite5m, cacheWrite1h, ms]); a, u and t are summed over both.
export function usageSessions() {
  loadState();
  const out = {};
  const addModels = (dst, src) => {
    for (const [model, t] of Object.entries(src)) {
      const d = dst[model] || (dst[model] = [0, 0, 0, 0, 0, 0, 0]);
      for (let i = 0; i < 7; i++) d[i] += t[i] || 0;
    }
  };
  for (const st of files.values()) {
    let s = out[st.sid];
    if (!s) s = out[st.sid] = { dir: st.dir, cwd: '', first: 0, last: 0, h: {} };
    if (!st.sub) {
      s.dir = st.dir;
      if (st.cwd) s.cwd = st.cwd;
    } else {
      if (!s.dir) s.dir = st.dir;
      if (!s.cwd && st.cwd) s.cwd = st.cwd;
    }
    if (st.firstTs && (!s.first || st.firstTs < s.first)) s.first = st.firstTs;
    if (st.lastTs > s.last) s.last = st.lastTs;
    for (const [key, r] of Object.entries(st.h)) {
      const d = s.h[key] || (s.h[key] = { a: 0, u: 0, t: 0, m: {}, sm: {} });
      d.a += r.a || 0;
      d.u += r.u || 0;
      d.t += r.t || 0;
      addModels(st.sub ? d.sm : d.m, r.m || {});
    }
  }
  return out;
}

export function usageIndexStatus() {
  loadState();
  const sids = new Set();
  for (const st of files.values()) sids.add(st.sid);
  return { files: files.size, sessions: sids.size, running: !!passPromise, lastPass: { ...lastPass }, firstPassDone };
}

// Tests only: drops what is in memory, so the next call loads usage-index.json again.
export function _resetForTests() {
  files = new Map();
  loaded = false;
  dirty = false;
  lastSave = 0;
  lastPass = { at: 0, ms: 0, bytes: 0 };
  firstPassDone = false;
}
