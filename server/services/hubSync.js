// The PC side of the hub (design/hub-spec.md): posts this PC's chats to the hub's mailbox, picks up the chats the other
// places wrote, and holds a chat's baton while it runs here. services/hub.js is the hub side.
//
// It runs on a PC with a link to the hub in .data/hub.json ({ url, headers }); without the file it does nothing. It runs on
// the hub too, linked to itself: the hub is then one more place that runs chats (for the phone when every PC is off), and
// its requests to its own mailbox are the hub's (no device).
// What was last in step with the hub is kept in .data/hub-sync.json: per chat, `synced`, the byte count both copies share.
//
//   posting     after every turn, and every SYNC_MS for the rest: the bytes of each chat past `synced`
//   the doorbell one request kept open on the hub (wait), answered the moment something changes there; then this PC
//               picks up what changed: a chat that grew there gets the new bytes added here
//   the baton   taken before a chat runs here (and its latest copy picked up first), let go when its process closes.
//               A chat another place holds: this PC asks it (an ask). If its Claude is not thinking, it hands the chat
//               over at once; if it is, it adds the message to its running Claude, as for the phone (relayed), and the
//               answer arrives here when it is posted. This PC answers the asks of the others the same way.
//   code        a code conversation is posted the same way (only its PC writes it). The other PCs list them from the
//               hub, in a tab named after their PC, and download one into .data/hub-cache only when it is opened, to
//               read it: they never go into Claude Code's own folders, so nothing can resume them here.
//   waiting     another PC's code conversation can still be written to: what is typed goes to the hub as its draft
//               (and its PC's draft follows), and a message sent waits on the hub until its PC takes it and runs it.
//   no hub      a chat still runs. If the hub then has a newer version too, this PC's version becomes a copy, "(copy)"
//               in its title, and the hub's version takes its place. Nothing is lost.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { CLAUDE_HOME, DATA_DIR, HUB_LINK_FILE, MACHINE_NAME, PORT, ROLE } from '../config.js';
import { CHATS_TRANSCRIPT_DIR } from '../lib/chats.js';
import { onPublish, publish } from '../lib/events.js';
import { readJson, writeJson } from '../lib/jsonStore.js';
import { getUpload, saveUpload, UPLOAD_BODY_LIMIT } from './uploads.js';
import { getDraft, putDraft } from './drafts.js';
import { allSessionRows, getSessionMessages } from './sessions.js';
import { getProject } from './catalog.js';
import { pcBlockedName } from './pcLink.js';

const HOME = process.env.MC_CLAUDE_HOME ? path.resolve(process.env.MC_CLAUDE_HOME) : CLAUDE_HOME;
const CHAT_T_DIR = path.join(HOME, 'projects', CHATS_TRANSCRIPT_DIR);
const STATE_FILE = path.join(DATA_DIR, 'hub-sync.json');
const CACHE_DIR = path.join(DATA_DIR, 'hub-cache');
const ONLINE_MS = Number(process.env.MC_HUB_STALE_MS) > 0 ? Number(process.env.MC_HUB_STALE_MS) : 2 * 60e3; // as the hub's STALE_MS: a PC rings every 25 s while it is on
const SYNC_MS = Number(process.env.MC_HUB_SYNC_MS) > 0 ? Number(process.env.MC_HUB_SYNC_MS) : 5 * 60e3; // the doorbell does the rest
const WAIT_MS = 25e3; // one doorbell request (the hub's own limit)
const RETRY_MS = Number(process.env.MC_HUB_RETRY_MS) > 0 ? Number(process.env.MC_HUB_RETRY_MS) : 15e3; // no hub: ring again after this
const ASK_WAIT_MS = 30e3; // how long an ask may take before the message is refused
const POST_MAX = 8 * 1024 * 1024; // the hub's limit for one post
const HEAD_BYTES = 1024; // as services/hub.js
const TIMEOUT_MS = 30e3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---- The link and the state ----

