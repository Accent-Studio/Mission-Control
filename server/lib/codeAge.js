// Has the server's own code changed since this server started? A pull, a sync or an edit writes the files in server/, and
// the running server still runs what it loaded at its start: the status window and the Sync panel say a restart is due.
// The runner's own files are left out (it is restarted on its own, runnerClient.js says when it is older than its code).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// MC_CODE_DIR, MC_CODE_AGE_MS: tests point it at a folder of their own and read it more often
const SERVER_DIR = process.env.MC_CODE_DIR ? path.resolve(process.env.MC_CODE_DIR) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set([path.join(SERVER_DIR, 'runner'), path.join(SERVER_DIR, 'data'), path.join(SERVER_DIR, 'node_modules')]);
const STARTED_MS = Date.now() - Math.round(process.uptime() * 1000);
const CACHE_MS = Number(process.env.MC_CODE_AGE_MS) || 5000;
let cached = null; // { at, newest }

function newestIn(dir, depth = 0) {
  let newest = 0;
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 6 && !SKIP.has(p) && !e.name.startsWith('.')) newest = Math.max(newest, newestIn(p, depth + 1));
    } else if (/\.(?:m?js|json)$/.test(e.name)) {
      try {
        newest = Math.max(newest, fs.statSync(p).mtimeMs);
      } catch {
        // gone meanwhile
      }
    }
  }
  return newest;
}

// The newest change to the server's code (ms), read at most every 5 s.
export function serverCodeStamp() {
  if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), newest: newestIn(SERVER_DIR) };
  return cached.newest;
}

// true when a file of the server's code is newer than this server
export function serverCodeChanged() {
  return serverCodeStamp() > STARTED_MS + 1000;
}

// What a computer's report (machines.js hereReport, code) says needs a restart: the server, and the runner or the bridge,
// which only Restart all three restarts (all). An older Mission Control only says code.restart, for its server.
export function restartDue(code) {
  const c = code || {};
  const d = { server: !!c.restart, runner: !!c.runner, bridge: !!c.bridge };
  return { ...d, all: d.runner || d.bridge };
}
