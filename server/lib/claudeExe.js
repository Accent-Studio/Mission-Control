// Finding the real claude entry point. Used by the server (runs.js) and by the runner (server/runner/index.js), which
// resolves it on its own and accepts a spawn request only for exactly this program.
import fs from 'node:fs';
import path from 'node:path';

let resolved = null;

// Reads the npm .cmd shim to find what it launches (a native exe or a cli.js).
function entryFromShim(cmdFile) {
  let text;
  try {
    text = fs.readFileSync(cmdFile, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(cmdFile);
  const re = /"([^"\r\n]*\.(?:exe|js|cjs|mjs))"/gi;
  let m;
  while ((m = re.exec(text))) {
    const target = path.normalize(m[1].replace(/%~?dp0%?\\?/gi, dir + path.sep));
    if (/(^|[\\/])node\.exe$/i.test(target)) continue; // the shim's "use local node if present" line
    if (!fs.existsSync(target)) continue;
    return /\.exe$/i.test(target)
      ? { cmd: target, pre: [] }
      : { cmd: process.execPath, pre: [target] };
  }
  return null;
}

const isFile = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

const WIN = process.platform === 'win32';

// Every claude.exe and claude.cmd in the PATH folders (on Linux, every claude), in PATH order. Only absolute folders are searched: where.exe looks in
// the current folder first (and so does a relative or empty PATH entry), and a claude binary dropped into the folder the
// server was started from would be picked up and run as the user.
function candidatesOnPath() {
  const out = [];
  const seen = new Set();
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter);
  for (const raw of dirs) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !path.isAbsolute(dir) || dir.startsWith('\\\\')) continue;
    for (const ext of WIN ? ['.exe', '.cmd'] : ['']) {
      const file = path.join(dir, 'claude' + ext);
      const key = file.toLowerCase();
      if (seen.has(key) || !isFile(file)) continue;
      seen.add(key);
      out.push(file);
    }
  }
  return out;
}

// { cmd, pre }: the program to start and the arguments that always come first (a cli.js behind node).
// Claude Code updates itself: the link on PATH moves to a new version and the old one may be removed. So the answer is
// kept only while its program is still there, and fresh: true reads PATH again (the runner does when a server names a
// program it does not know, which happens when the server started after an update and the runner before it).
export async function resolveClaude({ fresh = false } = {}) {
  if (resolved && !fresh && fs.existsSync(resolved.pre[0] || resolved.cmd)) return resolved;
  resolved = null;
  const lines = candidatesOnPath();
  if (!WIN) {
    // npm links bin/claude to the program: a native binary, or a cli.js that node runs
    for (const l of lines) {
      let real = l;
      try { real = fs.realpathSync(l); } catch { continue; }
      return (resolved = /\.(?:c|m)?js$/i.test(real) ? { cmd: process.execPath, pre: [real] } : { cmd: real, pre: [] });
    }
  }
  for (const l of lines) {
    if (/\.exe$/i.test(l)) return (resolved = { cmd: l, pre: [] });
  }
  for (const l of lines) {
    if (/\.cmd$/i.test(l)) {
      const e = entryFromShim(l);
      if (e) return (resolved = e);
    }
  }
  const err = new Error('Could not find the claude CLI on PATH');
  err.status = 500;
  throw err;
}

const samePath = (a, b) => (WIN ? path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase() : path.resolve(String(a)) === path.resolve(String(b)));

// True when cmd and the first arguments are exactly the resolved claude program (nothing else may be started).
export function isClaudeCommand(entry, cmd, args) {
  if (typeof cmd !== 'string' || !Array.isArray(args)) return false;
  if (!samePath(cmd, entry.cmd)) return false;
  return entry.pre.every((p, i) => typeof args[i] === 'string' && samePath(args[i], p));
}
