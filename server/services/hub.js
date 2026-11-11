// The hub's mailbox (only on the hub, config role "hub"): every conversation the PCs post, and who may write each chat.
// See design/hub-spec.md for the whole picture; services/hubSync.js is the PC side.
//
// A transcript only grows at the end, so a post is "these bytes, starting at byte N". The hub keeps one copy of each
// transcript and takes a post only when N is the size it already has and the first bytes match its own (the "head"), so
// two copies can never be glued together wrongly. Anything else is answered 409 with the hub's size, and the PC decides.
//
// The baton: one place at a time may add to a chat. A place takes it before it runs a chat (or by posting a chat nobody
// holds) and lets go when the chat's Claude process closes. A holder that has not been heard from for STALE_MS (it is
// off) loses it. A code conversation is only ever written by the PC it started on (its origin).
//
// The doorbell: a PC keeps one request open (wait), answered as soon as anything changes, so nobody checks for nothing.
// An ask: another place wants to write a chat that is held. The holder hears it on its doorbell, and either hands the
// chat over (its Claude was not thinking: it closes it, posts the rest and lets go) or adds the message to its running
// Claude, as for the phone (relayed). The asker reads the answer on the ask. The files of the message (pictures, PDFs)
// wait in .data/hub/asks/<askId>.json until the holder has answered.
//
// A code conversation of a PC that is off can still be written to from another place: what is typed there is its draft
// (one per conversation, the latest wins, the words only), and a message sent waits (a waiting message) until its PC
// takes it, runs it and says it was sent. The files of a waiting message wait in .data/hub/sends/<sendId>.json.
//
// A machine is the paired device a request came through (req.mcDevice); a request made on the hub itself is the hub.
// Everything lives in .data/hub: index.json, and transcripts/<id>.jsonl.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, MACHINE_NAME } from '../config.js';
import { readJson, writeJson } from '../lib/jsonStore.js';

const HUB_DIR = path.join(DATA_DIR, 'hub');
const INDEX_FILE = path.join(HUB_DIR, 'index.json');
const T_DIR = path.join(HUB_DIR, 'transcripts');
const ASK_DIR = path.join(HUB_DIR, 'asks');
const SEND_DIR = path.join(HUB_DIR, 'sends');
const SENDS_KEPT = 20;
const SEND_STATES = new Set(['taken', 'sent', 'failed', 'canceled']);
const DRAFT_MAX = 200000;
const ASK_FILES_MAX = 10;
export const STALE_MS = Number(process.env.MC_HUB_STALE_MS) > 0 ? Number(process.env.MC_HUB_STALE_MS) : 2 * 60e3; // a PC rings every WAIT_MAX_MS while it is on
export const WAIT_MAX_MS = 25e3;
const ASKS_KEPT = 10;
const ASK_STATES = new Set(['handed', 'relayed', 'busy', 'failed']);
export const HEAD_BYTES = 1024; // the head compared on every post: the start of the first record
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = new Set(['chat', 'code']);
const TEXT_MAX = 200;

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
const clean = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, TEXT_MAX) : null);

let index = null; // { seq, sessions: { id: entry }, machines: { id: { name, lastSeen } } }
function load() {
  if (index) return index;
  const r = readJson(INDEX_FILE, 'hub');
  if (!r.ok) throw fail(503, 'The hub could not read its index just now. Try again in a moment.');
  const v = r.value && typeof r.value === 'object' ? r.value : {};
  index = { seq: Number(v.seq) || 0, sessions: v.sessions && typeof v.sessions === 'object' ? v.sessions : {}, machines: v.machines && typeof v.machines === 'object' ? v.machines : {} };
  return index;
}
function save() {
  writeJson(INDEX_FILE, index, { pretty: false });
}
let touchT = null;
function saveSoon() {
  if (touchT) return;
  touchT = setTimeout(() => {
    touchT = null;
    try {
      save();
    } catch (err) {
      console.error('[hub] could not save the index:', err.message);
    }
  }, 5000);
  if (touchT.unref) touchT.unref();
}

// Every change gets the next number, and rings every doorbell waiting for one.
const waiters = new Set();
function bump() {
  const n = ++load().seq;
  for (const w of [...waiters]) w();
  return n;
}
// Something else on the hub changed (the task list, services/hubTasks.js): every doorbell rings, so the PCs pick it up.
export function ring() {
  bump();
  saveSoon();
}

