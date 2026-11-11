// At 5 min left: what to send a little before a conversation's prompt cache runs out (the expiryAction choice in
// sessionMeta.js). Both are real work done while the cache is still warm, which is cheaper than doing it cold:
//   compact  /compact, which sums up the conversation and frees the context. The default: every conversation gets it
//            unless None is picked (or expiryFor leaves it out: a one-off task, a Com Link chat, a terminal conversation).
//            Sent only when the cache holds more than 300K tokens (COMPACT_MIN); a smaller one is left to run out.
//   handoff  Claude runs the "handoff" skill: work half done, gaps, what to do next, and a prompt that lets a fresh
//            conversation continue. It is sent once, then the choice goes back to the default.
// It goes out LEAD before the end (5 min for the 1h cache, 1 min for the 5 min cache), once per cache time. The cache time
// is read from the transcript (getSessionStats), so a message sent meanwhile simply moves it later.
// A conversation with nothing planned whose cache is about to run out is announced instead (cache-ending), and the Talk
// page makes its row pulse.
// Never sent to: a locked conversation, one that is working (the work itself refreshes the cache), one open in Claude
// Desktop (two processes would split it), or one whose cache has already run out (it would cost a full cache write; it
// waits for the next real message instead).
// The flag lives in sessions-meta.json, so it survives a restart; what happened last lives in memory only.
import { publish, onPublish } from '../lib/events.js';
import { getAllMeta, getMeta, setMeta, expiryFor, EXPIRY_CHOICES } from './sessionMeta.js';
import { allSessionRows, getSessionInfo, getSessionStats, elsewhereFor, isUuid } from './sessions.js';
import { pingSession, isSessionBusy } from './runs.js';
import { HANDOFF_PROMPT } from './userKinds.js';
import { isChatDir } from '../lib/chats.js';
import { isLocalModel } from '../lib/localModels.js';

const PROMPTS = { handoff: HANDOFF_PROMPT, compact: '/compact' };
const TEST_LEAD = Number(process.env.MC_EXPIRY_LEAD_MS) > 0 ? Number(process.env.MC_EXPIRY_LEAD_MS) : 0; // tests: send this long before the end
const LEAD_MS = { '1h': TEST_LEAD || 5 * 60e3, '5m': TEST_LEAD || 60e3 };
const RETRY_MS = 60e3; // busy, too many runs, open elsewhere: look again a minute later
const COLD_CHECK_MS = 5 * 60e3; // no warm cache: look again now and then (a message sent elsewhere warms it again)
const MAX_WAIT_MS = 3600e3;
const MAX_TRIES = 3; // sends refused for being busy, per cache time
const SCAN_MS = Number(process.env.MC_EXPIRY_SCAN_MS) > 0 ? Number(process.env.MC_EXPIRY_SCAN_MS) : 30e3; // the look over recent conversations
const RECENT_MS = 65 * 60e3; // used longer ago than this, no cache can still be warm
// Compact only pays off on a big cache: a smaller one costs little to write again, and its summary would lose detail
const COMPACT_MIN = Number(process.env.MC_COMPACT_MIN_TOKENS) || 300e3;

const state = new Map(); // id -> { timer, nextAt, lastAt, last: 'sent'|'failed', lastAction, note, lastError, chain }

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function entry(id) {
  let s = state.get(id);
  if (!s) state.set(id, (s = { timer: null, nextAt: null, lastAt: null, last: null, note: null }));
  return s;
}

// The action in force for one conversation: 'compact', 'handoff' or null (nothing). A terminal conversation gets no
// default, and a chat gets nothing at all: slash commands and skills are off in a chat, so it could run neither.
async function actionOf(id) {
  const m = getMeta(id);
  if (m && m.locked) return null;
  const info = await getSessionInfo(id).catch(() => null);
  if (info && isChatDir(info.cwd)) return null;
  if (info && isLocalModel(info.model)) return null; // a local model has no cache that runs out
  return expiryFor(m, info && info.lastEp);
}

// What the page shows: { action, choice, nextAt, lastAt, last, lastAction, note }. action: 'handoff', 'compact' or null
// (nothing); choice: what was picked ('none', 'handoff', 'compact'), null for the default; last: 'sent' or 'failed'
// (lastAction says which); note: why nothing is planned right now.
export async function expiryStatus(id) {
  const key = String(id).toLowerCase();
  const m = getMeta(key);
  const s = state.get(key);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const action = await actionOf(key);
  const choice = (m && m.expiryAction) || null;
  if (!s) return { action, choice, nextAt: null, lastAt: null, last: null, lastAction: null, note: null };
  return { action, choice, nextAt: action ? iso(s.nextAt) : null, lastAt: iso(s.lastAt), last: s.last || null, lastAction: s.lastAction || null, note: action ? s.note || (s.last === 'failed' ? s.lastError || null : null) : null };
}

function announce(id) {
  expiryStatus(id).then((st) => publish('expiry-action', { id, ...st })).catch((err) => console.error('[expiry]', err.message));
}

