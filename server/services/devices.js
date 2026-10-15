// Paired phones: the device list, the pairing code, and the control stream to mc-bridge.exe.
//
// The source of truth is `.data\devices.json` ([{ id, name, pairedAt, lastSeen }], id = the phone's iroh endpoint
// id). It is read once at start and kept in memory. A change made to the file by hand is picked up on the next
// request (a stat check), so removing a line there has the same effect as the Remove button.
//
// In memory only: the open pairing code, which bridge is connected, and which phones are online right now.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { publish } from '../lib/events.js';
import { setDeviceLookup } from '../lib/bridgeAuth.js';

const FILE = path.join(DATA_DIR, 'devices.json');

// Same alphabet as the BlitzVoice pairing codes: no 0/O, 1/I/L, 5/S, 8/B lookalikes.
const CODE_ALPHABET = '2346789ACDEFGHJKMNPQRTUVWXYZ';
const CODE_LENGTH = 8;
const MAX_FAILURES = 5;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const ID_FORMAT = /^[A-Za-z0-9_-]{1,128}$/;
const NAME_MAX = 40;

// Reads a millisecond setting from the environment. Anything that is not a finite positive number falls back to
// the default; a number outside min..max is pulled into the range. The overrides exist for the tests.
export function clampMs(raw, fallback, min, max) {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

const PING_MS = clampMs(process.env.MC_DEVICES_PING_MS, 25000, 100, 25000);
const FLUSH_MS = clampMs(process.env.MC_DEVICES_FLUSH_MS, 60000, 100, 60000);

const ttlMs = () => clampMs(process.env.MC_PAIR_TTL_MS, DEFAULT_TTL_MS, 100, 600000);

export const isDeviceId = (id) => typeof id === 'string' && ID_FORMAT.test(id);

export function cleanName(name) {
  // Control characters and every format character (this includes the bidi controls U+202A-202E, U+2066-2069,
  // U+200E and U+200F, and zero-width characters) are dropped, so a name cannot reorder the text around it.
  const s = typeof name === 'string'
    ? [...name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()].slice(0, NAME_MAX).join('').trim()
    : '';
  return s || 'Phone';
}

// ---- The list ----

let devices = new Map(); // id -> { id, name, pairedAt, lastSeen }
let fileStamp = '';
let dirty = false; // lastSeen changed since the last write

// A read problem is never the same as "nobody is paired". Only a missing file means an empty list.
// `unsafe` is true while the file on disk is one we could not read (at startup, or after it changed). Background
// writes (lastSeen) wait until a read succeeds; an explicit owner action may still write, and then the unread
// file is copied aside first. `goodRead` says memory came from at least one good read since startup.
let unsafe = false;
let goodRead = false;
let badSeenStamp = null; // stamp of a file that held invalid JSON once; the next look is its one retry
let readFailure = null; // 'io' or 'json', set by readFile when it returns null

// Returns the stamp, '' when the file does not exist, or null when it cannot be looked at (antivirus, lock).
function stampOf() {
  try {
    const st = fs.statSync(FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch (err) {
    return err && err.code === 'ENOENT' ? '' : null;
  }
}

// Returns a Map (an empty one only when the file does not exist), or null when the file could not be read or
// parsed (readFailure then says which).
function readFile() {
  readFailure = null;
  let text;
  try {
    // MC_TEST_DEVICES_READ=1 plus a file named devices.json.fail-read stands in for a locked file in the tests.
    if (process.env.MC_TEST_DEVICES_READ === '1' && fs.existsSync(`${FILE}.fail-read`)) {
      throw Object.assign(new Error('simulated busy file'), { code: 'EBUSY' });
    }
    text = fs.readFileSync(FILE, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Map(); // no file yet: nobody is paired
    readFailure = 'io';
    return null;
  }
  let list;
  try {
    list = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    readFailure = 'json';
    return null;
  }
  const byId = new Map();
  for (const d of Array.isArray(list) ? list : []) {
    if (!d || !isDeviceId(d.id)) continue;
    byId.set(d.id, {
      id: d.id,
      name: cleanName(d.name),
      pairedAt: typeof d.pairedAt === 'string' ? d.pairedAt : new Date().toISOString(),
      lastSeen: typeof d.lastSeen === 'string' ? d.lastSeen : null,
    });
  }
  return byId;
}

// Keeps an invalid file for the owner to look at; a write must not destroy it.
function setAsideBad() {
  try {
    fs.renameSync(FILE, `${FILE}.bad-${Date.now()}`);
    console.error('[devices] devices.json held invalid JSON twice; it was set aside as devices.json.bad-*');
    return true;
  } catch {
    return false;
  }
}

// Write to a temp file, then rename over the real one, so a crash never leaves half a file.
// Returns false when the write failed; the list then stays dirty so the next flush tries again.
// With MC_TEST_DEVICES_WRITE=1, a file named devices.json.fail-write next to the list makes the rename fail
// (a stand-in for a locked file), so the tests never have to damage anything real.
function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (unsafe && fs.existsSync(FILE)) {
      // The existing file was never read successfully: keep a copy before it is replaced.
      fs.copyFileSync(FILE, `${FILE}.unread-${Date.now()}`);
    }
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...devices.values()], null, 2));
    if (process.env.MC_TEST_DEVICES_WRITE === '1' && fs.existsSync(`${FILE}.fail-write`)) throw new Error('simulated rename failure');
    fs.renameSync(tmp, FILE);
    fileStamp = stampOf() ?? '';
    badSeenStamp = null;
    unsafe = false;
    dirty = false;
    return true;
  } catch (err) {
    dirty = true;
    console.error('[devices] could not write devices.json:', err.message);
    return false;
  }
}

