// Crew: who is working on a project right now, read from the Claude transcripts. Read only.
// A session counts as active when its transcript changed in the last 2 minutes, when Mission Control has a run
// going for it, or when it has running subagents.
// Subagents come from two places:
//   1. the sidecar folder of the session (<session>/subagents/agent-*.jsonl plus agent-*.meta.json): a subagent
//      is running when its own transcript changed in the last 90 s and it did not hand back its result yet;
//   2. Agent/Task tool calls in the tail of the main transcript that were not answered yet (covers the moment
//      before the sidecar file exists).
// Attribution: a session is first tied to a project by its cwd (done by sessions.js). Sessions started from a
// folder that is no project (for example D:\Dev) are attributed by the paths their tool calls touch: each
// subagent goes to the project that holds most of the paths it used, and the Captain shows up on every project
// that has such a subagent or was touched by the main thread in the last 2 minutes.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME } from '../config.js';
import { cached } from '../lib/cache.js';
import { listSessions } from './sessions.js';
import { listRuns } from './runs.js';
import { loadCatalog } from './catalog.js';
import { classifyUserEntry } from './userKinds.js';

const HOME = process.env.MC_CLAUDE_HOME ? path.resolve(process.env.MC_CLAUDE_HOME) : CLAUDE_HOME;
const PROJECTS_DIR = path.join(HOME, 'projects');
const ACTIVE_MS = 2 * 60 * 1000; // transcript changed this recently: somebody is working
const LOOKBACK_MS = 3 * 60 * 60 * 1000; // sessions older than this are not even looked at
const SIDECAR_MS = 10 * 60 * 1000; // sessions changed this recently get their subagent folder listed
const AGENT_LIVE_MS = 90 * 1000; // a subagent whose own transcript is quieter than this is not running
const AGENT_QUIET_MS = 6 * 60 * 1000; // same for a foreground subagent (its parent waits for it), and for unmatched calls
const TOUCH_MS = 2 * 60 * 1000; // main thread touched a project's files this recently: the Captain is there
const MAX_AGENT_FILES = 400; // never stat more subagent files than this per session
const MAX_AGENTS = 60; // most subagents analyzed per session
const TAIL_RECORDS = 200;
const TAIL_START = 256 * 1024;
const TAIL_CAP = 4 * 1024 * 1024;
const MAX_LINE = 3 * 1024 * 1024;
const PATH_WINDOW = 64 * 1024; // tail window the touched paths are read from
const PATH_WINDOW_WIDE = 256 * 1024; // used once when the small window holds fewer than 3 whole lines
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const DONE_STATES = /<status>\s*(completed|failed|killed|cancelled|stopped|error)/i;

const tailCache = new Map(); // file -> { mtimeMs, size, analysis }
const agentCache = new Map(); // file -> { mtimeMs, size, info }
const metaCache = new Map(); // file -> meta of a subagent (static once written)

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 3).trimEnd() + '...' : t;
}

// Last `count` parseable records of a file, oldest first.
function readTail(file, size, count) {
  const fd = fs.openSync(file, 'r');
  try {
    let want = Math.min(size, TAIL_START);
    for (;;) {
      const start = size - want;
      const buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, start);
      const lines = buf.toString('utf8', 0, n).split('\n');
      if (start > 0) lines.shift(); // cut-off first line
      const out = [];
      for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
        const line = lines[i];
        if (!line || line[0] !== '{' || line.length > MAX_LINE) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // half-written line, ignore
        }
      }
      if (out.length >= count || want >= size || want >= TAIL_CAP) return out.reverse();
      want = Math.min(size, want * 2);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// The lines of the last `bytes` of a file as raw text (no parsing), without the cut-off first line.
function readLines(file, size, bytes) {
  const want = Math.min(size, bytes);
  if (!want) return [];
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(want);
    const n = fs.readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString('utf8', 0, n).split('\n');
    if (size > want) lines.shift();
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function tailLines(file, size) {
  let lines = readLines(file, size, PATH_WINDOW);
  if (lines.length < 3 && size > PATH_WINDOW) lines = readLines(file, size, PATH_WINDOW_WIDE);
  return lines;
}

function cleanText(raw) {
  let t = String(raw || '').replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/\*\*|__/g, '');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*[#>*-]+\s*/gm, '');
  t = t.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/); // first sentence when there is one
  return clip(m ? m[1] : t, 120);
}