function arm(id, at, note) {
  const s = entry(id);
  clearTimeout(s.timer);
  s.nextAt = note ? null : at;
  s.note = note || null;
  const wait = Math.max(1000, Math.min(at - Date.now(), MAX_WAIT_MS));
  s.timer = setTimeout(() => check(id), wait);
  if (s.timer.unref) s.timer.unref();
  announce(id);
}

// Stops the timer; the last result stays so the page can say when it went out.
function disarm(id) {
  const s = state.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = null;
  s.nextAt = null;
  s.note = null;
}

const expOf = (st) => (st && st.cache && st.cache.expiresAt ? Date.parse(st.cache.expiresAt) : NaN);

// One look at a time per conversation, so two looks can never both decide to send.
function check(id) {
  const s = entry(id);
  s.chain = (s.chain || Promise.resolve()).then(() => look(id)).catch((err) => console.error('[expiry]', err.message));
  return s.chain;
}

// No timer, only a note: a conversation on the default with no warm cache waits for the look over recent ones (scan).
function rest(id, note) {
  disarm(id);
  entry(id).note = note;
  announce(id);
}

// Works out what to do now for one conversation: send, wait, or plan the next look.
async function look(id) {
  const m = getMeta(id);
  const action = await actionOf(id);
  if (!action) { disarm(id); announce(id); return; }
  const picked = !!(m && m.expiryAction === 'handoff'); // a handoff keeps a timer while cold; Compact leaves it to scan()
  const st = await getSessionStats(id);
  if (!st) { if (picked) arm(id, Date.now() + COLD_CHECK_MS, 'Conversation not found'); else rest(id, 'Conversation not found'); return; }
  const exp = expOf(st);
  const lead = LEAD_MS[st.cache.ttl] || LEAD_MS['5m'];
  const now = Date.now();
  if (!Number.isFinite(exp) || exp <= now) {
    const note = st.cache.compactedAt ? 'Compacted: no cache until the next message' : 'Cache expired';
    if (picked) arm(id, now + COLD_CHECK_MS, note); else rest(id, note);
    return;
  }
  const s = entry(id);
  // A cache written just after our own /compact came from it (a compact that failed and answered instead): never compact
  // twice in a row, or the compacts would keep the conversation warm for ever. The next real message starts again.
  const wrote = Date.parse(st.cache.lastAt);
  if (action === 'compact' && s.last === 'sent' && s.lastAction === 'compact' && wrote >= s.lastAt - 1000 && wrote - s.lastAt < 180e3) {
    if (picked) arm(id, exp + 1000, 'Compacted: waits for the next message'); else rest(id, 'Compacted: waits for the next message');
    return;
  }
  if (action === 'compact' && !(Number(st.contextUsed) > COMPACT_MIN)) {
    rest(id, `Under ${Math.round(COMPACT_MIN / 1e3)}K tokens: no compact`); // a message that grows it past that looks again
    return;
  }
  if (s.triesExp !== exp) { s.triesExp = exp; s.giveUpExp = 0; s.tries = 0; } // a new cache time: a fresh start
  // Sent already for this cache time, and the cache did not move (the CLI refused it, or answered without a request):
  // sending again would only repeat that, every few seconds, until the cache runs out.
  if (s.last === 'sent' && s.sentExp === exp) { arm(id, exp + 1000, 'Sent: waits for the next message'); return; }
  // It failed for this cache time already: wait until the cache has run out (then it waits for a real message).
  if (s.giveUpExp === exp) { arm(id, exp + 1000, s.note || 'Could not send'); return; }
  if (isSessionBusy(id)) { arm(id, now + RETRY_MS); return; }
  const due = exp - lead;
  if (due > now + 1000) { arm(id, due); return; }
  // Due: the conversation must not be open in Claude Desktop.
  const where = await elsewhereFor(id, { waitMs: 5000 });
  if (where) { arm(id, now + RETRY_MS, `Open in ${where}`); return; }
  if (isSessionBusy(id)) { arm(id, Date.now() + RETRY_MS); return; } // a message went out during that wait
  try {
    await pingSession(id, PROMPTS[action], st.model);
    s.lastAt = Date.now();
    s.last = 'sent';
    s.lastAction = action;
    s.sentExp = exp;
    // A handoff goes once: back to the default (and the list loses its pill), unless the choice was changed while it was
    // being sent. Compact stays on for the next cache time.
    const cur = getMeta(id);
    try {
      if (action === 'handoff' && cur && cur.expiryAction === action) setMeta(id, { expiryAction: null });
    } catch (err) {
      console.error('[expiry] sent, but could not clear the choice:', err.message); // it was sent: never report a failure
    }
    disarm(id);
    publish('sessions.changed', { id });
    announce(id);
  } catch (err) {
    const status = err && err.status;
    s.lastAt = Date.now();
    s.last = 'failed';
    s.lastAction = action;
    s.lastError = String((err && err.message) || 'Could not send').slice(0, 200);
    s.tries = (s.tries || 0) + 1;
    // Too many runs at once (429) or a restart taking over (503): try again a minute later, at most MAX_TRIES times and only
    // while there is time. Anything else will not get better by itself: give up for this cache time.
    if ((status === 429 || status === 503) && s.tries < MAX_TRIES && exp - Date.now() > RETRY_MS + 30e3) arm(id, Date.now() + RETRY_MS);
    else {
      s.giveUpExp = exp;
      arm(id, exp + 1000, 'Could not send: ' + s.lastError);
    }
  }
}