function link() {
  if (ROLE === 'hub') return { url: `http://127.0.0.1:${PORT}`, headers: {} };
  if (ROLE !== 'pc') return null;
  const r = readJson(HUB_LINK_FILE, 'hub-sync');
  const v = r.ok ? r.value : null;
  if (!v || typeof v.url !== 'string' || !/^https?:\/\//.test(v.url)) return null;
  return { url: v.url.replace(/\/+$/, ''), headers: v.headers && typeof v.headers === 'object' ? v.headers : {} };
}
export const hubLinked = () => !!link();
export const hubLink = link;

// { cursor, me: { id, name } as the hub knows this PC, sessions: { id: { synced } }, remote: { id: hub entry } of the other
// PCs' code conversations, machines: [{ id, name, lastSeen }] }
let state = null;
function st() {
  if (state) return state;
  const r = readJson(STATE_FILE, 'hub-sync');
  const v = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  state = { cursor: Number(v.cursor) || 0, me: v.me || null, sessions: obj(v.sessions), remote: obj(v.remote), machines: Array.isArray(v.machines) ? v.machines : [], gone: obj(v.gone) };
  return state;
}
const syncedOf = (id) => Number((st().sessions[id] || {}).synced) || 0;
function setSynced(id, n) {
  st().sessions[id] = { ...(st().sessions[id] || {}), synced: n };
  writeJson(STATE_FILE, state, { pretty: false });
}

// What the page shows: { linked, lastOk, lastError }.
const health = { lastOk: null, lastError: null, lastRing: null };
export function hubStatus() {
  return { linked: hubLinked(), lastOk: health.lastOk, lastError: health.lastError };
}

// ---- What the Connections page shows (the hub-sync event, at most once a second) ----

const RECENT_MAX = 30;
const recent = []; // newest first: { at, what: sent | got | copy | failed, id, title, bytes, error }
const titles = new Map(); // id -> title, so the list says which conversation
let round = null; // the round running now: { startedAt, total, done, bytes, bytesDone, current, failed }
let lastRound = null; // { startedAt, finishedAt, sent, bytes, failed, ok }
let local = null; // at the last round: { chats, code, waiting, waitingBytes }
let hubTotals = null; // the hub's own count, from its last answer: { chats, code, bytes }
let pubT = null;
function changed() {
  if (pubT) return;
  pubT = setTimeout(() => { pubT = null; publish('hub-sync', syncStatus()); }, 1000);
  pubT.unref();
}
function note(what, id, bytes = 0, error = null) {
  recent.unshift({ at: new Date().toISOString(), what, id, title: titles.get(id) || null, bytes, error });
  recent.length = Math.min(recent.length, RECENT_MAX);
  changed();
}

export function syncStatus() {
  const s = st();
  return {
    linked: hubLinked(),
    lastOk: health.lastOk,
    lastError: health.lastError,
    lastRing: health.lastRing,
    round: round && { ...round },
    lastRound,
    local,
    hub: hubTotals,
    machines: s.machines.map((m) => ({ name: m.name, online: online(m), lastSeen: m.lastSeen, me: !!s.me && m.id === s.me.id })),
    recent,
  };
}

// One call to the hub: { status, json, buf, headers }. A call that does not get an answer throws (the hub is offline).
function call(method, p, { body, query, json, timeout = TIMEOUT_MS } = {}) {
  const l = link();
  if (!l) return Promise.reject(fail(503, 'No hub'));
  const u = new URL(l.url + p);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const headers = { ...l.headers };
  if (method !== 'GET') headers['X-MC'] = '1';
  if (json !== undefined) {
    body = Buffer.from(JSON.stringify(json));
    headers['Content-Type'] = 'application/json';
  }
  if (body) headers['Content-Length'] = body.length;
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers, timeout, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        if (/json/.test(String(res.headers['content-type']))) try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
        health.lastOk = new Date().toISOString();
        resolve({ status: res.statusCode, json, buf, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('the hub did not answer')));
    req.on('error', (err) => {
      health.lastError = `${new Date().toISOString()} ${err.message}`;
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

export const hubCall = call;

// ---- Files ----

const fileOf = (id) => path.join(CHAT_T_DIR, id + '.jsonl');
const sizeOf = (id) => { try { return fs.statSync(fileOf(id)).size; } catch { return 0; } };
const readRange = (id, start, end) => readFileRange(fileOf(id), start, end);
function readFileRange(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}
const headAt = (id, at) => crypto.createHash('sha256').update(readRange(id, 0, Math.min(HEAD_BYTES, at))).digest('hex');
const localChats = () => { try { return fs.readdirSync(CHAT_T_DIR).filter((f) => f.endsWith('.jsonl') && UUID_RE.test(f.slice(0, -6))).map((f) => f.slice(0, -6)); } catch { return []; } };

async function download(id, from) {
  const r = await call('GET', `/api/hub/transcripts/${id}`, { query: { from } });
  if (r.status !== 200) throw fail(r.status, (r.json && r.json.error) || `the hub answered ${r.status}`);
  return { bytes: r.buf, size: Number(r.headers['x-hub-size']) || from + r.buf.length };
}

// This PC's version and the hub's both grew past what they shared: this PC's becomes a copy (a new chat, which is posted
// as one), and the hub's takes the place of the original.
async function fork(id, why) {
  const text = fs.readFileSync(fileOf(id), 'utf8');
  const copy = crypto.randomUUID();
  let title = null;
  for (const line of text.split('\n')) {
    if (!line.includes('-title"')) continue;
    try {
      const o = JSON.parse(line);
      title = o.customTitle || o.aiTitle || title;
    } catch { /* half a line */ }
  }
  const rec = { type: 'custom-title', customTitle: `${title || 'Chat'} (copy from ${MACHINE_NAME})`.slice(0, 120), sessionId: copy };
  fs.writeFileSync(fileOf(copy), text.split(`"sessionId":"${id}"`).join(`"sessionId":"${copy}"`) + (text.endsWith('\n') ? '' : '\n') + JSON.stringify(rec) + '\n');
  setSynced(copy, 0);
  const all = await download(id, 0);
  fs.writeFileSync(fileOf(id) + '.hub', all.bytes);
  fs.renameSync(fileOf(id) + '.hub', fileOf(id));
  setSynced(id, all.size);
  console.log(`[hub-sync] ${id}: changed here and on the hub (${why}); this PC's version is now ${copy}`);
  titles.set(copy, rec.customTitle);
  note('copy', copy);
  publish('sessions.changed', { id });
  publish('sessions.changed', { id: copy });
  return copy;
}

// Do this PC's bytes from `from` match the hub's? Compares what both have.
async function sameAsHub(id, from, hubSize, file = fileOf(id)) {
  let mine = 0;
  try { mine = fs.statSync(file).size; } catch { /* none */ }
  const end = Math.min(mine, hubSize);
  if (end <= from) return true;
  const theirs = (await download(id, from)).bytes.subarray(0, end - from);
  return theirs.equals(readFileRange(file, from, end));
}
const clashed = new Set(); // code conversations the hub refused, told once

// ---- Posting ----

// src: { kind, file, title, project } of a code conversation; a chat by default.
async function pushOne(id, src = null) {
  if (src && src.title) titles.set(id, src.title);
  const sent = { bytes: 0 };
  try {
    return await pushBytes(id, src, sent);
  } finally {
    if (sent.bytes) note('sent', id, sent.bytes);
  }
}
async function pushBytes(id, src, sent) {
  const kind = src ? src.kind : 'chat';
  const file = src ? src.file : fileOf(id);
  const size = () => { try { return fs.statSync(file).size; } catch { return 0; } };
  const range = (a, b) => readFileRange(file, a, b);
  for (let guard = 0; guard < 64; guard++) {
    const local = size();
    let synced = syncedOf(id);
    const replace = !!(st().sessions[id] || {}).replace; // shrunk here (storage.js): the hub's copy is swapped for this one
    if (replace) synced = 0;
    if (local < synced) synced = 0; // the file was cut or replaced here: start again from the top (the head check guards it)
    if (local <= synced) return;
    const end = Math.min(local, synced + POST_MAX);
    const head = synced ? crypto.createHash('sha256').update(range(0, Math.min(HEAD_BYTES, synced))).digest('hex') : undefined;
    const r = await call('PUT', `/api/hub/transcripts/${id}`, { body: range(synced, end), query: { at: synced, kind, head, title: src && src.title, project: src && src.project, lastAt: src && src.lastAt, replace: replace ? 1 : undefined } });
    if (r.status === 200) {
      if (replace) delete st().sessions[id].replace;
      const n = r.json.size - synced;
      sent.bytes += n;
      if (round) { round.bytesDone += n; changed(); }
      setSynced(id, r.json.size);
      continue;
    }
    const why = r.json && r.json.reason;
    if (kind === 'code' && r.status === 409) {
      // only this PC writes its code conversations; a clash means the same transcript is on two PCs (a copied folder)
      if (why === 'size' && r.json.size > synced && local >= r.json.size && (await sameAsHub(id, synced, r.json.size, file))) { setSynced(id, r.json.size); continue; }
      if (!clashed.has(id)) console.error(`[hub-sync] ${id} is not posted: the hub has another version (${why})`);
      clashed.add(id);
      return;
    }
    if (r.status === 409 && why === 'size') {
      const hub = r.json.size;
      if (hub < synced) { setSynced(id, hub); continue; } // the hub has less: post from where it is
      if (!(await sameAsHub(id, synced, hub))) { await fork(id, 'both grew'); return; }
      if (local <= hub) return; // the hub is ahead and this PC has nothing new: picking up adds the rest
      setSynced(id, hub); // both had these bytes already (the state here was lost)
      continue;
    }
    if (r.status === 409 && (why === 'baton' || why === 'head')) {
      // another place holds this chat while this PC has bytes the hub never had: they were written without the baton
      await fork(id, why === 'baton' ? `written here while ${(r.json.holder && r.json.holder.name) || 'another place'} held it` : 'different start');
      return;
    }
    throw fail(r.status, (r.json && r.json.error) || `the hub answered ${r.status}`);
  }
}

// ---- Picking up ----

async function pullOne(e) {
  const id = e.id;
  const hub = e.size;
  let synced = syncedOf(id);
  const local = sizeOf(id);
  if (synced && !fs.existsSync(fileOf(id))) synced = 0; // deleted here: it comes back whole only if it changes elsewhere
  if (hub <= synced) return;
  if (local > synced) {
    // this PC has bytes the hub does not, and the hub has bytes this PC does not: unless they are the same bytes, fork
    if (await sameAsHub(id, synced, hub)) { setSynced(id, Math.min(local, hub)); if (local < hub) return pullOne(e); return; }
    await fork(id, 'both grew');
    return;
  }
  const got = await download(id, synced);
  fs.mkdirSync(CHAT_T_DIR, { recursive: true });
  if (synced === 0) {
    fs.writeFileSync(fileOf(id) + '.hub', got.bytes);
    fs.renameSync(fileOf(id) + '.hub', fileOf(id));
  } else fs.appendFileSync(fileOf(id), got.bytes);
  setSynced(id, synced + got.bytes.length);
  if (e.title) titles.set(id, e.title);
  note('got', id, got.bytes.length);
  publish('sessions.changed', { id });
}

async function pullAll() {
  const r = await call('GET', '/api/hub/changes', { query: { since: st().cursor } });
  if (r.status !== 200 || !r.json) throw fail(r.status, `the hub answered ${r.status}`);
  const s = st();
  if (r.json.you) s.me = r.json.you;
  if (Array.isArray(r.json.machines)) s.machines = r.json.machines;
  if (r.json.totals) hubTotals = r.json.totals;
  changed();
  for (const e of r.json.sessions) {
    if (!UUID_RE.test(e.id)) continue;
    if (e.kind === 'code') {
      if (s.me && e.origin && e.origin.id !== s.me.id) {
        const was = s.remote[e.id];
        if (s.gone[e.id] && was && e.size > (was.size || 0)) delete s.gone[e.id]; // written to again there: listed again
        s.remote[e.id] = was && was.titleHere && e.title === was.titleFrom ? { ...e, title: was.titleHere, titleHere: was.titleHere, titleFrom: was.titleFrom } : e; // another PC's: listed, read when opened
        publish('waiting', { id: e.id, sends: e.sends || [], online: online(s.machines.find((x) => x.id === e.origin.id)) });
      }
      if (e.draft) takeDraft(e);
      continue;
    }
    if (e.kind !== 'chat') continue;
    try {
      await pullOne(e);
    } catch (err) {
      console.error(`[hub-sync] could not pick up ${e.id}:`, err.message);
      if (e.title) titles.set(e.id, e.title);
      note('failed', e.id, 0, err.message);
      return; // the cursor stays, so it is tried again
    }
  }
  st().cursor = r.json.seq;
  writeJson(STATE_FILE, state, { pretty: false });
  publish('machines.changed', {});
}

// ---- One at a time ----

let chain = Promise.resolve();
function queue(fn) {
  const next = chain.catch(() => {}).then(fn);
  chain = next.catch(() => {});
  return next;
}

export function syncNow() {
  if (!hubLinked()) return Promise.resolve(false);
  return queue(async () => {
    // what waits to be posted: the chats, then the code conversations, each with the bytes the hub does not have yet
    const rows = await allSessionRows();
    for (const r of rows) if (r.title) titles.set(r.id, r.title);
    const chats = localChats();
    const code = await codeRows(rows);
    const work = [...chats.filter((id) => sizeOf(id) > syncedOf(id)).map((id) => ({ id, src: null, bytes: sizeOf(id) - syncedOf(id) })), ...code.map((c) => ({ ...c, bytes: c.size - syncedOf(c.id) }))];
    const bytes = work.reduce((n, w) => n + Math.max(0, w.bytes), 0);
    local = { chats: chats.length, code: rows.filter((r) => r.kind === 'code' && r.dir).length, waiting: work.length, waitingBytes: bytes };
    round = { startedAt: new Date().toISOString(), total: work.length, done: 0, bytes, bytesDone: 0, current: null, failed: 0 };
    changed();
    let ok = false;
    try {
      for (const w of work) {
        round.current = titles.get(w.id) || null;
        changed();
        try {
          await pushOne(w.id, w.src);
        } catch (err) {
          if (!err.status) throw err; // offline: stop, the next round tries again
          console.error(`[hub-sync] could not post ${w.id}:`, err.message);
          round.failed++;
          note('failed', w.id, 0, err.message);
        }
        round.done++;
        local.waiting = work.length - round.done + round.failed;
        local.waitingBytes = Math.max(0, bytes - round.bytesDone);
      }
      await pullAll();
      ok = true;
    } finally {
      lastRound = { startedAt: round.startedAt, finishedAt: new Date().toISOString(), sent: round.done - round.failed, bytes: round.bytesDone, failed: round.failed, ok };
      round = null;
      changed();
    }
    return true;
  }).catch((err) => {
    health.lastError = `${new Date().toISOString()} ${err.message}`;
    changed();
    return false;
  });
}

// ---- The baton ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Takes the baton: the hub's entry, or { held: holder } when another live place holds it. Throws when the hub is offline.
async function take(id) {
  const r = await call('POST', `/api/hub/baton/${id}`, { query: { take: 1 } });
  if (r.status === 200) return r.json;
  if (r.status === 409 && r.json && r.json.reason === 'baton') return { held: r.json.holder || { name: 'another computer' } };
  throw fail(r.status, (r.json && r.json.error) || `the hub answered ${r.status}`);
}

// The uploads of a message, for the hub: [{ name, type, data (base64) }]. Throws 413 with `tooBig` past the hub's limit.
function filesOf(attachments, tooBig) {
  const files = [];
  let bytes = 0;
  for (const u of (attachments || []).map(getUpload).filter(Boolean)) {
    const data = fs.readFileSync(u.file).toString('base64');
    bytes += data.length;
    files.push({ name: u.name, type: u.media_type, data });
  }
  if (bytes > UPLOAD_BODY_LIMIT - 1024 * 1024) throw fail(413, tooBig);
  return files;
}

// Before a chat runs here: take its baton and pick up its latest copy. When another place holds it, ask that place:
// null when the chat may run here now, { relayed: true, to } when the message went into the other place's running Claude.
// msg: { text, attachments (upload ids) }: they travel with the ask, as the phone's go to the PC. Throws 409 when it can
// do neither.
// With no hub (or none answering) the chat runs anyway; a clash is sorted out by fork() later.
export async function beforeChatRun(sessionId, msg = {}) {
  if (!hubLinked() || !UUID_RE.test(String(sessionId).toLowerCase())) return null;
  const id = String(sessionId).toLowerCase();
  let e;
  try {
    e = await take(id);
  } catch {
    return null; // no hub
  }
  if (e.held) {
    const holder = e.held.name;
    const files = filesOf(msg.attachments, `These files are too big to send to ${holder} while Claude is thinking there. Send them once it is done.`);
    const r = await call('POST', `/api/hub/asks/${id}`, { json: { text: msg.text || '', files } }).catch(() => null);
    if (!r) return null; // the hub went away meanwhile
    if (r.status === 409 && r.json && r.json.reason === 'free') e = await take(id).catch(() => null);
    else if (r.status !== 200) throw fail(r.status, (r.json && r.json.error) || `the hub answered ${r.status}`);
    else {
      const askId = r.json.askId;
      const t0 = Date.now();
      let a = null;
      while (Date.now() - t0 < ASK_WAIT_MS) {
        await sleep(300);
        const q = await call('GET', `/api/hub/asks/${id}/${askId}`).catch(() => null);
        a = q && q.status === 200 ? q.json : a;
        if (a && (a.state !== 'open' || !a.holder)) break; // answered, or the holder went silent (switched off)
      }
      if (a && a.state === 'open' && !a.holder) a = { state: 'handed' };
      if (!a || a.state === 'open') throw fail(409, `This chat is open on ${holder}, and ${holder} did not answer. Try again in a moment.`);
      if (a.state === 'relayed') return { relayed: true, to: holder };
      if (a.state === 'busy') throw fail(409, `Claude is thinking about this chat on ${holder}. Try again once it is done.`);
      if (a.state === 'failed') throw fail(409, `${holder} could not take your message: ${a.error || 'no reason given'}`);
      e = await take(id).catch(() => null); // handed (or the holder is gone): the baton is free now
    }
    if (!e || e.held) throw fail(409, `This chat is open on ${(e && e.held && e.held.name) || holder}. Try again in a moment.`);
  }
  if (e.size) await queue(() => pullOne(e));
  return null;
}

// Another place asked for a chat this PC holds (the doorbell brought it). Its Claude is thinking: the message goes into
// it, as a phone's would. It is not: this PC closes it, posts the rest and lets go.
const answering = new Set();
async function onAsk(a) {
  if (answering.has(a.askId)) return;
  answering.add(a.askId);
  const runs = await import('./runs.js'); // runs.js imports this file: read it when needed
  let state = 'failed';
  let error;
  try {
    if (runs.isSessionBusy(a.id)) {
      if (!a.relay) state = 'busy';
      else {
        // the files come down from the hub and are saved here as uploads, as a phone's would be
        const ids = [];
        if (a.files) {
          const r = await call('GET', `/api/hub/asks/${a.id}/${a.askId}/files`, { timeout: 120e3 });
          if (r.status !== 200 || !r.json || !Array.isArray(r.json.files)) throw fail(r.status, 'could not fetch the files of the message');
          for (const f of r.json.files) ids.push(saveUpload(f).id);
        }
        await runs.startRun({ prompt: a.text, sessionId: a.id, attachments: ids });
        state = 'relayed';
      }
    } else {
      await runs.releaseSession(a.id);
      await afterChatRun(a.id);
      state = 'handed';
    }
  } catch (err) {
    error = err.message;
  }
  await call('POST', `/api/hub/asks/${a.id}/${a.askId}`, { json: { state, error } }).catch((err) => console.error(`[hub-sync] could not answer ${a.by && a.by.name}:`, err.message));
  setTimeout(() => answering.delete(a.askId), 120e3).unref();
}

// After a chat's process closed here: post the rest, then let the baton go.
export function afterChatRun(sessionId) {
  if (!hubLinked() || !UUID_RE.test(String(sessionId))) return Promise.resolve();
  const id = String(sessionId).toLowerCase();
  return queue(async () => {
    if (fs.existsSync(fileOf(id))) await pushOne(id);
    await call('POST', `/api/hub/baton/${id}`, { query: { take: 0 } });
  }).catch((err) => console.error(`[hub-sync] could not hand back ${id}:`, err.message));
}

// ---- Code conversations ----

// A code conversation of this PC was rewritten smaller (storage.js, Shrink): the next post swaps the hub's copy for it.
export function markRewritten(id) {
  const k = String(id).toLowerCase();
  st().sessions[k] = { ...(st().sessions[k] || {}), synced: 0, replace: true };
  writeJson(STATE_FILE, state, { pretty: false });
}

// This PC's code conversations that have something the hub has not: [{ id, size, src: { kind, file, title, project } }].
async function codeRows(rows = null) {
  const out = [];
  if (ROLE === 'hub') return out; // the hub has no projects: its code conversations are the PCs'
  for (const row of rows || (await allSessionRows())) {
    if (row.kind !== 'code' || !row.dir || row.syncHidden || clashed.has(row.id)) continue;
    const file = path.join(HOME, 'projects', row.dir, row.id + '.jsonl');
    let size = 0;
    try { size = fs.statSync(file).size; } catch { continue; }
    if (size <= syncedOf(row.id)) continue;
    const p = row.project ? getProject(row.project) : null;
    out.push({ id: row.id, size, src: { kind: 'code', file, title: row.title, project: p ? p.name : row.project || null, lastAt: row.lastAt } });
  }
  return out;
}

// A code conversation of this PC had a turn: post it.
async function pushCode(id) {
  liveSrc.delete(id);
  const row = (await codeRows()).find((x) => x.id === id);
  if (row) await pushOne(row.id, row.src);
}

// While a turn runs, what it has written so far is posted every LIVE_MS, so another PC that has it open sees the message
// it sent, the steps and the answer as they come, not only once the turn is over. The row is looked up once per turn.
const LIVE_MS = Number(process.env.MC_HUB_LIVE_MS) > 0 ? Number(process.env.MC_HUB_LIVE_MS) : 2500;
const liveSrc = new Map(); // id -> src of pushOne, for the turn in progress
const liveT = new Map(); // id -> the timer of the next post
function pushLive(id) {
  if (liveT.has(id) || !hubLinked()) return;
  liveT.set(id, setTimeout(() => {
    liveT.delete(id);
    queue(async () => {
      let src = liveSrc.get(id);
      if (!src) {
        const row = (await codeRows()).find((x) => x.id === id);
        if (!row) return;
        liveSrc.set(id, (src = row.src));
      }
      await pushOne(id, src);
    }).catch(() => {});
  }, LIVE_MS));
}

const online = (m) => !!m && Date.now() - Date.parse(m.lastSeen) < ONLINE_MS;

// The PC this one is linked to holds it at its PIN lock (services/pcLink.js): its conversations do not show here either
const nameOf = (originId, fallback) => { const m = st().machines.find((x) => x.id === originId); return (m && m.name) || fallback; };
function shut(e) {
  const name = e && e.origin ? nameOf(e.origin.id, e.origin.name) : null;
  if (pcBlockedName(name)) throw Object.assign(new Error(`${name} is locked`), { status: 423, body: { error: 'peer_locked', pc: name } });
}

// The other PCs that have code conversations on the hub: [{ id, name, online, lastSeen, count }].
export function otherMachines() {
  const s = st();
  const count = new Map();
  for (const e of Object.values(s.remote)) if (e.origin && !s.gone[e.id]) count.set(e.origin.id, (count.get(e.origin.id) || 0) + 1);
  return s.machines
    .filter((m) => count.has(m.id) && (!s.me || m.id !== s.me.id))
    .map((m) => (pcBlockedName(m.name) ? { id: m.id, name: m.name, online: online(m), lastSeen: m.lastSeen, count: 0, locked: true }
      : { id: m.id, name: m.name, online: online(m), lastSeen: m.lastSeen, count: count.get(m.id) }));
}

const remoteRow = (e, name) => ({
  id: e.id, kind: 'code', title: e.title || 'Conversation', titleSource: 'hub', project: null, projectName: e.project || null, tags: [], lastAt: e.lastAt || e.updatedAt, startedAt: null,
  sizeKB: Math.round((e.size || 0) / 1024), pinned: false, archived: false, locked: true, readOnly: true, machine: { id: e.origin.id, name }, expiryAction: null, expiryChoice: null, order: null,
});

// Another PC's conversation, changed there over the PC link (routes/pcLink.js): shown so here at once, as the hub only
// hears of it with the next words written in it. gone: archived or thrown away there, left out of the list.
export function markRemote(id, { title, gone } = {}) {
  const s = st();
  const key = String(id).toLowerCase();
  const e = s.remote[key];
  if (!e) return;
  if (gone) s.gone[key] = new Date().toISOString();
  if (typeof title === 'string' && title) s.remote[key] = { ...e, titleFrom: e.titleFrom || e.title, titleHere: title, title };
  writeJson(STATE_FILE, state, { pretty: false });
  publish('sessions.changed', { id: key });
}

// Another PC's code conversations, newest first, as rows of the Sessions list (read only).
export function remoteSessions(machineId, limit = 50) {
  const s = st();
  const m = s.machines.find((x) => x.id === machineId);
  if (m && pcBlockedName(m.name)) return [];
  return Object.values(s.remote)
    .filter((e) => e.origin && e.origin.id === machineId && !s.gone[e.id])
    .sort((a, b) => String(b.lastAt || b.updatedAt).localeCompare(String(a.lastAt || a.updatedAt)))
    .slice(0, Math.max(1, Math.min(5000, Number(limit) || 50)))
    .map((e) => remoteRow(e, (m && m.name) || e.origin.name));
}

// One of another PC's code conversations, read from the cache (brought up to date from the hub first, when it answers):
// what getSessionMessages gives, plus readOnly and machine, or null when it is not another PC's.
export async function remoteMessages(id, limit, before) {
  const key = String(id).toLowerCase();
  const file = await remoteFile(key);
  if (!file) return null;
  const e = st().remote[key];
  const m = st().machines.find((x) => x.id === e.origin.id);
  const s = await getSessionMessages(key, limit, before, { file });
  return s && { ...s, title: e.title || s.title, readOnly: true, locked: true, sends: e.sends || [], machine: { id: e.origin.id, name: (m && m.name) || e.origin.name, online: online(m) } };
}

// The messages that wait on the hub (or went) for another PC's code conversation: [] when there are none.
export const remoteSends = (id) => { const e = st().remote[String(id).toLowerCase()]; try { shut(e); } catch { return []; } return (e || {}).sends || []; };

// The path of the cached copy of another PC's code conversation, brought up to date from the hub first (when it
// answers), or null when it is not another PC's. Throws 503 when there is no copy yet and the hub cannot be reached.
export async function remoteFile(id) {
  const key = String(id).toLowerCase();
  const e = st().remote[key];
  if (!e) return null;
  shut(e);
  const own = ROLE === 'hub' ? (await import('./hub.js')).transcriptFile(key) : null; // the hub reads its mailbox's copy
  const file = own || path.join(CACHE_DIR, key + '.jsonl');
  const genFile = path.join(CACHE_DIR, key + '.gen');
  let have = 0;
  try { have = fs.statSync(file).size; } catch { /* not cached yet */ }
  let gen = 0;
  try { gen = Number(fs.readFileSync(genFile, 'utf8')) || 0; } catch { /* first copy */ }
  const from = have && (e.gen || 0) !== gen ? 0 : have; // its PC rewrote it (shrunk): fetch it again whole
  if (!own && (from === 0 || have < e.size) && from < e.size && hubLinked()) {
    try {
      const got = await download(key, from);
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      if (from === 0) fs.writeFileSync(file, got.bytes);
      else fs.appendFileSync(file, got.bytes);
      fs.writeFileSync(genFile, String(e.gen || 0));
    } catch (err) {
      if (!have) throw fail(503, `${e.origin.name} is off, and the hub could not be reached to read this conversation`);
    }
  }
  return file;
}

// ---- Drafts and waiting messages of code conversations ----

// A code conversation the hub knows: another PC's, or one of this PC's that is posted there.
const onHub = (id) => !!st().remote[id] || (syncedOf(id) > 0 && !fs.existsSync(fileOf(id)));

// What is typed here for a code conversation goes to the hub (a second after the typing stops), so its PC, or the places
// that read it, see the same words. Called by the drafts route (what a page typed), never for a draft taken from the hub.
const draftT = new Map();
export function draftTyped(key, text, at) {
  const id = String(key || '').toLowerCase();
  if (!hubLinked() || !UUID_RE.test(id) || !onHub(id)) return;
  clearTimeout(draftT.get(id));
  draftT.set(id, setTimeout(() => {
    draftT.delete(id);
    call('PUT', `/api/hub/drafts/${id}`, { json: { text, at } }).catch(() => {}); // no hub: the words stay here
  }, 1000));
}

// A draft the hub has that is newer than this one: it becomes the draft here (the files attached here stay).
function takeDraft(e) {
  const d = e.draft;
  const me = st().me;
  if (!d || typeof d.text !== 'string' || (me && d.by && d.by.id === me.id)) return;
  try {
    const here = getDraft(e.id);
    if (here.at >= d.at || here.text === d.text) return;
    putDraft({ key: e.id, text: d.text, atts: here.atts, tab: 'hub' }, { at: d.at });
  } catch (err) {
    console.error(`[hub-sync] could not take the draft of ${e.id}:`, err.message);
  }
}

// A message for another PC's code conversation: it waits on the hub until that PC runs it. Answers the waiting message.
export async function remoteSend(sessionId, { prompt, attachments } = {}) {
  const id = String(sessionId || '').toLowerCase();
  const e = st().remote[id];
  if (!e) throw fail(404, "This is not another PC's conversation");
  shut(e);
  const name = (e.origin && e.origin.name) || 'its PC';
  const files = filesOf(attachments, `These files are too big to wait for ${name}. Send fewer at a time.`);
  const r = await call('POST', `/api/hub/sends/${id}`, { json: { text: prompt, files } }).catch(() => null);
  if (!r) throw fail(503, 'The hub could not be reached, so the message could not wait for ' + name + '. It is still in the message box.');
  if (r.status !== 201) throw fail(r.status, (r.json && r.json.error) || `the hub answered ${r.status}`);
  e.sends = [...(e.sends || []), r.json];
  publish('waiting', { id, sends: e.sends, online: !!r.json.originOnline });
  return r.json;
}

// Cancels a waiting message (it has not gone yet).
export async function remoteCancel(sessionId, sendId) {
  const id = String(sessionId || '').toLowerCase();
  shut(st().remote[id]);
  const r = await call('POST', `/api/hub/sends/${id}/${encodeURIComponent(sendId)}`, { json: { state: 'canceled' } }).catch(() => null);
  if (!r) throw fail(503, 'The hub could not be reached');
  if (r.status !== 200) throw fail(r.status, (r.json && r.json.error) || `the hub answered ${r.status}`);
  const e = st().remote[id];
  if (e) {
    e.sends = (e.sends || []).map((x) => (x.sendId === sendId ? r.json : x));
    publish('waiting', { id, sends: e.sends });
  }
  return r.json;
}

// A message waits on the hub for one of this PC's code conversations (the doorbell brought it): this PC takes it (once),
// runs it as if it was typed here, and says how it went.
const runningSends = new Set();
async function onSend(x) {
  if (runningSends.has(x.sendId)) return;
  runningSends.add(x.sendId);
  setTimeout(() => runningSends.delete(x.sendId), 120e3).unref();
  // this PC is locked with its PIN (services/pcLock.js), and the message comes from one of the computers it holds back
  const lockMod = await import('./pcLock.js');
  const devMod = await import('./devices.js');
  if (lockMod.pinSet() && !lockMod.unlocked() && x.by && devMod.getDeviceList().some((d) => d.computer && d.name === x.by.name)) {
    const took = await call('POST', `/api/hub/sends/${x.id}/${x.sendId}`, { json: { state: 'taken' } }).catch(() => null);
    if (took && took.status === 200) await call('POST', `/api/hub/sends/${x.id}/${x.sendId}`, { json: { state: 'failed', error: `${MACHINE_NAME} is locked. Type its PIN, then send it again.` } }).catch(() => null);
    return;
  }
  const t = await call('POST', `/api/hub/sends/${x.id}/${x.sendId}`, { json: { state: 'taken' } }).catch(() => null);
  if (!t || t.status !== 200) return; // canceled, or taken already
  let state = 'sent';
  let error;
  try {
    const ids = [];
    if (x.files) {
      const r = await call('GET', `/api/hub/sends/${x.id}/${x.sendId}/files`, { timeout: 120e3 });
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.files)) throw fail(r.status, 'could not fetch the files of the message');
      for (const f of r.json.files) ids.push(saveUpload(f).id);
    }
    const runs = await import('./runs.js');
    await runs.startRun({ prompt: x.text, sessionId: x.id, attachments: ids });
    console.log(`[hub-sync] ${x.id}: ran the message that waited from ${(x.by && x.by.name) || 'another place'}`);
  } catch (err) {
    state = 'failed';
    error = err.message;
  }
  await call('POST', `/api/hub/sends/${x.id}/${x.sendId}`, { json: { state, error } }).catch((err) => console.error('[hub-sync] could not say the waiting message went:', err.message));
}

// A pairing code for a phone, made by the hub: { code, uri, expiresAt }.
export async function pairPhoneWithHub() {
  const r = await call('POST', '/api/hub/pair-phone', { json: {} }).catch(() => null);
  if (!r) throw fail(503, 'The hub could not be reached');
  if (r.status !== 200) throw fail(r.status === 403 ? 409 : r.status, (r.json && r.json.error) || `the hub answered ${r.status}`);
  return r.json;
}

// ---- The doorbell ----

let rung = -1; // the hub's change number last seen here
const ringers = new Set(); // others told when the hub changed (services/taskSync.js); first: the first ring
export const onHubRing = (fn) => ringers.add(fn);
async function doorbell() {
  for (;;) {
    if (!hubLinked()) { await sleep(RETRY_MS); continue; }
    let r;
    try {
      r = await call('GET', '/api/hub/wait', { query: { since: rung, ms: WAIT_MS }, timeout: WAIT_MS + 15e3 });
    } catch {
      await sleep(RETRY_MS);
      continue;
    }
    if (r.status !== 200 || !r.json) { await sleep(RETRY_MS); continue; }
    health.lastRing = new Date().toISOString();
    changed();
    for (const a of r.json.asks || []) onAsk(a);
    for (const x of r.json.sends || []) onSend(x);
    if (r.json.seq !== rung) {
      const first = rung === -1;
      rung = r.json.seq;
      if (first) syncNow(); // the first ring: post what waits here too
      else queue(pullAll).catch((err) => { health.lastError = `${new Date().toISOString()} ${err.message}`; });
      for (const fn of ringers) fn(first);
    }
  }
}

// ---- Start ----

if (ROLE === 'pc' || ROLE === 'hub') {
  onPublish((type, data) => {
    if (type !== 'chat' || !data || !UUID_RE.test(String(data.sessionId || '').toLowerCase())) return;
    const id = String(data.sessionId).toLowerCase();
    if (!fs.existsSync(fileOf(id))) {
      if (data.turnDone) { clearTimeout(liveT.get(id)); liveT.delete(id); queue(() => pushCode(id)).catch(() => {}); } // a code conversation
      else if (ROLE === 'pc') pushLive(id);
      return;
    }
    if (data.turnDone) queue(() => pushOne(id)).catch(() => {});
    else if (data.done) afterChatRun(id);
  });
  setTimeout(() => {
    doorbell();
    setInterval(syncNow, SYNC_MS).unref();
  }, 2000).unref();
}