const fileOf = (id) => path.join(T_DIR, id + '.jsonl');
export const transcriptFile = (id) => (UUID_RE.test(id) ? fileOf(id) : null);
export const headOf = (buf) => crypto.createHash('sha256').update(buf.subarray(0, HEAD_BYTES)).digest('hex');
function headOnDisk(id, upTo) {
  const n = Math.min(HEAD_BYTES, upTo);
  if (n <= 0) return headOf(Buffer.alloc(0));
  const fd = fs.openSync(fileOf(id), 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return headOf(buf.subarray(0, got));
  } finally {
    fs.closeSync(fd);
  }
}

// Who is asking: { id, name }.
export function machineOf(req) {
  return req && req.mcDevice ? { id: String(req.mcDevice.id), name: String(req.mcDevice.name || 'PC') } : { id: 'hub', name: MACHINE_NAME };
}

// The name a machine last called in with, or null.
export const machineName = (id) => (load().machines[id] || {}).name || null;

// A PC that posts here: one of the conversations the hub keeps started on it (a phone never posts).
export const postsHere = (m) => m.id !== 'hub' && Object.values(load().sessions).some((e) => e.origin && e.origin.id === m.id);

// Every call from a machine says it is alive, so the baton of a machine that went quiet can be taken over.
export function touch(m) {
  const idx = load();
  idx.machines[m.id] = { name: m.name, lastSeen: Date.now() };
  saveSoon();
}

function holderStale(h) {
  if (!h) return true;
  const seen = (load().machines[h.id] || {}).lastSeen || 0;
  return Date.now() - seen > STALE_MS;
}
const publicHolder = (h) => (h && !holderStale(h) ? { id: h.id, name: h.name, since: h.since } : null);
const publicSend = (x) => ({ sendId: x.sendId, by: x.by, at: x.at, state: x.state, text: x.text, files: x.files || 0, error: x.error || null });
function publicEntry(e) {
  return {
    id: e.id, kind: e.kind, origin: e.origin, title: e.title || null, project: e.project || null, size: e.size, head: e.head || null, updatedAt: e.updatedAt, lastAt: e.lastAt || null, seq: e.seq, holder: publicHolder(e.holder), gen: e.gen || 0,
    draft: e.draft || null, sends: Array.isArray(e.sends) ? e.sends.map(publicSend) : [],
  };
}

// What changed since `since` (a seq from an earlier answer): { seq, you, sessions: [...], machines }, oldest change first.
// you: the caller as the hub knows it, so a PC can tell its own conversations from the others'.
export function changes(since = 0, m = null) {
  const idx = load();
  const all = Object.values(idx.sessions);
  const out = all.filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq).map(publicEntry);
  const totals = { chats: 0, code: 0, bytes: 0 }; // what the hub holds, for the PCs' Connections page
  for (const e of all) {
    if (e.kind === 'chat') totals.chats++;
    else totals.code++;
    totals.bytes += e.size || 0;
  }
  return { seq: idx.seq, you: m, sessions: out, totals, machines: Object.entries(idx.machines).map(([id, x]) => ({ id, name: x.name, lastSeen: new Date(x.lastSeen).toISOString() })) };
}

export function info(id) {
  const e = load().sessions[id];
  return e ? publicEntry(e) : null;
}

// The bytes of a transcript from `from` on, or null when the hub has none.
export function readFrom(id, from = 0) {
  if (!UUID_RE.test(id)) throw fail(400, 'Session id must be a lowercase uuid');
  const e = load().sessions[id];
  if (!e || !e.size) return null;
  const start = Math.max(0, Math.min(Number(from) || 0, e.size));
  return { size: e.size, stream: fs.createReadStream(fileOf(id), { start, end: e.size - 1 }), start };
}

const chains = new Map(); // id -> the promise of the last change, so changes to one transcript happen one at a time
function serial(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(id, next);
  next.finally(() => { if (chains.get(id) === next) chains.delete(id); }).catch(() => {});
  return next;
}

// May this machine write this conversation now? A chat: nobody holds it (or the holder went quiet), or this machine does.
// A code conversation: only its origin.
function mayWrite(e, m) {
  if (!e) return true;
  if (e.kind === 'code') return e.origin && e.origin.id === m.id;
  return !e.holder || e.holder.id === m.id || holderStale(e.holder);
}

