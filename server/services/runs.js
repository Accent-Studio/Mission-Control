// Chat runs: one Claude Code CLI process per conversation, kept alive between messages, speaking stream-json
// on stdin and stdout. Its JSON lines are streamed to SSE. The CLI is started directly (never through a shell
// or a .cmd file); messages travel as JSON lines on stdin, so no prompt is ever a command line argument.
//
// Who owns the process. Normally the runner (server/runner/index.js, started once on a cold start by run-server.bat, like
// the phone bridge) starts and keeps the claude processes, so a restart of this server (exit code 75) no longer ends the
// running conversations or their background helpers. This file keeps all the logic about a conversation: turns, seq
// numbers, permission questions, Remote Control, idle and background-work tracking. runnerClient.js is the one door to the
// process (the runner, or a direct child of this server when no runner is reachable; the log says which).
//
// After a restart the server builds each run's record again from the runner: its meta (what startRun knew), its last
// checkpoint (this file's small state at a quiet moment) and its journal (every stdout line and every action of this
// server since then, in order). The journal is replayed through the very same code that handled it live, with publishing,
// timers and writes to the process switched off (ctx.replay) and the clock set to each entry's own time. So the record
// ends in the state it was in, with the same seq numbers and the same pending permission questions, and the pages' own
// "seq" bookkeeping keeps working: an event is applied once, and a gap makes a page read the live turn again.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { run } from '../lib/run.js';
import { clientCount, onClientConnect, publish, sendTo } from '../lib/events.js';
import { resolveClaude } from '../lib/claudeExe.js';
import { getProject, loadCatalog } from './catalog.js';
import { isUuid, getSessionInfo, getSessionStats, statsFromAssistantEvent, noteContextWindow, withCurrentWindow, catalogModels, liveSendFileImages, transcriptSize } from './sessions.js';
import { buildContent, cacheImage } from './uploads.js';
import { ingestRateLimitEvent } from './usage.js';
import { PERSONAS, personaPromptFile, personaEvent } from './persona.js';
import { classifyUserEntry, rawTextOf } from './userKinds.js';
import { adoptRunnerProc, onAttach, onLost, runnerReady, spawnProc, startRunnerClient } from './runnerClient.js';
import { getVoicePrefs } from './voice.js';
import { isArchived, isOneOff, setOneOff, isLocked } from './sessionMeta.js';
import { nameConversation } from './autoTitle.js';
import { DEFAULT_CWD } from '../config.js'; // also one of the folders the runner accepts (runner/shared.js)

const MAX_CONCURRENT = 3;
const MAX_FINISHED = 20;
const MAX_PROMPT = 20000;

// What the chat can ask for. Only these values ever reach the command line: "default" means no flag, and
// bypassPermissions and dontAsk are deliberately not offered.
// Models are full ids (never aliases, because an alias such as "sonnet" can resolve to another version than
// the label says). The list comes from the CLI's own model catalog, with this table as the fallback.
const FALLBACK_MODELS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'sonnet' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', family: 'haiku' },
];
const FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];

// ---- Installed CLI version (read once, cached) ----

let installedVersion = null; // "2.1.278", or null while unknown or when it could not be read
let versionReady = null;

export function claudeVersion() {
  if (!versionReady) {
    versionReady = (async () => {
      try {
        const e = await resolveClaude();
        const r = await run(e.cmd, [...e.pre, '--version'], { timeoutMs: 15000 });
        const m = /(\d+(?:\.\d+){1,3})/.exec(r.stdout);
        if (r.code === 0 && m) installedVersion = m[1];
      } catch {
        // unknown version: no model is disabled because of it
      }
      return installedVersion;
    })();
  }
  return versionReady;
}

// True when version a is older than version b (numeric, segment by segment).
function olderThan(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0;
  }
  return false;
}

function modelOptions() {
  let list = [];
  try {
    list = catalogModels();
  } catch {
    list = [];
  }
  if (!list.length) list = FALLBACK_MODELS;
  const rank = (m) => {
    const i = FAMILY_ORDER.indexOf(m.family);
    return i < 0 ? FAMILY_ORDER.length : i;
  };
  // Version of a model id as numbers ("claude-haiku-5-5" is [5, 5], "claude-haiku-4-5-20251001" is [4, 5]); the
  // pages take the first model of a family, so within a family the newest version must come first.
  const versionOf = (id) => {
    const m = /^claude-[a-z]+-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
    return m ? [Number(m[1]), Number(m[2] || 0)] : [0, 0];
  };
  const sorted = list
    .map((m, i) => ({ m, i, v: versionOf(m.id) }))
    .sort((x, y) => rank(x.m) - rank(y.m) || y.v[0] - x.v[0] || y.v[1] - x.v[1] || x.i - y.i)
    .map((x) => x.m);
  return [
    { id: 'default', label: 'Default', flag: null },
    ...sorted.map((m) => {
      const o = { id: m.id, label: m.label, flag: m.id };
      if (m.minVersion && installedVersion && olderThan(installedVersion, m.minVersion)) {
        o.disabled = true;
        o.reason = `Needs Claude Code ${m.minVersion} or newer (run: claude update)`;
      }
      return o;
    }),
  ];
}

const MODES = [
  { id: 'default', label: 'Ask first', flag: null },
  { id: 'acceptEdits', label: 'Accept edits', flag: 'acceptEdits' },
  { id: 'plan', label: 'Plan', flag: 'plan' },
  { id: 'auto', label: 'Auto', flag: 'auto' },
];
const EFFORTS = [
  { id: 'default', label: 'Default', flag: null },
  { id: 'low', label: 'Low', flag: 'low' },
  { id: 'medium', label: 'Medium', flag: 'medium' },
  { id: 'high', label: 'High', flag: 'high' },
  { id: 'xhigh', label: 'Extra high', flag: 'xhigh' },
  { id: 'max', label: 'Max', flag: 'max' },
];

export async function chatOptions() {
  await claudeVersion();
  const strip = (list) => list.map(({ id, label, disabled, reason }) => (disabled ? { id, label, disabled: true, reason } : { id, label }));
  return { models: strip(modelOptions()), modes: strip(MODES), efforts: strip(EFFORTS) };
}

// Returns the CLI flag value for an option, null for "default", or throws 400 for anything not on the list.
function optionFlag(list, value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw fail(400, `${name} must be a string`);
  const hit = list.find((o) => o.id === value);
  if (!hit) throw fail(400, `unknown ${name}`);
  if (hit.disabled) throw fail(400, hit.reason);
  return hit.flag;
}

const runs = new Map(); // runId -> record

// Finding the real claude entry point lives in lib/claudeExe.js (the runner uses the same code to check what it starts).
export { resolveClaude };

// ---- What is being applied right now ----
// Everything that changes a record runs under a context: the entry from the journal being applied (a stdout line, the end of
// the process, or something this server did) and whether it is a replay after a restart. In a replay nothing leaves the
// server (no publish, no write to the process, no timer, no file) and the clock reads the entry's own time, so the record
// comes out as it was. With no entry (a plain call from a route) the clock is the real one.
const NO_CTX = { replay: false, t: 0, entry: null, outN: 0 };
let ctx = NO_CTX;

const tnow = () => (ctx.t || Date.now());
const isoNow = () => new Date(tnow()).toISOString();

// Runs fn with the clock of an entry (and as a replay or not). Nested use keeps the outer replay flag.
function within(next, fn) {
  const prev = ctx;
  ctx = { ...prev, ...next };
  try {
    return fn();
  } finally {
    ctx = prev;
  }
}

// publish() that stays quiet in a replay (the pages already saw those events, or read the turn again).
function pub(type, data) {
  if (!ctx.replay) publish(type, data);
}

// ---- Run records ----
// One record per claude process. The record lives as long as the process: starting (spawned, nothing heard yet),
// working (a turn is in progress), idle (a turn ended and no message waits), then done, failed or stopped.

const IDLE_MS = Number(process.env.MC_IDLE_MS) || 10 * 60 * 1000; // an idle process is closed after this long
const MAX_IDLE = Number(process.env.MC_IDLE_MAX) || 4; // at most this many idle processes stay open
const PERMISSION_MS = Number(process.env.MC_PERMISSION_MS) || 15 * 60 * 1000; // no answer by then: deny
const KILL_AFTER_CLOSE_MS = 15000; // a process that ignores a closed stdin is killed after this long
// Background work (helper agents, background shell commands) started in a turn keeps a run from being closed as idle. A
// task whose "finished" event was lost is forgotten after this long, so it cannot keep a process forever.
const BG_MAX_MS = Number(process.env.MC_BG_MAX_MS) || 4 * 60 * 60 * 1000;
const BG_MAX_TASKS = 256;
const CHECKPOINT_EVERY = 200; // journal lines handled while idle before the runner may drop them

const isLive = (r) => r.state === 'starting' || r.state === 'working' || r.state === 'idle';
const isBusy = (r) => r.state === 'starting' || r.state === 'working';