function toolHint(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  if (typeof i.file_path === 'string') return clip(base(i.file_path), 40);
  if (typeof i.path === 'string' && i.path) return clip(base(i.path), 40);
  if (typeof i.command === 'string') return clip(i.command, 48);
  if (typeof i.pattern === 'string') return clip(i.pattern, 40);
  if (typeof i.query === 'string') return clip(i.query, 48);
  if (typeof i.url === 'string') return clip(i.url.replace(/^https?:\/\//, ''), 48);
  if (typeof i.description === 'string') return clip(i.description, 48);
  return '';
}

// ---- Projects and touched paths ----

function norm(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// Project folders and their old folder names (aliases).
function projectFolders() {
  const out = [];
  for (const p of loadCatalog()) {
    if (!p || !p.id || !p.folder) continue;
    out.push({ id: p.id, folder: norm(p.folder) });
    for (const a of Array.isArray(p.aliases) ? p.aliases : []) if (typeof a === 'string' && a) out.push({ id: p.id, folder: norm(a) });
  }
  return out;
}

// Longest-prefix match on a separator boundary, case-insensitive. Returns the project id or null.
function projectOfPath(p, folders) {
  const c = norm(p);
  let best = null;
  for (const f of folders) {
    if (c === f.folder || c.startsWith(f.folder + '\\')) {
      if (!best || f.folder.length > best.folder.length) best = f;
    }
  }
  return best ? best.id : null;
}

const KV_RE = /"(file_path|notebook_path|path|cwd|command)":"((?:[^"\\]|\\.)*)"/g;
const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s"'`<>|;&()*?]*/g;
const GIT_PATH_RE = /(?<![\w.:/\\])\/([A-Za-z])\/[^\s"'`<>|;&()*?]+/g; // /d/dev/x as written by Git Bash
const STAMP_RE = /"timestamp":"([^"]+)"/;

function unescapeJson(v) {
  try {
    return JSON.parse('"' + v + '"');
  } catch {
    return v;
  }
}

// Absolute paths used by the tool calls on the lines, each with the time of its record.
// Only lines holding a tool_use are read, so tool results (file contents) never count.
function touchedPaths(lines) {
  const out = []; // { p, at }
  for (const line of lines) {
    if (!line.includes('"type":"tool_use"')) continue;
    const stamp = STAMP_RE.exec(line);
    const at = stamp ? Date.parse(stamp[1]) : NaN;
    const when = Number.isFinite(at) ? at : null;
    for (const m of line.matchAll(KV_RE)) {
      const val = unescapeJson(m[2]);
      if (m[1] === 'command') {
        for (const w of val.matchAll(WIN_PATH_RE)) out.push({ p: w[0], at: when });
        for (const g of val.matchAll(GIT_PATH_RE)) out.push({ p: g[1].toUpperCase() + ':' + g[0].slice(2), at: when });
      } else if (/^[A-Za-z]:[\\/]/.test(val)) {
        out.push({ p: val, at: when });
      }
    }
  }
  return out;
}

// The project that holds most of the paths (ties go to the one used last), or null when none matches.
function dominantProject(paths, folders) {
  const score = new Map(); // id -> { n, last }
  paths.forEach((t, i) => {
    const id = projectOfPath(t.p, folders);
    if (!id) return;
    const s = score.get(id) || { n: 0, last: 0 };
    s.n++;
    s.last = i;
    score.set(id, s);
  });
  let best = null;
  for (const [id, s] of score) if (!best || s.n > best.s.n || (s.n === best.s.n && s.last > best.s.last)) best = { id, s };
  return best ? best.id : null;
}

// ---- Main transcript ----

// Reads the tail of one transcript. Pure (depends only on the file), so it is cached by mtime and size.
function analyze(entry) {
  const hit = tailCache.get(entry.file);
  if (hit && hit.mtimeMs === entry.mtimeMs && hit.size === entry.size) return hit.analysis;
  let records = [];
  let touched = [];
  try {
    records = readTail(entry.file, entry.size, TAIL_RECORDS);
    touched = touchedPaths(tailLines(entry.file, entry.size));
  } catch {
    records = [];
  }
  const pending = new Map(); // tool_use id -> agent
  const doneIds = new Set(); // tool use ids that a task notification reported as finished
  let lastTool = null;
  let text = null;
  for (const o of records) {
    if (!o || o.isSidechain) continue;
    const at = typeof o.timestamp === 'string' ? o.timestamp : null;
    const content = o.message && o.message.content;
    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          text = { text: cleanText(b.text), at };
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          const input = b.input && typeof b.input === 'object' ? b.input : {};
          if (AGENT_TOOLS.has(b.name) && typeof b.id === 'string') {
            pending.set(b.id, {
              id: b.id,
              type: clip(input.subagent_type || 'general-purpose', 40),
              description: clip(input.description || input.prompt || 'Working', 80),
              model: typeof input.model === 'string' ? clip(input.model, 40) : null,
              background: input.run_in_background === true,
              startedAt: at,
            });
          } else {
            lastTool = { name: clip(b.name, 40), hint: toolHint(b.name, input), at };
          }
        }
      }
    } else if (o.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || b.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
          const async = o.toolUseResult && (o.toolUseResult.isAsync === true || o.toolUseResult.status === 'async_launched');
          if (!async) pending.delete(b.tool_use_id); // answered: the subagent is done
        }
      }
      // A background subagent ends with a task notification that names its tool use. Only a record the CLI
      // injected counts: the words inside a tool result or in a message of the user's do not.
      const note = classifyUserEntry(o);
      if (note.kind === 'notice' && note.type === 'task') {
        const id = note.toolUseId;
        if (id && DONE_STATES.test(note.text)) {
          pending.delete(id);
          doneIds.add(id);
        }
      }
    }
  }
  const analysis = { agents: [...pending.values()], doneIds, lastTool, text, touched };
  tailCache.set(entry.file, { mtimeMs: entry.mtimeMs, size: entry.size, analysis });
  if (tailCache.size > 200) tailCache.delete(tailCache.keys().next().value);
  return analysis;
}

