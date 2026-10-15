// Messages to send later: at a set time, after a timer, or when the 5-hour plan window resets.
// The server sends them itself, so the page (or the phone) may be closed when the time comes. They are kept in
// .data/delayed.json, so a restart does not lose them; one that was due while the server was down goes out at start.
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { publish } from '../lib/events.js';
import { readJson, writeJson, busyError } from '../lib/jsonStore.js';
import { startRun, hasLiveSession } from './runs.js';
import { getUsage } from './usage.js';
import { elsewhereFor, isUuid } from './sessions.js';
import { isLocked } from './sessionMeta.js';

const FILE = path.join(DATA_DIR, 'delayed.json');
const KINDS = ['time', 'timer', 'reset'];
const MAX_AHEAD_MS = 6 * 24 * 3600e3; // attachments are kept 7 days (uploads.js), so a later send could lose its files
const RESET_MARGIN_MS = 60e3; // send a minute after the window resets, so the CLI sees the new window
const RETRY_MS = 60e3; // too many runs at once, or a conversation being taken over after a restart: try again a minute later
const MAX_RETRIES = 30;
const ELSEWHERE_WAIT_MS = 5000;
const MAX_WAIT_MS = 3600e3; // the timer is set at most an hour ahead and then set again (setTimeout cannot wait weeks)

let items = null; // [{ id, kind, at, createdAt, req, preview, atts, status: 'waiting'|'sending'|'failed', error, tries }]
let timer = null;

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

// A file that could not be read right now gives an empty answer that is not kept: save() refuses meanwhile, so waiting
// messages are never written over (jsonStore.js), and a look a little later reads it again and arms the timer.
let retryT = null;
function load() {
  if (items) return items;
  const r = readJson(FILE, 'delayed');
  if (!r.ok) {
    if (!retryT) {
      retryT = setTimeout(() => {
        retryT = null;
        if (load() === items && items) changed();
      }, RETRY_MS);
      if (retryT.unref) retryT.unref();
    }
    return [];
  }
  const o = r.value;
  items = Array.isArray(o && o.items) ? o.items.filter((x) => x && typeof x.id === 'string' && x.req) : [];
  // A send that was under way when the server stopped may or may not have reached Claude: never send it twice.
  for (const it of items) {
    if (it.status === 'sending') {
      it.status = 'failed';
      it.error = 'Mission Control stopped while sending this. Check the conversation before you send it again.';
    }
  }
  return items;
}

function save() {
  if (!items) throw busyError(FILE);
  try {
    writeJson(FILE, { items });
  } catch (err) {
    console.error('[delayed] could not save delayed.json:', err.message);
  }
}

function publicItem(it) {
  return {
    id: it.id,
    kind: it.kind,
    at: it.at,
    createdAt: it.createdAt,
    sessionId: it.req.sessionId || null,
    projectId: it.req.projectId || null,
    preview: it.preview,
    text: it.req.prompt,
    atts: it.atts || [],
    status: it.status,
    error: it.error || null,
  };
}

export function listDelayed() {
  return { items: load().map(publicItem) };
}

function changed() {
  save();
  publish('delayed', listDelayed());
  arm();
}

function arm() {
  clearTimeout(timer);
  timer = null;
  const next = load()
    .filter((x) => x.status === 'waiting')
    .reduce((m, x) => Math.min(m, Date.parse(x.at)), Infinity);
  if (next === Infinity) return;
  const wait = Math.max(0, Math.min(next - Date.now(), MAX_WAIT_MS));
  timer = setTimeout(tick, wait);
  if (timer.unref) timer.unref();
}

function tick() {
  const now = Date.now();
  const due = load().filter((x) => x.status === 'waiting' && Date.parse(x.at) <= now);
  for (const it of due) fire(it);
  arm();
}

