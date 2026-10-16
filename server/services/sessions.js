// Claude Code session transcripts: ~/.claude/projects/<dir>/<uuid>.jsonl
// Files can be tens of MB, so listing only reads the head and the tail of each file, plus (for titles)
// one cached streaming scan that looks for the title records.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME, DATA_DIR } from '../config.js';
import { cached, invalidate } from '../lib/cache.js';
import { run } from '../lib/run.js';
import { publish } from '../lib/events.js';
import { loadCatalog } from './catalog.js';
import { getAllMeta, getMeta, setMeta, setOrder, removeMeta } from './sessionMeta.js';
import { startTagScanner, autoTagsOf, runPass as runTagPass } from './tags.js';
import { cacheImage, lazyImage, sniff, SERVABLE_EXT } from './uploads.js';
import { classifyUserEntry, collapse, isQueuedCommand, NOTICE_TEXT_MAX } from './userKinds.js';
import { desktopInfo, desktopInfoNow, elsewhereOf } from './elsewhere.js';

// MC_CLAUDE_HOME points the scan at another folder (used by tests, so nothing real is touched).
const HOME = process.env.MC_CLAUDE_HOME ? path.resolve(process.env.MC_CLAUDE_HOME) : CLAUDE_HOME;
const PROJECTS_DIR = path.join(HOME, 'projects');
const CATALOG_DIR = path.join(HOME, 'cache', 'model-catalog');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 64 * 1024;
const HEAD_BYTES_RETRY = 512 * 1024;
const TAIL_BYTES = 64 * 1024;
const TITLE_SCAN_CAP = 50 * 1024 * 1024; // never stream more than this much of one file for titles
const TITLE_SCAN_CHUNK = 4 * 1024 * 1024;
const MAX_LINE = 8 * 1024 * 1024;
const HEAD_LINE_MAX = 48 * 1024 * 1024; // a first message can carry up to 30MB of files, base64 in the transcript
const TITLE_MAX = 120;
const MESSAGE_TEXT_MAX = 100000; // same as the page's CAP_OPEN: the page folds a long message itself
const CUSTOM_MARK = Buffer.from('"custom-title"');
const AI_MARK = Buffer.from('"ai-title"');

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// ---- File scan ----