function publicRun(r) {
  return {
    runId: r.runId,
    projectId: r.projectId,
    sessionId: r.sessionId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    state: r.state,
    running: isBusy(r),
    promptPreview: r.promptPreview,
    ...(r.pending.size ? { pending: r.pending.size } : {}),
    ...(r.bg.size ? { background: r.bg.size } : {}), // background tasks still running (such a run is idle but is not closed)
    ...(r.turn.events.length ? { liveEvents: r.turn.events.length } : {}), // events kept for a page that joins the turn (gone when it ends)
    ...(r.remote.state !== 'off' ? { remote: r.remote.state } : {}),
    ...(r.remote.state === 'on' && r.remote.url ? { remoteUrl: r.remote.url } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

function prune() {
  const finished = [...runs.values()].filter((r) => !isLive(r)).sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  for (const r of finished.slice(MAX_FINISHED)) runs.delete(r.runId);
}

export function listRuns() {
  const all = [...runs.values()];
  const live = all.filter(isLive).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const done = all.filter((r) => !isLive(r)).sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, MAX_FINISHED);
  return [...live, ...done].map(publicRun);
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---- Starting a run ----

// Claude Code finds a session by its working folder, so a resumed run must start in the folder
// the session was recorded in. The folder comes from the transcript, never from the request.
// Returns that folder, or fallback when no session id is given.
export async function resolveSessionCwd(sessionId, fallback = DEFAULT_CWD) {
  if (!sessionId) return fallback;
  const info = await getSessionInfo(sessionId);
  if (!info) throw fail(404, 'Unknown session');
  const cwd = info.cwd;
  if (typeof cwd !== 'string' || !/^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes('\0')) {
    throw fail(409, 'The session has no usable working folder recorded, so it cannot be resumed here');
  }
  let ok = false;
  try {
    ok = fs.statSync(cwd).isDirectory();
  } catch {
    ok = false;
  }
  if (ok) return cwd;
  const moved = mapMovedFolder(cwd);
  if (moved) return moved;
  throw fail(409, `The session's working folder no longer exists (${cwd}), so it cannot be resumed`);
}

// A recorded folder that is gone may belong to a project that moved: its old folders are the catalog aliases.
// The old path (or a subfolder of it) maps to the same place under the project's current folder.
// Returns that existing folder, or null when no alias matches or the mapped folder does not exist.
function mapMovedFolder(cwd) {
  const clean = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '');
  const c = clean(cwd);
  const lc = c.toLowerCase();
  let best = null;
  for (const p of loadCatalog()) {
    if (!p || !p.folder) continue;
    for (const a of Array.isArray(p.aliases) ? p.aliases : []) {
      const na = clean(a).toLowerCase();
      if (!na) continue;
      if ((lc === na || lc.startsWith(na + '\\')) && (!best || na.length > best.len)) best = { folder: p.folder, len: na.length };
    }
  }
  if (!best) return null;
  const target = best.folder.replace(/[\\/]+$/, '') + c.slice(best.len);
  try {
    return fs.statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
}

// True while a run is starting or working on this session (an idle process does not count: it can be closed at will).
export function isSessionBusy(sessionId) {
  const id = String(sessionId || '').toLowerCase();
  if (!id) return false;
  for (const r of runs.values()) if (isBusy(r) && r.sessionId && r.sessionId.toLowerCase() === id) return true;
  return false;
}

// The live process (starting, working or idle, and not being closed) that holds this session, or null.
function findLive(sessionId) {
  const id = String(sessionId || '').toLowerCase();
  if (!id) return null;
  for (const r of runs.values()) if (isLive(r) && !r.closing && r.sessionId && r.sessionId.toLowerCase() === id) return r;
  return null;
}

// Closes the idle processes of a session and waits for them (used before the session is deleted).
export async function releaseSession(sessionId) {
  const id = String(sessionId || '').toLowerCase();
  const waits = [];
  for (const r of runs.values()) {
    if (r.state === 'idle' && r.sessionId && r.sessionId.toLowerCase() === id) {
      killTree(r);
      waits.push(Promise.race([r.exited, new Promise((res) => setTimeout(res, 5000).unref())]));
    }
  }
  await Promise.all(waits);
}

const lastOpts = new Map(); // session id (lowercase) -> { model, mode, effort, cwd } of its last run, kept in memory

function rememberOpts(rec) {
  if (!rec.sessionId) return;
  lastOpts.set(rec.sessionId.toLowerCase(), { model: rec.opts.model, mode: rec.opts.mode, effort: rec.opts.effort, cwd: rec.cwd, oneOff: !!rec.oneOff });
  if (lastOpts.size > 200) lastOpts.delete(lastOpts.keys().next().value);
  if (ctx.replay) return; // already on disk from the first time
  // The one-off flag also goes to the conversation's notes on disk: the memory above is gone after a restart of the server,
  // and a resume from the Talk page (which says nothing about it) must still keep the conversation off claude.ai.
  try {
    setOneOff(rec.sessionId, !!rec.oneOff);
  } catch (err) {
    console.error('[runs] could not save the one-off flag:', err.message);
  }
}

function checkPrompt(prompt, hasAttachments) {
  if (prompt === undefined || prompt === null) prompt = '';
  if (typeof prompt !== 'string') throw fail(400, 'prompt must be a string');
  if (!prompt.trim() && !hasAttachments) throw fail(400, 'prompt is required');
  if (prompt.length > MAX_PROMPT) throw fail(400, `prompt is longer than ${MAX_PROMPT} characters`);
  if (prompt.includes('\0')) throw fail(400, 'prompt must not contain NUL characters');
  return prompt;
}

const busyCount = () => [...runs.values()].filter(isBusy).length;

// A locked conversation is read only (sessionMeta.js): every way of sending to it ends here.
const LOCKED = 'This conversation is locked. Unlock it to send.';

// ---- Starting a run, or joining the live one ----

// The processes of a conversation that are closing must be gone before the next one resumes it: two at once would split
// the transcript in two. One still there after 5s is killed; if even that has not ended it 5s later, nothing is started
// (503: the page says so, Send later and At 5 min left try again a minute later).
async function untilGone(recs) {
  const wait = () => Promise.race([Promise.all(recs.map((r) => r.exited)), new Promise((res) => setTimeout(res, 5000).unref())]);
  await wait();
  const left = recs.filter(isLive);
  if (!left.length) return;
  for (const r of left) killTree(r);
  await wait();
  if (recs.some(isLive)) throw fail(503, 'The last process of this conversation is still closing. Try again in a moment.');
}

// A message for a conversation. If a live process already holds the conversation the message goes to its stdin
// ({ runId, joined: true }), otherwise a process starts ({ runId }).
// remote: false keeps the new process off claude.ai (Remote Control). A one-off task (Commit, Review and push, a skill
// chip) sets it and the conversation remembers it (remote: true turns it back on); a conversation the user holds (the Talk page, the Com Link) leaves it out, and it defaults to on.
export async function startRun({ prompt, attachments, projectId, sessionId, model, mode, effort, persona, remote } = {}) {
  await claudeVersion();
  await runnerReady(); // after a restart, the conversations the runner kept must be taken over before a new message is placed
  if (persona !== undefined && persona !== null && !PERSONAS.includes(persona)) throw fail(400, 'unknown persona');
  if (remote !== undefined && remote !== null && typeof remote !== 'boolean') throw fail(400, 'remote must be true or false');
  if (sessionId !== undefined && sessionId !== null && sessionId !== '' && !isUuid(sessionId)) {
    throw fail(400, 'sessionId must be a uuid');
  }
  if (sessionId && isLocked(sessionId)) throw fail(409, LOCKED);
  // A reply that names no model, mode or effort keeps what this conversation used last (a Haiku push review stays Haiku).
  const explicit = !(model === undefined && mode === undefined && effort === undefined);
  const last = sessionId ? lastOpts.get(String(sessionId).toLowerCase()) : null;
  if (last && !explicit) ({ model, mode, effort } = last);
  else if (last && model === undefined) model = last.model; // no model named: the conversation keeps its own, even when the effort changes
  const cwdHint = last ? last.cwd : null; // a conversation this server ran knows its folder, even before it is indexed
  const modelFlag = optionFlag(modelOptions(), model, 'model');
  const modeFlag = optionFlag(MODES, mode, 'mode');
  const effortFlag = optionFlag(EFFORTS, effort, 'effort');
  const hasFiles = Array.isArray(attachments) && attachments.length > 0;
  prompt = checkPrompt(prompt, hasFiles);
  const content = await buildContent(prompt, attachments);
  if (!content.blocks.length) throw fail(400, 'prompt is required');

  // A live process for this conversation takes the message itself: no new process, no start-up wait.
  const live = sessionId ? findLive(sessionId) : null;
  if (live) {
    const same = live.flags.model === modelFlag && live.flags.mode === modeFlag && live.flags.effort === effortFlag;
    if (same || !explicit) {
      submit(live, content, prompt);
      return { runId: live.runId, joined: true };
    }
    if (live.state !== 'idle' || live.bg.size) {
      // Model, mode and effort are fixed for the life of a process, so a change cannot reach a turn in progress. Nor can it
      // reach an idle process that still has background work running: replacing it would end that work.
      submit(live, content, prompt);
      return { runId: live.runId, joined: true, optionsIgnored: true };
    }
    // Idle and the options differ: close the idle process and start one with the new options (it resumes the conversation).
    act(live, { k: 'close', why: 'options', quiet: true }); // a message arriving meanwhile must not be written to the dying process
    killTree(live);
    await untilGone([live]);
  }
  // A process for this conversation that is shutting down (idle close) must be gone before the next one resumes it.
  if (sessionId) {
    const sid = String(sessionId).toLowerCase();
    const going = [...runs.values()].filter((r) => isLive(r) && r.closing && r.sessionId && r.sessionId.toLowerCase() === sid);
    if (going.length) await untilGone(going);
  }

  let cwd = DEFAULT_CWD;
  let pid = null;
  if (projectId) {
    const p = typeof projectId === 'string' ? getProject(projectId) : null;
    if (!p) throw fail(400, 'unknown projectId');
    if (!fs.existsSync(p.folder)) throw fail(400, 'project folder does not exist');
    cwd = p.folder;
    pid = p.id;
  }
  if (sessionId) cwd = cwdHint && fs.existsSync(cwdHint) ? cwdHint : await resolveSessionCwd(sessionId, cwd);

  // Resolve first, then count and register with no await in between. Counting before an await
  // would let two quick requests both see free capacity and both start.
  const entry = await resolveClaude();
  // Another request for the same conversation may have started its process during the awaits above: join it,
  // never start a second process for one conversation.
  const raced = sessionId ? findLive(sessionId) : null;
  if (raced) {
    submit(raced, content, prompt);
    return { runId: raced.runId, joined: true };
  }
  if (busyCount() >= MAX_CONCURRENT) throw fail(429, `Too many runs at once (limit ${MAX_CONCURRENT})`);

  // The runner checks every one of these: the fixed list, then only these flags with values of the expected shape.
  const args = [...entry.pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--permission-prompt-tool', 'stdio'];
  if (sessionId) args.push('--resume', sessionId);
  if (modelFlag) args.push('--model', modelFlag);
  if (modeFlag) args.push('--permission-mode', modeFlag);
  if (effortFlag) args.push('--effort', effortFlag);
  // The Com Link speaks as its persona: her prompt and memory, read fresh for every process (a resumed one too).
  if (persona) args.push('--append-system-prompt-file', personaPromptFile(persona, getVoicePrefs().comlinkName));

  const runId = crypto.randomUUID();
  const preview = prompt.trim() || content.sent.map((s) => s.name).join(', ');
  const rec = makeRec({
    runId,
    projectId: pid,
    sessionId: sessionId || null,
    startedAtMs: Date.now(),
    promptPreview: preview.replace(/\s+/g, ' ').trim().slice(0, 100),
    cwd,
    opts: { projectId: pid, model, mode, effort },
    persona: persona || null,
    firstPrompt: sessionId ? null : prompt, // a new conversation: its first message names it (autoTitle.js)
    flags: { model: modelFlag, mode: modeFlag, effort: effortFlag },
    // A one-off task: never shown on claude.ai, whatever the switch in Settings says. The flag belongs to the conversation:
    // a later process for it (idle close, options change, a resume that says nothing) keeps it unless remote:true is sent.
    oneOff: remote === false || (remote !== true && !!(sessionId && ((last && last.oneOff) || isOneOff(sessionId)))),
  });
  runs.set(runId, rec);
  rememberOpts(rec);
  beginTurnRecord(rec); // before the first message is written, so the transcript before it is known
  rec.mark0 = rec.turn.mark; // the runner keeps it: a rebuilt record starts its first turn from the same place
  submit(rec, content, prompt);

  // Windows can take a couple of seconds to start the CLI (spawn blocks while the exe is
  // scanned), so answer the request first and launch right after.
  setTimeout(() => {
    if (!isLive(rec)) return; // stopped before it was launched
    launch(entry, args, cwd, rec).catch((err) => console.error('[runs] could not start a run:', err));
  }, 30);

  return { runId };
}

// A fresh record. restoreRun() builds one the same way from what the runner kept.
function makeRec(init) {
  const rec = {
    runId: init.runId,
    projectId: init.projectId,
    sessionId: init.sessionId,
    startedAtMs: init.startedAtMs,
    startedAt: new Date(init.startedAtMs).toISOString(),
    endedAt: null,
    state: 'starting',
    promptPreview: init.promptPreview,
    stopRequested: false,
    error: null,
    outIds: new Map(),
    lastEventAt: init.startedAtMs,
    turnSentAt: 0,
    turnTimer: null,
    turnStartedAt: init.startedAtMs,
    cwd: init.cwd,
    opts: init.opts,
    persona: init.persona,
    firstPrompt: init.firstPrompt || null,
    flags: init.flags,
    pending: new Map(), // requestId -> permission question waiting for an answer
    controls: new Map(), // request id -> function that takes the CLI's answer to a control request of ours
    remote: { state: 'off', asked: false, logged: false, url: null, timer: null, reqId: null }, // Remote Control ("Show on claude.ai"): off, asking, on or failed
    oneOff: init.oneOff,
    seq: 0, // number of the last 'chat' event published for this run (the pages drop an event they already have)
    turn: { events: [], truncated: false, mark: null, bytes: 0 }, // what the turn in progress looks like to a page that joins late
    awaiting: [], // the kept 'sent' events whose replay has not come back yet, oldest first
    unconsumed: 0, // messages written whose replay has not come back yet
    sawReplay: false,
    heard: false, // something has been heard from the process
    replayed: new Set(), // uuids of replays already counted: the CLI may echo a mid-turn message more than once
    outbox: [], // stdin lines and journal entries written before the process exists
    proc: null, // the process handle (runnerClient.js): write, end, kill ...
    lastN: 0, // number of the last journal line (stdout line or end of the process) handled
    cpN: 0, // ... and the one the runner last got a checkpoint for
    cpDue: false,
    replaying: false, // the journal is being replayed after a restart
    bg: new Map(), // background tasks that are running: task id -> { since, type, description }
    pubSeq: 0, // (a record rebuilt after a restart) the last event number the old server is known to have published
    stash: null, // (same) the events numbered after it, for the pages that connect after the restart (see stashEvent)
    given: 0, // the last event number actually handed to a connected page (what the runner is told, see notePublished)
    givenSent: 0, // ... and the value the runner holds
    pubTimer: null,
    bgSystem: false, // the CLI reported background work with its system events (the text of tool results is then not read)
    bgTimer: null,
    idleTimer: null,
    idleSince: 0,
    closing: null, // 'idle' or 'cap' once stdin was closed by us
    closeAt: 0,
    killTimer: null,
    onEnd: null,
  };
  rec.exited = new Promise((resolve) => {
    rec.markExited = resolve;
  });
  return rec;
}

// A message for a run that exists (the Talk page replies with the run id it already holds).
export async function sendToRun(runId, { prompt, attachments } = {}) {
  await runnerReady();
  const rec = runs.get(runId);
  if (!rec) throw fail(404, 'Unknown run');
  if (!isLive(rec) || rec.closing) throw fail(409, 'This run has already ended');
  if (rec.sessionId && isLocked(rec.sessionId)) throw fail(409, LOCKED);
  prompt = checkPrompt(prompt, Array.isArray(attachments) && attachments.length > 0);
  const content = await buildContent(prompt, attachments);
  if (!content.blocks.length) throw fail(400, 'prompt is required');
  submit(rec, content, prompt);
  return { runId, joined: true };
}

// Writes one user message to the process. While the run works, Claude Code takes it in at the next step of the
// turn in progress; while it is idle it starts the next turn at once.
function submit(rec, content, prompt) {
  if (!isLive(rec) || rec.closing) throw fail(409, 'This run has already ended');
  if (rec.replaying) throw fail(503, 'Mission Control is taking this conversation over again after a restart, try again in a moment');
  if (rec.state === 'idle' && busyCount() >= MAX_CONCURRENT) throw fail(429, `Too many runs at once (limit ${MAX_CONCURRENT})`);
  // The message carries an id of our own: the CLI replays it and saves it to the transcript under that id (or, if it
  // ignores ours, the replay tells which id it used, see handleEvent). A page that holds the saved part and the live
  // events matches the two by that id, so a message that is in both shows once.
  const uuid = crypto.randomUUID();
  act(rec, { k: 'user', uuid, prompt, sent: content.sent });
  sendLine(rec, { type: 'user', uuid, message: { role: 'user', content: content.blocks } });
}

// ---- Things this server does to a conversation ----
// A message sent, a question answered, a process closed or killed. Each is one entry in the runner's journal, put after the
// last journal line the server had handled, so that the replay after a restart does them in the same order between the same
// lines. act() is both the effect and the journal write; in a replay it is only the effect (the entry comes from the journal).

function act(rec, e) {
  if (e.t === undefined) e.t = Date.now();
  if (e.after === undefined) e.after = rec.lastN;
  within({ t: e.t, entry: e }, () => {
    switch (e.k) {
      case 'user':
        // A message while idle starts the next turn at once; while the run works it joins the turn in progress.
        if (rec.state === 'idle') {
          clearIdle(rec);
          rec.state = 'working';
          startTurn(rec);
        }
        rec.unconsumed++;
        emit(rec, { sent: { text: e.prompt, attachments: e.sent }, at: isoNow(), uuid: e.uuid });
        break;
      case 'perm':
        applyAnswer(rec, e);
        break;
      case 'close':
        rec.closing = e.why;
        rec.closeAt = e.t;
        clearIdle(rec);
        if (!e.quiet) emit(rec, { closing: e.why });
        break;
      case 'kill':
        rec.stopRequested = true; // the end of a killed process is "stopped", not "failed"
        break;
      default:
        break;
    }
  });
  if (!ctx.replay) {
    if (rec.proc) rec.proc.note(e);
    else rec.outbox.push({ note: e });
  }
}

// ---- What a page sees of the turn in progress ----
// The CLI writes the conversation to its transcript as it goes, so a page that reads the transcript while a turn is
// still running would get the turn's messages twice (once saved, once live). To prevent that, every 'chat' event
// carries a number (seq), and the run keeps the page-relevant events of the turn in progress together with the
// transcript size at the moment the turn began (mark). A page that opens the conversation gets the saved part up
// to the mark and the turn's events from here (GET /api/sessions/:id, field "live"), so the two never overlap.

const MAX_TURN_EVENTS = 4000; // a turn with more events than this is not kept (the page then relies on the saved part)
// ... nor one whose events weigh more than this in total (a flood of big blocks would hold hundreds of MB and be sent whole
// to every page that opens the conversation). The page is told "truncated" and reads the transcript instead.
const MAX_TURN_BYTES = Number(process.env.MC_TURN_BYTES) || 4 * 1024 * 1024;

function markNow(rec) {
  return rec.sessionId ? transcriptSize(rec.sessionId) : 0; // no id yet: a brand new conversation, nothing saved
}

// The transcript size at the start of a turn. A replay cannot ask the transcript (it has grown since), so the live run notes
// the number with the entry that started the turn (a message, or a line the CLI wrote on its own) and the replay reads it back.
function turnMark(rec) {
  const e = ctx.entry;
  if (ctx.replay) {
    if (e && e.mark !== undefined) return e.mark;
    return e && e.a && e.a.mark !== undefined ? e.a.mark : 0;
  }
  const m = markNow(rec);
  if (e) {
    if (e.d === 'out') {
      if (rec.proc) rec.proc.annot(e.n, { mark: m });
    } else e.mark = m;
  }
  return m;
}

function beginTurnRecord(rec) {
  rec.turn = { events: [], truncated: false, mark: turnMark(rec), bytes: 0 };
}

// The turn is over and nobody can join it any more: the kept events are of no use and their memory goes back.
function dropTurnEvents(rec) {
  rec.turn.events = [];
  rec.turn.bytes = 0;
  rec.awaiting = [];
}

// The short form of a tool call the pages show ("Read C:\x\a.js").
function toolHint(input) {
  const out = {};
  if (input && typeof input === 'object') {
    for (const k of ['file_path', 'path', 'command', 'description', 'pattern', 'url']) {
      if (typeof input[k] === 'string') out[k] = input[k].slice(0, 200);
    }
  }
  return out;
}

// The part of a published 'chat' payload a page needs to rebuild the turn, or null when it needs nothing.
function turnPiece(p) {
  if (p.sent) return { sent: p.sent, at: p.at, uuid: p.uuid };
  if (Array.isArray(p.images)) return { images: p.images };
  if (p.permission) return { permission: p.permission };
  if (p.permissionDone != null) return { permissionDone: p.permissionDone, behavior: p.behavior };
  const ev = p.event;
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    const content = [];
    for (const b of ev.message.content) {
      if (b && b.type === 'text' && b.text) content.push({ type: 'text', text: String(b.text).slice(0, 200000) });
      else if (b && b.type === 'tool_use') content.push({ type: 'tool_use', name: String(b.name || 'tool').slice(0, 60), input: toolHint(b.input) });
    }
    return content.length ? { event: { type: 'assistant', message: { content } } } : null;
  }
  if (ev.type === 'user' && ev.mcNotice) return { event: { type: 'user', mcNotice: ev.mcNotice } };
  return null;
}

// Publishes one 'chat' event of a run, numbered, and keeps its page-relevant part for the turn in progress.
function emit(rec, payload) {
  const msg = { runId: rec.runId, seq: ++rec.seq, ...payload };
  const piece = turnPiece(payload);
  if (piece && !rec.turn.truncated) {
    const size = JSON.stringify(piece).length;
    if (rec.turn.events.length >= MAX_TURN_EVENTS || rec.turn.bytes + size > MAX_TURN_BYTES) {
      rec.turn.truncated = true;
      rec.turn.events = [];
      rec.turn.bytes = 0;
    } else {
      const kept = { runId: rec.runId, seq: msg.seq, ...piece };
      rec.turn.events.push(kept);
      rec.turn.bytes += size;
      if (piece.sent) rec.awaiting.push(kept); // its replay will tell which id the CLI saved it under
    }
  }
  stashEvent(rec, msg);
  pub('chat', msg);
  if (!ctx.replay && clientCount() > 0) rec.given = msg.seq; // somebody was connected: the event reached a page
  notePublished(rec);
}

// The turn a working process is answering for this conversation, as a page joining now needs it, or null when no
// process is working on the conversation. mark is the transcript size when the turn began (null when unknown).
export function liveTurnOf(sessionId) {
  const id = String(sessionId || '').toLowerCase();
  if (!id) return null;
  for (const r of runs.values()) {
    if (!isBusy(r) || !r.sessionId || r.sessionId.toLowerCase() !== id) continue;
    let out = 0;
    for (const n of r.outIds.values()) out += n;
    return {
      runId: r.runId,
      state: r.state,
      upto: r.seq,
      mark: r.turn.mark,
      truncated: r.turn.truncated,
      events: r.turn.events.slice(),
      turn: { startedAt: new Date(r.turnStartedAt).toISOString(), lastEventAt: new Date(r.lastEventAt).toISOString(), outputTokens: out },
    };
  }
  return null;
}

// One line to the process's stdin. Before the process exists it waits in the outbox. In a replay nothing is written: the
// process got the line when it happened.
function sendLine(rec, obj) {
  if (ctx.replay) return;
  const line = JSON.stringify(obj) + '\n';
  if (!rec.proc) {
    rec.outbox.push({ line });
    return;
  }
  rec.proc.write(line);
}

// ---- Idle processes ----
// A run is idle when its turn ended and no message waits. An idle process is closed after IDLE_MS, and the oldest of them
// when there are more than MAX_IDLE, unless background work is still running in it: a helper agent or a background command
// started in a turn lives in the process, so closing the process would end it. Such a run is idle but not closable, and does
// not count toward MAX_IDLE; the timer starts when the last task is reported finished (or the safety ceiling BG_MAX_MS passed).

function clearIdle(rec) {
  if (rec.idleTimer) clearTimeout(rec.idleTimer);
  rec.idleTimer = null;
  if (rec.bgTimer) clearTimeout(rec.bgTimer);
  rec.bgTimer = null;
}

// True when the run is idle and nothing keeps it open: it may be closed.
const closable = (r) => r.state === 'idle' && !r.closing && !r.bg.size && !!r.proc;

// (Re)starts the idle countdown of an idle run, or the wait for its background work. Called whenever the run becomes idle or
// its set of background tasks changes. Does nothing in a replay (settleRun does it once the replay is over).
function armIdle(rec) {
  clearIdle(rec);
  if (ctx.replay || rec.state !== 'idle' || rec.closing || !rec.proc) return;
  if (rec.bg.size) {
    // Never wait longer than the ceiling for the oldest task: a "finished" event may have been lost.
    let oldest = Infinity;
    for (const t of rec.bg.values()) oldest = Math.min(oldest, t.since);
    const wait = Math.max(0, oldest + BG_MAX_MS - Date.now());
    rec.bgTimer = setTimeout(() => expireBackground(rec), Math.min(wait, 2 ** 31 - 1));
    rec.bgTimer.unref();
    return;
  }
  const left = Math.max(0, IDLE_MS - (Date.now() - rec.idleSince));
  rec.idleTimer = setTimeout(() => closeIdle(rec, 'idle'), left);
  rec.idleTimer.unref();
}

// A span for a log line: units with no space (6s, 4h, 7d) except minutes ("4 min").
export function formatSpan(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '0s';
  if (n < 60000) return `${Math.max(0, Math.round(n / 1000))}s`;
  if (n < 3600000) return `${Math.round(n / 60000)} min`;
  if (n < 86400000) return `${Math.round((n / 3600000) * 10) / 10}h`;
  return `${Math.round((n / 86400000) * 10) / 10}d`;
}

// Forgets the tasks that have been "running" longer than the ceiling, then lets the idle countdown go on.
function expireBackground(rec) {
  rec.bgTimer = null;
  const cut = Date.now() - BG_MAX_MS;
  for (const [id, t] of [...rec.bg]) {
    if (t.since <= cut) {
      rec.bg.delete(id);
      console.log(`[runs] background task ${id} of run ${rec.runId.slice(0, 8)} was never reported finished after ${formatSpan(BG_MAX_MS)}, no longer waiting for it`);
    }
  }
  persistRun(rec);
  armIdle(rec);
}

function enterIdle(rec) {
  rec.state = 'idle';
  rec.idleSince = tnow();
  rec.cpDue = true; // a quiet moment: the runner may drop the journal up to here (see afterEntry)
  armIdle(rec);
  enforceIdleCap();
}

function enforceIdleCap() {
  if (ctx.replay) return;
  const idle = [...runs.values()].filter(closable).sort((a, b) => a.idleSince - b.idleSince);
  while (idle.length > MAX_IDLE) closeIdle(idle.shift(), 'cap');
}

// Ends an idle process the clean way: closing stdin makes the CLI exit by itself.
function closeIdle(rec, why) {
  if (!closable(rec)) return; // not idle, already closing, or background work is running
  act(rec, { k: 'close', why });
  rec.proc.end();
  armKill(rec);
}

// A process that ignores a closed stdin is killed after a while.
function armKill(rec) {
  if (ctx.replay || !rec.closing || rec.killTimer) return;
  const left = Math.max(0, KILL_AFTER_CLOSE_MS - (Date.now() - (rec.closeAt || Date.now())));
  rec.killTimer = setTimeout(() => killTree(rec), left);
  rec.killTimer.unref();
}

function killTree(rec) {
  if (!rec.proc) return;
  act(rec, { k: 'kill' });
  rec.proc.kill();
}

// ---- Live turn timing: SSE "chat.turn", at most once per 2 s while a turn works, plus a final one per turn ----

const TURN_EVERY_MS = 2000;

function startTurn(rec) {
  beginTurnRecord(rec);
  rec.turnStartedAt = tnow();
  rec.outIds = new Map();
  rec.lastEventAt = tnow();
  publishTurn(rec, false); // at once, so the page can start counting
}

function publishTurn(rec, final) {
  if (ctx.replay) return;
  if (rec.turnTimer) {
    clearTimeout(rec.turnTimer);
    rec.turnTimer = null;
  }
  rec.turnSentAt = Date.now();
  let out = 0;
  for (const n of rec.outIds.values()) out += n;
  const payload = {
    runId: rec.runId,
    sessionId: rec.sessionId,
    startedAt: new Date(rec.turnStartedAt).toISOString(),
    lastEventAt: new Date(rec.lastEventAt).toISOString(),
    outputTokens: out,
  };
  if (final) {
    const end = rec.endedAt ? Date.parse(rec.endedAt) : Date.now();
    payload.done = true;
    payload.durationMs = Math.max(0, end - rec.turnStartedAt);
  }
  publish('chat.turn', payload);
}

// Counts output tokens once per message id (a response written as several events repeats its usage).
function noteTurn(rec, event) {
  rec.lastEventAt = tnow();
  const m = event && event.type === 'assistant' ? event.message : null;
  if (m && m.usage && m.model !== '<synthetic>' && !event.parent_tool_use_id && !event.isSidechain) {
    const n = Number(m.usage.output_tokens);
    const id = m.id || event.uuid || String(rec.outIds.size);
    if (Number.isFinite(n) && n > 0) rec.outIds.set(id, Math.max(rec.outIds.get(id) || 0, n));
  }
  if (ctx.replay) return;
  const wait = TURN_EVERY_MS - (Date.now() - rec.turnSentAt);
  if (wait <= 0) publishTurn(rec, false);
  else if (!rec.turnTimer) {
    rec.turnTimer = setTimeout(() => {
      rec.turnTimer = null;
      if (isBusy(rec)) publishTurn(rec, false);
    }, wait);
    rec.turnTimer.unref();
  }
}

// A /compact in a live run: no request follows it, so the new numbers come from the transcript, whose boundary record
// carries the size after it. Read a few times, as that record may land a moment after the event. Skipped once a newer
// request has given its own numbers (mark: how many requests had given numbers when the compact was seen).
function noteCompact(rec, sid, mark, tries) {
  getSessionStats(sid)
    .then((st) => {
      if ((rec.statsN || 0) !== mark) return;
      if (st && st.cache && st.cache.compactedAt) {
        rec.lastStats = st;
        pub('session.stats', { sessionId: sid, ...st });
      } else if (tries < 4) setTimeout(() => noteCompact(rec, sid, mark, tries + 1), 1500).unref();
    })
    .catch((err) => console.error('[runs] could not read the numbers after a compact:', err.message));
}

// Reads plan usage and context numbers out of the stream. Never throws into the run.
function observe(rec, event) {
  if (!event || typeof event !== 'object') return;
  noteTurn(rec, event);
  if (event.type === 'rate_limit_event') {
    if (!ctx.replay) ingestRateLimitEvent(event);
  } else if (event.type === 'assistant') {
    const sid = rec.sessionId;
    const stats = sid ? statsFromAssistantEvent(sid, event) : null;
    if (stats) {
      rec.lastStats = stats;
      rec.statsN = (rec.statsN || 0) + 1;
      pub('session.stats', { sessionId: sid, ...stats });
    }
  } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
    if (rec.sessionId && !ctx.replay) noteCompact(rec, rec.sessionId, rec.statsN || 0, 0);
  } else if (event.type === 'result') {
    // modelUsage carries the exact window of each model used. Its token counts are totals for the whole
    // run, so they are not the context size.
    const mu = event.modelUsage;
    if (mu && typeof mu === 'object') for (const [m, v] of Object.entries(mu)) if (v) noteContextWindow(m, v.contextWindow);
    if (rec.lastStats && rec.sessionId) {
      rec.lastStats = withCurrentWindow(rec.lastStats);
      pub('session.stats', { sessionId: rec.sessionId, ...rec.lastStats });
    }
  }
}

// ---- Events from the process ----

// Inline image and PDF bytes never go to the browser through the event stream: images are cached and carry a src,
// documents are marked as omitted. (A message with a PDF can be 20 MB; the Talk page shows files from its own state.)
function slimBlock(b) {
  if (!b || typeof b !== 'object') return b;
  if ((b.type === 'image' || b.type === 'document') && b.source && typeof b.source.data === 'string') {
    const src = b.type === 'image' ? cacheImage(b.source.media_type, b.source.data) : null;
    return { ...b, source: { type: b.source.type, media_type: b.source.media_type, omitted: true }, ...(src ? { src } : {}) };
  }
  if (b.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: b.content.map(slimBlock) };
  return b;
}

// The notice a user-side stream event stands for (a finished background task, a helper's report), or null when
// it is the human's own message or a tool result. A replayed message is the human's own unless a marker says
// otherwise, so the text shape alone never turns a replay into a notice.
function noticeOf(event) {
  if (!event || event.type !== 'user') return null;
  const c = classifyUserEntry(event, { legacyText: !event.isReplay });
  return c.kind === 'notice' ? c : null;
}

function slimEvent(event) {
  if (event.type !== 'user') return event;
  const out = { ...event };
  const n = noticeOf(event);
  if (n) out.mcNotice = { type: n.type, label: n.label, status: n.status, text: n.text };
  const m = event.message;
  if (m && Array.isArray(m.content)) out.message = { ...m, content: m.content.map(slimBlock) };
  const t = event.tool_use_result;
  if (t && !Array.isArray(t) && typeof t === 'object' && t.file && typeof t.file === 'object' && 'base64' in t.file) {
    const { base64, ...file } = t.file;
    out.tool_use_result = { ...t, file };
  }
  return out;
}

// ---- Background work ----
// How the CLI reports it (read from its stream-json output code, version 2.1.x), all as `system` events:
//   background_tasks_changed  the full set of live background tasks after every change (replace semantics, a level signal:
//                             a missed edge cannot leave a stale entry). Tasks flagged `ambient` (watchers, not activity) or
//                             `awaited` (a call that waits for them) are not background work.
//   task_started              a task began (is_backgrounded false for a foreground one, which is not counted)
//   task_updated              a patch; status completed, failed or killed, or is_backgrounded turning true
//   task_notification         the task ended (the CLI then queues a <task-notification> message and answers it with a turn)
// A helper agent started with run_in_background shows as task_type local_agent, a background shell command as local_bash.
// Fallback, only until a system event of these kinds has been seen in the process: the tool_result text of the launch
// ("Async agent launched successfully ... agentId: X", "Command running in background with ID: X") starts a task, and a
// <task-notification> with a final <status> ends it.
const BG_FINAL = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled']);

// Updates rec.bg from one stream event. Returns true when the set of tasks changed.
function noteBackground(rec, ev) {
  if (!ev || typeof ev !== 'object') return false;
  const before = rec.bg.size;
  let changed = false;
  const add = (id, type, description) => {
    if (typeof id !== 'string' || !id || rec.bg.has(id)) return;
    if (rec.bg.size >= BG_MAX_TASKS) rec.bg.delete(rec.bg.keys().next().value);
    rec.bg.set(id, { since: tnow(), type: String(type || '').slice(0, 40), description: String(description || '').slice(0, 120) });
    changed = true;
  };
  const del = (id) => {
    if (typeof id === 'string' && rec.bg.delete(id)) changed = true;
  };
  if (ev.type === 'system') {
    switch (ev.subtype) {
      case 'background_tasks_changed': {
        if (!Array.isArray(ev.tasks)) break;
        rec.bgSystem = true;
        const next = new Map();
        for (const t of ev.tasks) {
          if (!t || typeof t.task_id !== 'string' || t.ambient === true || t.awaited === true) continue;
          next.set(t.task_id, rec.bg.get(t.task_id) || { since: tnow(), type: String(t.task_type || '').slice(0, 40), description: String(t.description || '').slice(0, 120) });
        }
        if (next.size !== rec.bg.size || [...next.keys()].some((k) => !rec.bg.has(k))) changed = true;
        rec.bg = next;
        break;
      }
      case 'task_started':
        rec.bgSystem = true;
        if (ev.is_backgrounded !== false && ev.awaited !== true && ev.ambient !== true) add(ev.task_id, ev.task_type, ev.description);
        break;
      case 'task_updated': {
        rec.bgSystem = true;
        const patch = ev.patch && typeof ev.patch === 'object' ? ev.patch : {};
        if (patch.is_backgrounded === true && ev.awaited !== true) add(ev.task_id, ev.task_type, ev.description);
        if (BG_FINAL.has(patch.status)) del(ev.task_id);
        break;
      }
      case 'task_notification':
        rec.bgSystem = true;
        del(ev.task_id);
        break;
      default:
        break;
    }
  } else if (ev.type === 'user' && !rec.bgSystem) {
    const text = rawTextOf(ev.message) + ' ' + toolResultText(ev.message);
    for (const m of text.matchAll(/Async agent launched successfully[\s\S]{0,200}?agentId:\s*([A-Za-z0-9]+)/g)) add(m[1], 'local_agent', 'helper agent');
    for (const m of text.matchAll(/Command running in background with ID:\s*([A-Za-z0-9]+)/g)) add(m[1], 'local_bash', 'background command');
    if (text.includes('<task-notification>')) {
      const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text);
      const status = /<status>\s*([A-Za-z_]+)\s*<\/status>/.exec(text);
      if (id && status && BG_FINAL.has(status[1].toLowerCase())) del(id[1]);
    }
  }
  if (changed && before > 0 && rec.bg.size === 0) rec.idleSince = tnow(); // the idle countdown starts when the last task is over
  return changed;
}

// The text of the tool_result blocks of a user message (the launch text of a background task is one).
function toolResultText(message) {
  const c = message && message.content;
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const b of c) {
    if (!b || b.type !== 'tool_result') continue;
    if (typeof b.content === 'string') parts.push(b.content);
    else if (Array.isArray(b.content)) for (const x of b.content) if (x && x.type === 'text' && typeof x.text === 'string') parts.push(x.text);
  }
  return parts.join('\n');
}