// Sets the choice for one conversation: 'none', 'handoff', 'compact', or null (the default). Returns the status the page shows.
export async function setExpiryAction(id, action) {
  if (!isUuid(id)) throw fail(400, 'Session id must be a uuid');
  if (action === '' || action === undefined) action = null;
  if (action !== null && !EXPIRY_CHOICES.includes(action)) throw fail(400, `action must be ${EXPIRY_CHOICES.join(', ')}`);
  const key = id.toLowerCase();
  if (action && action !== 'none' && !(await getSessionStats(key))) throw fail(404, 'Unknown session');
  if (action && action !== 'none') {
    const info = await getSessionInfo(key).catch(() => null);
    if (info && isChatDir(info.cwd)) throw fail(409, 'A chat cannot run Compact or Handoff');
  }
  if (action === 'compact') {
    const info = await getSessionInfo(key).catch(() => null);
    if (expiryFor({ ...(getMeta(key) || {}), expiryAction: undefined }, info && info.lastEp) === 'compact') action = null; // the default already
  }
  setMeta(key, { expiryAction: action });
  publish('sessions.changed', { id: key });
  if (await actionOf(key)) {
    const s = entry(key);
    s.last = null; // a fresh choice: the page no longer reports the last one
    s.lastAt = null;
    s.lastAction = null;
    await check(key);
  } else { disarm(key); announce(key); }
  return expiryStatus(key);
}

// A conversation with Handoff picked gets a timer at start; a change to a conversation (a message, a lock) is looked at again.
function startAll() {
  for (const [id, m] of Object.entries(getAllMeta())) if (m && m.expiryAction === 'handoff') check(id);
}

// Caches about to run out with nothing planned: id -> expiresAt (ms). The Talk page pulses these rows.
const ending = new Map();
export function cacheEnding() {
  return [...ending].map(([id, at]) => ({ id, expiresAt: new Date(at).toISOString() }));
}

// The look over recent conversations, every SCAN_MS. Conversations on the default get no timer while cold, and a message
// sent from Claude Desktop tells this server nothing, so this is how they are found again. Those with nothing planned are
// checked for a cache about to run out.
let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const rows = await allSessionRows();
    const now = Date.now();
    const seen = new Set();
    for (const r of rows) {
      const at = Date.parse(r.lastAt);
      if (!Number.isFinite(at) || now - at > RECENT_MS || r.locked || r.kind === 'chat') continue;
      const id = r.id.toLowerCase();
      if (r.expiryAction) {
        const s = state.get(id);
        if (!(s && s.timer) && !(s && s.restedAt === r.lastAt)) {
          entry(id).restedAt = r.lastAt; // a cold one is looked at again only once it has been used since
          check(id);
        }
        continue;
      }
      const st = await getSessionStats(id).catch(() => null);
      if (st && isLocalModel(st.model)) continue;
      const exp = expOf(st);
      const lead = (st && LEAD_MS[st.cache.ttl]) || LEAD_MS['5m'];
      if (!Number.isFinite(exp) || exp <= now || exp - lead > now) continue;
      seen.add(id);
      if (ending.get(id) !== exp) {
        ending.set(id, exp);
        publish('cache-ending', { id, expiresAt: new Date(exp).toISOString() });
      }
    }
    for (const id of [...ending.keys()]) {
      if (seen.has(id)) continue;
      ending.delete(id);
      publish('cache-ending', { id, expiresAt: null });
    }
  } catch (err) {
    console.error('[expiry] scan:', err.message);
  } finally {
    scanning = false;
  }
}

let changeT = null;
const changed = new Set();
onPublish((type, data) => {
  if (type !== 'sessions.changed' && type !== 'session.stats') return;
  const id = data && (data.id || data.sessionId);
  if (typeof id !== 'string') return;
  const key = id.toLowerCase();
  const m = getMeta(key);
  if (!expiryFor(m, null)) {
    if (state.has(key) && state.get(key).timer) { disarm(key); announce(key); } // set to None or locked from elsewhere
    return;
  }
  changed.add(key);
  clearTimeout(changeT);
  changeT = setTimeout(() => {
    for (const k of changed) check(k);
    changed.clear();
  }, 3000);
  if (changeT.unref) changeT.unref();
});

setTimeout(startAll, 8000).unref();
setTimeout(() => {
  scan();
  setInterval(scan, SCAN_MS).unref();
}, 9000).unref();