// If someone edited the file by hand, take its content and tell the bridge about the difference.
function syncFromFile() {
  const now = stampOf();
  if (now === null || now === fileStamp) return; // cannot look: keep memory and try again next time
  const fresh = readFile();
  if (fresh === null) {
    // Keep memory and the old stamp, so the next call reads again. Until then no background write may replace
    // the file we could not see.
    unsafe = true;
    if (readFailure === 'json') {
      if (badSeenStamp !== now) {
        badSeenStamp = now; // maybe half written: one more look before it counts as bad
      } else if (setAsideBad()) {
        badSeenStamp = null;
        fileStamp = '';
        // Memory from a good read is written back on the next flush; an empty startup list is not.
        unsafe = !goodRead;
        if (goodRead) dirty = true;
      }
    }
    return;
  }
  badSeenStamp = null;
  unsafe = false;
  const firstRead = !goodRead;
  goodRead = true;
  fileStamp = now;
  if (firstRead) {
    // The first good read after a start that could not read the file: the bridge has had no list from us yet.
    devices = fresh;
    sendControl({ type: 'devices', ids: [...devices.keys()] });
    changed('file');
    return;
  }
  const removed = [...devices.keys()].filter((id) => !fresh.has(id));
  const added = [...fresh.keys()].filter((id) => !devices.has(id));
  devices = fresh;
  for (const id of removed) {
    presence.delete(id);
    revoke(id);
  }
  for (const id of added) sendControl({ type: 'add', id });
  if (removed.length || added.length) changed('file');
}

function changed(reason, extra = {}) {
  publish('devices.changed', { reason, ...extra });
}

{
  const first = stampOf();
  const loaded = readFile();
  if (loaded) {
    goodRead = true;
    devices = loaded;
    fileStamp = first ?? '';
  } else {
    // The file exists but cannot be read: start empty in memory, write nothing until a read works or the owner acts.
    devices = new Map();
    unsafe = true;
    fileStamp = '';
    if (readFailure === 'json') badSeenStamp = first;
    console.error(`[devices] devices.json could not be read (${readFailure}); the list is empty for now and nothing is written until it can be read`);
  }
}

// ---- Presence and last seen ----

const presence = new Set(); // ids with at least one live connection at the bridge

function markSeen(id) {
  const d = devices.get(id);
  if (!d) return;
  d.lastSeen = new Date().toISOString();
  dirty = true;
}