// A post: bytes at offset `at`. meta: { kind, head (sha256 of the poster's first HEAD_BYTES), title, project (its name),
// lastAt (when the conversation was last used, as the poster reads it), replace }.
// replace (with at 0) swaps the whole copy for the poster's, for the one allowed to write it. Answers the new entry.
export function append(m, id, at, bytes, meta = {}) {
  if (!UUID_RE.test(id)) throw fail(400, 'Session id must be a lowercase uuid');
  if (!KINDS.has(meta.kind)) throw fail(400, 'kind must be chat or code');
  if (!Number.isInteger(at) || at < 0) throw fail(400, 'at must be a byte offset');
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw fail(400, 'Nothing to add');
  return serial(id, () => {
    const idx = load();
    let e = idx.sessions[id];
    if (e && e.kind !== meta.kind) throw fail(409, 'This conversation is a ' + e.kind + ' on the hub', { reason: 'kind', size: e.size });
    if (!mayWrite(e, m)) {
      const h = e.kind === 'code' ? e.origin : publicHolder(e.holder);
      throw fail(409, `${h ? h.name : 'Another computer'} is writing this conversation`, { reason: 'baton', holder: h, size: e.size });
    }
    if (meta.replace) {
      if (at !== 0) throw fail(400, 'A replace starts at byte 0');
      fs.mkdirSync(T_DIR, { recursive: true });
      fs.writeFileSync(fileOf(id), bytes);
    } else {
      const size = e ? e.size : 0;
      if (at !== size) throw fail(409, 'The hub has a different size', { reason: 'size', size, head: e ? e.head : null });
      if (size > 0 && meta.head !== headOnDisk(id, size)) throw fail(409, 'The start of this conversation differs from the hub copy', { reason: 'head', size, head: e.head });
      fs.mkdirSync(T_DIR, { recursive: true });
      fs.appendFileSync(fileOf(id), bytes);
    }
    const size = fs.statSync(fileOf(id)).size;
    if (!e) e = idx.sessions[id] = { id, kind: meta.kind, origin: { id: m.id, name: m.name }, holder: null };
    if (meta.replace) e.gen = (e.gen || 0) + 1; // a copy read elsewhere is fetched again whole (it may have shrunk)
    e.size = size;
    e.head = headOnDisk(id, size);
    e.updatedAt = new Date().toISOString();
    if (clean(meta.title)) e.title = clean(meta.title);
    if (clean(meta.project)) e.project = clean(meta.project);
    if (typeof meta.lastAt === 'string' && Number.isFinite(Date.parse(meta.lastAt))) e.lastAt = new Date(meta.lastAt).toISOString();
    if (e.kind === 'chat' && (!e.holder || holderStale(e.holder))) e.holder = { id: m.id, name: m.name, since: e.updatedAt }; // the poster has it now
    e.seq = bump();
    idx.machines[m.id] = { name: m.name, lastSeen: Date.now() };
    save();
    return publicEntry(e);
  });
}

// take: true asks for the baton of a chat (it is made on the hub when the hub has never seen the chat), take: false lets
// it go. Answers the entry; a baton held by another machine is a 409 naming it.
export function baton(m, id, take) {
  if (!UUID_RE.test(id)) throw fail(400, 'Session id must be a lowercase uuid');
  return serial(id, () => {
    const idx = load();
    let e = idx.sessions[id];
    if (e && e.kind !== 'chat') throw fail(409, 'Only a chat moves between computers', { reason: 'kind' });
    if (!take) {
      if (e && e.holder && e.holder.id === m.id) {
        e.holder = null;
        e.seq = bump();
        save();
      }
      return e ? publicEntry(e) : null;
    }
    if (!mayWrite(e, m)) throw fail(409, `${publicHolder(e.holder).name} is writing this chat`, { reason: 'baton', holder: publicHolder(e.holder), size: e.size });
    if (!e) e = idx.sessions[id] = { id, kind: 'chat', origin: { id: m.id, name: m.name }, size: 0, head: null, updatedAt: new Date().toISOString(), holder: null };
    if (!e.holder || e.holder.id !== m.id) {
      e.holder = { id: m.id, name: m.name, since: new Date().toISOString() };
      e.seq = bump();
    }
    idx.machines[m.id] = { name: m.name, lastSeen: Date.now() };
    save();
    return publicEntry(e);
  });
}

// ---- The doorbell and asks ----

// The open asks addressed to this machine (it holds the chat they are about).
function asksFor(m) {
  const out = [];
  for (const e of Object.values(load().sessions)) {
    if (!e.holder || e.holder.id !== m.id || !Array.isArray(e.asks)) continue;
    for (const a of e.asks) if (a.state === 'open') out.push({ id: e.id, askId: a.askId, by: a.by, text: a.text, files: a.files || 0, relay: a.relay });
  }
  return out;
}

