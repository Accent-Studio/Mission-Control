// At 5 min left: what to send once a little before a conversation's prompt cache runs out (the expiryAction flag in
// sessionMeta.js). Both are real work done while the cache is still warm, which is cheaper than doing it cold:
//   handoff  Claude runs the "handoff" skill: work half done, gaps, what to do next, and a prompt that lets a fresh
//            conversation continue. If the conversation goes cold anyway, the next one starts from it.
//   compact  /compact, which sums up the conversation and frees the context.
// It is sent once, then the flag clears itself (back to None). It goes out LEAD before the end (5 min for the 1h cache,
// 1 min for the 5 min cache). The cache time is read from the transcript (getSessionStats), so a message sent meanwhile
// simply moves it later.
// Never sent to: a locked conversation, one that is working (the work itself refreshes the cache), one open in Claude
// Desktop (two processes would split it), or one whose cache has already run out (it would cost a full cache write; it
// waits for the next real message instead).
// The flag lives in sessions-meta.json, so it survives a restart; what happened last lives in memory only.
import { publish, onPublish } from '../lib/events.js';
import { getAllMeta, getMeta, setMeta, EXPIRY_ACTIONS } from './sessionMeta.js';
import { getSessionStats, elsewhereFor, isUuid } from './sessions.js';
import { pingSession, isSessionBusy } from './runs.js';
import { HANDOFF_PROMPT } from './userKinds.js';

const PROMPTS = { handoff: HANDOFF_PROMPT, compact: '/compact' };
const TEST_LEAD = Number(process.env.MC_EXPIRY_LEAD_MS) > 0 ? Number(process.env.MC_EXPIRY_LEAD_MS) : 0; // tests: send this long before the end
const LEAD_MS = { '1h': TEST_LEAD || 5 * 60e3, '5m': TEST_LEAD || 60e3 };
const RETRY_MS = 60e3; // busy, too many runs, open elsewhere: look again a minute later
const COLD_CHECK_MS = 5 * 60e3; // no warm cache: look again now and then (a message sent elsewhere warms it again)
const MAX_WAIT_MS = 3600e3;
const MAX_TRIES = 3; // sends refused for being busy, per cache time

const state = new Map(); // id -> { timer, nextAt, lastAt, last: 'sent'|'failed', lastAction, note, lastError, chain }

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function entry(id) {
  let s = state.get(id);
  if (!s) state.set(id, (s = { timer: null, nextAt: null, lastAt: null, last: null, note: null }));
  return s;
}

// What the page shows: { action, nextAt, lastAt, last, lastAction, note }. action: 'handoff', 'compact' or null (None);
// last: 'sent' or 'failed' (lastAction says which); note: why nothing is planned right now.
export function expiryStatus(id) {
  const key = String(id).toLowerCase();
  const m = getMeta(key);
  const s = state.get(key);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const action = (m && m.expiryAction) || null;
  if (!s) return { action, nextAt: null, lastAt: null, last: null, lastAction: null, note: null };
  return { action, nextAt: action ? iso(s.nextAt) : null, lastAt: iso(s.lastAt), last: s.last || null, lastAction: s.lastAction || null, note: action ? s.note || (s.last === 'failed' ? s.lastError || null : null) : null };
}

function announce(id) {
  publish('expiry-action', { id, ...expiryStatus(id) });
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

// Works out what to do now for one conversation: send, wait, or plan the next look.
async function look(id) {
  const m = getMeta(id);
  const action = m && !m.locked ? m.expiryAction : null;
  if (!action) { disarm(id); announce(id); return; }
  const st = await getSessionStats(id);
  if (!st) { arm(id, Date.now() + COLD_CHECK_MS, 'Conversation not found'); return; }
  const exp = expOf(st);
  const lead = LEAD_MS[st.cache.ttl] || LEAD_MS['5m'];
  const now = Date.now();
  if (!Number.isFinite(exp) || exp <= now) { arm(id, now + COLD_CHECK_MS, st.cache.compactedAt ? 'Compacted: no cache until the next message' : 'Cache expired'); return; }
  const s = entry(id);
  if (s.triesExp !== exp) { s.triesExp = exp; s.giveUpExp = 0; s.tries = 0; } // a new cache time: a fresh start
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
    // Once only: back to None (and the list loses its pill), unless the choice was changed while it was being sent.
    const cur = getMeta(id);
    try {
      if (cur && cur.expiryAction === action) setMeta(id, { expiryAction: null });
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

// Sets the action for one conversation: 'handoff', 'compact', or null (None). Returns the status the page shows.
export async function setExpiryAction(id, action) {
  if (!isUuid(id)) throw fail(400, 'Session id must be a uuid');
  if (action === 'none' || action === '') action = null;
  if (action !== null && !EXPIRY_ACTIONS.includes(action)) throw fail(400, `action must be none, ${EXPIRY_ACTIONS.join(' or ')}`);
  const key = id.toLowerCase();
  if (action && !(await getSessionStats(key))) throw fail(404, 'Unknown session');
  setMeta(key, { expiryAction: action });
  publish('sessions.changed', { id: key });
  if (action) {
    const s = entry(key);
    s.last = null; // a fresh choice: the page no longer reports the last one
    s.lastAt = null;
    s.lastAction = null;
    await check(key);
  } else { disarm(key); announce(key); }
  return expiryStatus(key);
}

// Every conversation that has an action gets a timer; a change to a conversation (a message, a lock) is looked at again.
function startAll() {
  for (const [id, m] of Object.entries(getAllMeta())) if (m && m.expiryAction) check(id);
}

let changeT = null;
const changed = new Set();
onPublish((type, data) => {
  if (type !== 'sessions.changed' && type !== 'session.stats') return;
  const id = data && (data.id || data.sessionId);
  if (typeof id !== 'string') return;
  const key = id.toLowerCase();
  const m = getMeta(key);
  if (!(m && m.expiryAction)) {
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