function handleEvent(rec, event) {
  if (event && typeof event.session_id === 'string' && isUuid(event.session_id) && rec.sessionId !== event.session_id) {
    const isNew = !rec.sessionId;
    rec.sessionId = event.session_id;
    persistRun(rec);
    // a conversation that starts here gets a short name from its first message; one-off tasks keep their own
    if (isNew && !ctx.replay && rec.firstPrompt && !rec.oneOff) nameConversation(rec.sessionId, rec.firstPrompt, rec.opts && rec.opts.projectId);
    rec.firstPrompt = null;
  }
  const type = event && event.type;
  if (type === 'control_request') return onControlRequest(rec, event);
  if (type === 'control_cancel_request') return dropPending(rec, event.request_id, 'cancelled');
  if (type === 'control_response') return onControlResponse(rec, event);
  rec.heard = true;
  if (!rec.remote.asked && !ctx.replay) enableRemote(rec); // the first thing heard from a process: ask for Remote Control (never delays a message)
  if (noteBackground(rec, event) && rec.state === 'idle') {
    armIdle(rec);
    enforceIdleCap(); // the last task may just have ended: the run can be closed again, and counts toward the cap again
  }

  if (rec.state === 'starting') {
    rec.state = 'working';
  } else if (rec.state === 'idle' && type === 'assistant' && !rec.closing) {
    // Claude started a turn by itself (a background task finished): the run is working again.
    clearIdle(rec);
    rec.state = 'working';
    startTurn(rec);
  }
  if (type === 'user' && event.isReplay) {
    rec.sawReplay = true;
    // Only the replay of a message we wrote ends a wait; a notice the CLI replays is not one of ours.
    // The Talk page already shows the message from the 'sent' event, and a replay never becomes a bubble, so a
    // message sent mid-answer appears once. A second replay of the same uuid must not use up another message.
    const again = typeof event.uuid === 'string' && rec.replayed.has(event.uuid);
    if (typeof event.uuid === 'string' && !again) {
      if (rec.replayed.size >= 200) rec.replayed.clear();
      rec.replayed.add(event.uuid);
    }
    const nt = noticeOf(event);
    if (rec.unconsumed > 0 && !again && (!nt || nt.type === 'handoff')) { // the handoff request is a notice line, but it is ours
      rec.unconsumed--;
      // The replay names the id the CLI saved the message under. It is ours when the CLI took ours; if not, the page
      // matches the saved record by this one (alias).
      const sent = rec.awaiting.shift();
      if (sent && typeof event.uuid === 'string' && event.uuid !== sent.uuid) sent.alias = event.uuid;
    }
  }
  try {
    observe(rec, event);
  } catch (err) {
    console.error('[runs] could not read usage from an event:', err.message);
  }
  if (rec.persona && type === 'assistant') {
    try {
      event = personaEvent(event, { save: !ctx.replay }); // her memory notes are saved and taken out, so they are never shown or read aloud (a replay only takes them out)
    } catch (err) {
      console.error('[runs] could not read the memory notes:', err.message);
    }
  }
  emit(rec, { event: slimEvent(event) });

  if (type === 'user' && event.tool_use_result && rec.sessionId) {
    try {
      const images = liveSendFileImages(rec.sessionId, event.tool_use_result);
      if (images.length) emit(rec, { images });
    } catch (err) {
      console.error('[runs] could not read files Claude sent:', err.message);
    }
  }
  if (type === 'result') onTurnDone(rec, event);
}

