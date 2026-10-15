// Link to the BlitzVoice local control server. One SSE connection in, republished on Mission Control's own stream.
// The token lives only in memory here and is never logged or sent to the browser.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { publish, clientCount } from '../lib/events.js';
import { DATA_DIR } from '../config.js';
import { readJson, writeJson, busyError } from '../lib/jsonStore.js';
import '../../app/phrases.js'; // the same phrase rules the browser uses (sets globalThis.MCPhrases)

const Phrases = globalThis.MCPhrases;

const CONTROL_FILE = process.env.MC_VOICE_CONTROL_FILE
  || path.join(process.env.APPDATA || '', 'com.blitzraw.voice', 'control.json');

const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30000;
const LEVEL_GAP_MS = 1000 / 15;

let ctl = null; // control info the current attempt or connection uses: { port, token, pid }
let req = null; // the live SSE request
let connected = false;
let reason = 'not running';
let state = 'idle';
let backoff = BACKOFF_MIN;
let retryTimer = null;
let lastLevelAt = 0;
let levelValue = 0;
let levelTimer = null;
let started = false;
const seenWakeIds = new Set(); // ids of wake dictations already handled (newest 100)
const WAKE_IDS_CAP = 100;
const WAKE_TEXT_MAX = 4000; // characters; a longer wake dictation is dropped
let wake = null; // BlitzVoice's last wake status (what GET /wake and the wake_state event carry), null when unknown
const wakeRoutes = new Map(); // wake dictation id -> { target }: the tab named when the wake word was heard, so partials and the text agree
const WAKE_ROUTES_CAP = 100;

function readControl() {
  let raw;
  try {
    raw = fs.readFileSync(CONTROL_FILE, 'utf8');
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(raw.replace(/^﻿/, ''));
    const port = Number(j.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof j.token !== 'string' || !j.token) return null;
    return { port, token: j.token, pid: Number(j.pid) || 0 };
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return true; // unknown pid: let the connection attempt decide
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

function sameCtl(a, b) {
  return !!a && !!b && a.port === b.port && a.token === b.token && a.pid === b.pid;
}

function status() {
  return { available: connected, reason: connected ? 'ok' : reason, state: connected ? state : 'idle' };
}

function announce() {
  publish('voice', { kind: 'status', ...status() });
}

function setDown(why) {
  const changed = connected || reason !== why;
  connected = false;
  reason = why;
  state = 'idle';
  wake = null;
  if (changed) announce();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(attempt, backoff);
  retryTimer.unref();
  backoff = Math.min(BACKOFF_MAX, backoff * 2);
}

function dropConnection() {
  if (req) {
    const r = req;
    req = null;
    r.destroy();
  }
}

function handleEvent(name, raw) {
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!data || typeof data !== 'object') return;
  const kind = name || data.type;
  if (kind === 'hello') {
    backoff = BACKOFF_MIN;
    if (!connected) {
      connected = true;
      reason = 'ok';
      announce();
      // wake_state also comes with every change, but ask once for the current one. Then the wake dictation runs until
      // a phrase ends it (the assistant listens for "send it" and "cancel that") instead of stopping at the first pause.
      refreshWake().then(pinWakeAutostop);
    }
  } else if (kind === 'state') {
    if (typeof data.state !== 'string') return;
    state = data.state;
    publish('voice', { kind: 'state', state });
  } else if (kind === 'level') {
    const v = Number(data.value);
    if (!Number.isFinite(v) || clientCount() === 0) return;
    levelValue = Math.max(0, Math.min(1, v));
    // At most 15 a second: the newest value waits for the next slot instead of being dropped.
    if (levelTimer) return;
    const wait = Math.max(0, LEVEL_GAP_MS - (Date.now() - lastLevelAt));
    levelTimer = setTimeout(() => {
      levelTimer = null;
      lastLevelAt = Date.now();
      if (clientCount() > 0 && state === 'recording') publish('voice', { kind: 'level', value: levelValue });
    }, wait);
    levelTimer.unref();
  } else if (kind === 'transcript') {
    const text = typeof data.text === 'string' ? data.text : '';
    const error = typeof data.error === 'string' && data.error ? data.error.slice(0, 200) : '';
    if (typeof data.text !== 'string' && !error) return;
    // An empty text with an error is a failed dictation; an empty text alone means nothing was heard.
    const id = data.id == null ? null : String(data.id);
    if (data.wake === true) {
      // A replay or a reconnect must never send twice: each wake dictation id is handled once
      // (BlitzVoice seeds its ids from the clock, so a restart does not reuse them).
      if (id != null) {
        if (seenWakeIds.has(id)) return;
        seenWakeIds.add(id);
        if (seenWakeIds.size > WAKE_IDS_CAP) seenWakeIds.delete(seenWakeIds.values().next().value);
      }
      // A wake dictation goes to one tab only: the one looked at last (null when no tab was visible lately).
      // The tab named when the wake word was heard keeps it, so the live words and the text reach the same tab.
      const route = id != null ? wakeRoutes.get(id) : null;
      const target = route ? route.target : pickWakeTarget();
      if (text.length > WAKE_TEXT_MAX) {
        // Too long to send into a conversation: drop it and tell the tab that would have sent it.
        if (target) publish('voice', { kind: 'wake_note', target, note: 'Dictation too long, so nothing was sent.' });
        return;
      }
      publish('voice', { kind: 'transcript', id, text, wake: true, target, ...(error ? { error } : {}) });
    } else {
      publish('voice', { kind: 'transcript', id, text, ...(error ? { error } : {}) });
    }
  } else if (kind === 'partial') {
    // The latest full text of a live dictation (about 10 a second). A wake dictation carries its target tab.
    const id = data.id == null ? null : String(data.id);
    if (id == null || typeof data.text !== 'string' || clientCount() === 0) return;
    const route = wakeRoutes.get(id);
    publish('voice', { kind: 'partial', id, text: data.text.slice(0, WAKE_TEXT_MAX), ...(route ? { wake: true, target: route.target } : {}) });
  } else if (kind === 'wake_state') {
    setWake(data.status);
  } else if (kind === 'wake') {
    if (typeof data.model !== 'string') return;
    const score = Number(data.score);
    const id = data.id == null ? null : String(data.id);
    // The tab that acts is chosen now. When none would (no page is being looked at, or the one is not a page with the
    // assistant) the dictation is dropped at once, because nobody would end it.
    let target = pickWakeTarget();
    if (target && tabs.get(target) && tabs.get(target).page === 'other') target = null;
    if (id != null) {
      wakeRoutes.set(id, { target });
      if (wakeRoutes.size > WAKE_ROUTES_CAP) wakeRoutes.delete(wakeRoutes.keys().next().value);
    }
    if (!target) dropOrphanDictation();
    publish('voice', { kind: 'wake', id, model: data.model.slice(0, 80), score: Number.isFinite(score) ? score : null, target });
  }
}

function attempt() {
  clearTimeout(retryTimer);
  if (req) return;
  const next = readControl();
  if (!next) {
    ctl = null;
    setDown('not running');
    return scheduleRetry();
  }
  ctl = next;
  if (!pidAlive(next.pid)) {
    setDown('not running');
    return scheduleRetry();
  }
  const r = http.request({
    host: '127.0.0.1',
    port: next.port,
    path: '/events',
    method: 'GET',
    headers: { Authorization: `Bearer ${next.token}`, Accept: 'text/event-stream' },
  });
  req = r;
  r.on('response', (res) => {
    // Every exit from here ends in 'close', which clears the request and schedules the next try.
    res.on('error', () => {}); // an abrupt end is reported by 'close' just below
    res.on('close', () => {
      if (req !== r) return; // dropped on purpose: its replacement owns the state
      req = null;
      setDown(connected ? 'not running' : reason);
      scheduleRetry();
    });
    if (res.statusCode === 401 || res.statusCode === 403) {
      res.resume();
      setDown('unauthorized');
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      setDown('link off');
      return;
    }
    // BlitzVoice sends a heartbeat every 15 s: silence for 45 s means the connection is dead.
    if (res.socket) res.socket.setTimeout(45000, () => r.destroy());
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        let name = '';
        const dataLines = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (dataLines.length) handleEvent(name, dataLines.join('\n'));
      }
      if (buf.length > 65536) buf = '';
    });
  });
  r.on('error', (err) => {
    if (req !== r) return;
    req = null;
    // Refused while the process is alive: the link setting is off. Anything else: not running.
    setDown(err && err.code === 'ECONNREFUSED' && next.pid && pidAlive(next.pid) ? 'link off' : 'not running');
    scheduleRetry();
  });
  r.end();
}

