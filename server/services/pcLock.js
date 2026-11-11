// The PIN that guards this PC from the other computer (the linked PC, services/pcLink.js, or any device marked as a
// computer): set here, typed there. While it is unlocked, that computer may do here everything this PC's own pages do
// (the console, temp and storage, settings: server/app.js). While it is locked, it gets nothing from this PC but the
// lock screen, and a message it left on the hub for one of this PC's conversations is refused (services/hubSync.js).
//
//   unlock    the PIN, typed on the other computer; it holds until the next lock time (lockAt, 03:00 unless set here)
//   lock      from here, from a phone, or from the other computer (its "Lock" button before leaving)
//   tries     5 wrong PINs lock it out for 15 min, then 30, 60 ... at most a day; a right PIN starts the count again
//   no PIN    nothing changes: the other computer keeps the limited access it always had (server/lib/remote-policy.js)
//
//   .data/pc-lock.json   { salt, hash, until, by, fails, blocks, outUntil, lockAt }; the PIN itself is never kept
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { dropComputers, publish } from '../lib/events.js';
import { readJson, writeJson } from '../lib/jsonStore.js';

const FILE = path.join(DATA_DIR, 'pc-lock.json');
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCK_AT = '03:00';
const TRIES = 5;
const BLOCK_MS = Number(process.env.MC_PC_BLOCK_MS) > 0 ? Number(process.env.MC_PC_BLOCK_MS) : 15 * 60e3;
const BLOCK_MAX_MS = 24 * 3600e3;
export const PIN_RE = /^\d{4,8}$/;

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });

let st = null;
function load() {
  if (st) return st;
  const r = readJson(FILE, 'pc-lock');
  st = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
  return st;
}
const save = () => writeJson(FILE, st);
const hashOf = (pin, salt) => crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), 32).toString('hex');

// The lock time ("16:30", local time), and the next one after now
const lockAt = () => (TIME_RE.test(String(load().lockAt || '')) ? load().lockAt : LOCK_AT);
function nextExpiry(now = new Date()) {
  const d = new Date(now);
  const [h, m] = lockAt().split(':').map(Number);
  d.setHours(h, m, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export const pinSet = () => !!load().hash;
export const unlocked = () => pinSet() && Number(load().until) > Date.now();
// A computer is held at the lock screen: a PIN is set, and it was not typed since the last lock
export const lockedFor = (device) => !!(device && device.computer) && pinSet() && !unlocked();
// A computer may use this PC as its own pages do
export const fullFor = (device) => !!(device && device.computer) && unlocked();

export function lockStatus() {
  const s = load();
  return {
    pin: pinSet(),
    unlocked: unlocked(),
    until: unlocked() ? new Date(s.until).toISOString() : null,
    by: unlocked() ? s.by || null : null,
    outUntil: Number(s.outUntil) > Date.now() ? new Date(s.outUntil).toISOString() : null,
    tries: Math.max(0, TRIES - (Number(s.fails) || 0)),
    lockAt: lockAt(),
  };
}
// what changed goes to the pages, and to the other computer's server on its stream (services/pcLink.js there); locked,
// that stream ends, so it gets nothing more
const changed = () => { publish('pc-lock', lockStatus()); if (pinSet() && !unlocked()) dropComputers(); };

// Set or change the PIN (at this PC only); setting it locks
export function setPin(pin) {
  if (!PIN_RE.test(String(pin || ''))) throw fail(400, 'The PIN is 4 to 8 digits');
  const salt = crypto.randomBytes(16).toString('hex');
  st = { salt, hash: hashOf(pin, salt), until: 0, by: null, fails: 0, blocks: 0, outUntil: 0, lockAt: load().lockAt };
  save();
  changed();
  return lockStatus();
}

// Remove the PIN (at this PC only): the other computer goes back to the limited access
export function clearPin() {
  st = { lockAt: load().lockAt };
  save();
  changed();
  return lockStatus();
}

export function unlock(pin, deviceName) {
  const s = load();
  if (!s.hash) throw fail(409, 'No PIN is set on this PC');
  if (Number(s.outUntil) > Date.now()) throw fail(429, 'Too many wrong PINs. Try again later.', { outUntil: new Date(s.outUntil).toISOString() });
  const want = Buffer.from(s.hash, 'hex');
  const got = Buffer.from(hashOf(String(pin || ''), s.salt), 'hex');
  if (!PIN_RE.test(String(pin || '')) || !crypto.timingSafeEqual(want, got)) {
    s.fails = (Number(s.fails) || 0) + 1;
    if (s.fails >= TRIES) {
      s.blocks = (Number(s.blocks) || 0) + 1;
      s.outUntil = Date.now() + Math.min(BLOCK_MAX_MS, BLOCK_MS * 2 ** (s.blocks - 1));
      s.fails = 0;
      console.warn(`[pc-lock] ${TRIES} wrong PINs from ${deviceName || 'a computer'}: locked out until ${new Date(s.outUntil).toLocaleTimeString()}`);
    }
    save();
    changed();
    throw fail(403, 'Wrong PIN', { tries: Math.max(0, TRIES - s.fails), outUntil: Number(s.outUntil) > Date.now() ? new Date(s.outUntil).toISOString() : null });
  }
  Object.assign(s, { until: nextExpiry(), by: deviceName || null, fails: 0, blocks: 0, outUntil: 0 });
  save();
  changed();
  return lockStatus();
}

// The time it locks again each day (at this PC only). Open now, it locks at the new time.
export function setLockAt(at) {
  if (!TIME_RE.test(String(at || ''))) throw fail(400, 'The time is HH:MM, for example 16:30');
  const s = load();
  s.lockAt = at;
  if (Number(s.until) > Date.now()) s.until = nextExpiry();
  save();
  changed();
  return lockStatus();
}

export function lock() {
  const s = load();
  if (s.hash && Number(s.until) > Date.now()) {
    s.until = 0;
    s.by = null;
    save();
    changed();
  }
  return lockStatus();
}

// A locked computer's request gets this answer, and only these routes (the lock screen's own)
export const LOCK_OPEN = new Set(['GET /api/whoami', 'GET /api/pc-lock', 'POST /api/pc-lock/unlock', 'POST /api/pc-lock/lock', 'GET /api/health']);

// the expiry passes on its own: tell the pages when it does
setInterval(() => {
  const s = load();
  if (s.hash && Number(s.until) > 0 && Number(s.until) <= Date.now()) {
    s.until = 0;
    s.by = null;
    save();
    changed();
  }
}, 60e3).unref();
