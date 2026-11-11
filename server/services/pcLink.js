// A link to another PC's Mission Control (Home), the way a phone reaches it: this PC is paired with it as a device, and
// mc-link runs with that pairing as a child of this server, a local proxy over the same encrypted peer-to-peer link.
//
//   .data/home-link/               mc-link's state: this PC's key on that PC and server.json (the PC it is paired with)
//   .data/home-link/secret         the link secret this server sends in X-MC-Link, private to the current user
//   .data/home-link/projects.json  that PC's projects and root folders as last read, for when it is off
//   .data/home-link/lock.json      that PC's PIN lock as last heard, { pin, until }, for when it is off
//
// For now it reads only: when the link comes online and every few minutes after, it reads that PC's projects and root
// folders (GET /api/projects, as the phone does) and the pages list them in the project tree under that PC's name. With
// the PC off, the last list stays, and the conversations come from the hub (read only, services/hubSync.js).
// It also hands a browser on this PC a one-use enter address for that PC's own pages (open-home.command): each line
// on mc-link's stdin asks for one. This server holds that stdin, so the link ends when the server does.
//
// The Sync panel (services/machines.js) calls that PC through the same link with pcCall.
//
// Its conversations, live, as the phone has them: while the link is online this server follows that PC's event stream
// and passes its live turns on to the pages here as pc.chat, pc.chat.turn and pc.session.stats (to the pages only, so
// nothing here acts on them). A page reads a conversation of that PC through the link (pcSession), with the turn in
// progress, and sends to it there (routes/pcLink.js), so the answer streams in as it is written. A new conversation in
// one of that PC's projects starts there the same way, the way its phone starts one.
//
// Without a pairing nothing runs. MC_PC_LINK_PORT moves the proxy (default 1704), MC_PC_LINK_EXE points at another
// mc-link, MC_PC_LINK_ARGS adds options to it (tests: no relay, the PC's address), MC_PC_LINK_POLL_MS sets how often
// the projects are read (default 3 min). MC_PC_LINK_TEST ({ name, url, headers } as JSON) stands in for the whole link
// in the tests: pcCall goes straight to that address, and nothing else runs.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, MACHINE_NAME, ROLE, ROOT } from '../config.js';
import { cancelPairing, getDeviceList, setComputer, startPairing } from './devices.js';
import { getUpload } from './uploads.js';
import { loadOrCreateSecret } from '../lib/privateSecret.js';
import { readJson, writeJson } from '../lib/jsonStore.js';
import { broadcast, clientCount, onClientConnect, publish, sendTo } from '../lib/events.js';

const LINK_DIR = path.join(DATA_DIR, 'home-link');
const SECRET_FILE = path.join(LINK_DIR, 'secret');
const SERVER_FILE = path.join(LINK_DIR, 'server.json');
const CACHE_FILE = path.join(LINK_DIR, 'projects.json');
const LOCK_FILE = path.join(LINK_DIR, 'lock.json');
const PORT = Number(process.env.MC_PC_LINK_PORT) || 1704; // 1703 is the hub link's
const EXE = process.env.MC_PC_LINK_EXE || path.join(ROOT, 'bridge', 'run', process.platform === 'win32' ? 'mc-link.exe' : 'mc-link');
const EXTRA = (process.env.MC_PC_LINK_ARGS || '').split(' ').filter(Boolean);
const POLL_MS = Number(process.env.MC_PC_LINK_POLL_MS) > 0 ? Number(process.env.MC_PC_LINK_POLL_MS) : 180e3;
const READ_TIMEOUT_MS = 20e3;
const ENTER_TIMEOUT_MS = 8e3;
// Only what the tree and its status need: no checks, jobs or build details.
const KEEP = ['id', 'name', 'folder', 'about', 'isRepo', 'branch', 'dirty', 'ahead', 'behind', 'hidden', 'needsYou', 'notes'];
// notes: the project's notes folders in that PC's vaults on the hub (services/library.js sharedNotes), [{ repo, folder }]
const cleanNotes = (v) => (Array.isArray(v) ? v.filter((n) => n && typeof n.repo === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(n.repo)
  && typeof n.folder === 'string' && !n.folder.split('/').includes('..')).map((n) => ({ repo: n.repo, folder: n.folder })) : undefined);