// ---- Subagent transcripts (sidecar folder) ----

function readMeta(file) {
  const hit = metaCache.get(file);
  if (hit) return hit;
  try {
    const m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    if (m && typeof m === 'object') {
      metaCache.set(file, m);
      if (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value);
      return m;
    }
  } catch {
    // no meta file (yet)
  }
  return null;
}

// Whole tail records of a subagent file that show it handed its result back (the harness' SubagentHandback
// call) or that its last model turn ended normally.
function endedIn(lines) {
  const last = lines.slice(-4);
  for (const l of last) if (l.includes('"name":"SubagentHandback"')) return true;
  for (let i = last.length - 1; i >= 0; i--) {
    const l = last[i];
    if (!l.includes('"type":"assistant"')) continue;
    return l.includes('"stop_reason":"end_turn"') && !l.includes('"type":"tool_use"');
  }
  return false;
}

// Reads facts about one subagent file from a bounded tail window (last 64 KB). Cached by mtime and size.
function analyzeAgent(file, mtimeMs, size) {
  const hit = agentCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.info;
  let lines = [];
  try {
    lines = tailLines(file, size);
  } catch {
    lines = [];
  }
  let lastTool = null;
  for (let i = lines.length - 1; i >= 0 && !lastTool; i--) {
    const l = lines[i];
    if (!l.includes('"type":"assistant"') || !l.includes('"type":"tool_use"') || l.length > 256 * 1024) continue;
    try {
      const o = JSON.parse(l);
      const uses = (o.message && Array.isArray(o.message.content) ? o.message.content : []).filter((b) => b && b.type === 'tool_use' && b.name !== 'SubagentHandback');
      const b = uses[uses.length - 1];
      if (b) lastTool = { name: clip(b.name, 40), hint: toolHint(b.name, b.input), at: typeof o.timestamp === 'string' ? o.timestamp : null };
    } catch {
      // half-written line
    }
  }
  const info = { ended: endedIn(lines), lastTool, touched: touchedPaths(lines) };
  agentCache.set(file, { mtimeMs, size, info });
  if (agentCache.size > 300) agentCache.delete(agentCache.keys().next().value);
  return info;
}