// A result ends a turn, not the process. Messages written while the turn ran were taken into it (each one's replay
// came back before the result), so the process is idle unless a message is still waiting for its own turn.
function onTurnDone(rec, event) {
  publishTurn(rec, true);
  emit(rec, { turnDone: true, sessionId: rec.sessionId, ok: !event.is_error });
  pub('sessions.changed', { id: rec.sessionId });
  rememberOpts(rec);
  if (rec.sawReplay && rec.unconsumed > 0) {
    // The messages still waiting start the next turn. Their 'sent' events belong to it, so they move over.
    const waiting = rec.turn.events.filter((e) => e.sent).slice(-rec.unconsumed);
    startTurn(rec);
    rec.turn.events = waiting;
    rec.turn.bytes = waiting.reduce((n, e) => n + JSON.stringify(e).length, 0);
  } else {
    rec.unconsumed = 0;
    // Nobody can join a turn that is over (the page reads the whole transcript from now on), so its events go.
    dropTurnEvents(rec);
    enterIdle(rec);
  }
}

// ---- Permission questions ----

function trimInput(input) {
  const out = {};
  let budget = 2048;
  for (const [k, v] of Object.entries(input)) {
    if (budget <= 0) break;
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (typeof s !== 'string') s = String(v);
    const room = Math.min(budget, 1500);
    if (s.length > room) s = s.slice(0, room) + '...';
    out[k] = s;
    budget -= s.length + k.length;
  }
  return out;
}