const fail = (status, message) => Object.assign(new Error(message), { status });
const TEST_LINK = (() => { try { const v = JSON.parse(process.env.MC_PC_LINK_TEST || 'null'); return v && typeof v.url === 'string' ? v : null; } catch { return null; } })();

// mc-link, or in the tests a script in its place
const spawnLink = (args, stdio) => (/\.m?js$/i.test(EXE) ? spawn(process.execPath, [EXE, ...args], { windowsHide: true, stdio }) : spawn(EXE, args, { windowsHide: true, stdio }));

let child = null;
let origin = null; // the proxy's address once it listens
let secret = null;
let state = 'off'; // off, starting, connecting, online, offline: <why>, no longer paired
let stopped = false;
let backoff = 2000;
let pollTimer = null;
let reading = null;
let lastError = null;
let back = { state: 'unknown', at: null, error: null, name: null }; // the link from that PC to this one (pcBack)
let backBusy = null;
let backFailedAt = 0;
let cache = readJson(CACHE_FILE, 'pc link projects').value || null; // { at, name, roots, projects }
const enterWaiters = []; // resolvers waiting for the next "enter" line

function paired() {
  if (TEST_LINK) return { name: String(TEST_LINK.name || 'Home') };
  try {
    const v = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
    return v && typeof v.id === 'string' && !v.revoked ? { name: String(v.name || 'Home') } : null;
  } catch {
    return null;
  }
}

// What the pages get: { paired: { name } | null, state, at, roots, projects, error }. The lists are the last ones read.
export function pcLinkStatus() {
  const p = paired();
  const c = cache && p && cache.name === p.name && !peerBlocked() ? cache : null;
  return {
    paired: p,
    state: TEST_LINK ? 'online' : p ? state : 'off',
    online: !!TEST_LINK || (!!p && state === 'online'),
    at: c ? c.at : null,
    roots: c ? c.roots : [],
    projects: c ? c.projects : [],
    error: lastError,
    me: MACHINE_NAME,
    pairBack: true, // this Mission Control takes POST /api/pc-link/pair-back
    back,
    locked: !!p && peerBlocked(), // that PC holds this one at its PIN lock (services/pcLock.js there): nothing of it shows
    lockedUntil: !!p && !peerBlocked() && peerLock.pin && peerLock.until ? new Date(peerLock.until).toISOString() : null,
  };
}