// Answers when the hub has a change newer than `since`, or an ask for this machine, or after `ms` (at most WAIT_MAX_MS):
// { seq, asks }.
// The waiting messages for this machine's own code conversations: [{ id, sendId, text, files, by }].
function sendsFor(m) {
  const out = [];
  for (const e of Object.values(load().sessions)) {
    if (e.kind !== 'code' || !e.origin || e.origin.id !== m.id || !Array.isArray(e.sends)) continue;
    for (const x of e.sends) if (x.state === 'waiting') out.push({ id: e.id, sendId: x.sendId, text: x.text, files: x.files || 0, by: x.by });
  }
  return out;
}

export function wait(m, since, ms, onClose) {
  touch(m);
  const done = () => ({ seq: load().seq, asks: asksFor(m), sends: sendsFor(m) });
  if (load().seq !== since || asksFor(m).length || sendsFor(m).length) return Promise.resolve(done());
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(t);
      waiters.delete(finish);
      touch(m);
      resolve(done());
    };
    const t = setTimeout(finish, Math.max(0, Math.min(Number(ms) || WAIT_MAX_MS, WAIT_MAX_MS)));
    waiters.add(finish);
    if (onClose) onClose(finish);
  });
}

// Another place wants to write a chat held by a live holder. text and files ([{ name, type, data (base64) }]): the
// message, sent on by the holder if its Claude is thinking. 409 reason "free" when nobody live holds it.
export function ask(m, id, { text, files } = {}) {
  if (!UUID_RE.test(id)) throw fail(400, 'Session id must be a lowercase uuid');
  if (text !== undefined && (typeof text !== 'string' || text.length > 100000)) throw fail(400, 'text must be a string');
  if (files !== undefined && (!Array.isArray(files) || files.length > ASK_FILES_MAX || files.some((f) => !f || typeof f.name !== 'string' || typeof f.data !== 'string' || (f.type !== undefined && typeof f.type !== 'string')))) {
    throw fail(400, `files must be at most ${ASK_FILES_MAX} { name, type, data }`);
  }
  return serial(id, () => {
    const idx = load();
    const e = idx.sessions[id];
    if (!e || e.kind !== 'chat' || !e.holder || holderStale(e.holder) || e.holder.id === m.id) throw fail(409, 'Nobody else holds this chat', { reason: 'free' });
    const n = Array.isArray(files) ? files.length : 0;
    const a = { askId: crypto.randomUUID(), by: { id: m.id, name: m.name }, text: text || '', files: n, relay: !!text || n > 0, state: 'open', at: new Date().toISOString() };
    if (n) {
      fs.mkdirSync(ASK_DIR, { recursive: true });
      fs.writeFileSync(path.join(ASK_DIR, a.askId + '.json'), JSON.stringify(files.map((f) => ({ name: f.name, type: f.type || '', data: f.data }))));
    }
    e.asks = [...(Array.isArray(e.asks) ? e.asks : []), a].slice(-ASKS_KEPT);
    e.seq = bump();
    idx.machines[m.id] = { name: m.name, lastSeen: Date.now() };
    save();
    return { ...a, holder: publicHolder(e.holder) };
  });
}

export function askOf(id, askId) {
  const e = load().sessions[id];
  const a = e && Array.isArray(e.asks) ? e.asks.find((x) => x.askId === askId) : null;
  return a ? { ...a, holder: publicHolder(e.holder) } : null;
}

// The holder's answer: handed (it let the chat go), relayed (the message went into its running Claude), busy (its Claude
// is thinking and the message cannot travel), failed (error says why).
export function answerAsk(m, id, askId, state, error) {
  if (!ASK_STATES.has(state)) throw fail(400, 'state must be handed, relayed, busy or failed');
  return serial(id, () => {
    const e = load().sessions[id];
    const a = e && Array.isArray(e.asks) ? e.asks.find((x) => x.askId === askId) : null;
    if (!a) throw fail(404, 'No such ask');
    if (!e.holder || e.holder.id !== m.id) {
      if (state !== 'handed') throw fail(409, 'Only the holder answers an ask', { reason: 'baton' });
    }
    a.state = state;
    if (typeof error === 'string') a.error = error.slice(0, 300);
    fs.rmSync(path.join(ASK_DIR, askId + '.json'), { force: true }); // answered: its files are no longer needed
    e.seq = bump();
    save();
    return { ...a, holder: publicHolder(e.holder) };
  });
}

// The files of an ask, for the holder: [{ name, type, data }], or null.
export function askFiles(id, askId) {
  if (!askOf(id, askId)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(ASK_DIR, askId + '.json'), 'utf8'));
  } catch {
    return [];
  }
}

// ---- Drafts and waiting messages of code conversations ----