const SUMMARY_KEYS = ['command', 'file_path', 'path', 'notebook_path', 'url', 'pattern', 'query', 'prompt', 'description'];

function summaryOf(input) {
  for (const k of SUMMARY_KEYS) {
    if (typeof input[k] === 'string' && input[k].trim()) return input[k].replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  let s = '';
  try {
    s = JSON.stringify(input);
  } catch {
    s = '';
  }
  return s === '{}' ? '' : s.slice(0, 200);
}

function publicPending(p) {
  return { requestId: p.requestId, tool: p.tool, summary: p.summary, input: p.input, suggestions: p.suggestions, toolUseId: p.toolUseId, at: p.at, ...(p.questions ? { questions: p.questions } : {}) };
}

// Claude's multiple choice questions (its AskUserQuestion tool) arrive as a permission request. The page shows them as a
// question card; the answer goes back as an allow whose updatedInput carries `answers`: { "<question text>": "<chosen label>" }
// (several labels joined with ", ", or the words typed under Other).
const ASK_TOOL = 'AskUserQuestion';
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function questionsOf(input) {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs.slice(0, 4).map((q) => ({
    // kept exactly as Claude wrote it: the answer goes back under this very text
    question: q && typeof q.question === 'string' ? q.question.slice(0, 4000) : '',
    header: clip(q && q.header, 40),
    multiSelect: !!(q && q.multiSelect),
    options: (Array.isArray(q && q.options) ? q.options : []).slice(0, 6).map((o) => ({ label: clip(o && o.label, 200), description: clip(o && o.description, 500) })).filter((o) => o.label),
  })).filter((q) => q.question.trim());
}
function checkAnswers(p, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw fail(400, 'answers must be an object');
  const asked = new Set((p.questions || []).map((q) => q.question));
  const out = {};
  for (const [k, v] of Object.entries(answers)) {
    if (!asked.has(k)) throw fail(400, 'answers names a question that was not asked');
    if (typeof v !== 'string' || !v.trim() || v.length > 4000) throw fail(400, 'each answer must be text of at most 4000 characters');
    out[k] = v.trim();
  }
  if (!Object.keys(out).length) throw fail(400, 'answers is empty');
  return out;
}

function onControlRequest(rec, event) {
  const req = event.request;
  const requestId = event.request_id;
  if (typeof requestId !== 'string' || !req || req.subtype !== 'can_use_tool') {
    // Nothing else is supported; an unanswered request would hang the turn.
    if (typeof requestId === 'string') {
      sendLine(rec, { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'Not supported by Mission Control' } });
    }
    return;
  }
  const input = req.input && typeof req.input === 'object' && !Array.isArray(req.input) ? req.input : {};
  const suggestions = (Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [])
    .filter((s) => s && typeof s === 'object' && JSON.stringify(s).length <= 2000)
    // "Allow always" only remembers rules for tools. Suggestions that switch the whole conversation's mode
    // (setMode) or widen its folders (addDirectories) are left out: those are bigger decisions than one click.
    .filter((s) => s.type === 'addRules')
    .slice(0, 10);
  const p = {
    requestId,
    tool: String(req.tool_name || 'tool').slice(0, 80),
    summary: summaryOf(input),
    input: trimInput(input),
    suggestions,
    toolUseId: typeof req.tool_use_id === 'string' ? req.tool_use_id : null,
    at: isoNow(),
    rawInput: input,
    timer: null,
  };
  if (p.tool === ASK_TOOL) {
    const qs = questionsOf(input);
    if (qs.length) { p.questions = qs; p.summary = qs[0].question.replace(/\s+/g, ' ').trim().slice(0, 200); }
  }
  rec.pending.set(requestId, p);
  armPermission(rec, p);
  emit(rec, { permission: publicPending(p) });
}