// lastSeen is written at most once a minute (and once more when the process exits). A hand edit is taken in
// first, so the write never puts back a device that was removed from the file.
setInterval(() => {
  syncFromFile();
  if (dirty && !unsafe) saveNow();
}, FLUSH_MS).unref();
process.on('exit', () => {
  // If the file changed since it was last read, it is newer than memory: leave it alone.
  if (dirty && !unsafe && stampOf() === fileStamp) saveNow();
});

// The lookup that index.js uses on the bridge listener for every phone request.
setDeviceLookup({
  get(id) {
    syncFromFile();
    const d = devices.get(id);
    return d ? { id: d.id, name: d.name } : null;
  },
  touch(id) {
    markSeen(id);
  },
});

export function getDeviceList() {
  syncFromFile();
  return [...devices.values()];
}

export function setPresence(id, online) {
  syncFromFile();
  if (!devices.has(id)) return false;
  if (online) {
    presence.add(id);
    markSeen(id);
  } else {
    presence.delete(id);
    markSeen(id);
  }
  changed('presence', { id, online: !!online });
  return true;
}

export function renameDevice(id, name) {
  syncFromFile();
  const d = devices.get(id);
  if (!d) return null;
  const oldName = d.name;
  d.name = cleanName(name);
  if (!saveNow()) {
    d.name = oldName;
    return 'write_failed';
  }
  changed('renamed', { id });
  return { id: d.id, name: d.name };
}

// ---- The bridge and its control stream ----

const bridge = { endpointId: null, version: null, startedAt: null, seenAt: null };
const controlStreams = new Set(); // open SSE responses of GET /api/bridge/control

const bridgeOnline = () => controlStreams.size > 0;

function sendControl(event) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of controlStreams) {
    try {
      res.write(msg);
    } catch {
      // a dead stream is dropped by its close handler
    }
  }
}

// Code that must drop a revoked phone's open requests registers here (index.js does, for the bridge listener).
const revokeListeners = new Set();
export function onRevoke(fn) {
  revokeListeners.add(fn);
}

function revoke(id) {
  for (const fn of revokeListeners) {
    try {
      fn(id);
    } catch {
      // a listener must never stop the revoke
    }
  }
  sendControl({ type: 'revoke', id });
}

// The ping also looks at the file, so a hand-removed device is revoked even when nobody is asking anything.
setInterval(() => {
  syncFromFile();
  sendControl({ type: 'ping' });
}, PING_MS).unref();

export function bridgeHello({ endpointId, version, startedAt, online }) {
  bridge.endpointId = endpointId;
  bridge.version = typeof version === 'string' ? version.slice(0, 40) : null;
  bridge.startedAt = typeof startedAt === 'string' ? startedAt.slice(0, 40) : null;
  bridge.seenAt = new Date().toISOString();
  // A hello means the bridge (re)started its link: it states which phones are connected right now.
  presence.clear();
  for (const id of Array.isArray(online) ? online : []) if (devices.has(id)) presence.add(id);
  changed('bridge');
}

// Registers an open control stream. The first event is the full list of allowed ids, but only once the list was read: an
// empty list sent because devices.json could not be read would make the bridge close every phone as removed. Without one,
// the bridge keeps what it had, or tells phones to try again, until syncFromFile reads the file and sends it.
export function attachControl(res) {
  syncFromFile();
  controlStreams.add(res);
  if (goodRead || !unsafe) res.write(`data: ${JSON.stringify({ type: 'devices', ids: [...devices.keys()] })}\n\n`);
  changed('bridge');
  return () => {
    controlStreams.delete(res);
    changed('bridge');
  };
}

export function restartBridge() {
  if (!bridgeOnline()) return false;
  sendControl({ type: 'restart' });
  return true;
}

// ---- Pairing ----

let pairing = null; // { code (8 chars, no dash), expiresAt (ms), failures, timer }

function burnPairing(reason) {
  if (!pairing) return false;
  clearTimeout(pairing.timer);
  pairing = null;
  changed('pairing', { state: reason });
  return true;
}

const dashed = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
const normalize = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();

// Returns null while no code is open (or after it expired).
export function currentPairing() {
  if (pairing && Date.now() >= pairing.expiresAt) burnPairing('expired');
  return pairing ? { expiresAt: new Date(pairing.expiresAt).toISOString() } : null;
}

