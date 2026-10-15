// A shared secret in a file that only the current Windows user can read (used by the runner, see server/runner/index.js).
// The secret is used as an HMAC key for a handshake (below) and is never sent anywhere.
// Same method as the phone bridge secret in bridgeAuth.js: the folder and the file are locked to the current user with
// icacls, and the result is checked. A file that exists but is not 64 hex characters is never replaced by itself
// (rotating a secret is a deliberate act: delete the file).
//
// MC_TEST_ICACLS=fail makes the apply step fail and MC_TEST_ICACLS=widen makes the check see an extra account; both
// only make this stricter, and exist so the tests never have to damage a real ACL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const currentUser = () => `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`;

function restrictToUser(target, isDir, label) {
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
    console.error(`[${label}] could not restrict ${path.basename(target)} to the current user: ${err.message}`);
    return false;
  }
}

// True only when the ACL lists exactly one account and it is the current user.
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

const lockDown = (target, isDir, label) => restrictToUser(target, isDir, label) && aclIsUserOnly(target);

// Reads the secret, creating it when the file does not exist yet (two processes racing to create it is fine: the
// loser of the exclusive write reads what the winner wrote). Returns { ok: true, secret } or { ok: false, reason }.
export function loadOrCreateSecret({ dir, file, label }) {
  const win = process.platform === 'win32';
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (win && !aclIsUserOnly(dir) && !lockDown(dir, true, label)) {
      return { ok: false, reason: `the ${label} folder is not private to the current user and could not be fixed` };
    }
    if (!fs.existsSync(file)) {
      const fresh = crypto.randomBytes(32).toString('hex');
      try {
        fs.writeFileSync(file, fresh, { mode: 0o600, flag: 'wx' });
        if (win && !lockDown(file, false, label)) {
          try {
            fs.unlinkSync(file);
          } catch {
            // nothing more to do; the secret is unusable either way
          }
          return { ok: false, reason: `the new ${label} secret could not be made private; it was deleted` };
        }
        console.log(`[${label}] created a new secret`);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    if (win && !aclIsUserOnly(file) && !lockDown(file, false, label)) {
      return { ok: false, reason: `the ${label} secret file can be read by other accounts and could not be fixed` };
    }
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(text)) {
      return { ok: false, reason: `the ${label} secret file is not 64 hex characters (delete it to make a new one)` };
    }
    return { ok: true, secret: text };
  } catch (err) {
    return { ok: false, reason: `could not load the ${label} secret: ${err.message}` };
  }
}

// ---- Mutual challenge-response (the secret never crosses a socket) ----
// Each side sends a random nonce first. Proof of knowing the secret is an HMAC-SHA256 keyed with it over the role, then both
// nonces, so an answer is good for one pair of nonces only: it cannot be replayed on another connection, and the proof a
// client gives cannot be passed off as the proof a runner gives (the role differs).
//   client proof = HMAC(secret, "client" | runnerNonce | clientNonce)
//   runner proof = HMAC(secret, "runner" | clientNonce | runnerNonce)

export const NONCE_HEX = 64; // 32 random bytes

export const makeNonce = () => crypto.randomBytes(32).toString('hex');

export const isNonce = (v) => typeof v === 'string' && v.length === NONCE_HEX && /^[0-9a-f]+$/.test(v);

export function handshakeProof(secret, role, first, second) {
  return crypto.createHmac('sha256', Buffer.from(String(secret), 'utf8')).update(`${role}|${first}|${second}`, 'utf8').digest('hex');
}

// Constant time for any input: a proof of the wrong kind or length is simply false.
export function proofMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || given.length !== expected.length || !/^[0-9a-f]+$/.test(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}