const codeEntry = (id) => {
  if (!UUID_RE.test(id)) throw fail(400, 'Session id must be a lowercase uuid');
  const e = load().sessions[id];
  if (!e || e.kind !== 'code') throw fail(404, 'The hub has no such code conversation');
  return e;
};

// What is typed for a code conversation, anywhere: { text, at (ms, the writer's clock) }. An older one than the hub's is
// ignored (answered with the hub's), so two places typing at once settle on the latest.
export function setDraft(m, id, { text, at } = {}) {
  if (typeof text !== 'string' || text.length > DRAFT_MAX) throw fail(400, 'text must be a string');
  const when = Number(at);
  if (!Number.isFinite(when) || when <= 0) throw fail(400, 'at must be a time in ms');
  return serial(id, () => {
    const e = codeEntry(id);
    if (!e.draft || e.draft.at < when) {
      e.draft = { text, at: when, by: { id: m.id, name: m.name } };
      e.seq = bump();
      save();
    }
    touch(m);
    return e.draft;
  });
}

// A message for a code conversation, to run on its PC when it is on. files: [{ name, type, data (base64) }].
export function addSend(m, id, { text, files } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw fail(400, 'text is required');
  if (files !== undefined && (!Array.isArray(files) || files.length > ASK_FILES_MAX || files.some((f) => !f || typeof f.name !== 'string' || typeof f.data !== 'string'))) {
    throw fail(400, `files must be at most ${ASK_FILES_MAX} { name, type, data }`);
  }
  return serial(id, () => {
    const e = codeEntry(id);
    if (e.origin && e.origin.id === m.id) throw fail(409, 'This conversation runs on this computer');
    const n = Array.isArray(files) ? files.length : 0;
    const x = { sendId: crypto.randomUUID(), by: { id: m.id, name: m.name }, text, files: n, state: 'waiting', at: new Date().toISOString() };
    if (n) {
      fs.mkdirSync(SEND_DIR, { recursive: true });
      fs.writeFileSync(path.join(SEND_DIR, x.sendId + '.json'), JSON.stringify(files.map((f) => ({ name: f.name, type: f.type || '', data: f.data }))));
    }
    // the ones that are over make room first; a waiting one is never dropped
    const all = [...(Array.isArray(e.sends) ? e.sends : []), x];
    const over = (y) => y.state !== 'waiting' && y.state !== 'taken';
    while (all.length > SENDS_KEPT && all.some(over)) all.splice(all.findIndex(over), 1);
    e.sends = all;
    e.seq = bump();
    touch(m);
    save();
    return { ...publicSend(x), origin: e.origin, originOnline: !holderStale(e.origin) };
  });
}

// state: canceled (by anyone, while it waits), taken (by its PC, before it runs it: one PC, once), sent or failed (by its
// PC, after). Answers the waiting message.
export function updateSend(m, id, sendId, state, error) {
  if (!SEND_STATES.has(state)) throw fail(400, 'state must be taken, sent, failed or canceled');
  return serial(id, () => {
    const e = codeEntry(id);
    const x = Array.isArray(e.sends) ? e.sends.find((y) => y.sendId === sendId) : null;
    if (!x) throw fail(404, 'No such waiting message');
    const origin = !!e.origin && e.origin.id === m.id;
    if (state === 'canceled' || state === 'taken') {
      if (x.state !== 'waiting') throw fail(409, x.state === 'canceled' ? 'It was canceled' : 'It went already', { reason: 'state', state: x.state });
      if (state === 'taken' && !origin) throw fail(409, 'Only its PC takes it', { reason: 'origin' });
    } else if (!origin || x.state !== 'taken') throw fail(409, 'Only its PC says it was sent', { reason: 'origin' });
    x.state = state;
    if (typeof error === 'string') x.error = error.slice(0, 300);
    if (state !== 'taken') fs.rmSync(path.join(SEND_DIR, sendId + '.json'), { force: true });
    e.seq = bump();
    touch(m);
    save();
    return publicSend(x);
  });
}

// The files of a waiting message, for its PC: [{ name, type, data }], or null.
export function sendFiles(id, sendId) {
  const e = load().sessions[id];
  if (!e || !Array.isArray(e.sends) || !e.sends.some((y) => y.sendId === sendId)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(SEND_DIR, sendId + '.json'), 'utf8'));
  } catch {
    return [];
  }
}

// Files of asks nobody answered (the holder was switched off meanwhile) go after a week.
setTimeout(() => {
  try {
    for (const f of fs.readdirSync(ASK_DIR)) {
      const p = path.join(ASK_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 7 * 24 * 3600e3) fs.rmSync(p, { force: true });
    }
  } catch {
    // no asks folder yet
  }
}, 60e3).unref();