// Opens a new code (the previous one, if any, stops working). Needs a connected bridge: the phone dials it.
export function startPairing() {
  if (!bridgeOnline() || !bridge.endpointId) return { error: 'bridge_offline' };
  // A pairing writes the list. While the file on disk cannot be read, writing it would drop the phones in it.
  syncFromFile();
  if (unsafe) return { error: 'list_unreadable' };
  if (pairing) clearTimeout(pairing.timer);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  const ttl = ttlMs();
  const timer = setTimeout(() => {
    if (pairing && pairing.code === code) burnPairing('expired');
  }, ttl);
  timer.unref();
  pairing = { code, expiresAt: Date.now() + ttl, failures: 0, timer };
  changed('pairing', { state: 'open' });
  return {
    code: dashed(code),
    uri: `missioncontrol-pair:${bridge.endpointId}:${dashed(code)}`,
    expiresAt: new Date(pairing.expiresAt).toISOString(),
  };
}

export function cancelPairing() {
  return burnPairing('cancelled');
}

// The bridge asks on behalf of a phone that sent a code. A wrong code counts against the open code; the
// fifth wrong one burns it. Every failure looks the same from outside (`bad_code`).
export function tryPair({ endpointId, code, deviceName }) {
  syncFromFile();
  if (currentPairing() === null) return { ok: false, code: 'bad_code' };
  if (unsafe) return { error: 'list_unreadable' }; // the code stays open: the phone can try again once the file reads
  const given = normalize(code);
  const match = given.length === CODE_LENGTH && crypto.timingSafeEqual(sha256(given), sha256(pairing.code));
  if (!match) {
    pairing.failures += 1;
    if (pairing.failures >= MAX_FAILURES) burnPairing('burned');
    return { ok: false, code: 'bad_code' };
  }
  const now = new Date().toISOString();
  const existing = devices.get(endpointId);
  const device = { id: endpointId, name: cleanName(deviceName), pairedAt: now, lastSeen: now };
  if (existing) device.pairedAt = existing.pairedAt;
  devices.set(endpointId, device);
  if (!saveNow()) {
    // Not saved: undo the change and keep the code open, so the phone can try again.
    if (existing) devices.set(endpointId, existing);
    else devices.delete(endpointId);
    return { error: 'write_failed' };
  }
  burnPairing('used');
  sendControl({ type: 'add', id: endpointId });
  changed('paired', { id: endpointId, name: device.name });
  return { ok: true, serverName: os.hostname() };
}

// ---- Removing ----

// Deleting from the list comes first, so a request still in flight on the bridge listener already gets
// 403 device_revoked. The revoke event then makes the bridge close that phone's connections at once.
// `revokeDelayMs` lets a phone that removes itself still receive the answer to its own request.
// Returns true, false (unknown id) or 'write_failed' (the list could not be saved; nothing changed).
export function removeDevice(id, { revokeDelayMs = 0 } = {}) {
  syncFromFile();
  const old = devices.get(id);
  if (!old) return false;
  devices.delete(id);
  if (!saveNow()) {
    devices.set(id, old);
    return 'write_failed';
  }
  presence.delete(id);
  changed('removed', { id });
  if (revokeDelayMs > 0) {
    // Only the pairing that was removed is revoked: if the phone paired again meanwhile, it is in the list again.
    setTimeout(() => {
      if (!devices.has(id)) revoke(id);
    }, revokeDelayMs).unref();
  } else {
    revoke(id);
  }
  return true;
}

// ---- What the Connections page shows ----

export function listView({ remote = false } = {}) {
  const list = getDeviceList().map((d) => ({
    id: d.id,
    name: d.name,
    pairedAt: d.pairedAt,
    lastSeen: d.lastSeen,
    online: bridgeOnline() && presence.has(d.id),
  }));
  const view = { pairing: currentPairing(), devices: list };
  // The bridge's own address stays at the PC.
  if (!remote) {
    view.bridge = bridge.endpointId || bridgeOnline() ? { online: bridgeOnline(), endpointId: bridge.endpointId, version: bridge.version } : null;
  }
  return view;
}