// ---- That PC's PIN lock ----
// When that PC has a PIN, it answers 423 pc_locked to everything this PC asks until the PIN is typed (here, on the
// Connections page or the other PC's place row, POST /api/pc-link/unlock). While it is locked nothing of it shows here
// either: not its projects, not its conversations from the hub (services/hubSync.js), not its live turns. This PC keeps
// what it last heard of that lock ({ pin, until }), so it stays shut when that PC is off, and shuts at "until" by itself.
let peerLock = (() => { const v = readJson(LOCK_FILE, 'pc link lock').value; return v && typeof v === 'object' ? { pin: !!v.pin, until: Number(v.until) || 0 } : { pin: false, until: 0 }; })();
const peerBlocked = () => peerLock.pin && !(peerLock.until > Date.now());
let wasBlocked = peerBlocked();
// That PC's lock shuts what this PC shows of it: the other PC by its name (the hub's machines, services/hubSync.js)
export const pcPeerBlocked = () => !!paired() && peerBlocked();
export const pcBlockedName = (name) => pcPeerBlocked() && typeof name === 'string' && name === pcName();
function lockChanged() {
  const now = peerBlocked();
  if (now === wasBlocked) return;
  wasBlocked = now;
  publish('pc-link', pcLinkStatus());
  publish('sessions.changed', {});
  if (!now && pcOnline()) { readProjects(); openFeed(); }
}
// v: that PC's lock (its GET /api/pc-lock), or true: it answered "locked"
function notePeerLock(v) {
  const next = v === true ? { pin: true, until: 0 } : { pin: !!v.pin, until: v.unlocked && v.until ? Date.parse(v.until) || 0 : 0 };
  if (next.pin !== peerLock.pin || next.until !== peerLock.until) {
    peerLock = next;
    try { writeJson(LOCK_FILE, peerLock); } catch (err) { console.error('[pc-link] could not keep the lock:', err.message); }
  }
  lockChanged();
}
let lockReading = null;
function readPeerLock() {
  if (lockReading) return lockReading;
  lockReading = pcCall('GET', '/api/pc-lock', { timeout: 8000 })
    .then((r) => { if (r.status === 200 && r.json && typeof r.json === 'object') notePeerLock(r.json); })
    .catch(() => {})
    .finally(() => { lockReading = null; });
  return lockReading;
}
// true: it answered "locked"; false: it answered (its lock is read again); { pin, unlocked, until }: its lock
export function pcPeerLocked(v) {
  if (v === true) notePeerLock(true);
  else if (v === false) readPeerLock();
  else if (v && typeof v === 'object') notePeerLock(v);
}
setInterval(lockChanged, 30e3).unref(); // "until" passes on its own, also with that PC off

function setState(s) {
  if (s === state) return;
  state = s;
  publish('pc-link', pcLinkStatus());
  if (s === 'online') { readPeerLock(); readProjects(); openFeed(); readPcGpu(); setTimeout(autoBack, 3000).unref(); } else { closeFeed(); setPcGpu(null); }
}

// ---- That PC's live events ----

const RELAY = new Set(['chat', 'chat.turn', 'session.stats']);
const FEED_RETRY_MS = 3000;
const FEED_SILENT_MS = 70e3; // that PC pings every 25 s: this long with nothing, the stream is dead
let feed = null; // the request that holds the stream
let feedT = null;
let feedAt = 0; // when it last said anything
let feedOk = false;

const linkTarget = () => (TEST_LINK ? { base: TEST_LINK.url, headers: { ...(TEST_LINK.headers || {}) } } : origin && secret && state === 'online' ? { base: origin, headers: { 'X-MC-Link': secret } } : null);

function openFeed() {
  clearTimeout(feedT);
  feedT = null;
  if (feed || stopped || !paired()) return;
  const L = linkTarget();
  if (!L) return;
  const req = http.get(L.base + '/api/events', { headers: { ...L.headers, Accept: 'text/event-stream' }, agent: false }, (res) => {
    if (res.statusCode === 423) pcPeerLocked(true);
    if (res.statusCode !== 200) { res.resume(); req.destroy(); return; }
    if (peerLock.pin) readPeerLock(); // it opened: typed there, or the PIN removed
    feedOk = true;
    feedAt = Date.now();
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      feedAt = Date.now();
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let m;
        try { m = JSON.parse(data); } catch { continue; }
        if (m && m.type === 'pc-lock' && m.data && typeof m.data === 'object') notePeerLock(m.data);
        else if (m && RELAY.has(m.type) && !peerBlocked()) broadcast('pc.' + m.type, m.data);
      }
    });
    res.on('error', () => req.destroy());
  });
  feed = req;
  const again = () => {
    if (feed !== req) return;
    feed = null;
    feedOk = false;
    feedT = setTimeout(openFeed, peerBlocked() ? 60e3 : FEED_RETRY_MS);
    feedT.unref();
  };
  req.on('error', again);
  req.on('close', again);
}