// Re-reads the control file now and then: a changed file or a dead process restarts the connection at once.
function watch() {
  const next = readControl();
  if (req && (!next || !sameCtl(next, ctl) || !pidAlive(next.pid))) {
    dropConnection();
    setDown('not running');
    backoff = BACKOFF_MIN;
    attempt();
  } else if (!req && next && !sameCtl(next, ctl)) {
    backoff = BACKOFF_MIN;
    attempt();
  }
}

export function startVoice() {
  if (started) return;
  started = true;
  attempt();
  setInterval(watch, 2000).unref();
}

export function voiceStatus() {
  startVoice();
  return status();
}

// Calls BlitzVoice with the token. Resolves { status, body }. The body is JSON, or raw bytes when `body` is a Buffer
// (then opts.contentType names them). Both kinds of answer are JSON. opts.timeout is the wait in ms (5 s unless given).
// opts.maxReply is the most bytes of an answer that are kept (64 KB unless given): a bigger one is dropped and gives a 502.
// An answer that really came from BlitzVoice carries `bv: true` (a 502 or 503 made here does not).
const REPLY_MAX = 64 * 1024;
function voiceCall(method, route, body, opts = {}) {
  startVoice();
  return new Promise((resolveOnce) => {
    // Every exit (the answer, a timeout, a cut connection, an oversized answer) goes through here, and only the first one counts.
    let settled = false;
    const resolve = (v) => {
      if (settled) return;
      settled = true;
      resolveOnce(v);
    };
    const c = connected ? ctl : null;
    if (!c) return resolve({ status: 503, body: { error: 'BlitzVoice is not connected', ...status() } });
    const maxReply = opts.maxReply || REPLY_MAX;
    const get = method === 'GET';
    const raw = Buffer.isBuffer(body);
    const payload = get ? '' : raw ? body : JSON.stringify(body || {});
    const headers = { Authorization: `Bearer ${c.token}` };
    if (!get) {
      headers['Content-Type'] = raw ? opts.contentType || 'application/octet-stream' : 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request({
      host: '127.0.0.1',
      port: c.port,
      path: route,
      method,
      agent: false, // one request per socket: BlitzVoice closes after every answer
      headers,
      timeout: opts.timeout || 5000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      let ended = false;
      const overflow = () => {
        tooBig = true;
        chunks.length = 0;
        resolve({ status: 502, body: { error: 'BlitzVoice answer too large' } });
        r.destroy();
      };
      // BlitzVoice closed in the middle of its answer (the headers came, the body did not finish): that is a 502, not a hang.
      const cut = () => {
        if (ended) return;
        chunks.length = 0;
        resolve({ status: 502, body: { error: 'BlitzVoice did not answer' } });
      };
      res.on('aborted', cut);
      res.on('error', cut);
      res.on('close', cut);
      if (Number(res.headers['content-length']) > maxReply) return overflow();
      res.on('data', (d) => {
        if (tooBig) return;
        size += d.length;
        if (size > maxReply) return overflow();
        chunks.push(d);
      });
      res.on('end', () => {
        ended = true;
        if (tooBig) return;
        let parsed = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          parsed = {};
        }
        resolve({ status: res.statusCode || 502, body: parsed && typeof parsed === 'object' ? parsed : {}, bv: true });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', () => resolve({ status: 502, body: { error: 'BlitzVoice did not answer' } }));
    if (get) r.end(); else r.end(payload);
  });
}

// Forwards start, stop, cancel or discard to BlitzVoice with the token. Resolves { status, body }.
export function voiceAction(action, body) {
  return voiceCall('POST', '/' + action, body);
}

// What /start sends to BlitzVoice. The browser may ask for live words (partials), no automatic stop (autostop) and a
// model; the rest is fixed here. The dictation cleanup switch lives in the voice preferences unless the page overrides it.
export function buildStartBody(opts) {
  const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const out = { deliver: 'link', cleanup: typeof o.cleanup === 'boolean' ? o.cleanup : getVoicePrefs().cleanup };
  if (typeof o.partials === 'boolean') out.partials = o.partials;
  if (o.autostop === 'none' || o.autostop === 'silence') out.autostop = o.autostop;
  if (typeof o.model === 'string' && o.model && o.model.length <= 80) out.model = o.model;
  return out;
}

// Ends a dictation at once: no transcription, no paste, no transcript event.
export function voiceDiscard() {
  return voiceAction('discard', {});
}

// A wake dictation nobody will end. Asked twice because the recording may not have begun when the wake word was announced.
function dropOrphanDictation() {
  voiceDiscard().catch(() => {});
  const t = setTimeout(() => {
    if (state === 'recording') voiceDiscard().catch(() => {});
  }, 600);
  t.unref();
}

// ---- Wake word: BlitzVoice listens for the phrase and starts a dictation by itself ----

// Keeps the newest status and tells the browsers, but only when something changed.
function setWake(status) {
  const next = status && typeof status === 'object' && !Array.isArray(status) ? cleanWake(status) : null;
  if (JSON.stringify(next) === JSON.stringify(wake)) return;
  wake = next;
  publish('voice', { kind: 'wake_state', wake });
}

// Only the fields the browser uses, with their types checked.
function cleanWake(w) {
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    enabled: w.enabled === true,
    state: ['off', 'loading', 'listening', 'paused', 'error'].includes(w.state) ? w.state : 'off',
    paused_reason: ['no_link', 'speaking', 'dictating'].includes(w.paused_reason) ? w.paused_reason : null,
    model: str(w.model, 80),
    threshold: num(w.threshold),
    models: Array.isArray(w.models)
      ? w.models.filter((m) => m && typeof m.id === 'string').slice(0, 50).map((m) => ({ id: m.id.slice(0, 80), bundled: m.bundled === true }))
      : [],
    autostop: w.autostop === undefined ? null : w.autostop,
    error: str(w.error, 300),
  };
}

async function refreshWake() {
  const r = await voiceCall('GET', '/wake');
  if (r.status === 200) setWake(r.body);
}

// Tells BlitzVoice to end wake dictations by phrase. An older BlitzVoice refuses the key: then nothing changes.
async function pinWakeAutostop() {
  if (!connected) return;
  const r = await voiceCall('POST', '/wake', { autostop: 'phrase' });
  if (r.status === 200) setWake(r.body);
}

// What the browser asks for: whether BlitzVoice is linked, and its last wake status
// (null when there is none, for example an older BlitzVoice without a wake word).
export function wakeStatus() {
  startVoice();
  return { available: connected, wake: connected ? wake : null };
}

const WAKE_KEYS = ['enabled', 'model', 'threshold', 'autostop'];

// Checks a change to the wake settings and passes it on. Resolves { status, body } like voiceAction.
export async function setWakeSettings(body) {
  const bad = (error) => ({ status: 400, body: { error } });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Send an object like {"enabled": true}');
  const keys = Object.keys(body);
  if (!keys.length) return bad('Send enabled, model, threshold or autostop');
  for (const k of keys) if (!WAKE_KEYS.includes(k)) return bad(`Unknown setting: ${k.slice(0, 40)}`);
  const out = {};
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') return bad('enabled must be true or false');
    out.enabled = body.enabled;
  }
  if ('model' in body) {
    if (typeof body.model !== 'string' || !body.model || body.model.length > 80) return bad('model must be a model id');
    if (wake && wake.models.length && !wake.models.some((m) => m.id === body.model)) return bad('That wake word model is not installed');
    out.model = body.model;
  }
  if ('threshold' in body) {
    const t = body.threshold;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0.05 || t > 0.99) return bad('threshold must be a number from 0.05 to 0.99');
    out.threshold = t;
  }
  if ('autostop' in body) {
    if (body.autostop !== 'silence' && body.autostop !== 'phrase') return bad('autostop must be silence or phrase');
    out.autostop = body.autostop;
  }
  const r = await voiceCall('POST', '/wake', out);
  if (r.status === 200) setWake(r.body);
  return r;
}

// ---- Which browser tab gets a wake dictation ----
// Each page tells the server when it becomes visible or focused. The text goes to the tab focused last.
// When every tab is hidden it still goes to the one that was visible most recently, for up to 2 minutes.

const GRACE_MS = Number(process.env.MC_WAKE_GRACE_MS) || 2 * 60 * 1000;
const VISIBLE_STALE_MS = 95 * 1000;
const TAB_FORGET_MS = 10 * 60 * 1000;
const AT_MAX_AGE_MS = 60 * 1000; // a report claiming to be older than this is treated as 60s old
const TAB_CAP = 50;
const GONE_CAP = 200;
const tabs = new Map(); // tab id -> { page, visible, focusAt, visibleAt, seen, seq }
const gone = new Map(); // tab id -> seq of its last "gone" report, so a late older report cannot bring the tab back

// A page report: {tab, seq, at, page, visible, focused?, beat?} or {tab, seq, gone: true}.
// Order comes from the page: seq rises per tab, and at is the page's own clock time of the event.
// The server's arrival time only decides which tab was seen least recently.
export function noteTab(body, nowMs) {
  const fail = (m) => Object.assign(new Error(m), { status: 400 });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Send {tab, seq, at, page, visible}');
  const { tab, page, visible, seq } = body;
  if (typeof tab !== 'string' || !/^[\w-]{1,64}$/.test(tab)) throw fail('tab must be a short id');
  if (!Number.isSafeInteger(seq) || seq < 0) throw fail('seq must be a whole number');
  const isGone = body.gone === true;
  if (!isGone) {
    if (page !== 'chat' && page !== 'comlink' && page !== 'other') throw fail('page must be chat, comlink or other');
    if (typeof visible !== 'boolean') throw fail('visible must be true or false');
    if (typeof body.at !== 'number' || !Number.isFinite(body.at)) throw fail('at must be a time in milliseconds');
  }
  const now = nowMs == null ? Date.now() : nowMs;
  for (const [id, t] of tabs) if (now - t.seen > TAB_FORGET_MS) tabs.delete(id);
  if (isGone) {
    const prev = tabs.get(tab);
    if (prev && seq <= prev.seq) return { ok: true, ignored: true }; // an older "gone" than a report already seen
    tabs.delete(tab);
    gone.delete(tab);
    gone.set(tab, seq);
    if (gone.size > GONE_CAP) gone.delete(gone.keys().next().value);
    return { ok: true };
  }
  let t = tabs.get(tab);
  if (t ? seq <= t.seq : gone.has(tab) && seq <= gone.get(tab)) return { ok: true, ignored: true }; // a replay or a late report
  const isNew = !t;
  if (!t) {
    if (tabs.size >= TAB_CAP) {
      let oldest = null;
      let oldestSeen = Infinity;
      for (const [id, x] of tabs) if (x.seen < oldestSeen) { oldest = id; oldestSeen = x.seen; }
      tabs.delete(oldest);
    }
    gone.delete(tab);
    t = { page, visible: false, focusAt: 0, visibleAt: 0, seen: now, seq };
    tabs.set(tab, t);
  }
  const at = Math.min(now, Math.max(now - AT_MAX_AGE_MS, body.at));
  t.page = page;
  t.seen = now;
  t.seq = seq;
  // Only a real focus event (a visible, focused page, not a heartbeat) makes a tab the one focused last.
  // A tab's first report counts as one even if it is a heartbeat: after a server restart that is all we get.
  if (visible && body.focused === true && (body.beat !== true || isNew)) t.focusAt = Math.max(t.focusAt, at);
  if (visible || t.visible) t.visibleAt = Math.max(t.visibleAt, at); // a tab that just hid was visible until then
  t.visible = visible;
  return { ok: true };
}

// The id of the tab that gets a wake dictation, or null.
export function pickWakeTarget(nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  let best = null;
  let bestId = null;
  for (const [id, t] of tabs) {
    // A visible tab beats every 30s: three missed beats mean its page is gone. A hidden one counts for the grace time.
    if (now - t.visibleAt > (t.visible ? VISIBLE_STALE_MS : GRACE_MS)) continue;
    let better;
    if (!best) better = true;
    else if (t.visible !== best.visible) better = t.visible;
    else if (t.visible) better = t.focusAt > best.focusAt || (t.focusAt === best.focusAt && t.visibleAt > best.visibleAt);
    else better = t.visibleAt > best.visibleAt;
    if (better) { best = t; bestId = id; }
  }
  return bestId;
}

// Test hook: forget every tab.
export function resetTabs() {
  tabs.clear();
  gone.clear();
}

// ---- Voice preferences: kept on the server so every tab (and later a phone) sees the same switches ----

const PREFS_FILE = path.join(DATA_DIR, 'voice-prefs.json');
// readAloud and cleanup are for the Talk page. The rest drive the Com Link: its name and persona, listening again after
// an answer, and the panel. remoteControl ("Show on claude.ai") is not about voice but lives here with the other
// switches every page shares: runs.js reads it when it starts a Claude process.
const BOOL_PREFS = { readAloud: false, cleanup: true, comlinkPersona: true, autoListen: true, remoteControl: true };
// Whole numbers in seconds: [default, min, max]. hidePanelSec 0 means the panel never hides by itself.
const NUM_PREFS = { listenSilenceSec: [30, 5, 600], hidePanelSec: [0, 0, 3600] };
// Choices: [default, allowed values]. comlinkModel '' means the newest Haiku; any other value is a model id from the CLI.
const CHOICE_PREFS = {
  comlinkEffort: ['medium', ['default', 'low', 'medium', 'high', 'xhigh', 'max']],
  comlinkMode: ['auto', ['default', 'acceptEdits', 'plan', 'auto']],
};
const MODEL_RE = /^[A-Za-z0-9._[\]-]{0,80}$/;
// The assistant's name, shown on every page: 1 to 24 letters, digits, spaces, dots, apostrophes and hyphens.
const NAME_RE = /^[\p{L}\p{N} .'-]{1,24}$/u;
const nameOk = (v) => typeof v === 'string' && NAME_RE.test(v.trim()) && v.trim() === v;
const PHRASE_PREFS = {
  sendPhrase: Phrases.DEFAULTS.send,
  cancelPhrase: Phrases.DEFAULTS.cancel,
  rewritePhrase: Phrases.DEFAULTS.rewrite,
  endPhrase: Phrases.DEFAULTS.end,
};
// The first two phrase settings that share a variation once normalized, or null. Every phrase must differ from the others.
function samePhrases(p) {
  const keys = Object.keys(PHRASE_PREFS);
  const sets = keys.map((k) => new Set(Phrases.variants(p[k]).map(Phrases.normalize)));
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) if ([...sets[i]].some((v) => sets[j].has(v))) return [keys[i], keys[j]];
  return null;
}
const PREF_DEFAULTS = {
  ...BOOL_PREFS,
  ...PHRASE_PREFS,
  ...Object.fromEntries(Object.entries(NUM_PREFS).map(([k, v]) => [k, v[0]])),
  ...Object.fromEntries(Object.entries(CHOICE_PREFS).map(([k, v]) => [k, v[0]])),
  comlinkModel: '',
  comlinkName: 'Com Link',
};
const numOk = (k, v) => Number.isInteger(v) && v >= NUM_PREFS[k][1] && v <= NUM_PREFS[k][2];
let prefs = null;

// A file that could not be read right now gives the defaults without keeping them: the next call reads again, and a
// save refuses meanwhile, so the saved choices are never written over by defaults (jsonStore.js).
function loadPrefs() {
  if (prefs) return prefs;
  const r = readJson(PREFS_FILE, 'voice');
  const p = { ...PREF_DEFAULTS };
  const j = r.value && typeof r.value === 'object' ? r.value : {};
  for (const k of Object.keys(BOOL_PREFS)) if (typeof j[k] === 'boolean') p[k] = j[k];
  for (const k of Object.keys(PHRASE_PREFS)) {
    const c = Phrases.checkPhrase(j[k]);
    if (c.ok) p[k] = c.phrase;
  }
  if (samePhrases(p)) Object.assign(p, PHRASE_PREFS);
  for (const k of Object.keys(NUM_PREFS)) if (numOk(k, j[k])) p[k] = j[k];
  for (const k of Object.keys(CHOICE_PREFS)) if (CHOICE_PREFS[k][1].includes(j[k])) p[k] = j[k];
  if (typeof j.comlinkModel === 'string' && MODEL_RE.test(j.comlinkModel)) p.comlinkModel = j.comlinkModel;
  if (nameOk(j.comlinkName)) p.comlinkName = j.comlinkName;
  if (r.ok) prefs = p;
  return p;
}

export function getVoicePrefs() {
  return { ...loadPrefs() };
}

// Takes a partial object: the booleans, the phrases (2 to 30 letters and spaces, and all must differ), the numbers in
// NUM_PREFS, the choices in CHOICE_PREFS, comlinkModel and comlinkName. Throws a 400 for a wrong type or value. Unknown keys are ignored.
export function setVoicePrefs(patch) {
  const fail = (m) => Object.assign(new Error(m), { status: 400 });
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('Send an object like {"readAloud": true}');
  const next = { ...loadPrefs() };
  if (!prefs) throw busyError(PREFS_FILE);
  for (const k of Object.keys(BOOL_PREFS)) {
    if (!(k in patch)) continue;
    if (typeof patch[k] !== 'boolean') throw fail(`${k} must be true or false`);
    next[k] = patch[k];
  }
  for (const k of Object.keys(PHRASE_PREFS)) {
    if (!(k in patch)) continue;
    const c = Phrases.checkPhrase(patch[k]);
    if (!c.ok) throw fail(`${k} ${c.error}`);
    next[k] = c.phrase;
  }
  const same = samePhrases(next);
  if (same) throw fail(`${same[0]} and ${same[1]} must differ`);
  for (const k of Object.keys(NUM_PREFS)) {
    if (!(k in patch)) continue;
    if (!numOk(k, patch[k])) throw fail(`${k} must be a whole number from ${NUM_PREFS[k][1]} to ${NUM_PREFS[k][2]}`);
    next[k] = patch[k];
  }
  for (const k of Object.keys(CHOICE_PREFS)) {
    if (!(k in patch)) continue;
    if (!CHOICE_PREFS[k][1].includes(patch[k])) throw fail(`${k} must be one of ${CHOICE_PREFS[k][1].join(', ')}`);
    next[k] = patch[k];
  }
  if ('comlinkModel' in patch) {
    if (typeof patch.comlinkModel !== 'string' || !MODEL_RE.test(patch.comlinkModel)) throw fail('comlinkModel must be a model id');
    next.comlinkModel = patch.comlinkModel;
  }
  if ('comlinkName' in patch) {
    if (!nameOk(patch.comlinkName)) throw fail('comlinkName must be 1 to 24 letters, digits or spaces');
    next.comlinkName = patch.comlinkName;
  }
  const changed = Object.keys(PREF_DEFAULTS).some((k) => next[k] !== prefs[k]);
  prefs = next;
  if (changed) {
    try {
      writeJson(PREFS_FILE, prefs);
    } catch (err) {
      console.error('[voice] could not save preferences:', err.message);
    }
    publish('voice', { kind: 'prefs', ...prefs });
  }
  return { ...prefs };
}

// ---- Reading replies aloud ----

export const SPEAK_MAX = 20000;
const DEDUPE_MS = 2 * 60 * 1000;
const SEEN_MAX = 500;
const seenKeys = new Map(); // dedupe key -> time first seen
const LEAD = '(^|[\\s(\\[`"\'])'; // a path starts at the beginning or after a space, bracket or quote
const PUNCT_END = '.,;:!?';
// Sentence punctuation at the very end of a matched URL or path belongs to the sentence, not to the link or path.
function endPunct(s) {
  let i = s.length;
  while (i > 0 && PUNCT_END.includes(s[i - 1])) i--;
  return s.slice(i);
}
// A Windows path: segments before the last may hold spaces (up to 40 characters each), the last one ends at a space.
const WIN_PATH = '(?:[A-Za-z]:[\\\\/]|\\\\\\\\)(?:[\\w .\\-]{0,40}[\\\\/])*[^\\s)\\]`"\'<>]*';
const MD_PARENS = '\\(((?:[^()\\n]|\\([^()\\n]*\\)){0,2000})\\)'; // the target of a link, one level of brackets allowed
const HTML_TAG = /<\/?(?:a|b|i|u|s|em|strong|code|pre|br|hr|p|div|span|li|ul|ol|h[1-6]|sub|sup|kbd|small|mark|del|ins|details|summary|blockquote|table|thead|tbody|tr|td|th|img)\b(?:\s[^<>\n]{0,200})?\/?>/gi;
const CODE_ONLY = 'code skipped.';

// Turns a Claude reply (markdown) into text that sounds right when spoken: no code, no symbols, no links or paths.
// Every pattern here is bounded or linear, because this runs on the server's only thread.
export function speakableText(input) {
  let t = String(input == null ? '' : input).slice(0, SPEAK_MAX * 2).replace(/\r\n?/g, '\n');
  // Long runs of one symbol and of blanks add nothing when spoken and are what slows patterns down.
  t = t.replace(/([`_*~|\-=#<>.()[\]])\1{7,}/g, '$1$1$1').replace(/[^\S\n]{40,}/g, ' ');
  // Fenced code blocks (a fence that is never closed runs to the end). "code skipped" is said once.
  const kept = [];
  let fence = null; // { ch, len } while inside a block
  let said = false;
  for (const line of t.split('\n')) {
    if (fence) {
      const m = /^[ \t]*([`~]+)[ \t]*$/.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      continue;
    }
    const o = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (o) {
      fence = { ch: o[1][0], len: o[1].length };
      if (!said) { said = true; kept.push(CODE_ONLY); }
      continue;
    }
    kept.push(line);
  }
  t = kept.join('\n');
  // Images and links keep their label. Bare URLs and file paths go (a sentence period after them stays).
  t = t.replace(new RegExp('!\\[([^\\[\\]\\n]{0,300})\\]' + MD_PARENS, 'g'), '$1');
  t = t.replace(new RegExp('\\[([^\\[\\]\\n]{1,300})\\]' + MD_PARENS, 'g'), '$1');
  t = t.replace(/<(?:https?|ftp|file):\/\/[^\s<>]*>/gi, '');
  t = t.replace(/\b(?:https?|ftp|file):\/\/[^\s)>\]]+/gi, (m) => endPunct(m));
  t = t.replace(/\bwww\.[^\s)>\]]+/gi, (m) => endPunct(m));
  t = t.replace(new RegExp('(["\'`])(?:[A-Za-z]:[\\\\/]|\\\\\\\\)[^"\'`\\n]{0,300}\\1', 'g'), ''); // a quoted path may hold spaces
  t = t.replace(new RegExp(LEAD + WIN_PATH, 'g'), (m, lead) => lead + endPunct(m.slice(lead.length)));
  t = t.replace(new RegExp(LEAD + '(?:~|\\.{1,2})?/[^\\s)\\]`"\']*[\\w.\\-/]', 'g'), (m, lead) => lead + endPunct(m.slice(lead.length)));
  t = t.replace(new RegExp(LEAD + '(?:[\\w.\\-]+/)+[\\w\\-]+\\.[A-Za-z]\\w{0,5}(?::\\d+(?:-\\d+)?)*', 'g'), '$1');
  t = t.replace(HTML_TAG, ' ').replace(/<\s{0,40}>/g, '');
  // Line by line: headings, quotes, list markers, table rows and rules.
  const out = [];
  for (let line of t.split('\n')) {
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line) || (/^[\s:|-]+$/.test(line) && line.indexOf('|', 1) !== -1)) continue;
    let own = false; // headings, list items and table rows are spoken as their own sentence
    if (/^\s*#{1,6}\s+/.test(line)) { line = line.replace(/^\s*#{1,6}\s+/, ''); own = true; }
    line = line.replace(/^\s*(?:>\s*)+/, '');
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) { line = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''); own = true; }
    let s = line.trim();
    if (s.startsWith('|') || s.endsWith('|')) {
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      line = s.split('|').map((c) => c.trim()).join(', ');
      own = true;
    }
    line = line.trim();
    if (!line) { out.push(''); continue; }
    if (own && !/[.!?:;,]$/.test(line)) line += '.';
    out.push(line);
  }
  t = out.join('\n');
  // Emphasis and code marks, then whitespace.
  t = t.replace(/`+/g, '').replace(/~~/g, '').replace(/\*+/g, '');
  t = t.replace(/(^|[^\w])_+(?=\S)/g, '$1').replace(/(\S)_+(?=[^\w]|$)/g, '$1');
  t = t.replace(/\(\s{0,40}\)|\[\s{0,40}\]/g, '').replace(/\s+/g, ' ').replace(/ ([.,;:!?])/g, '$1').trim();
  if (t === CODE_ONLY) return 'The reply is code.';
  return t.length > SPEAK_MAX ? t.slice(0, SPEAK_MAX) : t;
}

// ---- A phone's voice: its recording is transcribed here, and a reply comes back as a WAV (nothing plays on the PC) ----

export const PHONE_WAV_MAX = 4 * 1024 * 1024; // bytes of a phone recording
export const TTS_MAX = 4000; // characters of a reply read out for a phone
const PHONE_WAIT_MS = 60000;

// Checks a recording before it goes to BlitzVoice: RIFF/WAVE, PCM 16-bit mono 16000 Hz, with a data chunk.
// Returns { ok: true } or { ok: false, why }.
export function checkPhoneWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return { ok: false, why: 'That is not a WAV recording.' };
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return { ok: false, why: 'That is not a WAV recording.' };
  let fmt = null;
  let hasData = false;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && size >= 16 && at + 8 + 16 <= buf.length) {
      fmt = { tag: buf.readUInt16LE(at + 8), channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    } else if (id === 'data') {
      hasData = size > 0 && buf.length > at + 8;
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!fmt || !hasData) return { ok: false, why: 'That WAV recording has no sound in it.' };
  if (fmt.tag !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) return { ok: false, why: 'The recording must be 16-bit mono at 16000 Hz.' };
  return { ok: true };
}

// The error a phone sees when BlitzVoice cannot be used: 503 with a short reason, 409 busy, 400 bad audio.
function phoneVoiceFailure(r, what) {
  // No "Model for Mission Control" is chosen in BlitzVoice: it never falls back to the main dictation model.
  if (r.status === 409 && r.body && r.body.error === 'no_link_model') return { status: 409, body: { error: 'no_link_model', reason: 'Choose a "Model for Mission Control" in BlitzVoice on the PC.' } };
  if (r.status === 409) return { status: 409, body: { error: 'busy', reason: 'BlitzVoice is busy. Try again in a moment.' } };
  if (r.status === 400) return { status: 400, body: { error: 'bad_audio', reason: 'BlitzVoice could not use that.' } };
  if (r.status === 503 || r.status === 502) {
    const why = status().reason;
    const reason = r.status === 502 ? 'BlitzVoice did not answer.'
      : why === 'link off' ? 'The BlitzVoice link is off.'
      : why === 'unauthorized' ? 'BlitzVoice refused the link.'
      : 'BlitzVoice is not running.';
    return { status: 503, body: { error: 'unavailable', reason } };
  }
  // A new BlitzVoice takes 4 MB here and Mission Control refuses more first, so a 413 means an old build that caps every body at 4 KB.
  if (r.status === 404 || r.status === 413) return { status: 503, body: { error: 'unavailable', reason: 'This BlitzVoice is too old for phone voice.' } };
  return { status: 502, body: { error: `${what}_failed`, reason: 'BlitzVoice could not do that.' } };
}

// An old BlitzVoice does not know to:"wav" and would play the text on the PC's speakers. /transcribe came in the same update,
// so a link process that has answered /transcribe the way a new one does is a new one. Only a 200, or a 409 that says
// no_link_model or busy, counts: an old build answers 413 to any body over 4 KB and 400 to a bad request before it routes,
// so those prove nothing. Keyed by port, pid and token of the link (each BlitzVoice start writes a new token), and never
// remembered for a link with no pid, so a restarted old build can never inherit what a new one proved. Kept in memory only.
const wavLinks = new Set();
const WAV_LINKS_CAP = 20;
const WAV_REPLY_MAX = 12 * 1024 * 1024 + 1024; // the base64 of a WAV and the little JSON around it
const linkKey = () => (connected && ctl && ctl.pid > 0 && ctl.token ? `${ctl.port}:${ctl.pid}:${ctl.token}` : '');

// Does the BlitzVoice linked right now take to:"wav"? False until a /transcribe has shown it does.
export function wavSupported() {
  const k = linkKey();
  return !!k && wavLinks.has(k);
}

// Test hook: forget what is known about the link.
export function resetWavSupport() {
  wavLinks.clear();
}

// Sends a phone's WAV to BlitzVoice. Resolves { status, body } with body { text } on success.
export async function voiceTranscribe(wav) {
  const key = linkKey();
  const r = await voiceCall('POST', '/transcribe', wav, { contentType: 'audio/wav', timeout: PHONE_WAIT_MS });
  const newBuild = r.status === 200 || (r.status === 409 && !!r.body && (r.body.error === 'no_link_model' || r.body.error === 'busy'));
  if (key && r.bv && newBuild && key === linkKey()) {
    wavLinks.add(key);
    if (wavLinks.size > WAV_LINKS_CAP) wavLinks.delete(wavLinks.values().next().value);
  }
  if (r.status !== 200 || !r.body || r.body.ok !== true) return phoneVoiceFailure(r, 'transcribe');
  const text = typeof r.body.text === 'string' ? r.body.text.trim().slice(0, WAKE_TEXT_MAX) : '';
  return { status: 200, body: { text } };
}

// Cuts a long text at the end of a sentence near the limit when it can, else at the limit.
function capSpeech(t, max) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max * 0.6 ? cut.slice(0, end + 1) : cut.trim();
}

// Has BlitzVoice say a reply into a WAV for a phone. Resolves { status, body } with body { wav: Buffer } on success,
// or { skipped: true } when the text has nothing to say.
// The voice is the one configured in BlitzVoice: a caller cannot pick another. Nothing is sent unless this BlitzVoice is known
// to take to:"wav" (see wavSupported), because an older one would play the text on the PC.
export async function voiceSpeakWav(text) {
  const clean = capSpeech(speakableText(text), TTS_MAX);
  if (!clean) return { status: 200, body: { skipped: true } };
  if (connected && !wavSupported()) return { status: 503, body: { error: 'unavailable', reason: 'BlitzVoice needs an update.' } };
  const r = await voiceCall('POST', '/speak', { text: clean, to: 'wav' }, { timeout: PHONE_WAIT_MS, maxReply: WAV_REPLY_MAX });
  if (r.status !== 200 || !r.body || r.body.ok !== true || typeof r.body.wav !== 'string') return phoneVoiceFailure(r, 'speak');
  const wav = Buffer.from(r.body.wav, 'base64');
  if (wav.length < 44 || wav.toString('latin1', 0, 4) !== 'RIFF') return { status: 502, body: { error: 'speak_failed', reason: 'BlitzVoice sent no sound.' } };
  return { status: 200, body: { wav } };
}

// Speaks a reply through BlitzVoice. The same key within 2 minutes is ignored (two open tabs send the same one).
export async function voiceSpeak(text, key, voice) {
  const clean = speakableText(text);
  if (!clean) return { status: 200, body: { ok: true, skipped: 'nothing to say' } };
  const now = Date.now();
  for (const [k, at] of seenKeys) if (now - at > DEDUPE_MS) seenKeys.delete(k);
  const k = typeof key === 'string' && key ? key.slice(0, 300) : '';
  if (k) {
    if (seenKeys.has(k)) return { status: 200, body: { ok: true, duplicate: true } };
    seenKeys.set(k, now);
    while (seenKeys.size > SEEN_MAX) seenKeys.delete(seenKeys.keys().next().value); // oldest go first
  }
  const body = { text: clean };
  if (typeof voice === 'string' && voice && voice.length <= 80) body.voice = voice;
  const r = await voiceAction('speak', body);
  if (k && r.status >= 300) seenKeys.delete(k); // nothing was read, so a retry may go through
  return r;
}