// Nobody answered in time: deny. The countdown runs from when the question was asked, also after a restart of the server.
function armPermission(rec, p) {
  if (ctx.replay || p.timer) return;
  const left = Math.max(0, PERMISSION_MS - (Date.now() - Date.parse(p.at)));
  p.timer = setTimeout(() => answer(rec, p, 'deny', 'No answer in time', false), left);
  p.timer.unref();
}

function dropPending(rec, requestId, behavior) {
  const p = rec.pending.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  rec.pending.delete(requestId);
  emit(rec, { permissionDone: requestId, behavior });
}

function answer(rec, p, behavior, message, always, answers) {
  if (!rec.pending.has(p.requestId)) return;
  act(rec, { k: 'perm', requestId: p.requestId, behavior, ...(message ? { message } : {}), ...(always ? { always: true } : {}), ...(answers ? { answers } : {}) });
}

// The effect of an answer (see act): the question is gone, the process gets the answer, the pages hear of it.
function applyAnswer(rec, e) {
  const p = rec.pending.get(e.requestId);
  if (!p) return;
  clearTimeout(p.timer);
  rec.pending.delete(p.requestId);
  const response =
    e.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: e.answers ? { ...p.rawInput, answers: e.answers } : p.rawInput, ...(e.always && p.suggestions.length ? { updatedPermissions: p.suggestions } : {}) }
      : { behavior: 'deny', message: e.message || 'Denied in Mission Control' };
  sendLine(rec, { type: 'control_response', response: { subtype: 'success', request_id: p.requestId, response } });
  emit(rec, { permissionDone: p.requestId, behavior: e.behavior });
}

// POST /api/runs/:id/permission
export function answerPermission(runId, { requestId, behavior, message, always, answers } = {}) {
  const rec = runs.get(runId);
  if (!rec) throw fail(404, 'Unknown run');
  if (rec.replaying) throw fail(503, 'Mission Control is taking this conversation over again after a restart, try again in a moment');
  if (typeof requestId !== 'string' || !requestId) throw fail(400, 'requestId is required');
  if (behavior !== 'allow' && behavior !== 'deny') throw fail(400, 'behavior must be "allow" or "deny"');
  if (message !== undefined && message !== null && typeof message !== 'string') throw fail(400, 'message must be a string');
  const p = rec.pending.get(requestId);
  if (!p) throw fail(404, 'No such question is waiting (it may have been answered or timed out)');
  /* Claude's questions are answered with what was chosen; an Allow with no answers would hand it an empty reply */
  let picked = null;
  if (p.questions && behavior === 'allow') picked = checkAnswers(p, answers);
  else if (answers !== undefined) throw fail(400, 'answers are only for a question card');
  answer(rec, p, behavior, message ? message.slice(0, 500) : '', always === true && !p.questions, picked);
  return { ok: true, requestId, behavior };
}

// GET /api/runs/:id/pending
export function pendingFor(runId) {
  const rec = runs.get(runId);
  if (!rec) throw fail(404, 'Unknown run');
  return [...rec.pending.values()].map(publicPending);
}

// ---- Remote Control ("Show on claude.ai") ----
// The CLI takes a control request {subtype:"remote_control", enabled:true}: it registers the conversation with
// claude.ai so it shows in claude.ai/code and the Claude phone app and can be continued there. The success response
// carries { session_url, connect_url, environment_id, bridge_epoch, bridge_session_id }; an error carries a plain
// sentence (not signed in with a claude.ai account, organization policy, feature gate) and sometimes an error_code.
// {enabled:false} takes the conversation offline again. The request goes out after the first thing heard from the
// process, so the user's first message is never held up, and a refusal only costs a line in the server log.

const REMOTE_ANSWER_MS = Number(process.env.MC_REMOTE_ANSWER_MS) || 90 * 1000;

function remotePrefOn() {
  try {
    return getVoicePrefs().remoteControl !== false;
  } catch {
    return true;
  }
}

// Only a claude.ai address is ever offered to the pages as a link.
function claudeAiUrl(u) {
  try {
    const url = new URL(String(u));
    const ok = url.protocol === 'https:' && (url.hostname === 'claude.ai' || url.hostname.endsWith('.claude.ai'));
    return ok ? url.href : null;
  } catch {
    return null;
  }
}

function publishRemote(rec) {
  persistRun(rec);
  pub('run.remote', { runId: rec.runId, sessionId: rec.sessionId, state: rec.remote.state, url: rec.remote.state === 'on' ? rec.remote.url : null });
}

// A reason from the CLI, short and with anything that looks like a secret cut out. Logged once per process.
function remoteFailed(rec, reason) {
  if (rec.remote.state === 'on') return;
  clearTimeout(rec.remote.timer);
  rec.remote.state = 'failed';
  rec.remote.url = null;
  if (!rec.remote.logged) {
    rec.remote.logged = true;
    const text = String(reason || 'no reason given').replace(/[A-Za-z0-9_-]{32,}/g, '...').replace(/\s+/g, ' ').slice(0, 200);
    console.log(`[runs] Remote Control is not on for run ${rec.runId.slice(0, 8)}: ${text}`);
  }
  publishRemote(rec);
}

function sendControl(rec, request, onAnswer) {
  const id = `mc-${request.subtype}-${crypto.randomUUID()}`;
  if (onAnswer) rec.controls.set(id, onAnswer);
  sendLine(rec, { type: 'control_request', request_id: id, request });
  return id;
}

function onControlResponse(rec, event) {
  const r = event.response;
  const cb = r && typeof r.request_id === 'string' ? rec.controls.get(r.request_id) : null;
  if (!cb) return; // the CLI echoing one of our own answers
  rec.controls.delete(r.request_id);
  try {
    cb(r);
  } catch (err) {
    console.error('[runs] could not read a control response:', err.message);
  }
}

// What happens when the CLI answers our remote_control request. Also put back on a rebuilt record whose request was
// still out when the server restarted, so the answer (replayed from the journal, or arriving later) is not lost.
function remoteAnswerHandler(rec) {
  return (r) => {
    clearTimeout(rec.remote.timer);
    if (r.subtype !== 'success') {
      if (rec.remote.state === 'off') return; // switched off meanwhile: nothing is on, so nothing to report
      return remoteFailed(rec, r.error || r.error_code || r.subtype);
    }
    if (rec.remote.state === 'off') {
      // Switched off or archived while the request was out: it went online anyway, so take it offline now.
      if (rec.proc) sendControl(rec, { subtype: 'remote_control', enabled: false }, null);
      return;
    }
    rec.remote.state = 'on';
    const body = r.response && typeof r.response === 'object' ? r.response : {};
    rec.remote.url = claudeAiUrl(body.session_url);
    publishRemote(rec);
  };
}

function armRemote(rec) {
  if (ctx.replay || rec.remote.state !== 'asking') return;
  clearTimeout(rec.remote.timer);
  rec.remote.timer = setTimeout(() => remoteFailed(rec, 'the CLI did not answer in time'), REMOTE_ANSWER_MS);
  rec.remote.timer.unref();
}

function enableRemote(rec) {
  if (rec.remote.asked || rec.closing || rec.oneOff || !remotePrefOn()) return;
  if (rec.sessionId && isArchived(rec.sessionId)) return; // an archived conversation stays off claude.ai
  rec.remote.asked = true;
  rec.remote.state = 'asking';
  armRemote(rec);
  // keep_session_on_exit: without it the CLI archives the claude.ai session when the process ends, and Mission Control ends
  // idle processes after 10 min, so conversations vanished from claude.ai's list. A CLI too old to know the field is asked
  // again without it.
  const plain = remoteAnswerHandler(rec);
  rec.remote.reqId = sendControl(rec, { subtype: 'remote_control', enabled: true, keep_session_on_exit: true }, (r) => {
    const why = String((r && (r.error || r.error_code)) || '');
    if (r && r.subtype !== 'success' && /keep_session_on_exit|unknown (field|key|property|option)|unrecognized/i.test(why) && rec.proc && rec.remote.state === 'asking') {
      armRemote(rec);
      rec.remote.reqId = sendControl(rec, { subtype: 'remote_control', enabled: true }, plain);
      persistRun(rec);
      return;
    }
    plain(r);
  });
  persistRun(rec);
}

// Takes the conversation offline on claude.ai. Marks the process as asked, so nothing turns it on again by itself.
function disableRemote(rec) {
  const was = rec.remote.state;
  clearTimeout(rec.remote.timer);
  rec.remote.timer = null;
  rec.remote.asked = true;
  rec.remote.state = 'off';
  rec.remote.url = null;
  // A request still out is taken offline when its answer arrives (see enableRemote); an online one now.
  if (was === 'on') sendControl(rec, { subtype: 'remote_control', enabled: false }, null);
  if (was === 'on' || was === 'asking') publishRemote(rec);
  else persistRun(rec);
}

function remoteEnded(rec) {
  clearTimeout(rec.remote.timer);
  rec.controls.clear();
  if (rec.remote.state !== 'off') {
    rec.remote.state = 'off';
    rec.remote.url = null;
    publishRemote(rec);
  }
}