function closeFeed() {
  clearTimeout(feedT);
  feedT = null;
  const f = feed;
  feed = null;
  feedOk = false;
  if (f) f.destroy();
}

// Whether that PC can be reached right now (its conversations are read and sent to through the link)
export const pcOnline = () => !!paired() && (!!TEST_LINK || (state === 'online' && !!origin && !!secret));
export const pcName = () => { const p = paired(); return p ? p.name : null; };

// One of that PC's own conversations, read through the link with the turn in progress (what GET /api/sessions/:id gives
// there), or null: the link is down, or it is not that PC's own (that PC's read-only copy of another PC's is skipped).
export async function pcSession(id, search = '') {
  if (!pcOnline()) return null;
  try {
    const r = await pcCall('GET', `/api/sessions/${encodeURIComponent(id)}${search}`, { timeout: 6000 });
    return r.status === 200 && r.json && !r.json.readOnly ? r.json : null;
  } catch {
    return null;
  }
}

// Its context and cache, read there, or null.
export async function pcStats(id) {
  if (!pcOnline()) return null;
  try {
    const r = await pcCall('GET', `/api/sessions/${encodeURIComponent(id)}/stats`, { timeout: 6000 });
    return r.status === 200 && r.json ? r.json : null;
  } catch {
    return null;
  }
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: READ_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode === 423) pcPeerLocked(true);
        else if (res.statusCode === 200) pcPeerLocked(false);
        if (res.statusCode !== 200) return reject(new Error(res.statusCode === 423 ? 'locked: type its PIN' : `${res.statusCode} ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('the answer is not JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', reject);
  });
}

// Reads that PC's projects and root folders through the link, and keeps them.
export function readProjects() {
  const L = linkTarget();
  if (reading || !L) return reading || Promise.resolve(pcLinkStatus());
  const p = paired();
  reading = getJson(L.base + '/api/projects', { ...L.headers, 'X-MC': '1' })
    .then((d) => {
      const projects = (Array.isArray(d && d.projects) ? d.projects : [])
        .filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string')
        .map((x) => Object.fromEntries(KEEP.filter((k) => x[k] !== undefined).map((k) => [k, k === 'notes' ? cleanNotes(x[k]) : x[k]])));
      const roots = (Array.isArray(d && d.roots) ? d.roots : []).filter((r) => typeof r === 'string');
      cache = { at: new Date().toISOString(), name: p ? p.name : 'Home', roots, projects };
      try { writeJson(CACHE_FILE, cache); } catch (err) { console.error('[pc-link] could not keep the projects:', err.message); }
      lastError = null;
    })
    .catch((err) => {
      lastError = String(err.message || err).slice(0, 300);
      console.error('[pc-link] could not read the projects:', lastError);
    })
    .finally(() => {
      reading = null;
      publish('pc-link', pcLinkStatus());
    })
    .then(() => pcLinkStatus());
  return reading;
}

// One of that PC's projects by its id there, from the last list read (null when it has none by that id). Synchronous, for
// checks that cannot wait on the link (a task's project).
export function pcProjectKnown(id) {
  const st = pcLinkStatus();
  return (typeof id === 'string' && st.paired && st.projects.find((x) => x.id === id)) || null;
}

// The same, but a project missing from the last list (added there since) makes it read the list again once.
export async function pcProject(id) {
  if (typeof id !== 'string' || !id) return null;
  return pcProjectKnown(id) || ((await readProjects()).projects || []).find((x) => x.id === id) || null;
}

// Files attached here, uploaded there first: their ids there, to go with a message
export async function pcUpload(ids) {
  const out = [];
  for (const id of ids) {
    const u = getUpload(id);
    if (!u) throw fail(400, 'An attached file is gone. Attach it again.');
    const r = await pcCall('POST', '/api/uploads', { json: { name: u.name, type: u.media_type, data: fs.readFileSync(u.file).toString('base64') }, timeout: 120e3 });
    if (r.status !== 200 || !r.json || !r.json.id) throw fail(r.status === 200 ? 502 : r.status, (r.json && r.json.error) || 'The file could not go to the other PC');
    out.push(r.json.id);
  }
  return out;
}

// That PC's "locked" answer, renamed: passed on as it is, this PC's own page would take it for its own lock screen
const peerLockedBody = () => ({ error: 'peer_locked', pc: pcName() });

// One call to that PC through the link: { status, json }, with buffer: true { status, buf, type } instead. Throws when the
// link is down or the PC gives no answer.
export function pcCall(method, p, { json, timeout = READ_TIMEOUT_MS, buffer = false } = {}) {
  const base = TEST_LINK ? TEST_LINK.url : origin;
  if (!paired()) return Promise.reject(fail(409, 'This PC is not paired with another PC'));
  if (!base || (!TEST_LINK && (!secret || state !== 'online'))) return Promise.reject(fail(503, 'The other PC is not online'));
  const headers = TEST_LINK ? { ...(TEST_LINK.headers || {}) } : { 'X-MC-Link': secret };
  if (method !== 'GET') headers['X-MC'] = '1';
  let body = null;
  if (json !== undefined) {
    body = Buffer.from(JSON.stringify(json));
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = body.length;
  }
  return new Promise((resolve, reject) => {
    const req = http.request(base + p, { method, headers, timeout, agent: false }, (res) => {
      if (buffer) {
        const parts = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () => {
          if (res.statusCode !== 423) return resolve({ status: res.statusCode, buf: Buffer.concat(parts), type: res.headers['content-type'] || '' });
          pcPeerLocked(true);
          resolve({ status: 423, buf: Buffer.from(JSON.stringify(peerLockedBody())), type: 'application/json' });
        });
        res.on('error', reject);
        return;
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        if (res.statusCode === 423) { pcPeerLocked(true); parsed = peerLockedBody(); }
        resolve({ status: res.statusCode, json: parsed });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('the other PC did not answer in time')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// A POST to that PC whose answer comes as lines of JSON (services/modelAsk.js): {"wait":s} lines while it works, then
// one result line, which this resolves with. An answer that is not 200 resolves as { ok: false, status, error }. Gives up
// when nothing came for idleMs or the whole took limitMs; aborting the signal ends the request there too.
export function pcPostLines(p, json, { signal, idleMs = 90e3, limitMs = 30 * 60e3 } = {}) {
  const base = TEST_LINK ? TEST_LINK.url : origin;
  if (!paired()) return Promise.reject(fail(409, 'This PC is not paired with another PC'));
  if (!base || (!TEST_LINK && (!secret || state !== 'online'))) return Promise.reject(fail(503, 'The other PC is not online'));
  const headers = TEST_LINK ? { ...(TEST_LINK.headers || {}) } : { 'X-MC-Link': secret };
  const body = Buffer.from(JSON.stringify(json));
  Object.assign(headers, { 'X-MC': '1', 'Content-Type': 'application/json', 'Content-Length': body.length, Accept: 'application/x-ndjson' });
  return new Promise((resolve, reject) => {
    let last = null;
    let idle = null;
    const req = http.request(base + p, { method: 'POST', headers, agent: false }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        poke();
        buf += d;
        if (res.statusCode !== 200) return;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try { const v = JSON.parse(line); if (v && v.wait === undefined) last = v; } catch { /* not a line of JSON */ }
        }
      });
      res.on('end', () => {
        done();
        if (res.statusCode !== 200) {
          let j = null;
          try { j = JSON.parse(buf); } catch { /* not JSON */ }
          return resolve({ ok: false, status: res.statusCode, error: (j && j.error) || `the other PC answered ${res.statusCode}` });
        }
        if (!last && buf.trim()) { try { last = JSON.parse(buf.trim()); } catch { /* cut short */ } }
        if (last) resolve(last);
        else reject(fail(502, 'The other PC ended the answer without a result'));
      });
      res.on('error', (err) => { done(); reject(err); });
    });
    const whole = setTimeout(() => req.destroy(fail(504, 'The other PC did not finish in time')), limitMs);
    function poke() {
      clearTimeout(idle);
      idle = setTimeout(() => req.destroy(fail(504, 'The other PC went quiet')), idleMs);
    }
    function done() { clearTimeout(idle); clearTimeout(whole); }
    const onAbort = () => req.destroy(fail(499, 'canceled'));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', (err) => { done(); reject(err.status ? err : fail(502, `The link to the other PC failed: ${err.message}`)); });
    req.on('close', done);
    poke();
    req.end(body);
  });
}

// A one-use address that opens that PC's own pages in a browser on this PC (it gives the browser the link's cookie).
export function enterUrl() {
  if (!paired()) return Promise.reject(fail(409, 'This PC is not paired with another PC'));
  if (!child || !origin) return Promise.reject(fail(503, 'The link to the other PC is not running yet'));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const i = enterWaiters.indexOf(done);
      if (i >= 0) enterWaiters.splice(i, 1);
      reject(fail(504, 'The link gave no address in time'));
    }, ENTER_TIMEOUT_MS);
    function done(url) {
      clearTimeout(t);
      resolve({ url });
    }
    enterWaiters.push(done);
    try { child.stdin.write('\n'); } catch (err) { clearTimeout(t); enterWaiters.splice(enterWaiters.indexOf(done), 1); reject(fail(503, 'The link is not running')); }
  });
}

function startLink() {
  if (stopped || child || ROLE !== 'pc' || !paired() || !fs.existsSync(EXE)) return;
  const sec = loadOrCreateSecret({ dir: LINK_DIR, file: SECRET_FILE, label: 'pc link' });
  if (!sec.ok) {
    console.error('[pc-link]', sec.reason);
    return;
  }
  secret = sec.secret;
  setState('starting');
  const p = spawnLink([...EXTRA, '--state', LINK_DIR, 'serve', '--port', String(PORT), '--browser', '--secret-file', SECRET_FILE], ['pipe', 'pipe', 'pipe']);
  child = p;
  let buf = '';
  let first = true; // the enter line printed at start is not asked for: nobody gets it
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('listening ')) {
        origin = line.slice(10).trim();
        backoff = 2000;
        setState('connecting');
      } else if (line.startsWith('enter ')) {
        if (first) { first = false; continue; }
        const w = enterWaiters.shift();
        if (w) w(line.slice(6).trim());
      } else if (line.startsWith('link ')) setState(line.slice(5));
    }
  });
  p.stdin.on('error', () => { /* the link is gone; its exit handler starts it again */ });
  p.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) console.log(l.trim().replace(/^\[link\]/, '[pc-link]')); });
  p.on('error', (err) => console.error('[pc-link] could not start mc-link:', err.message));
  p.on('exit', (code) => {
    if (child === p) { child = null; origin = null; }
    if (stopped) return;
    setState('off');
    console.error(`[pc-link] mc-link stopped (${code}); starting it again in ${backoff / 1000} s`);
    setTimeout(startLink, backoff).unref();
    backoff = Math.min(backoff * 2, 60e3);
  });
}

setInterval(() => { if (feed && feedOk && Date.now() - feedAt > FEED_SILENT_MS) feed.destroy(); }, 15e3).unref();

// ---- Both ways ----
// Each PC calls the other through its own link: this one through the pairing above, that one through a pairing of its
// own with this PC's bridge. When this PC's link comes online (and when the Connections page asks), it reads whether
// that PC's link to here is set up (that PC's GET /api/pc-link names this PC). When that PC has no link at all, this
// PC opens a pairing code on its own bridge and hands it over the link (POST /api/pc-link/pair-back there): that PC
// pairs with this bridge and starts its link, and this PC marks the new device as a linked computer. A PC already linked
// to another computer is left alone. pcBack(): { state, at, error }, state one of
//   unknown, checking, linked (that PC's link to here is online), paired (set up, not online right now), missing,
//   other (that PC is linked to another computer), old (its Mission Control is older), pairing, failed.
const BACK_RETRY_MS = 10 * 60e3;
const BACK_WAIT_MS = Number(process.env.MC_PC_BACK_WAIT_MS) > 0 ? Number(process.env.MC_PC_BACK_WAIT_MS) : 30e3; // its link coming online

function setBack(state, error = null, name = null) {
  back = { state, at: new Date().toISOString(), error, name };
  publish('pc-link', pcLinkStatus());
}
export const pcBack = () => back;

// That PC's view of its own link: what it says about the link back to this PC.
export async function checkBack() {
  if (!pcOnline()) { setBack('unknown'); return back; }
  const r = await pcCall('GET', '/api/pc-link', { timeout: 8000 }).catch(() => null);
  if (!r) setBack('unknown', 'That PC did not answer');
  else if (r.status === 404 || (r.status === 200 && r.json && !('pairBack' in r.json))) setBack('old', 'That PC runs an older Mission Control: sync and restart it first');
  else if (r.status !== 200 || !r.json) setBack('unknown', `That PC answered ${r.status}`);
  else {
    const p = r.json.paired;
    if (!p) setBack('missing');
    else if (p.name !== MACHINE_NAME) setBack('other', null, p.name);
    else setBack(r.json.online ? 'linked' : 'paired');
  }
  return back;
}

// Makes the link back when that PC has none. Returns pcBack().
export function linkBack() {
  if (backBusy) return backBusy;
  backBusy = (async () => {
    if (ROLE !== 'pc') throw fail(409, 'Only a PC links to another PC');
    await checkBack();
    if (back.state !== 'missing') return back;
    setBack('pairing');
    const opened = startPairing();
    if (opened.error) {
      backFailedAt = Date.now();
      setBack('failed', opened.error === 'bridge_offline' ? `${MACHINE_NAME}'s bridge is not running, so ${pcName()} cannot pair with it` : `No pairing code could be opened (${opened.error})`);
      return back;
    }
    const before = new Set(getDeviceList().map((d) => d.id));
    const r = await pcCall('POST', '/api/pc-link/pair-back', { json: { uri: opened.uri }, timeout: 90e3 }).catch((err) => ({ status: 0, json: { error: err.message } }));
    if (r.status !== 200) {
      cancelPairing();
      backFailedAt = Date.now();
      setBack('failed', `${pcName()} could not pair: ${(r.json && r.json.error) || r.status}`);
      return back;
    }
    // the device that just paired is that PC: it may sync and restart this one, as this one does there
    const fresh = getDeviceList().filter((d) => !before.has(d.id));
    const dev = fresh.find((d) => d.name === pcName()) || fresh[0];
    if (dev) setComputer(dev.id, true);
    backFailedAt = 0;
    // its link takes a few seconds to come online
    for (const until = Date.now() + BACK_WAIT_MS; Date.now() < until;) {
      await new Promise((ok) => setTimeout(ok, Math.min(1500, BACK_WAIT_MS)));
      await checkBack();
      if (back.state === 'linked') break;
    }
    return back;
  })().finally(() => { backBusy = null; });
  return backBusy;
}