async function fire(it) {
  it.status = 'sending';
  changed();
  const r = it.req;
  try {
    // The same guard as a send from the page: a conversation open in Claude Desktop would split in two.
    if (isUuid(r.sessionId) && r.elsewhereOk !== true && !hasLiveSession(r.sessionId)) {
      const where = await elsewhereFor(r.sessionId, { waitMs: ELSEWHERE_WAIT_MS });
      if (where) throw fail(409, `Not sent: the conversation is open in ${where}. Close it there, then press Send now.`);
    }
    const out = await startRun({
      prompt: r.prompt,
      attachments: r.attachments,
      projectId: r.projectId,
      sessionId: r.sessionId,
      model: r.model,
      mode: r.mode,
      effort: r.effort,
    });
    items = load().filter((x) => x !== it);
    changed();
    publish('delayed.sent', { id: it.id, runId: out.runId, sessionId: r.sessionId || null, projectId: r.projectId || null });
  } catch (err) {
    const status = err && err.status;
    if ((status === 429 || status === 503) && (it.tries || 0) < MAX_RETRIES) {
      it.tries = (it.tries || 0) + 1;
      it.status = 'waiting';
      it.at = new Date(Date.now() + RETRY_MS).toISOString();
    } else {
      it.status = 'failed';
      it.error = String((err && err.message) || 'Could not send').slice(0, 300);
    }
    changed();
  }
}

function str(v, max = 200) {
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

// body: { kind: 'time'|'timer'|'reset', at?: ISO time (time and timer), req: what the page would send to POST /api/chat, atts?: chips to show }
export function addDelayed(body) {
  if (!body || typeof body !== 'object') throw fail(400, 'Body must be a JSON object');
  const kind = body.kind;
  if (!KINDS.includes(kind)) throw fail(400, 'kind must be time, timer or reset');
  let at;
  if (kind === 'reset') {
    const w = getUsage().fiveHour;
    const t = w && w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (!Number.isFinite(t) || t <= Date.now()) throw fail(409, 'The reset time of the 5-hour window is not known yet. Refresh Plan usage first.');
    at = t + RESET_MARGIN_MS;
  } else {
    at = Date.parse(body.at);
    if (!Number.isFinite(at)) throw fail(400, 'at must be a time');
  }
  if (at < Date.now() + 5000) throw fail(400, 'That time has already passed');
  if (at > Date.now() + MAX_AHEAD_MS) throw fail(400, 'A message can wait 6 days at most (attached files are kept 7 days)');

  const q = body.req;
  if (!q || typeof q !== 'object') throw fail(400, 'req is required');
  const prompt = str(q.prompt, 200000);
  if (!prompt || !prompt.trim()) throw fail(400, 'The message is empty');
  if (q.sessionId !== undefined && !isUuid(q.sessionId)) throw fail(400, 'sessionId must be a uuid');
  if (q.sessionId && isLocked(q.sessionId)) throw fail(409, 'This conversation is locked. Unlock it to send.');
  const attachments = Array.isArray(q.attachments) ? q.attachments.filter((a) => typeof a === 'string' && a.length <= 100).slice(0, 20) : undefined;
  const req = {
    prompt,
    attachments: attachments && attachments.length ? attachments : undefined,
    sessionId: q.sessionId || undefined,
    projectId: q.sessionId ? undefined : str(q.projectId),
    model: str(q.model),
    mode: str(q.mode),
    effort: str(q.effort),
    elsewhereOk: q.elsewhereOk === true || undefined,
  };
  const atts = Array.isArray(body.atts)
    ? body.atts.slice(0, 20).map((a) => ({ id: str(a && a.id, 100), name: str(a && a.name, 300), kind: str(a && a.kind, 20), size: Number(a && a.size) || 0, src: str(a && a.src, 300) || '' }))
    : [];
  const it = {
    id: crypto.randomUUID(),
    kind,
    at: new Date(at).toISOString(),
    createdAt: new Date().toISOString(),
    req,
    preview: prompt.replace(/\s+/g, ' ').trim().slice(0, 120),
    atts,
    status: 'waiting',
    tries: 0,
  };
  load().push(it);
  changed();
  return publicItem(it);
}

// Removes a waiting or failed message and hands it back, so the page can put the words in the message box again.
export function cancelDelayed(id) {
  const it = load().find((x) => x.id === id);
  if (!it) throw fail(404, 'Unknown message');
  if (it.status === 'sending') throw fail(409, 'This message is being sent right now');
  items = items.filter((x) => x !== it);
  changed();
  return publicItem(it);
}

export function sendDelayedNow(id) {
  const it = load().find((x) => x.id === id);
  if (!it) throw fail(404, 'Unknown message');
  if (it.status === 'sending') throw fail(409, 'This message is being sent right now');
  it.status = 'waiting';
  it.error = undefined;
  it.tries = 0;
  it.at = new Date().toISOString();
  changed();
  return publicItem(it);
}

// Start: arm the timer for what was waiting when the server stopped (anything overdue goes out at once).
load();
if (items && items.some((x) => x.status === 'failed')) save();
arm();