function scanFiles() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(PROJECTS_DIR, d.name));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl') || !isUuid(f.slice(0, -6))) continue;
      const full = path.join(PROJECTS_DIR, d.name, f);
      try {
        const st = fs.statSync(full);
        out.push({ id: f.slice(0, -6), dir: d.name, file: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // file vanished, ignore
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function files() {
  return cached('sessions:scan', 3000, async () => scanFiles());
}

async function findEntry(id) {
  if (!isUuid(id)) return null;
  const find = (list) => list.find((e) => e.id.toLowerCase() === id.toLowerCase()) || null;
  const hit = find(await files());
  if (hit) return hit;
  invalidate('sessions:scan'); // a session created a moment ago may not be in the cached scan yet
  return find(await files());
}

// Size in bytes of a conversation's transcript right now, read straight from the disk (not from the scan cache):
// 0 when the conversation has no file yet (it is brand new), null when the id is unusable or the file cannot be read.
// Mission Control notes it when a turn begins, so the part of the transcript that belongs to the turn is known exactly.
const transcriptFiles = new Map(); // session id (lowercase) -> transcript path
export function transcriptSize(id) {
  if (!isUuid(id)) return null;
  const key = id.toLowerCase();
  let file = transcriptFiles.get(key);
  if (!file || !fs.existsSync(file)) {
    file = null;
    try {
      for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const f = path.join(PROJECTS_DIR, d.name, key + '.jsonl');
        if (fs.existsSync(f)) {
          file = f;
          break;
        }
      }
    } catch {
      return 0; // no projects folder yet: nothing has been written
    }
    if (!file) return 0;
    if (transcriptFiles.size >= 500) transcriptFiles.delete(transcriptFiles.keys().next().value);
    transcriptFiles.set(key, file);
  }
  // The CLI may be appending to the file this very moment, and Windows can refuse a stat for an instant: ask again.
  for (let i = 0; i < 3; i++) {
    try {
      return fs.statSync(file).size;
    } catch {
      // try again
    }
  }
  return null;
}

function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseLine(line) {
  if (!line || line[0] !== '{') return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Calls onLine(line, offset) for the complete lines of a file from the last one backwards, reading growing
// windows from `endAt` (first `startBytes`, then twice as much, up to `capBytes` in total). `offset` is the
// byte position of the line start. Stops as soon as onLine returns true.
// Returns 'stopped' (onLine asked to stop), 'head' (every line down to the first one was visited) or
// 'floor' (the byte cap was reached first, older lines were not visited).
function walkBackwards(entry, startBytes, capBytes, onLine, endAt = entry.size) {
  const fd = fs.openSync(entry.file, 'r');
  try {
    const floor = Math.max(0, endAt - capBytes);
    let end = endAt;
    let chunk = startBytes;
    let carry = Buffer.alloc(0); // the cut-off first line of the window above, waiting for its beginning
    while (end > floor) {
      const start = Math.max(floor, end - chunk);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const data = carry.length ? Buffer.concat([buf, carry]) : buf;
      let body = data;
      let bodyOff = start;
      carry = Buffer.alloc(0);
      if (start > 0) {
        const nl = data.indexOf(10);
        if (nl < 0) {
          if (data.length > capBytes) break;
          carry = data; // one line longer than the window: grow the window
          end = start;
          chunk *= 2;
          continue;
        }
        if (start > floor) carry = data.subarray(0, nl);
        body = data.subarray(nl + 1);
        bodyOff = start + nl + 1;
      }
      let pos = body.length;
      while (pos > 0) {
        const nl = body.lastIndexOf(10, pos - 1);
        const s = nl + 1;
        if (pos > s) {
          if (onLine(body.toString('utf8', s, pos), bodyOff + s)) return 'stopped';
        }
        pos = nl < 0 ? 0 : nl;
      }
      end = start;
      chunk *= 2;
    }
    return floor === 0 ? 'head' : 'floor';
  } finally {
    fs.closeSync(fd);
  }
}

// ---- Text extraction ----

// Readable one-line title: no wrapper tags, no simple markdown.
function cleanTitle(raw) {
  let t = String(raw || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
  t = t.replace(/<\/?[a-z][a-z0-9_-]*(?:\s[^<>]*)?>/gi, ' ');
  t = t.replace(/\*\*|__|`/g, '');
  t = collapse(t).replace(/^#+\s*/, '');
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX - 3).trimEnd() + '...';
  return t;
}

// (cleanUserText, userTextOf and the sorting of user-side records live in userKinds.js)

function assistantTextOf(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const b of c) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim());
    else if (b.type === 'tool_use') parts.push(`[tool: ${String(b.name || 'unknown')}]`);
  }
  return parts.join('\n');
}

// ---- Title records (custom-title, ai-title) ----
// The CLI appends these again and again, so the last occurrence in a file is the current one.
// A found-but-empty title is kept as '' (it overrides older ones), "not found" is null.

function titleOf(o, field) {
  return typeof o[field] === 'string' ? o[field] : null;
}

// Last record in the buffer that holds `mark` and parses as the wanted type.
function lastTitleRecord(buf, mark, type, field) {
  let p = buf.lastIndexOf(mark);
  while (p >= 0) {
    const ls = buf.lastIndexOf(10, p) + 1;
    let le = buf.indexOf(10, p);
    if (le < 0) le = buf.length;
    if (le - ls < MAX_LINE) {
      const o = parseLine(buf.toString('utf8', ls, le));
      if (o && o.type === type) {
        const t = titleOf(o, field);
        if (t !== null) return t;
      }
    }
    if (ls === 0) break;
    p = buf.lastIndexOf(mark, ls - 1);
  }
  return null;
}

// Streams the byte range [from, to) in chunks and returns the last custom and ai title in it, plus
// the offset up to which whole lines were read (the next incremental scan starts there).
async function streamTitles(file, from, to) {
  const out = { custom: null, ai: null, consumedTo: from };
  const fh = await fs.promises.open(file, 'r');
  try {
    let pos = from;
    let carry = Buffer.alloc(0); // the unfinished last line of the previous chunk
    while (pos < to) {
      const len = Math.min(TITLE_SCAN_CHUNK, to - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (!bytesRead) break;
      const base = pos - carry.length; // file offset of data[0]
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const nl = data.lastIndexOf(10);
      const last = pos >= to;
      // On the last chunk a final line without a newline is read too (it may be a title still being written).
      const upto = last ? data.length : nl + 1;
      if (upto > 0) {
        const part = data.subarray(0, upto);
        const c = lastTitleRecord(part, CUSTOM_MARK, 'custom-title', 'customTitle');
        const a = lastTitleRecord(part, AI_MARK, 'ai-title', 'aiTitle');
        if (c !== null) out.custom = c;
        if (a !== null) out.ai = a;
      }
      if (last) {
        // The next scan starts at the beginning of a line that had no newline yet, and reads it again whole.
        out.consumedTo = nl >= 0 ? base + nl + 1 : base;
        carry = Buffer.alloc(0);
      } else {
        carry = nl >= 0 ? data.subarray(nl + 1) : data;
        if (carry.length > MAX_LINE) carry = Buffer.alloc(0); // a line this long is not a title record
      }
      await new Promise((r) => setImmediate(r)); // let requests through between chunks
    }
  } finally {
    await fh.close();
  }
  return out;
}

// ---- Per-file metadata (cached by mtime and size) ----

const metaCache = new Map(); // file -> { mtimeMs, size, meta, scan }
const metaInflight = new Map();

function readMeta(entry) {
  const hit = metaCache.get(entry.file);
  if (hit && hit.mtimeMs === entry.mtimeMs && hit.size === entry.size) return Promise.resolve(hit.meta);
  const key = `${entry.file}|${entry.mtimeMs}|${entry.size}`;
  let p = metaInflight.get(key);
  if (p) return p;
  p = buildMeta(entry, hit ? hit.scan : null)
    .then(({ meta, scan }) => {
      metaCache.set(entry.file, { mtimeMs: entry.mtimeMs, size: entry.size, meta, scan });
      return meta;
    })
    .finally(() => metaInflight.delete(key));
  metaInflight.set(key, p);
  return p;
}

// The offset of the first newline at or after start, looking at most cap bytes ahead, else -1.
function nextNewline(file, start, end, cap) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (let pos = start; pos < end && pos < start + cap; ) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
      if (n <= 0) break;
      const i = buf.subarray(0, n).indexOf(10);
      if (i >= 0) return pos + i;
      pos += n;
    }
    return -1;
  } finally {
    fs.closeSync(fd);
  }
}

function scanHead(entry, bytes, meta) {
  let len = Math.min(entry.size, bytes);
  // A first message with pasted pictures can be one line of several MB, and its cwd sits at the end of that line:
  // the line the window cuts is read to its end.
  if (len < entry.size) {
    const nl = nextNewline(entry.file, len - 1, entry.size, HEAD_LINE_MAX);
    if (nl >= 0) len = nl + 1;
  }
  const text = readRange(entry.file, 0, len);
  const lines = text.split('\n');
  if (len < entry.size) lines.pop(); // last line is probably cut off
  for (const line of lines) {
    const o = parseLine(line);
    if (!o) continue;
    if (!meta.cwd && typeof o.cwd === 'string') meta.cwd = o.cwd;
    if (!meta.startedAt && typeof o.timestamp === 'string') meta.startedAt = o.timestamp;
    if (!meta.firstEp && typeof o.entrypoint === 'string' && typeof o.timestamp === 'string') meta.firstEp = { entrypoint: o.entrypoint, at: o.timestamp };
    if (!meta.branch && typeof o.gitBranch === 'string' && o.gitBranch) meta.branch = o.gitBranch;
    if (!meta.prompt && o.type === 'user' && !o.isSidechain) {
      // Only the human's own words make a title, never a task notification or a helper report.
      const c = classifyUserEntry(o);
      if (c.kind === 'user' && c.text) meta.prompt = c.text;
    }
    if (o.type === 'custom-title' && titleOf(o, 'customTitle') !== null) meta.headCustom = o.customTitle;
    else if (o.type === 'ai-title' && titleOf(o, 'aiTitle') !== null) meta.headAi = o.aiTitle;
  }
}

function lastModelOf(entry) {
  let model = null;
  try {
    walkBackwards(entry, TAIL_BYTES, 1024 * 1024, (line) => {
      if (!line.includes('"type":"assistant"') || line.includes('"isSidechain":true')) return false;
      const o = parseLine(line);
      const m = o && o.type === 'assistant' && o.message && o.message.model;
      if (typeof m === 'string' && m && m !== '<synthetic>') {
        model = m;
        return true;
      }
      return false;
    });
  } catch {
    // unreadable: no model
  }
  return model;
}

async function buildMeta(entry, prevScan) {
  const meta = { cwd: null, startedAt: null, lastAt: null, branch: null, prompt: null, headCustom: null, headAi: null, firstEp: null };
  let lastEp = null;
  let tailCustom = null;
  let tailAi = null;
  let scan = null;
  try {
    scanHead(entry, HEAD_BYTES, meta);
    if (!meta.prompt && entry.size > HEAD_BYTES) scanHead(entry, HEAD_BYTES_RETRY, meta);
    const tailLen = Math.min(entry.size, TAIL_BYTES);
    const tail = readRange(entry.file, entry.size - tailLen, tailLen);
    const lines = tail.split('\n');
    if (tailLen < entry.size) lines.shift(); // first line is probably cut off
    let tailBranch = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = parseLine(lines[i]);
      if (!o) continue;
      if (!meta.lastAt && typeof o.timestamp === 'string') meta.lastAt = o.timestamp;
      if (!lastEp && typeof o.entrypoint === 'string' && typeof o.timestamp === 'string') lastEp = { entrypoint: o.entrypoint, at: o.timestamp };
      if (!tailBranch && typeof o.gitBranch === 'string' && o.gitBranch) tailBranch = o.gitBranch;
      if (tailCustom === null && o.type === 'custom-title') tailCustom = titleOf(o, 'customTitle');
      if (tailAi === null && o.type === 'ai-title') tailAi = titleOf(o, 'aiTitle');
    }
    if (tailBranch) meta.branch = tailBranch;
    // Neither window can see a title record from the middle of a long file, so look through the file
    // (the newest part first-class: capped, and only the new bytes when the file just grew).
    if (tailCustom === null && entry.size > HEAD_BYTES + TAIL_BYTES) {
      const floor = Math.max(0, entry.size - TITLE_SCAN_CAP);
      const grown = prevScan && prevScan.consumedTo <= entry.size && prevScan.consumedTo >= floor;
      const from = grown ? prevScan.consumedTo : floor;
      const r = await streamTitles(entry.file, from, entry.size);
      scan = {
        consumedTo: r.consumedTo,
        custom: r.custom !== null ? r.custom : grown ? prevScan.custom : null,
        ai: r.ai !== null ? r.ai : grown ? prevScan.ai : null,
      };
    }
  } catch {
    // unreadable file: fall through with what we have
  }
  const pick = (a, b, c) => (a !== null && a !== undefined ? a : b !== null && b !== undefined ? b : c !== undefined ? c : null);
  const custom = cleanTitle(pick(tailCustom, scan && scan.custom, meta.headCustom));
  const ai = cleanTitle(pick(tailAi, scan && scan.ai, meta.headAi));
  const out = {
    cwd: meta.cwd,
    startedAt: meta.startedAt,
    lastAt: meta.lastAt || new Date(entry.mtimeMs).toISOString(),
    branch: meta.branch,
    prompt: cleanTitle(meta.prompt) || null,
    custom: custom || null,
    ai: ai || null,
    model: lastModelOf(entry),
    firstEp: meta.firstEp,
    lastEp,
  };
  return { meta: out, scan };
}

// Best title: Mission Control's own rename (the newest intent of the user), then the CLI's custom title,
// then Claude's generated title, then the first prompt. Clearing the rename falls back to the next one.
function pickTitle(m, mc) {
  if (mc && mc.title) return { title: mc.title, titleSource: 'mc' }; // already one clean line of at most 120 characters; shown exactly as typed
  if (m.custom) return { title: m.custom, titleSource: 'custom' };
  if (mc && mc.autoTitle) return { title: mc.autoTitle, titleSource: 'auto' }; // the short name Mission Control gave it (autoTitle.js)
  if (m.ai) return { title: m.ai, titleSource: 'claude' };
  return { title: m.prompt || '(untitled)', titleSource: 'prompt' };
}

// ---- Project matching ----

function norm(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function projectFor(cwd, folders) {
  if (!cwd) return null;
  const c = norm(cwd);
  let best = null;
  for (const f of folders) {
    if (c === f.folder || c.startsWith(f.folder + '\\')) {
      if (!best || f.folder.length > best.folder.length) best = f;
    }
  }
  return best ? best.id : null;
}

function projectFolders() {
  const out = [];
  for (const p of loadCatalog()) {
    if (!p || !p.id || !p.folder) continue;
    out.push({ id: p.id, folder: norm(p.folder) });
    // Old folder names of a renamed project.
    for (const a of Array.isArray(p.aliases) ? p.aliases : []) if (typeof a === 'string' && a) out.push({ id: p.id, folder: norm(a) });
  }
  return out;
}

// ---- Public API ----

// Pinned first (by order), then sessions with an order, then the rest by newest activity.
function compareSessions(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const ao = a.order !== null;
  const bo = b.order !== null;
  if (ao && bo && a.order !== b.order) return a.order - b.order;
  if (ao !== bo) return ao ? -1 : 1;
  return String(b.lastAt).localeCompare(String(a.lastAt));
}

// Tags of one session: the manual list when the user set one (it replaces the automatic tags), else the
// automatic ones from the touched paths. `ids` is the set of project ids that exist in the catalog.
function tagsFor(id, mc, ids) {
  const auto = autoTagsOf(id);
  if (mc && Array.isArray(mc.tags)) {
    const tags = mc.tags.filter((p) => ids.has(p)).map((p) => ({ projectId: p, source: 'manual', share: auto.shares[p] || 0 }));
    return { tags, tagsSource: 'manual', tagsPending: false };
  }
  return { tags: auto.auto.filter((t) => ids.has(t.projectId)), tagsSource: 'auto', tagsPending: !auto.ready };
}

// archived: 'all' (default) lists every conversation, 'hide' leaves the archived ones out, 'only' lists just those.
export async function listSessions({ project = null, limit = 50, archived = 'all' } = {}) {
  const max = Math.max(1, Math.min(200, Number(limit) || 50));
  const out = (await scanSessions(project)).filter((s) => (archived === 'hide' ? !s.archived : archived === 'only' ? s.archived : true));
  out.length = Math.min(out.length, max);
  return out;
}

// Every conversation row, archived ones too, with no limit (the Usage page names conversations and their projects).
export function allSessionRows() {
  return scanSessions(null);
}

// How many archived conversations there are (inside the project, when one is given).
export async function countArchivedSessions(project = null) {
  return (await scanSessions(project)).filter((s) => s.archived).length;
}

async function scanSessions(project) {
  const all = await files();
  const folders = projectFolders();
  const ids = new Set(folders.map((f) => f.id));
  const meta = getAllMeta();
  const desk = desktopInfoNow(); // the newest process snapshot, never waited for (a refresh runs in the background)
  const out = [];
  for (const e of all) {
    const m = await readMeta(e);
    const pid = projectFor(m.cwd, folders);
    const mc = meta[e.id.toLowerCase()] || null;
    const tg = tagsFor(e.id, mc, ids);
    // A project filter keeps the sessions tagged with the project and the ones started inside its folder.
    if (project && pid !== project && !tg.tags.some((t) => t.projectId === project)) continue;
    const t = pickTitle(m, mc);
    const elsewhere = elsewhereOf({ id: e.id, firstEp: m.firstEp, lastEp: m.lastEp }, desk);
    out.push({
      ...(elsewhere ? { elsewhere } : {}),
      id: e.id,
      dir: e.dir,
      cwd: m.cwd,
      project: pid,
      tags: tg.tags,
      tagsSource: tg.tagsSource,
      tagsPending: tg.tagsPending,
      title: t.title,
      titleSource: t.titleSource,
      startedAt: m.startedAt,
      lastAt: m.lastAt,
      sizeKB: Math.round(e.size / 1024),
      branch: m.branch,
      model: m.model,
      pinned: !!(mc && mc.pinned),
      archived: !!(mc && mc.archived),
      locked: !!(mc && mc.locked),
      expiryAction: (mc && mc.expiryAction) || null,
      order: mc && Number.isFinite(mc.order) ? mc.order : null,
    });
  }
  out.sort(compareSessions);
  return out;
}

// 'Claude Desktop' when the conversation is open in the Claude desktop app (see elsewhere.js), else null. An unknown id is null.
// With { waitMs } (the send guard) it waits up to that long for a process list and then fails open; without, it never waits.
export async function elsewhereFor(id, { waitMs } = {}) {
  const entry = await findEntry(id);
  if (!entry) return null;
  const m = await readMeta(entry);
  return elsewhereOf({ id: entry.id, firstEp: m.firstEp, lastEp: m.lastEp }, waitMs ? await desktopInfo(waitMs) : desktopInfoNow());
}

// Returns { id, cwd } as recorded in the transcript, or null when the session is unknown.
export async function getSessionInfo(id) {
  const entry = await findEntry(id);
  if (!entry) return null;
  return { id: entry.id, cwd: (await readMeta(entry)).cwd };
}

// ---- Messages, turns and paging ----

const PAGE_START_BYTES = 512 * 1024;
const PAGE_CAP_BYTES = 8 * 1024 * 1024; // most one request ever reads
const RELEVANT_RE = /"type":"(?:user|assistant|queued_command)"/;

// Sorts a transcript record into what it means for message listing and turn timing. Sidechain (subagent)
// records are ignored everywhere. Returns null for records that are not part of the conversation,
// else { kind, text } with kind one of:
//   'prompt'    a real prompt typed by the human: starts a turn
//   'injected'  user-role text that is not the human's (task notification, helper report, compact summary):
//               shown as a notice line, never as the user's bubble. It ends the previous turn and starts none.
//               Also carries notice: { type, label, status }.
//   'tool'      a tool result going back to the model: part of a turn, shows no message
//   'assistant' a model response record
//   'queued'    something delivered into the turn in progress (a queued_command attachment): the human's message
//               sent while Claude was answering (role 'user'), or a notice that arrived the same way (role
//               'notice', with notice: { type, label, status }). Shown at the point of delivery, but it neither
//               starts nor ends a turn: the answer that follows is still part of the same turn.
// Skill text, image notes and command noise (meta records) come back as null. See userKinds.js for the markers.
function classify(o) {
  if (!o || o.isSidechain) return null;
  if (o.type === 'assistant') return o.isMeta ? null : { kind: 'assistant', text: assistantTextOf(o.message) };
  if (isQueuedCommand(o)) {
    const q = classifyUserEntry(o);
    if (q.kind === 'user') return { kind: 'queued', role: 'user', text: q.text };
    if (q.kind === 'notice') return { kind: 'queued', role: 'notice', text: q.text, notice: { type: q.type, label: q.label, status: q.status } };
    return null;
  }
  if (o.type !== 'user') return null;
  const c = classifyUserEntry(o);
  if (c.kind === 'user') return { kind: 'prompt', text: c.text };
  if (c.kind === 'notice') return { kind: 'injected', text: c.text, notice: { type: c.type, label: c.label, status: c.status } };
  if (c.kind === 'tool') return { kind: 'tool', text: '' };
  return null;
}

// ---- Images in transcripts ----
// Three kinds, all found in the record that holds them:
//   from "you"     an image block in a prompt (inline base64)
//   from "tool"    an image inside a tool_result, for example Claude reading a screenshot (inline base64)
//   from "claude"  a file Claude sent with SendUserFile: toolUseResult.attachments[] holds its path, not its bytes
const B64_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES_PER_MESSAGE = 12;

function servableExt(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(p);
  return m && SERVABLE_EXT[m[1].toLowerCase()] ? SERVABLE_EXT[m[1].toLowerCase()] : null;
}

function mediaOf(o) {
  const out = [];
  // a message sent while Claude works is a queued_command attachment: its blocks are in attachment.prompt
  const c = isQueuedCommand(o) ? o.attachment.prompt : o.message && o.message.content;
  if (!Array.isArray(c)) return out;
  const isB64 = (b) => b && b.type === 'image' && b.source && b.source.type === 'base64' && B64_IMAGE_TYPES.has(b.source.media_type) && typeof b.source.data === 'string';
  let firstResultId = null;
  for (const b of c) {
    if (!b) continue;
    if (isB64(b)) {
      out.push({ from: 'you', mediaType: b.source.media_type, data: b.source.data });
    } else if (b.type === 'tool_result') {
      if (firstResultId === null) firstResultId = b.tool_use_id || null;
      if (Array.isArray(b.content)) {
        for (const x of b.content) if (isB64(x)) out.push({ from: 'tool', toolUseId: b.tool_use_id || null, mediaType: x.source.media_type, data: x.source.data });
      }
    }
  }
  const t = o.toolUseResult;
  for (const a of sendFileAttachments(o)) {
    const type = servableExt(a.path);
    if (!type) continue;
    out.push({
      from: 'claude',
      toolUseId: firstResultId,
      path: a.path,
      kind: type === 'application/pdf' ? 'pdf' : 'image',
      caption: typeof t.caption === 'string' && t.caption ? t.caption.slice(0, 500) : undefined,
    });
  }
  return out;
}

// The files of a SendUserFile result: toolUseResult.attachments[] with a path and an isImage flag.
function sendFileAttachments(o) {
  const t = o && o.type === 'user' ? o.toolUseResult : null;
  if (!t || Array.isArray(t) || typeof t !== 'object' || !Array.isArray(t.attachments)) return [];
  return t.attachments.filter((a) => a && typeof a.path === 'string' && a.path && typeof a.isImage === 'boolean');
}

const baseName = (p) => String(p).split(/[\\/]/).pop();

// Final form of the images of one message for the API: bytes go to the cache, nothing inline.
function publicImages(raw, sessionId) {
  const out = [];
  let n = 0;
  for (const im of raw) {
    if (out.length >= MAX_IMAGES_PER_MESSAGE) break;
    if (im.from === 'claude') {
      out.push({
        src: attachmentUrl(sessionId, im.path),
        name: baseName(im.path),
        from: 'claude',
        kind: im.kind,
        ...(im.caption ? { caption: im.caption } : {}),
      });
    } else {
      const src = cacheImage(im.mediaType, im.data);
      if (!src) continue;
      n++;
      out.push({ src, name: `image-${n}.${src.slice(src.lastIndexOf('.') + 1)}`, from: im.from, kind: 'image' });
    }
  }
  return out;
}

function attachmentUrl(sessionId, p) {
  return `/api/sessions/${sessionId}/attachment?path=${encodeURIComponent(p)}`;
}

// Slim form of one transcript line for message and turn work, or null when it is not a conversation record.
function toRec(line, off) {
  if (!RELEVANT_RE.test(line)) return null;
  const o = parseLine(line);
  const c = classify(o);
  if (!c) return null;
  const m = o.message || {};
  const isA = o.type === 'assistant';
  const imgs = !isA && (line.includes('"image"') || line.includes('"attachments"')) ? mediaOf(o) : [];
  const toolUseIds = [];
  const resultFor = [];
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (!b) continue;
      if (isA && b.type === 'tool_use' && typeof b.id === 'string') toolUseIds.push(b.id);
      else if (!isA && b.type === 'tool_result' && typeof b.tool_use_id === 'string') resultFor.push(b.tool_use_id);
    }
  }
  return {
    off,
    kind: c.kind,
    role: c.role || (c.notice ? 'notice' : o.type),
    notice: c.notice || null,
    text: c.text,
    imgs,
    toolUseIds,
    resultFor,
    shows: !!c.text || !!c.notice || (c.kind === 'prompt' && imgs.some((i) => i.from === 'you')),
    at: typeof o.timestamp === 'string' ? o.timestamp : null,
    msgId: isA ? m.id || o.uuid || null : null,
    // The ids a person's message is known by: the record's own, and for a queued_command the id of the message it delivers.
    // A page that also has this message from the live events matches the two by these (see GET /api/sessions/:id).
    uuids: isA ? null : [o.uuid, o.attachment && o.attachment.source_uuid].filter((x) => typeof x === 'string'),
    usage: isA && m.model !== '<synthetic>' && m.usage && typeof m.usage === 'object' ? m.usage : null,
    model: isA ? m.model : null,
  };
}

// Conversation records from byte `from` forward up to (not including) the next real prompt, in file order.
// Returns { recs, complete }: complete is false when the cap ended the read before a prompt or the end of file.
function readTurnTail(file, from, size) {
  const recs = [];
  const fd = fs.openSync(file, 'r');
  try {
    let pos = from;
    let carry = Buffer.alloc(0);
    let base = from; // file offset of carry[0]
    while (pos < size) {
      if (pos - from >= PAGE_CAP_BYTES) return { recs, complete: false };
      const buf = Buffer.alloc(Math.min(512 * 1024, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let at = 0;
      for (;;) {
        const nl = data.indexOf(10, at);
        if (nl < 0) break;
        const r = toRec(data.toString('utf8', at, nl), base + at);
        at = nl + 1;
        if (!r) continue;
        if (r.kind === 'prompt' || r.kind === 'injected') return { recs, complete: true };
        recs.push(r);
      }
      carry = data.subarray(at);
      base += at;
    }
    if (carry.length) {
      const r = toRec(carry.toString('utf8'), base);
      if (r && r.kind !== 'prompt') recs.push(r);
    }
    return { recs, complete: true };
  } finally {
    fs.closeSync(fd);
  }
}

// Turn boundaries. A turn is the work between two boundaries, and it ends at the last assistant or tool-result
// record BEFORE the boundary, never at the boundary itself. A boundary is any of:
//   1. a real prompt typed by the human (it also starts the next turn),
//   2. a user-side record that is neither a prompt nor a tool result (task notification, compact summary,
//      command noise): it ends the previous turn but does not start a user turn of its own, so the hours
//      a background task took are not charged to the turn that launched it. Whatever the model does in
//      answer to it is a new turn that starts at the first record that follows,
//   3. a gap of more than 30 minutes with no record at all (the machine slept, or the run was abandoned):
//      the record after the gap starts a new turn.
const TURN_GAP_MS = 30 * 60 * 1000;
const msOf = (at) => {
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : null;
};
const gapBetween = (olderAt, newerAt) => {
  const a = msOf(olderAt);
  const b = msOf(newerAt);
  return a !== null && b !== null && b - a > TURN_GAP_MS;
};

const tokenOf = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

function newTurn(startedAt, startKnown) {
  return { startedAt, startKnown, endedAt: null, usage: new Map(), model: null, lastMsg: null };
}

// Puts the turn figures on the last assistant message of the turn.
// outputTokens and totalTokens cover the main-thread assistant requests of the turn. The CLI writes one
// transcript record per content block, and every block of one response repeats that response's usage, so
// usage is counted once per message id, not once per record.
// totalTokens = output + input + cache read + cache write. Cache reads dominate it, because every request in
// a turn re-reads the whole context, so it measures work done, not new text.
function finishTurn(t) {
  if (!t || !t.lastMsg || !t.endedAt) return;
  let out = 0;
  let total = 0;
  for (const u of t.usage.values()) {
    const o = tokenOf(u.output_tokens);
    out += o;
    total += o + tokenOf(u.input_tokens) + tokenOf(u.cache_read_input_tokens) + tokenOf(u.cache_creation_input_tokens);
  }
  if (!t.startKnown) {
    // The prompt that started this turn is outside the loaded range: the figures cover only what was seen.
    t.lastMsg.turn = { partial: true, endedAt: t.endedAt, outputTokens: out, totalTokens: total, model: t.model };
    return;
  }
  const d = Date.parse(t.endedAt) - Date.parse(t.startedAt);
  t.lastMsg.turn = {
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    durationMs: Number.isFinite(d) ? Math.max(0, d) : null,
    outputTokens: out,
    totalTokens: total,
    model: t.model,
  };
}

// One page of messages: the newest `limit` messages that lie before byte offset `before` (default: end of file).
// Returns null when the session is unknown. `cursor` (a byte offset as a string) is the `before` for the next
// older page, null when nothing is older. The file is read backwards in windows (512 KB, doubling, 8 MB at
// most), so a huge transcript stays fast.
// Turn figures use every record in the loaded range. The range is extended past the page until the prompt of
// the oldest turn is found (within the cap), so that turn is usually exact; otherwise turn.partial is set.
// A turn that continues into newer records than this page gets its marker on the newer page, not here.
// upTo: true lets `before` be the current end of the file (the saved part of a turn in progress ends exactly where the
// turn began, and the file may not have grown since); the default refuses it, as a page cursor always lies inside the file.
export async function getSessionMessages(id, limit = 40, before = null, { upTo = false } = {}) {
  const entry0 = await findEntry(id);
  if (!entry0) return null;
  const max = Math.max(1, Math.min(200, Number(limit) || 40));
  let size;
  try {
    size = fs.statSync(entry0.file).size; // fresh: the scan may be a few seconds old
  } catch {
    return null;
  }
  const entry = { ...entry0, size };
  let end = size;
  if (before !== null && before !== undefined && before !== '') {
    if (!/^\d{1,15}$/.test(String(before))) throw fail(400, 'Invalid cursor');
    end = Number(before);
    if (end > size || (end === size && !upTo)) throw fail(400, 'Invalid cursor');
    if (end > 0) {
      const b = Buffer.alloc(1);
      const fd = fs.openSync(entry.file, 'r');
      try {
        fs.readSync(fd, b, 0, 1, end - 1);
      } finally {
        fs.closeSync(fd);
      }
      if (b[0] !== 10) throw fail(400, 'Invalid cursor'); // not the start of a line
    }
  }
  // The turn that is open at `end` may continue into newer records: read its tail, so its figures are exact
  // and the page that holds the turn's last assistant message is the one that puts the marker on it.
  let tail = { recs: [], complete: true };
  if (end < size) tail = readTurnTail(entry.file, end, size);

  const loaded = []; // newest first
  let count = 0;
  let searching = false;
  let startFound = false;
  let newerAt = null;
  let lastOff = end;
  const how = walkBackwards(
    entry,
    PAGE_START_BYTES,
    PAGE_CAP_BYTES,
    (line, off) => {
      lastOff = off;
      const r = toRec(line, off);
      if (!r) return false;
      loaded.push(r);
      if (r.shows) {
        count++;
        if (count === max) searching = true;
      }
      // The oldest wanted turn is complete once its start is visible: a prompt, an injected record, or a
      // gap of more than 30 minutes to the newer record just visited (that one starts a turn).
      if (searching) {
        if (r.kind === 'prompt' || r.kind === 'injected') startFound = true;
        else if (newerAt !== null && gapBetween(r.at, newerAt)) startFound = true;
      }
      if (r.kind !== 'injected' && r.at) newerAt = r.at;
      return count >= max + 1 && startFound;
    },
    end,
  );

  // Forward pass (oldest first): messages and turns.
  const all = [];
  let cur = null;
  let prevAt = null; // time of the previous assistant or tool record of the current turn
  let afterBoundary = false; // a boundary was seen, so the next turn starts at a known record
  let tailDone = false; // the tail reached a boundary: the rest of it belongs to a newer page
  let injectedAt = null;
  const byToolUse = new Map(); // tool_use id -> the message that shows the call, so its result images can join it
  const step = (r, isTail) => {
    if (tailDone) return;
    if (r.kind === 'prompt') {
      finishTurn(cur);
      cur = newTurn(r.at, true);
      prevAt = r.at;
      afterBoundary = false;
    } else if (r.kind === 'injected') {
      finishTurn(cur); // ends the previous turn, starts none (see TURN_GAP_MS)
      cur = null;
      prevAt = null;
      afterBoundary = true;
      injectedAt = r.at;
    } else {
      if (cur && gapBetween(prevAt, r.at)) {
        finishTurn(cur);
        cur = null;
        afterBoundary = true;
        injectedAt = null;
        if (isTail) {
          tailDone = true;
          return;
        }
      }
      if (!cur) cur = afterBoundary ? newTurn(injectedAt || r.at, true) : newTurn(null, false);
      injectedAt = null;
      if (r.at) {
        cur.endedAt = r.at;
        prevAt = r.at;
      }
      if (r.kind === 'assistant') {
        if (r.usage) cur.usage.set(r.msgId || 'off:' + r.off, r.usage);
        if (r.model && r.model !== '<synthetic>') cur.model = r.model;
      }
    }
    if (r.shows && !isTail) {
      // A notice keeps up to 20 KB (the page offers it behind a disclosure), other messages 100,000 characters.
      const textMax = r.notice ? NOTICE_TEXT_MAX : MESSAGE_TEXT_MAX;
      const msg = { role: r.role, text: r.text.length > textMax ? r.text.slice(0, textMax) + '...' : r.text, at: r.at, pos: r.off, rawImgs: r.kind === 'prompt' || (r.kind === 'queued' && r.role === 'user') ? r.imgs.filter((i) => i.from === 'you') : [] };
      if (r.role === 'user' && r.uuids && r.uuids.length) msg.uuids = r.uuids;
      if (r.kind === 'queued') msg.queued = true; // sent while Claude was answering: part of that turn, not a new question
      if (r.notice) {
        msg.noticeType = r.notice.type;
        msg.label = r.notice.label;
        if (r.notice.status) msg.status = r.notice.status;
      }
      all.push(msg);
      if (r.kind === 'assistant') for (const id of r.toolUseIds) byToolUse.set(id, msg);
      if (r.kind === 'assistant' && cur) cur.lastMsg = msg;
    } else if (r.shows && r.kind === 'assistant' && cur) {
      cur.lastMsg = null; // the turn's last message is on a newer page
    }
    if (r.kind === 'tool' && r.imgs.length && !isTail) {
      for (const im of r.imgs) {
        const target = byToolUse.get(im.toolUseId) || (r.resultFor.length ? byToolUse.get(r.resultFor[0]) : null);
        if (target) target.rawImgs.push(im);
      }
    }
  };
  for (let i = loaded.length - 1; i >= 0; i--) step(loaded[i], false);
  for (const r of tail.recs) step(r, true);
  if (tail.complete && !tailDone) finishTurn(cur);

  // The CLI writes the summary of a /compact before the /compact line itself (the summary is saved as the new start of the
  // conversation, then the command that made it). Shown the other way round: the command, then its summary.
  for (let i = 0; i + 1 < all.length; i++) {
    if (all[i].noticeType === 'summary' && all[i + 1].role === 'user' && /^\/compact(\s|$)/.test(all[i + 1].text)) {
      [all[i], all[i + 1]] = [all[i + 1], all[i]];
      all[i].beforeSummary = true;
      i++;
    }
  }
  let first = Math.max(0, all.length - max);
  if (first > 0 && all[first - 1].beforeSummary) first--; // the pair stays on one page (the /compact lies after the cursor)
  for (const msg of all) delete msg.beforeSummary;
  const messages = all.slice(first);
  for (const msg of messages) {
    msg.images = publicImages(msg.rawImgs, entry.id);
    delete msg.rawImgs;
  }
  let hasMore = how === 'stopped' ? true : how === 'floor' ? lastOff > 0 : false;
  if (hasMore && !messages.length && lastOff >= end) hasMore = false; // nothing could be read: do not loop forever
  const m = await readMeta(entry0);
  const t = pickTitle(m, getMeta(entry.id));
  // The oldest byte shown, not the first message: a swapped /compact sits before its summary but lies after it in the file.
  const cursor = hasMore ? String(messages.length ? Math.min(...messages.map((x) => x.pos)) : lastOff) : null;
  return { id: entry.id, title: t.title, titleSource: t.titleSource, cwd: m.cwd, messages, cursor, hasMore };
}

// ---- SendUserFile attachments: which paths may be served ----
// The attachment route serves a file only when its exact path is in a SendUserFile result of that session.
// Live runs note the paths they see at once (the transcript may not have the record yet).

const liveAttach = new Map(); // session id (lowercase) -> Set of paths
export function noteAttachment(sessionId, p) {
  if (!isUuid(sessionId) || typeof p !== 'string' || !p) return;
  const key = sessionId.toLowerCase();
  let set = liveAttach.get(key);
  if (!set) {
    set = new Set();
    liveAttach.set(key, set);
    if (liveAttach.size > 100) liveAttach.delete(liveAttach.keys().next().value);
  }
  if (set.size < 500) set.add(p);
}

const ATT_MARK = Buffer.from('"attachments"');
const ATT_MARK2 = Buffer.from('"isImage"');
const attachScan = new Map(); // transcript file -> { offset, paths } (transcripts only grow, so each call reads just the new part)

function scanAttachments(entry) {
  let size;
  try {
    size = fs.statSync(entry.file).size;
  } catch {
    return new Set();
  }
  let st = attachScan.get(entry.file);
  if (!st || size < st.offset) {
    st = { offset: 0, paths: new Set() };
    attachScan.set(entry.file, st);
    if (attachScan.size > 50) attachScan.delete(attachScan.keys().next().value);
  }
  if (size === st.offset) return st.paths;
  const fd = fs.openSync(entry.file, 'r');
  try {
    let pos = st.offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let at = 0;
      for (;;) {
        const nl = data.indexOf(10, at);
        if (nl < 0) break;
        const line = data.subarray(at, nl);
        at = nl + 1;
        if (line.length < 10 || !line.includes(ATT_MARK) || !line.includes(ATT_MARK2)) continue;
        const o = parseLine(line.toString('utf8'));
        if (o && !o.isSidechain) for (const a of sendFileAttachments(o)) st.paths.add(a.path);
      }
      carry = data.subarray(at);
      st.offset = pos - carry.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return st.paths;
}

// ---- Every picture of a conversation, for the page's gallery ----
// The pictures the two people shared: images in my prompts (from "you") and the files Claude sent with SendUserFile
// (from "claude"), oldest first. Pictures Claude only looked at with a tool are left out. The scan reads only the part of
// the transcript added since the last call (transcripts only grow) and keeps at most GALLERY_MAX pictures.
const GALLERY_MAX = 500;
const IMG_MARK = Buffer.from('"image"');
const galleryScan = new Map(); // transcript file -> { offset, items }

// { tools: true } also lists the pictures Claude looked at with a tool (from "tool": screenshots it took to check its work), for
// a project's Screenshots tab. That list is kept apart from the gallery's.
export async function getSessionImages(id, { tools = false } = {}) {
  const entry = await findEntry(id);
  if (!entry) return null;
  let size;
  try {
    size = fs.statSync(entry.file).size;
  } catch {
    return null;
  }
  const ck = tools ? entry.file + '#tools' : entry.file;
  let st = galleryScan.get(ck);
  if (!st || size < st.offset) {
    st = { offset: 0, items: [], n: 0, t: 0 };
    galleryScan.set(ck, st);
    if (galleryScan.size > 20) galleryScan.delete(galleryScan.keys().next().value);
  }
  if (size > st.offset) {
    const fd = fs.openSync(entry.file, 'r');
    try {
      let pos = st.offset;
      let carry = Buffer.alloc(0);
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, size - pos));
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (!n) break;
        const base = pos - carry.length; // file offset of data[0]
        pos += n;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        let at = 0;
        for (;;) {
          const nl = data.indexOf(10, at);
          if (nl < 0) break;
          const line = data.subarray(at, nl);
          const lineOff = base + at;
          at = nl + 1;
          if (line.length < 10 || (!line.includes(IMG_MARK) && !line.includes(ATT_MARK))) continue;
          const o = parseLine(line.toString('utf8'));
          if (!o || o.isSidechain || (o.type !== 'user' && !isQueuedCommand(o))) continue;
          const at0 = typeof o.timestamp === 'string' ? o.timestamp : null;
          let k = 0;
          let kt = 0;
          for (const im of mediaOf(o)) {
            if (im.from === 'tool') {
              if (!tools || !im.data) continue;
              const file = entry.file, kk = kt++;
              const src = lazyImage(im.mediaType, im.data, () => yourImageAt(file, lineOff, kk, 'tool'));
              if (!src) continue;
              st.t++;
              st.items.push({ src, name: `looked-at-${st.t}.${src.slice(src.lastIndexOf('.') + 1)}`, from: 'tool', at: at0 });
            } else if (im.from === 'claude') {
              if (im.kind !== 'image') continue;
              st.items.push({ src: attachmentUrl(entry.id, im.path), name: baseName(im.path), from: 'claude', at: at0, ...(im.caption ? { caption: im.caption } : {}) });
            } else {
              // named now, written to the image cache only when it is first shown (see lazyImage)
              const file = entry.file, kk = k++;
              const src = lazyImage(im.mediaType, im.data, () => yourImageAt(file, lineOff, kk));
              if (!src) continue;
              st.n++;
              st.items.push({ src, name: `image-${st.n}.${src.slice(src.lastIndexOf('.') + 1)}`, from: 'you', at: at0 });
            }
          }
          if (st.items.length > GALLERY_MAX) st.items.splice(0, st.items.length - GALLERY_MAX); // the newest are kept
        }
        carry = data.subarray(at);
        st.offset = pos - carry.length;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return st.items;
}

// ---- How many pictures a conversation has, for the folder counts of a project's Screenshots tab ----
// The same pictures as getSessionImages with tools (mine, Claude's sent files, what Claude looked at), only counted. Each
// transcript is read once from the start; after that only the part added since (transcripts only grow). Where each count
// stopped is kept in .data/image-counts.json, so a restart does not read everything again.
const COUNTS_FILE = path.join(DATA_DIR, 'image-counts.json');
let counts = null; // session id -> { size, offset, n }
let countsT = 0;
function loadCounts() {
  if (counts) return counts;
  try { counts = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8')) || {}; } catch { counts = {}; }
  if (typeof counts !== 'object' || Array.isArray(counts)) counts = {};
  return counts;
}
function saveCountsSoon() {
  clearTimeout(countsT);
  countsT = setTimeout(() => {
    try { fs.writeFileSync(COUNTS_FILE + '.tmp', JSON.stringify(counts)); fs.renameSync(COUNTS_FILE + '.tmp', COUNTS_FILE); } catch { /* next time */ }
  }, 2000);
  if (countsT.unref) countsT.unref();
}
// One count at a time per conversation: two at once would read the same new lines and count them twice.
const counting = new Map();
export function countSessionImages(id) {
  if (counting.has(id)) return counting.get(id);
  const p = countOnce(id).finally(() => counting.delete(id));
  counting.set(id, p);
  return p;
}
async function countOnce(id) {
  const entry = await findEntry(id);
  if (!entry) return null;
  let size;
  try { size = (await fs.promises.stat(entry.file)).size; } catch { return null; }
  const all = loadCounts();
  let st = all[id];
  if (!st || typeof st.offset !== 'number' || size < st.offset) st = { size: 0, offset: 0, n: 0 };
  if (size > st.offset) {
    const fh = await fs.promises.open(entry.file, 'r');
    try {
      let pos = st.offset;
      let carry = Buffer.alloc(0);
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let at = 0;
        for (;;) {
          const nl = data.indexOf(10, at);
          if (nl < 0) break;
          const line = data.subarray(at, nl);
          at = nl + 1;
          if (line.length < 10 || (!line.includes(IMG_MARK) && !line.includes(ATT_MARK))) continue;
          const o = parseLine(line.toString('utf8'));
          if (!o || o.isSidechain || (o.type !== 'user' && !isQueuedCommand(o))) continue;
          for (const im of mediaOf(o)) if (im.from !== 'claude' || im.kind === 'image') st.n++;
        }
        carry = data.subarray(at);
        st.offset = pos - carry.length;
      }
    } finally {
      await fh.close();
    }
    st.size = size;
    all[id] = st;
    saveCountsSoon();
  }
  return Math.min(st.n, GALLERY_MAX);
}

// The k-th picture of mine in the transcript line that starts at byte `off`, read again when the gallery shows it.
function yourImageAt(file, off, k, from = 'you') {
  const fd = fs.openSync(file, 'r');
  try {
    const chunks = [];
    let pos = off;
    for (let total = 0; total < 64 * 1024 * 1024; ) {
      const buf = Buffer.alloc(1024 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(buf.subarray(0, nl >= 0 ? nl : n));
      if (nl >= 0) break;
      pos += n;
      total += n;
    }
    const o = parseLine(Buffer.concat(chunks).toString('utf8'));
    const mine = o ? mediaOf(o).filter((im) => im.from === from) : [];
    return mine[k] ? { mediaType: mine[k].mediaType, data: mine[k].data } : null;
  } finally {
    fs.closeSync(fd);
  }
}

// For a live run: the files in a SendUserFile result (the tool_use_result of a stream event) as image entries,
// and the paths are noted so the attachment route serves them at once.
export function liveSendFileImages(sessionId, toolUseResult) {
  const out = [];
  for (const a of sendFileAttachments({ type: 'user', toolUseResult })) {
    const type = servableExt(a.path);
    if (!type) continue;
    noteAttachment(sessionId, a.path);
    out.push({
      src: attachmentUrl(sessionId, a.path),
      name: baseName(a.path),
      from: 'claude',
      kind: type === 'application/pdf' ? 'pdf' : 'image',
      ...(typeof toolUseResult.caption === 'string' && toolUseResult.caption ? { caption: toolUseResult.caption.slice(0, 500) } : {}),
    });
  }
  return out;
}

// The file to send for GET /api/sessions/:id/attachment?path=..., or null (the route answers 404).
// Only a path that is in a SendUserFile result of this session, exists, and is an image or a PDF qualifies.
export async function resolveAttachment(sessionId, p) {
  if (!isUuid(sessionId) || typeof p !== 'string' || !p || p.length > 1024 || p.includes('\0')) return null;
  if (!/^[A-Za-z]:[\\/]/.test(p)) return null;
  const type = servableExt(p);
  if (!type) return null;
  let ok = !!(liveAttach.get(sessionId.toLowerCase()) || new Set()).has(p);
  if (!ok) {
    const entry = await findEntry(sessionId);
    if (!entry) return null;
    ok = scanAttachments(entry).has(p);
  }
  if (!ok) return null;
  try {
    // Follow links first and judge the real file: a link or junction must not lead out to something that is not
    // an image or a PDF, and the bytes (not the name) must say it is one.
    const real = fs.realpathSync(p);
    if (!servableExt(real)) return null;
    const st = fs.statSync(real);
    if (!st.isFile()) return null;
    const fd = fs.openSync(real, 'r');
    let head;
    try {
      head = Buffer.alloc(16);
      head = head.subarray(0, fs.readSync(fd, head, 0, 16, 0));
    } finally {
      fs.closeSync(fd);
    }
    const real_type = sniff(head);
    if (!real_type || !(real_type === 'application/pdf' ? type === 'application/pdf' : type !== 'application/pdf')) return null;
    return { file: real, name: baseName(p), type: real_type, size: st.size, inline: true };
  } catch {
    return null;
  }
}

// Milliseconds since the transcript file was last written (fresh stat), or null when the session is unknown.
// Sessions run from the user's own terminal are not tracked as runs, so this is how "in use" is detected.
export async function sessionIdleMs(id) {
  const entry = await findEntry(id);
  if (!entry) return null;
  try {
    return Math.max(0, Date.now() - fs.statSync(entry.file).mtimeMs);
  } catch {
    return null;
  }
}

// ---- Rename, pin, order ----

export async function updateSessionMeta(id, patch) {
  const entry = await findEntry(id);
  if (!entry) throw fail(404, 'Unknown session');
  setMeta(entry.id, patch);
  publish('sessions.changed', { id: entry.id });
  return { ok: true };
}

// Archives or unarchives a conversation. A conversation that has no transcript yet (its first reply is still coming)
// is accepted when the caller knows it exists (allowUnknown), so ending a brand new Com Link conversation still counts.
export async function setSessionArchived(id, archived, { allowUnknown = false } = {}) {
  if (!isUuid(id)) throw fail(400, 'Session id must be a uuid');
  const entry = await findEntry(id);
  if (!entry && !allowUnknown) throw fail(404, 'Unknown session');
  const key = entry ? entry.id : String(id).toLowerCase();
  setMeta(key, { archived });
  publish('sessions.changed', { id: key });
  return { ok: true, archived };
}

export function updateSessionOrder(ids) {
  setOrder(ids);
  publish('sessions.changed', {});
  return { ok: true };
}

// ---- Delete (to the Recycle Bin) ----

// The paths are passed base64 encoded as plain arguments, so nothing from a file name can become script text.
const RECYCLE_SCRIPT =
  "& { param($f, $d) Add-Type -AssemblyName Microsoft.VisualBasic; " +
  "function Dec($s) { if ([string]::IsNullOrEmpty($s)) { return '' }; [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }; " +
  "$file = Dec $f; $dir = Dec $d; " +
  "if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'file missing' }; " +
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($file, 'OnlyErrorDialogs', 'SendToRecycleBin'); " +
  "if ($dir -ne '' -and (Test-Path -LiteralPath $dir -PathType Container)) { " +
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($dir, 'OnlyErrorDialogs', 'SendToRecycleBin') } }";

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Moves the transcript (and its sidecar folder, if any) to the Recycle Bin. The caller must make sure
// no run uses the session. The path comes from a fresh scan of the projects folder, never from the request.
export async function deleteSession(id) {
  if (!isUuid(id)) throw fail(400, 'Session id must be a uuid');
  invalidate('sessions:scan');
  const entry = scanFiles().find((e) => e.id.toLowerCase() === id.toLowerCase());
  if (!entry) throw fail(404, 'Unknown session');
  if (!inside(PROJECTS_DIR, entry.file)) throw fail(500, 'Session file is outside the projects folder');

  let sidecar = '';
  const side = path.join(path.dirname(entry.file), entry.id);
  try {
    const st = fs.lstatSync(side);
    // A junction or link is left alone: it could point anywhere.
    if (st.isDirectory() && !st.isSymbolicLink() && inside(PROJECTS_DIR, side)) sidecar = side;
  } catch {
    // no sidecar folder
  }

  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_SCRIPT, `'${b64(entry.file)}'`, `'${sidecar ? b64(sidecar) : ''}'`],
    { timeoutMs: 60000 },
  );
  if (r.code !== 0 || fs.existsSync(entry.file)) {
    throw fail(500, 'Could not move the session to the Recycle Bin' + (r.stderr ? ': ' + r.stderr.trim().split(/\r?\n/)[0].slice(0, 160) : ''));
  }
  try {
    removeMeta(entry.id);
  } catch (err) {
    console.error('[sessions] deleted, but its name and pin stay in sessions-meta.json:', err.message); // harmless leftover
  }
  metaCache.delete(entry.file);
  invalidate('sessions:scan');
  publish('sessions.changed', { id: entry.id, deleted: true });
  return { ok: true, sidecar: !!sidecar };
}

// ---- Context window, cache and usage numbers ----

const TTL_MS = { '1h': 60 * 60 * 1000, '5m': 5 * 60 * 1000 };
const seenWindows = new Map(); // model -> window size reported by a finished run (most exact source)
let catalogCache = { key: '', docs: [] };
let windowCache = { key: '', windows: new Map() };
let modelCache = { key: '', models: [] };

// Newer CLI versions stopped refreshing published-*.json and write "<uuid>-<hash>-cc.json" instead (version 2:
// { fetchedAt, catalog: { config: { models } } }, with no runtime block). Rewrites that into the published shape
// so the readers below handle both. Returns null for anything else.
function normalizeCatalog(j) {
  if (j && typeof j === 'object' && j.document && typeof j.document === 'object') return j;
  const cfg = j && j.catalog && j.catalog.surface === 'cc' ? j.catalog.config : null;
  if (!cfg || !Array.isArray(cfg.models)) return null;
  return { fetchedAt: j.fetchedAt, document: { surfaces: { cc: { model_selector_config: [cfg] } } } };
}

// The CLI's model catalogs (published-*.json and the "<uuid>-<hash>-cc.json" files of newer CLIs; the tok-*
// and the -ccd files are never opened), parsed once per change of the files. Newest first.
function catalogDocs() {
  let names = [];
  try {
    names = fs.readdirSync(CATALOG_DIR).filter((n) => /^published-.*.json$/.test(n) || /^[0-9a-f-]{36}-[0-9a-f]+-cc\.json$/i.test(n));
  } catch {
    return [];
  }
  const stats = names.map((n) => {
    try {
      return `${n}:${fs.statSync(path.join(CATALOG_DIR, n)).mtimeMs}`;
    } catch {
      return n;
    }
  });
  const key = stats.join('|');
  if (key === catalogCache.key) return catalogCache.docs;
  const docs = [];
  for (const n of names) {
    try {
      const j = normalizeCatalog(JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, n), 'utf8').replace(/^﻿/, '')));
      if (j) docs.push(j);
    } catch {
      // unreadable catalog file: use the others
    }
  }
  docs.sort((x, y) => String(y.fetchedAt || '').localeCompare(String(x.fetchedAt || '')));
  catalogCache = { key, docs };
  return docs;
}

// Window sizes from the CLI's model catalog.
function catalogWindows() {
  const docs = catalogDocs();
  if (catalogCache.key === windowCache.key) return windowCache.windows;
  const windows = new Map();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 12) return;
    if (typeof o.id === 'string' && o.runtime && Number.isFinite(o.runtime.max_input_tokens)) {
      windows.set(o.id, Math.max(windows.get(o.id) || 0, o.runtime.max_input_tokens));
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  for (const d of docs) walk(d, 0);
  windowCache = { key: catalogCache.key, windows };
  return windows;
}

const MODEL_ID_RE = /^claude-[a-z0-9][a-z0-9.-]{0,63}$/;

// The models the CLI offers in its own picker (surface "cc", section "main"), as { id, label, family }.
// The id is a full model id, and the label is the catalog's own name for that same id, so the two always
// agree. Empty when the catalog is missing or unreadable (the caller then uses its fallback table).
export function catalogModels() {
  const docs = catalogDocs();
  if (catalogCache.key === modelCache.key) return modelCache.models;
  let models = [];
  for (const d of docs) {
    const surfaces = d.document && d.document.surfaces;
    const cfg = surfaces && surfaces.cc && Array.isArray(surfaces.cc.model_selector_config) ? surfaces.cc.model_selector_config[0] : null;
    const list = cfg && Array.isArray(cfg.models) ? cfg.models : [];
    const out = [];
    for (const m of list) {
      if (!m || typeof m.id !== 'string' || !MODEL_ID_RE.test(m.id)) continue;
      if (m.section !== 'main' && m.quick_select !== true) continue;
      const name = typeof m.name === 'string' ? m.name.replace(/[^ -~]/g, '').trim().slice(0, 40) : '';
      // Newer catalogs carry no runtime block, so the family is read from the id ("claude-haiku-5-5" is haiku).
      const idFamily = /^claude-(fable|opus|sonnet|haiku)-/.exec(m.id);
      const family = m.runtime && typeof m.runtime.family === 'string' ? m.runtime.family : idFamily ? idFamily[1] : '';
      const minVersion = typeof m.min_claude_code_version === 'string' && /^\d+(\.\d+){1,3}$/.test(m.min_claude_code_version) ? m.min_claude_code_version : null;
      out.push({ id: m.id, label: name || m.id, family, minVersion });
    }
    if (out.length) {
      models = out;
      break;
    }
  }
  modelCache = { key: catalogCache.key, models };
  return models;
}

function fallbackWindow(model) {
  // Haiku 4.x has 200K; Haiku 5.5 has 1M (per the Claude API model table), like the other generation 5 models.
  // The version is one or two digits not followed by another digit, so a date ("claude-3-5-haiku-20241022") is never read as one.
  const m = /(?:opus|fable|sonnet|haiku)-(\d{1,2})(?!\d)/i.exec(model);
  if (m && Number(m[1]) >= 5) return 1000000;
  return 200000;
}

export function contextWindowFor(model) {
  if (typeof model !== 'string' || !model) return null;
  if (seenWindows.has(model)) return seenWindows.get(model);
  const cat = catalogWindows();
  if (cat.has(model)) return cat.get(model);
  for (const [id, n] of cat) if (model.startsWith(id + '-')) return n; // dated variant of a catalog id
  return fallbackWindow(model);
}

export function noteContextWindow(model, size) {
  if (typeof model === 'string' && model && Number.isFinite(size) && size > 0) seenWindows.set(model, size);
}

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

function cacheTtlOf(usage) {
  const cc = usage && usage.cache_creation;
  if (cc && typeof cc === 'object') {
    if (num(cc.ephemeral_1h_input_tokens) > 0) return '1h';
    if (num(cc.ephemeral_5m_input_tokens) > 0) return '5m';
    return null;
  }
  return num(usage && usage.cache_creation_input_tokens) > 0 ? '5m' : null;
}

const touchedCache = (u) => num(u.cache_creation_input_tokens) > 0 || num(u.cache_read_input_tokens) > 0;

// last: { model, usage, at (ms) }   cacheReq: { at (ms) } | null   ttl: '1h' | '5m' | null
function buildStats(last, cacheReq, ttl) {
  const u = last.usage;
  const used = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  const window = contextWindowFor(last.model);
  const pct = window ? Math.max(0, Math.min(100, Math.round((used / window) * 1000) / 10)) : null;
  const at = cacheReq ? cacheReq.at : last.at;
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  return {
    model: last.model || null,
    contextUsed: used,
    contextWindow: window,
    contextPct: pct,
    cache: {
      ttl: ttl || null,
      lastAt: iso(at),
      expiresAt: ttl && cacheReq && Number.isFinite(at) ? iso(at + TTL_MS[ttl]) : null,
    },
    lastUsage: {
      input: num(u.input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      output: num(u.output_tokens),
    },
  };
}

// A /compact newer than every request: the conversation is now its summary, and the old cache is never read again.
// Returns { at (ms), postTokens } from a compact_boundary record of the main thread, or null.
function compactOf(o) {
  if (!o || o.type !== 'system' || o.subtype !== 'compact_boundary' || o.isSidechain) return null;
  const md = o.compactMetadata || o.compact_metadata || {};
  const post = Number(md.postTokens ?? md.post_tokens);
  return { at: Date.parse(o.timestamp), postTokens: Number.isFinite(post) && post > 0 ? post : null };
}

// Stats right after a /compact: the context is the summary (postTokens, as the CLI counts it), and there is no cache until
// the next message writes a new, small one. The model is the one of the last request before it.
export function compactedStats(compact, model) {
  const window = contextWindowFor(model);
  const used = compact.postTokens;
  const pct = window && used != null ? Math.max(0, Math.min(100, Math.round((used / window) * 1000) / 10)) : null;
  const at = Number.isFinite(compact.at) ? new Date(compact.at).toISOString() : null;
  return { model: model || null, contextUsed: used, contextWindow: window, contextPct: pct, cache: { ttl: null, lastAt: null, expiresAt: null, compactedAt: at }, lastUsage: null };
}

// Numbers for the newest main-thread request in the transcript, or null when the session is unknown.
export async function getSessionStats(id) {
  const entry = await findEntry(id);
  if (!entry) return null;
  let last = null;
  let cacheReq = null;
  let ttl = null;
  let compact = null;
  let visited = 0;
  try {
    walkBackwards(entry, 256 * 1024, 16 * 1024 * 1024, (line) => {
      if (!last && !compact && line.includes('"subtype":"compact_boundary"') && !line.includes('"isSidechain":true')) {
        compact = compactOf(parseLine(line));
        return false;
      }
      if (!line.includes('"type":"assistant"') || line.includes('"isSidechain":true')) return false;
      const o = parseLine(line);
      const m = o && o.type === 'assistant' ? o.message : null;
      if (!m || !m.usage || typeof m.usage !== 'object' || m.model === '<synthetic>') return false;
      const at = Date.parse(o.timestamp);
      if (!last) last = { model: m.model, usage: m.usage, at };
      if (compact) return true; // only the model is wanted from before the compact
      if (!cacheReq && touchedCache(m.usage)) cacheReq = { at };
      if (!ttl) ttl = cacheTtlOf(m.usage);
      visited++;
      return (cacheReq && ttl) || (cacheReq && visited > 200);
    });
  } catch {
    // unreadable: report what was found
  }
  if (compact) return compactedStats(compact, last && last.model);
  if (!last) return { model: null, contextUsed: null, contextWindow: null, contextPct: null, cache: { ttl: null, lastAt: null, expiresAt: null }, lastUsage: null };
  return buildStats(last, cacheReq, ttl);
}

// Live runs: numbers from one assistant stream event. Remembers the cache TTL per session, because a
// request that only read the cache does not say which TTL it was written with.
const liveCache = new Map(); // sessionId -> { ttl, at }

export function statsFromAssistantEvent(sessionId, event) {
  const m = event && event.message;
  if (!m || !m.usage || typeof m.usage !== 'object' || m.model === '<synthetic>') return null;
  if (event.isSidechain || event.parent_tool_use_id) return null; // subagent request, not the main thread
  const t = Date.parse(event.timestamp);
  const at = Number.isFinite(t) ? t : Date.now();
  const prev = liveCache.get(sessionId) || null;
  const ttl = cacheTtlOf(m.usage) || (prev && prev.ttl) || null;
  if (touchedCache(m.usage)) liveCache.set(sessionId, { ttl, at });
  if (liveCache.size > 200) liveCache.delete(liveCache.keys().next().value);
  const cur = liveCache.get(sessionId) || null;
  return buildStats({ model: m.model, usage: m.usage, at }, cur ? { at: cur.at } : null, cur ? cur.ttl : ttl);
}

// Same stats with the window and percentage looked up again (after a finished run reported the exact window).
export function withCurrentWindow(stats) {
  const window = contextWindowFor(stats.model);
  const pct = window && Number.isFinite(stats.contextUsed) ? Math.max(0, Math.min(100, Math.round((stats.contextUsed / window) * 1000) / 10)) : null;
  return { ...stats, contextWindow: window, contextPct: pct };
}

// ---- Warm the title cache in the background, so the first list is quick ----

async function warm() {
  try {
    for (const e of await files()) await readMeta(e);
  } catch {
    // best effort
  }
}
setTimeout(warm, 3000).unref();

// ---- Project tags (background scan of the tool calls, see tags.js) ----

startTagScanner({ listFiles: files, projectsDir: PROJECTS_DIR });

// One tag pass right now (used by tests).
export function scanTagsNow() {
  invalidate('sessions:scan');
  return runTagPass();
}