// On each link start: check, and link back by itself, except within BACK_RETRY_MS of a failure.
function autoBack() {
  if (!pcOnline() || backBusy) return;
  if (backFailedAt && Date.now() - backFailedAt < BACK_RETRY_MS) { checkBack().catch(() => {}); return; }
  linkBack().catch((err) => setBack('failed', err.message));
}

function runLink(args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawnLink(args, ['ignore', 'pipe', 'pipe']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', (err) => { clearTimeout(t); resolve({ code: -1, out: err.message }); });
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

// That PC asks this one to pair with its bridge (uri: missioncontrol-pair:ID:CODE, made there a moment ago), so that this
// PC can call it too. from: the name of the device that asked (that PC). Refused when this PC is linked to another one.
export async function pairBack(uri, from) {
  if (ROLE !== 'pc') throw fail(409, 'Only a PC links to another PC');
  if (typeof uri !== 'string' || !/^missioncontrol-pair:[A-Za-z0-9]+:[A-Za-z0-9-]+$/.test(uri.trim())) throw fail(400, 'uri must be a missioncontrol-pair: text');
  const p = paired();
  if (p && !TEST_LINK && from && p.name !== from) throw fail(409, `${MACHINE_NAME} is already linked to ${p.name}`);
  if (!fs.existsSync(EXE)) throw fail(409, 'mc-link is not built on this PC');
  fs.mkdirSync(LINK_DIR, { recursive: true });
  const r = await runLink([...EXTRA, '--state', LINK_DIR, 'pair', uri.trim(), '--name', MACHINE_NAME], 60e3);
  if (r.code !== 0) throw fail(502, (r.out.trim().split('\n').pop() || 'Pairing failed').slice(0, 300));
  // the new pairing: its link starts (again)
  if (!TEST_LINK) {
    stopped = true;
    if (child) { try { child.kill(); } catch { /* gone */ } child = null; }
    await new Promise((ok) => setTimeout(ok, 500));
    stopped = false;
    backoff = 2000;
    startLink();
  }
  return pcLinkStatus();
}

// ---- That PC's graphics card ----
// While a page is open here and the link is online, that PC's graphics memory is read every GPU_POLL_MS (its GET
// /api/system, as its own System page reads it; only the card is kept) and goes to the pages as pc.gpu
// { machine, name, vramUsedGB, vramTotalGB, utilPct } (null: not known now). The status bar shows it as "<name> VRAM".
const GPU_POLL_MS = Number(process.env.MC_PC_GPU_POLL_MS) > 0 ? Number(process.env.MC_PC_GPU_POLL_MS) : 10e3;
let pcGpu = null;
let gpuReading = false;
const sameGpu = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function setPcGpu(v) {
  if (sameGpu(v, pcGpu)) return;
  pcGpu = v;
  broadcast('pc.gpu', v);
}
async function readPcGpu() {
  if (gpuReading) return;
  if (!pcOnline()) return setPcGpu(null);
  gpuReading = true;
  try {
    const r = await pcCall('GET', '/api/system', { timeout: 8000 });
    const g = r.status === 200 && r.json && r.json.gpu;
    setPcGpu(g && g.vramTotalGB > 0 ? { machine: pcName(), name: g.name || null, vramUsedGB: Number(g.vramUsedGB) || 0, vramTotalGB: Number(g.vramTotalGB), utilPct: Number.isFinite(g.utilPct) ? g.utilPct : null } : null);
  } catch {
    setPcGpu(null);
  } finally {
    gpuReading = false;
  }
}
export const pcGpuNow = () => pcGpu;
if (ROLE === 'pc') {
  setInterval(() => { if (clientCount() > 0) readPcGpu(); }, GPU_POLL_MS).unref();
  // a page that opens gets the last reading at once, and a fresh one soon after
  onClientConnect((res) => { if (pcGpu) sendTo(res, 'pc.gpu', pcGpu); if (paired()) setTimeout(readPcGpu, 300).unref(); });
}
if (ROLE === 'pc' && TEST_LINK) setTimeout(openFeed, 500).unref();
if (ROLE === 'pc' && !TEST_LINK) {
  setTimeout(startLink, 1500).unref();
  pollTimer = setInterval(() => { if (state === 'online') readProjects(); }, POLL_MS);
  pollTimer.unref();
}