// The "Show on claude.ai" switch changed: every live process follows it.
export function applyRemoteSetting() {
  const on = remotePrefOn();
  for (const r of runs.values()) {
    if (!isLive(r) || r.closing || !r.proc || r.oneOff || r.replaying) continue;
    if (on) {
      if (r.remote.state === 'off' || r.remote.state === 'failed') {
        r.remote.asked = false;
        r.remote.state = 'off';
        enableRemote(r);
      }
    } else disableRemote(r);
  }
}

// A conversation was archived: it goes offline on claude.ai. Returns how many live processes were asked.
export function takeSessionOffline(sessionId) {
  const id = String(sessionId || '').toLowerCase();
  let n = 0;
  for (const r of runs.values()) {
    if (!isLive(r) || !r.sessionId || r.sessionId.toLowerCase() !== id) continue;
    if (r.remote.state === 'on' || r.remote.state === 'asking') n++;
    disableRemote(r);
  }
  return n;
}

// True when a live process holds this conversation (a brand new one may not have a transcript yet).
export function hasLiveSession(sessionId) {
  return !!findLive(sessionId);
}

// An expiry action (expiryAction.js): one message on the conversation's own model, because the cache belongs to one model
// and a message on another would write a whole new cache. A live process or a run this server remembers keeps its options; after
// a restart the model comes from the transcript (model: the id its last answer names).
export async function pingSession(sessionId, prompt, model) {
  const known = findLive(sessionId) || lastOpts.has(String(sessionId).toLowerCase());
  if (known) return startRun({ prompt, sessionId });
  const list = modelOptions().filter((o) => o.flag && !o.disabled);
  const hit = typeof model === 'string' && model ? list.find((o) => o.id === model) || list.find((o) => model.startsWith(o.id + '-') || model.startsWith(o.id + '[')) : null;
  if (!hit) throw fail(409, `The model of this conversation (${model || 'unknown'}) is not in the model list`);
  return startRun({ prompt, sessionId, model: hit.id });
}

// ---- The process ----

// What the runner keeps of a run so that a new server can build its record again (small, JSON). Sent with the start request.
function metaOf(rec) {
  return {
    projectId: rec.projectId,
    sessionId: rec.sessionId,
    startedAtMs: rec.startedAtMs,
    promptPreview: rec.promptPreview,
    cwd: rec.cwd,
    opts: rec.opts,
    persona: rec.persona,
    flags: rec.flags,
    oneOff: rec.oneOff,
    mark0: rec.mark0 === undefined ? null : rec.mark0,
    remote: remoteState(rec),
  };
}

const remoteState = (rec) => ({ state: rec.remote.state, asked: rec.remote.asked, logged: rec.remote.logged, url: rec.remote.url, reqId: rec.remote.reqId });

// Tells the runner what changed in the small part of the record that no journal line recreates (the Remote Control state,
// the conversation id). Not in a replay, and not for a process the server started itself.
function persistRun(rec) {
  if (ctx.replay || !rec.proc) return;
  rec.proc.meta({ sessionId: rec.sessionId, remote: remoteState(rec) });
}

// The small state that, together with the journal after it, makes a record again. Taken at a quiet moment: idle, nothing asked.
function checkpointState(rec) {
  return {
    seq: rec.seq,
    sawReplay: rec.sawReplay,
    state: rec.state,
    idleSince: rec.idleSince,
    sessionId: rec.sessionId,
    lastStats: rec.lastStats || null,
    bg: [...rec.bg],
    closing: rec.closing,
    closeAt: rec.closeAt,
    stopRequested: rec.stopRequested,
    // The events no page has been given yet (see stashEvent), so a server that takes over from this checkpoint still has them.
    stash: keptStash(rec),
  };
}

const CHECKPOINT_STASH_BYTES = Number(process.env.MC_CHECKPOINT_STASH_BYTES) || 1024 * 1024;

// The events after the last one given to a page, as the checkpoint keeps them (null when there is nothing to keep or too much).
function keptStash(rec) {
  const s = rec.stash;
  if (!s) return null;
  const events = s.over ? [] : s.events.filter((m) => m.seq > rec.given);
  if (!s.over && JSON.stringify(events).length > CHECKPOINT_STASH_BYTES) return { over: true, events: [] };
  if (!s.over && !events.length) return null;
  return { over: !!s.over, events };
}

function applyCheckpoint(rec, s) {
  rec.seq = Number(s.seq) || 0;
  rec.sawReplay = !!s.sawReplay;
  rec.state = s.state === 'idle' ? 'idle' : 'working';
  rec.idleSince = Number(s.idleSince) || 0;
  if (typeof s.sessionId === 'string') rec.sessionId = s.sessionId;
  if (s.lastStats && typeof s.lastStats === 'object') rec.lastStats = s.lastStats;
  rec.bg = new Map(Array.isArray(s.bg) ? s.bg.filter((x) => Array.isArray(x) && typeof x[0] === 'string') : []);
  rec.closing = s.closing || null;
  rec.closeAt = Number(s.closeAt) || 0;
  rec.stopRequested = !!s.stopRequested;
  rec.heard = true;
  // Events the previous server numbered but no page got (they come before the journal lines replayed after this checkpoint).
  const k = s.stash;
  if (rec.stash && k && typeof k === 'object') {
    if (k.over) rec.stash.over = true;
    else if (Array.isArray(k.events)) {
      for (const m of k.events) {
        if (!m || typeof m !== 'object' || !(m.seq > rec.pubSeq)) continue;
        rec.stash.events.push(m);
        rec.stash.bytes += JSON.stringify(m).length;
      }
    }
  }
}

function takeCheckpoint(rec) {
  rec.cpDue = false;
  rec.cpN = rec.lastN;
  if (rec.proc) rec.proc.checkpoint(rec.lastN, checkpointState(rec));
}

async function launch(entry, args, cwd, rec) {
  try {
    await spawnProc({ runId: rec.runId, cmd: entry.cmd, args, cwd, meta: metaOf(rec) }, sinkFor(rec));
  } catch (err) {
    // The process could not even be started: the run fails right here.
    if (!isLive(rec)) return;
    rec.endedAt = new Date().toISOString();
    rec.state = 'failed';
    rec.error = String(err.message).slice(0, 500);
    rec.markExited();
    emit(rec, { done: true, code: -1, sessionId: rec.sessionId, state: rec.state });
    prune();
    return;
  }
}

// Where the journal lines of a process arrive (live from the process or, after a restart, replayed by the runner).
function sinkFor(rec) {
  return {
    attach(proc) {
      if (!isLive(rec)) {
        // Stopped while the runner was still starting it: the process goes, and what it says is not listened to.
        rec.zombie = proc;
        proc.kill();
        return;
      }
      rec.proc = proc;
      rec.lastEventAt = Date.now();
      for (const item of rec.outbox.splice(0)) {
        if (item.note) proc.note(item.note);
        else proc.write(item.line);
      }
    },
    entry: (e) => applyEntry(rec, e, rec.replaying),
    batch: (frame) => applyBatch(rec, frame),
  };
}

// Handles one journal entry: a stdout line of the process, the end of the process, or (only in a replay) something this server
// did earlier. A replay changes the record and nothing else; see "What is being applied right now" at the top.
function applyEntry(rec, e, replay) {
  if (!isLive(rec) && e.d !== 'in') {
    // A run that was stopped before its process was attached: only the end of that process is of interest (the runner forgets it).
    if (e.d === 'exit' && rec.zombie) rec.zombie.forget();
    return;
  }
  if (e.d !== 'in') {
    if (e.n <= rec.lastN) return; // already handled
    rec.lastN = e.n; // before handling: what the server does in answer to this line is journaled "after" it
  }
  within({ replay, t: e.t, entry: e }, () => {
    if (e.d === 'in') act(rec, e);
    else if (e.d === 'out') handleLine(rec, e.line);
    else if (e.d === 'exit') finishRun(rec, e.code, e.errTail);
  });
  if (replay || e.d === 'in') return;
  if (e.d === 'exit') {
    if (rec.lastProc) rec.lastProc.forget(); // the runner may let go of a process the server has seen end
    return;
  }
  // A quiet moment: tell the runner it may drop the journal up to here.
  if (rec.state === 'idle' && rec.proc && rec.pending.size === 0 && (rec.cpDue || rec.lastN - rec.cpN >= CHECKPOINT_EVERY)) takeCheckpoint(rec);
}

function handleLine(rec, line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!event || typeof event !== 'object') return;
  try {
    handleEvent(rec, event);
  } catch (err) {
    console.error('[runs] could not handle an event:', err);
  }
}

// The process ended (or was found ended): the run is over.
function finishRun(rec, code, errTail) {
  rec.lastProc = rec.proc;
  rec.proc = null;
  clearIdle(rec);
  if (rec.killTimer) clearTimeout(rec.killTimer);
  rec.killTimer = null;
  for (const id of [...rec.pending.keys()]) dropPending(rec, id, 'cancelled');
  remoteEnded(rec);
  const wasBusy = isBusy(rec);
  rec.endedAt = isoNow();
  rec.state = rec.stopRequested ? 'stopped' : code === 0 && !wasBusy ? 'done' : 'failed';
  const tail = String(errTail || '').trim();
  if (rec.state === 'failed' && tail) rec.error = tail.slice(-500);
  else if (rec.state === 'failed' && !rec.error) rec.error = 'The Claude process ended in the middle of a reply';
  if (wasBusy) publishTurn(rec, true);
  rememberOpts(rec);
  // error: the reason, for a page that would otherwise only say "code -1" (the runner stopped, the process ended mid reply ...)
  emit(rec, { done: true, code, sessionId: rec.sessionId, state: rec.state, ...(rec.state === 'failed' && rec.error ? { error: rec.error } : {}), ...(rec.closing ? { closedBy: rec.closing } : {}) });
  dropTurnEvents(rec);
  rec.bg.clear();
  pub('sessions.changed', { id: rec.sessionId });
  prune();
  rec.markExited();
  if (rec.onEnd) rec.onEnd();
}

// ---- Taking the runs over again after a restart ----

const adopted = new Map(); // runId -> function that says the replay of that run is over

// The runner's hello (or its answer after the connection came back) lists the processes it holds. A run this server does not
// know is rebuilt from the runner (meta, checkpoint, journal); one it knows only asks for the lines it missed.
async function adoptRuns(info) {
  const waits = [];
  const present = new Set();
  for (const R of info.runs) {
    present.add(R.runId);
    const known = runs.get(R.runId);
    if (known) {
      if (known.proc && known.proc.kind === 'runner') known.proc.sub(known.lastN, false); // the connection came back: only what was missed
      continue;
    }
    const rec = restoreRun(R);
    waits.push(new Promise((res) => adopted.set(R.runId, res)));
    console.log(`[runs] took over run ${rec.runId.slice(0, 8)} from the runner (${R.alive ? 'running' : 'ended'}${R.checkpoint ? `, checkpoint at line ${R.checkpoint.n}` : ''}, ${R.lastN - (R.checkpoint ? R.checkpoint.n : 0)} lines to replay)`);
  }
  for (const rec of runs.values()) {
    if (isLive(rec) && rec.proc && rec.proc.kind === 'runner' && !present.has(rec.runId)) lostRun(rec, RUNNER_FORGOT);
  }
  await Promise.race([Promise.all(waits), new Promise((res) => setTimeout(res, 10000).unref())]);
}

