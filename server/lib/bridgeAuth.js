// Trust for the phone bridge listener: the shared secret and the paired device lookup.
//
// The bridge program (mc-bridge.exe) talks to the second listener and proves itself with the secret in
// `.data\bridge\secret`. It then tells us which phone a request came from in X-MC-Device. Neither header is
// ever believed on the local listener (app.js strips them there).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from '../config.js';

const BRIDGE_DIR = path.join(DATA_DIR, 'bridge');
export const SECRET_FILE = path.join(BRIDGE_DIR, 'secret');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

let secretHash = null; // sha256 of the secret, so the compare below always sees two 32-byte buffers

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();

const currentUser = () => `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`;

// Only the current Windows user may read the folder and the file (a plain mode bit means little on Windows).
// MC_TEST_ICACLS=fail makes the apply step fail and MC_TEST_ICACLS=widen makes the check see an extra account;
// both only make this stricter, and exist so the tests never have to damage a real ACL.
function restrictToUser(target, isDir) {
  const user = currentUser();
  if (user.length < 3) return false;
  try {
    if (process.env.MC_TEST_ICACLS === 'fail') throw new Error('simulated icacls failure');
    // An argument array, never a shell string.
    execFileSync('icacls', [target, '/inheritance:r', '/grant:r', `${user}:${isDir ? '(OI)(CI)F' : 'F'}`], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15000,
    });
    return true;
  } catch (err) {
    console.error(`[bridge] could not restrict ${path.basename(target)} to the current user: ${err.message}`);
    return false;
  }
}

// True only when the ACL lists exactly one account and it is the current user. SYSTEM is not tolerated either:
// the design says the owner alone, and the service never needs this file.
function aclIsUserOnly(target) {
  try {
    const out = execFileSync('icacls', [target], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const names = [];
    for (const raw of out.split(/\r?\n/)) {
      const at = raw.indexOf(':(');
      if (at < 0) continue;
      let name = raw.slice(0, at);
      if (name.startsWith(target)) name = name.slice(target.length);
      names.push(name.trim().toLowerCase());
    }
    if (process.env.MC_TEST_ICACLS === 'widen') names.push('nt authority\\system');
    return names.length === 1 && names[0] === currentUser().toLowerCase();
  } catch {
    return false;
  }
}

// Applies and then verifies. A failure at either step means the target is not private.
function lockDown(target, isDir) {
  return restrictToUser(target, isDir) && aclIsUserOnly(target);
}

// Reads the secret, creating it on the first start. Returns false (and leaves the bridge listener off)
// when the file cannot be made private, or exists but is not a 64 character hex secret: rotating it is a
// deliberate act, never automatic.
export function loadBridgeSecret() {
  const win = process.platform === 'win32';
  try {
    fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    if (win && !aclIsUserOnly(BRIDGE_DIR) && !lockDown(BRIDGE_DIR, true)) {
      console.error('[bridge] the bridge folder is not private to the current user and could not be fixed. The bridge listener stays off.');
      return false;
    }
    if (!fs.existsSync(SECRET_FILE)) {
      const fresh = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(SECRET_FILE, fresh, { mode: 0o600, flag: 'wx' });
      if (win && !lockDown(SECRET_FILE, false)) {
        try {
          fs.unlinkSync(SECRET_FILE);
        } catch {
          // nothing more to do; the listener stays off either way
        }
        console.error('[bridge] could not make the new bridge secret private; it was deleted. The bridge listener stays off.');
        return false;
      }
      console.log('[bridge] created a new bridge secret');
    } else if (win && !aclIsUserOnly(SECRET_FILE) && !lockDown(SECRET_FILE, false)) {
      console.error('[bridge] the bridge secret file can be read by other accounts and could not be fixed. The bridge listener stays off.');
      return false;
    }
    const text = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(text)) {
      console.error('[bridge] the bridge secret file is not 64 hex characters; delete it to make a new one. The bridge listener stays off.');
      return false;
    }
    secretHash = sha256(text);
    return true;
  } catch (err) {
    console.error('[bridge] could not load the bridge secret:', err.message);
    return false;
  }
}

// Constant time for any input: both sides are hashed to 32 bytes first.
export function verifyBridgeSecret(header) {
  if (!secretHash || typeof header !== 'string') {
    noteAuthFailure();
    return false;
  }
  const ok = crypto.timingSafeEqual(sha256(header), secretHash);
  if (!ok) noteAuthFailure();
  return ok;
}

// Failures are counted per minute; the 20th in a minute is logged once.
let failWindowStart = 0;
let failCount = 0;
function noteAuthFailure() {
  const now = Date.now();
  if (now - failWindowStart > 60000) {
    failWindowStart = now;
    failCount = 0;
  }
  failCount += 1;
  if (failCount === 20) console.warn('[bridge] 20 requests with a missing or wrong bridge secret within a minute');
}

// ---- Paired devices ----
//
// The source of truth is `.data\devices.json` ([{ id, name, pairedAt, lastSeen }], written by the devices
// service). Until that service registers its own lookup, the file is read as it is, checked for changes on every
// call, so a removed device stops working on the next request.

const ID_FORMAT = /^[A-Za-z0-9_-]{1,128}$/;

let fileCache = { stamp: '', byId: new Map() };
function lookupFromFile(id) {
  try {
    const st = fs.statSync(DEVICES_FILE);
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp !== fileCache.stamp) {
      const list = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
      const byId = new Map();
      for (const d of Array.isArray(list) ? list : []) {
        if (d && typeof d.id === 'string') byId.set(d.id, { id: d.id, name: typeof d.name === 'string' ? d.name : 'Phone' });
      }
      fileCache = { stamp, byId };
    }
    return fileCache.byId.get(id) || null;
  } catch {
    return null; // no file or a half-written one: nobody is paired
  }
}

let lookup = { get: lookupFromFile, touch: () => {} };

// The devices service calls this to answer from its own memory and to record "last seen".
export function setDeviceLookup(impl) {
  lookup = { get: impl.get, touch: impl.touch || (() => {}) };
}

// Returns { id, name } for a paired device, or null.
export function getDevice(id) {
  if (typeof id !== 'string' || !ID_FORMAT.test(id)) return null;
  return lookup.get(id) || null;
}

export function touchDevice(id) {
  try {
    lookup.touch(id);
  } catch {
    // last-seen bookkeeping must never fail a request
  }
}