// The subagent transcripts of a session that were written recently enough to be running.
// Returns [{ file, agentId, mtimeMs, birthMs, meta }], newest first.
function recentSubagents(dir, sessionId, now) {
  const folder = path.join(PROJECTS_DIR, dir, sessionId, 'subagents');
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const out = [];
  let stats = 0;
  for (const n of names) {
    if (!n.endsWith('.jsonl') || !n.startsWith('agent-')) continue;
    if (++stats > MAX_AGENT_FILES) break;
    const file = path.join(folder, n);
    try {
      const st = fs.statSync(file);
      if (now - st.mtimeMs <= AGENT_QUIET_MS && st.size > 0) out.push({ file, agentId: n.slice(6, -6), mtimeMs: st.mtimeMs, size: st.size, birthMs: st.birthtimeMs });
    } catch {
      // vanished
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, MAX_AGENTS).map((f) => ({ ...f, meta: readMeta(f.file) }));
}

// ---- Scan of all sessions (shared by every project, cached) ----

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Running subagents of one session, each with the project it works on (null: no path matched).
function runningAgents(s, a, mtimeMs, now, folders) {
  const pendingById = new Map(a.agents.map((g) => [g.id, g]));
  const files = mtimeMs !== null && (now - mtimeMs <= SIDECAR_MS || a.agents.length > 0) ? recentSubagents(s.dir, s.id, now) : [];
  const out = [];
  const matched = new Set();
  for (const f of files) {
    const tid = f.meta && typeof f.meta.toolUseId === 'string' ? f.meta.toolUseId : null;
    const pend = tid ? pendingById.get(tid) : null;
    if (tid) matched.add(tid);
    if (tid && a.doneIds.has(tid)) continue;
    const info = analyzeAgent(f.file, f.mtimeMs, f.size);
    if (info.ended) continue;
    const limit = pend && !pend.background ? AGENT_QUIET_MS : AGENT_LIVE_MS;
    if (now - f.mtimeMs > limit) continue;
    const meta = f.meta || {};
    out.push({
      id: tid || f.agentId,
      type: clip(meta.agentType || (pend && pend.type) || 'general-purpose', 40),
      description: clip(meta.description || (pend && pend.description) || 'Working', 80),
      model: pend && pend.model ? pend.model : meta.model ? clip(meta.model, 40) : null,
      background: pend ? pend.background : meta.requestShape === 'background',
      startedAt: (pend && pend.startedAt) || iso(f.birthMs),
      agentId: f.agentId,
      source: 'sidecar',
      lastAt: iso(f.mtimeMs),
      lastTool: info.lastTool,
      project: dominantProject(info.touched, folders),
    });
  }
  // Calls in the main transcript that have no sidecar file (yet): the old rule, by the time they started.
  for (const g of a.agents) {
    if (matched.has(g.id)) continue;
    const startMs = Date.parse(g.startedAt);
    if (!Number.isFinite(startMs) || now - startMs > AGENT_QUIET_MS) continue;
    out.push({ ...g, agentId: null, source: 'transcript', lastAt: g.startedAt, lastTool: null, project: null });
  }
  return out;
}

async function scanAll() {
  const now = Date.now();
  const folders = projectFolders();
  const all = await listSessions({ limit: 200 });
  const records = [];
  for (const s of all) {
    const lastMs = Date.parse(s.lastAt);
    if (!Number.isFinite(lastMs) || now - lastMs > LOOKBACK_MS) continue;
    const file = path.join(PROJECTS_DIR, s.dir, s.id + '.jsonl');
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const a = analyze({ file, mtimeMs: st.mtimeMs, size: st.size });
    const agents = runningAgents(s, a, st.mtimeMs, now, folders);
    // Projects the main thread touched just now (only used for sessions that belong to no project).
    const touchedNow = new Set();
    if (!s.project) {
      for (const t of a.touched) {
        if (t.at === null || now - t.at > TOUCH_MS) continue;
        const id = projectOfPath(t.p, folders);
        if (id) touchedNow.add(id);
      }
    }
    records.push({ s, lastMs, a, agents, touchedNow });
  }
  return records;
}

function scan() {
  return cached('crew:scan', 3000, scanAll);
}

function publicAgent(g) {
  const { project: _p, ...rest } = g;
  return rest;
}

async function build(projectId) {
  const now = Date.now();
  const records = await scan();
  const runs = listRuns().filter((r) => r.projectId === projectId && r.state === 'running');
  const runBySession = new Map(runs.filter((r) => r.sessionId).map((r) => [String(r.sessionId).toLowerCase(), r]));
  const sessions = [];
  for (const rec of records) {
    const { s, lastMs, a } = rec;
    const home = s.project || null;
    const isHome = home === projectId;
    // An agent belongs to the project its paths point at; without paths it stays with the session's own project.
    const agents = rec.agents.filter((g) => (g.project || home) === projectId).map(publicAgent);
    const run = isHome ? runBySession.get(s.id.toLowerCase()) || null : null;
    let active;
    if (isHome) active = now - lastMs < ACTIVE_MS || !!run || agents.length > 0;
    else active = agents.length > 0 || (!home && rec.touchedNow.has(projectId));
    if (!active) continue;
    sessions.push({
      id: s.id,
      title: s.title,
      lastAt: s.lastAt,
      model: s.model || null,
      running: !!run,
      runId: run ? run.runId : null,
      lastTool: a.lastTool,
      text: a.text ? a.text.text : null,
      textAt: a.text ? a.text.at : null,
      agents,
      attribution: isHome ? 'cwd' : 'paths',
    });
  }
  // A run that has no session id yet (the CLI is still starting) still means the captain is busy.
  for (const r of runs) {
    if (r.sessionId) continue; // it has a session: listed above, or the next call finds it
    sessions.push({ id: null, title: clip(r.promptPreview || 'New session', 80), lastAt: r.startedAt, running: true, runId: r.runId, lastTool: null, text: null, textAt: null, agents: [], attribution: 'cwd' });
  }
  sessions.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  return { project: projectId, generatedAt: new Date(now).toISOString(), sessions };
}

export function getCrew(projectId) {
  return cached(`crew:${projectId}`, 3000, () => build(projectId));
}