// A record from what the runner kept: meta, checkpoint, then the journal after it (asked for here, delivered to applyBatch).
function restoreRun(R) {
  const m = R.meta && typeof R.meta === 'object' ? R.meta : {};
  const rec = makeRec({
    runId: R.runId,
    projectId: m.projectId || null,
    sessionId: typeof m.sessionId === 'string' ? m.sessionId : null,
    startedAtMs: Number(m.startedAtMs) || R.startedAt || Date.now(),
    promptPreview: String(m.promptPreview || ''),
    cwd: m.cwd,
    opts: m.opts && typeof m.opts === 'object' ? m.opts : {},
    persona: m.persona || null,
    flags: m.flags && typeof m.flags === 'object' ? m.flags : {},
    oneOff: !!m.oneOff,
  });
  rec.mark0 = m.mark0;
  rec.turn.mark = Number.isFinite(m.mark0) ? m.mark0 : 0;
  rec.restored = true; // taken over from the runner: the pages that connect after the restart get its stash instead (see onClientConnect)
  rec.pubSeq = Number(m.pubSeq) || 0; // the last event number the old server is known to have given to the pages
  rec.given = rec.givenSent = rec.pubSeq; // events this server numbers after it are given to no page until one is connected
  rec.stash = { events: [], bytes: 0, over: false, until: 0 };
  if (m.remote && typeof m.remote === 'object') {
    Object.assign(rec.remote, { state: m.remote.state || 'off', asked: !!m.remote.asked, logged: !!m.remote.logged, url: m.remote.url || null, reqId: m.remote.reqId || null });
    if (rec.remote.state === 'asking' && rec.remote.reqId) rec.controls.set(rec.remote.reqId, remoteAnswerHandler(rec)); // the answer may be in the journal
  }
  if (R.checkpoint && R.checkpoint.state) {
    applyCheckpoint(rec, R.checkpoint.state);
    rec.lastN = R.checkpoint.n;
    rec.cpN = R.checkpoint.n;
  }
  rec.replaying = true;
  rec.gap = R.droppedOut > rec.lastN; // the runner had to drop lines it was asked to keep (too much output while no server was there)
  runs.set(rec.runId, rec);
  rememberOpts(rec);
  rec.proc = adoptRunnerProc(rec.runId, R.pid, sinkFor(rec));
  rec.proc.sub(rec.lastN, true);
  return rec;
}

// A frame of the journal the runner sent for a run: entries after what this server had. A restored record replays them (nothing
// leaves the server); a record that only missed some lines while the connection was down handles them as they come.
function applyBatch(rec, frame) {
  if (frame.unknown) return lostRun(rec, RUNNER_FORGOT);
  const replay = rec.replaying;
  if (replay && rec.gap && !rec.gapNoted) {
    // Lines were lost: the state cannot be rebuilt faithfully. The pages are told to read the saved conversation instead.
    rec.gapNoted = true;
    rec.turn.truncated = true;
    rec.seq += 1000;
    console.log(`[runs] run ${rec.runId.slice(0, 8)}: the runner dropped output while no server was connected, the turn is shown from the saved conversation`);
  }
  for (const e of frame.entries) {
    try {
      applyEntry(rec, e, replay);
    } catch (err) {
      console.error('[runs] could not replay a journal entry:', err);
    }
  }
  if (frame.done && replay) settleRun(rec);
}

// The replay is over: the record is as it was, now give it back its timers and let it talk again.
function settleRun(rec) {
  rec.replaying = false;
  const lastProc = rec.lastProc;
  if (isLive(rec) && rec.proc) {
    persistRun(rec);
    for (const p of rec.pending.values()) armPermission(rec, p);
    armRemote(rec);
    armKill(rec);
    // Background tasks that were being waited for when the server went away may be past the ceiling by now.
    const cut = Date.now() - BG_MAX_MS;
    for (const [id, t] of [...rec.bg]) if (t.since <= cut) rec.bg.delete(id);
    armIdle(rec);
    if (rec.heard && !rec.remote.asked && !rec.closing) enableRemote(rec);
    enforceIdleCap();
  } else if (lastProc) lastProc.forget();
  if (rec.stash) {
    rec.stash.until = Date.now() + RESYNC_MS;
    const t = setTimeout(() => (rec.stash = null), RESYNC_MS + 1000);
    t.unref();
  }
  // Events numbered after the last one any page is known to have got may be lost (a server before this one saw them and wrote
  // a checkpoint while no page was connected). One resync event makes every page read the conversation again, once.
  // Not needed when the stash holds every one of them, in order.
  const st = rec.stash;
  const covered = rec.seq <= rec.pubSeq || (st && !st.over && st.events.length === rec.seq - rec.pubSeq && st.events[0].seq === rec.pubSeq + 1 && st.events[st.events.length - 1].seq === rec.seq);
  if (!covered) emit(rec, { resync: true });
  const done = adopted.get(rec.runId);
  adopted.delete(rec.runId);
  if (done) done();
}

// What the pages of a restarted server missed. A page's event stream reconnects by itself a few seconds after the server is
// back, and what the server published while no page was connected never reaches it. The page only notices when a later event
// arrives with a number that skips; if the turn ended while the server was away no later event comes, and the page would show
// the turn half way. So the server keeps, for every run it took over from the runner, the events it numbered after the last
// one it knows the old server had published (rec.pubSeq, which the old server tells the runner every 400 ms while it works),
// and gives them, in order and with their own numbers, to every page that connects within RESYNC_MS of the restart. The pages
// drop what they already have by the number (the Talk page does; the others only see a few events they had twice), and take
// what they missed, the end of the turn included, exactly once.
const RESYNC_MS = Number(process.env.MC_RESYNC_MS) || 5 * 60 * 1000;
const STASH_BYTES = 8 * 1024 * 1024;

onClientConnect((res) => {
  const now = Date.now();
  for (const rec of runs.values()) {
    if (!rec.stash && !rec.restored && rec.given < rec.seq) {
      // Events (a turn's end, say) were published while no page was connected: this page reads the conversation again once.
      sendTo(res, 'chat', { runId: rec.runId, seq: rec.seq, resync: true });
      rec.given = rec.seq;
      notePublished(rec);
      continue;
    }
    if (!rec.stash || rec.stash.until === 0 || now > rec.stash.until) continue;
    for (const msg of rec.stash.events) sendTo(res, 'chat', msg);
    // The stash holds every event after the old server's last one, so a page that got it has everything up to the newest.
    if (!rec.stash.over && rec.stash.events.length) {
      rec.given = Math.max(rec.given, rec.stash.events[rec.stash.events.length - 1].seq);
      notePublished(rec);
    }
  }
});

// Called by emit(): remembers an event for the pages that connect after a restart.
function stashEvent(rec, msg) {
  const s = rec.stash;
  if (!s || msg.seq <= rec.pubSeq) return;
  if (msg.resync) {
    s.events.push(msg); // tiny, and the one thing a page must get even when the rest was too much to keep
    return;
  }
  if (s.over) return;
  const size = JSON.stringify(msg).length;
  if (s.bytes + size > STASH_BYTES) {
    s.over = true; // too much to hand over: the pages see the jump in the numbers and read the conversation again
    s.events = [];
    return;
  }
  s.events.push(msg);
  s.bytes += size;
}

// Tells the runner how far the pages have been given events (at most every 400 ms while events flow). Only events that reached
// a connected page count (rec.given): if this server is replaced while no page is connected (two restarts in a row, before the
// pages' event streams reconnect), the next server must still stash everything the pages never got.
function notePublished(rec) {
  if (ctx.replay || rec.pubTimer || rec.given <= rec.givenSent || !rec.proc || rec.proc.kind !== 'runner') return;
  rec.pubTimer = setTimeout(() => {
    rec.pubTimer = null;
    if (rec.proc && rec.given > rec.givenSent) {
      rec.givenSent = rec.given;
      rec.proc.meta({ pubSeq: rec.given });
    }
  }, 400);
  rec.pubTimer.unref();
}

// What a page shows for a conversation whose process went with the runner (the reason travels in the run's error and in the
// "done" event; the conversation itself is saved and a new message resumes it).
const RUNNER_GONE = 'The runner stopped, and the conversation with it. Send a message to continue it.';
const RUNNER_FORGOT = 'The runner no longer has this conversation. Send a message to continue it.';

// The runner is gone (or lost this run): the process is gone with it.
function lostRun(rec, why) {
  within({ replay: false, t: Date.now(), entry: null }, () => {
    if (isLive(rec)) {
      rec.error = why;
      finishRun(rec, -1, why);
    }
  });
  const done = adopted.get(rec.runId);
  adopted.delete(rec.runId);
  if (done) done();
}

onAttach(adoptRuns);
onLost(() => {
  for (const rec of runs.values()) if (isLive(rec) && rec.proc && rec.proc.kind === 'runner') lostRun(rec, RUNNER_GONE);
});
startRunnerClient();

// ---- Stopping ----

// An explicit Stop (or a delete of the conversation) is the one thing that still ends a process on purpose; a restart of the
// server never does.
export async function stopRun(runId) {
  const rec = runs.get(runId);
  if (!rec) throw fail(404, 'Unknown run');
  if (!isLive(rec)) throw fail(409, 'Run is not running');
  rec.stopRequested = true;
  if (!rec.proc) {
    // Not launched yet: it ends here and now (so it stops counting as busy), and the launcher finds it ended.
    rec.endedAt = new Date().toISOString();
    rec.state = 'stopped';
    rec.markExited();
    emit(rec, { done: true, code: -1, sessionId: rec.sessionId, state: rec.state });
    dropTurnEvents(rec);
    prune();
    return publicRun(rec);
  }
  const ended = new Promise((resolve) => {
    const prev = rec.onEnd; // a second stop request must not strand the first
    rec.onEnd = () => {
      if (prev) prev();
      resolve();
    };
    setTimeout(resolve, 5000).unref();
  });
  killTree(rec);
  await ended;
  return publicRun(rec);
}

// When the server ends, the processes the runner owns keep running (that is the point). The ones this server started itself
// because no runner was reachable are killed by runnerClient.js, so no orphaned claude process is left behind.
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
process.on('SIGHUP', () => process.exit(129)); // console window closed
process.on('SIGBREAK', () => process.exit(131)); // Ctrl+Break

// Look the CLI up once at startup so the first chat request returns at once.
resolveClaude().catch(() => {});
claudeVersion();
