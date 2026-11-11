// What the runner and its client (server/services/runnerClient.js) agree on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHATS_DIR, DATA_DIR, DEFAULT_CWD, DISCOVERY_ROOTS, EXTRA_PROJECTS, LOCAL_MODELS_DIR, OPEN_DRIVES, PERSONA_SYSTEM_FILE, savedDiscoveryRoots } from '../config.js';

// Bump when the wire protocol changes in a way an older runner cannot follow. A client refuses a runner with another number
// and starts claude directly instead. 2: the secret no longer crosses the socket (mutual challenge-response, see
// lib/privateSecret.js and the header of index.js).
export const PROTO = 2;

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.join(here, '..', 'lib');
const PROMPTS_DIR = path.join(here, '..', 'prompts');

// The files a running runner was loaded from. If any is newer than the runner's start, the runner is older than the code.
const FILES = [
  path.join(here, 'index.js'),
  path.join(here, 'shared.js'),
  path.join(here, '..', 'config.js'),
  path.join(lib, 'privateSecret.js'),
  path.join(lib, 'claudeExe.js'),
];

// Newest modification time (ms) of the runner's code.
export function codeStamp() {
  let newest = 0;
  for (const f of FILES) {
    try {
      newest = Math.max(newest, fs.statSync(f).mtimeMs);
    } catch {
      // a missing file counts as nothing
    }
  }
  return Math.floor(newest);
}

// The only options a spawn request may carry, as the server builds them (runs.js startRun). Anything else is refused.
export const FIXED_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--permission-prompt-tool', 'stdio'];
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// A plain chat (runs.js CHAT_FLAGS): web search and web pages only, the user's own settings only, no MCP servers, no skills.
export const CHAT_TOOLS = 'WebSearch,WebFetch';
const BARE_FLAGS = ['--strict-mcp-config', '--disable-slash-commands']; // flags that take no value
// Mission Control's own MCP server (services/mcp.js): runs.js writes one config per run in MCP_DIR, named after the run, and
// lets its tools run without asking (they only read and write tasks).
export const MCP_DIR = path.join(DATA_DIR, 'mcp');
export const MC_TOOLS = 'mcp__mc';
export const mcpConfigFile = (runId) => path.join(MCP_DIR, `${runId}.json`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID.test(s);

// Checks the arguments after the program (and its fixed leading arguments). Returns null when they are fine, otherwise a
// short reason. Every argument must be a string; the shape is the fixed list plus these flags with their values.
export function checkSpawnArgs(rest) {
  if (!Array.isArray(rest) || rest.length > 64) return 'args must be a short list';
  for (const a of rest) if (typeof a !== 'string' || a.length > 4096 || a.includes('\0')) return 'every argument must be a string without NUL characters';
  for (let i = 0; i < FIXED_ARGS.length; i++) if (rest[i] !== FIXED_ARGS[i]) return 'unexpected arguments';
  for (let i = FIXED_ARGS.length; i < rest.length; i += 2) {
    const flag = rest[i];
    if (BARE_FLAGS.includes(flag)) {
      i -= 1; // no value to skip
      continue;
    }
    const val = rest[i + 1];
    if (typeof val !== 'string') return `${flag} needs a value`;
    if (flag === '--resume') {
      if (!isUuid(val)) return '--resume needs a session id';
    } else if (flag === '--model') {
      if (!/^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,80}$/.test(val)) return 'bad --model value';
    } else if (flag === '--permission-mode') {
      if (!PERMISSION_MODES.includes(val)) return 'bad --permission-mode value';
    } else if (flag === '--effort') {
      if (!EFFORT_LEVELS.includes(val)) return 'bad --effort value';
    } else if (flag === '--append-system-prompt-file' || flag === '--system-prompt-file') {
      if (!isPromptFile(val)) return `bad ${flag} value`;
    } else if (flag === '--tools') {
      if (val !== CHAT_TOOLS) return `bad ${flag} value`;
    } else if (flag === '--allowedTools') {
      if (val !== CHAT_TOOLS && val !== MC_TOOLS) return `bad ${flag} value`;
    } else if (flag === '--mcp-config') {
      if (!isMcpConfig(val)) return 'bad --mcp-config value';
    } else if (flag === '--setting-sources') {
      if (val !== 'user') return 'bad --setting-sources value';
    } else if (flag === '--settings') {
      if (!isLocalModelSettings(val)) return 'bad --settings value';
    } else return `flag not allowed: ${flag}`;
  }
  return null;
}

// ---- Where a process may run and what it may read as a system prompt ----

// A plain local path on a drive letter: no UNC share, no \\?\ or \\.\ device path, no NUL, no stream mark, no wildcard.
// On macOS and Linux, a plain absolute path (/Users/...): no // network form and no NUL.
function plainDrivePath(p) {
  if (typeof p !== 'string' || p.length >= 1024) return false;
  if (process.platform !== 'win32') return p.startsWith('/') && !p.startsWith('//') && !p.includes('\0');
  return /^[A-Za-z]:[\\/]/.test(p) && !/[\0<>"|?*]/.test(p) && !p.slice(2).includes(':');
}

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const isInside = (p, root) => p === root || p.startsWith(root + path.sep);

// The folders runs.js starts a conversation in: the default folder, the chats folder, the project folders of the discovery roots (and anything
// below them, a resumed session may have been recorded in a subfolder) and the extra projects. The discovery roots come from
// the start and from .data/config.json now, so a root folder added since then counts too.
export function allowedRoots() {
  return [DEFAULT_CWD, CHATS_DIR, ...DISCOVERY_ROOTS, ...savedDiscoveryRoots(), ...EXTRA_PROJECTS.map((x) => x.folder)].filter(plainDrivePath).map(norm);
}

// True when a process may be started in this folder.
// The real path (junctions and links followed) of something that exists, or null.
function realOf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

// True when a process may be started in this folder: an existing folder on one of the open drives (openDrives in
// .data/config.json), or inside one of the current roots.
// Both are judged on the real path, so a junction inside an allowed folder cannot lead out of it.
export function cwdAllowed(cwd) {
  if (!plainDrivePath(cwd)) return false;
  const real = realOf(cwd);
  if (!real || !plainDrivePath(real)) return false;
  try {
    if (!fs.statSync(real).isDirectory()) return false;
  } catch {
    return false;
  }
  const p = norm(real);
  if (OPEN_DRIVES.some((d) => p.startsWith(d + ':'))) return true;
  return allowedRoots().some((root) => {
    const rr = realOf(root);
    return isInside(p, rr && plainDrivePath(rr) ? norm(rr) : root);
  });
}

// True when this is one of the MCP configs runs.js writes: <run id>.json right in MCP_DIR.
// True when this is one of the local model settings files services/localModels.js writes: <model>-<effort>.json right in
// LOCAL_MODELS_DIR.
export function isLocalModelSettings(val) {
  if (!plainDrivePath(val) || path.extname(val) !== '.json' || !/^[a-z0-9][a-z0-9._-]{0,60}-(none|low|medium|xhigh)$/i.test(path.basename(val, '.json'))) return false;
  const real = realOf(val);
  const dirReal = realOf(LOCAL_MODELS_DIR);
  if (!real || !dirReal || norm(path.dirname(real)) !== norm(dirReal)) return false;
  try {
    return fs.statSync(real).isFile();
  } catch {
    return false;
  }
}

export function isMcpConfig(val) {
  if (!plainDrivePath(val) || !isUuid(path.basename(val, '.json')) || path.extname(val) !== '.json') return false;
  const real = realOf(val);
  const dirReal = realOf(MCP_DIR);
  if (!real || !dirReal || norm(path.dirname(real)) !== norm(dirReal)) return false;
  try {
    return fs.statSync(real).isFile();
  } catch {
    return false;
  }
}

// True when this is a system prompt file the server writes itself: the persona prompt, or a prompt shipped in server\prompts.
export function isPromptFile(val) {
  if (!plainDrivePath(val)) return false;
  const real = realOf(val);
  if (!real || !plainDrivePath(real)) return false;
  const p = norm(real);
  const dirReal = realOf(PROMPTS_DIR);
  const ok = p === norm(realOf(PERSONA_SYSTEM_FILE) || PERSONA_SYSTEM_FILE) || (path.dirname(p) === norm(dirReal || PROMPTS_DIR) && p.endsWith('.md'));
  if (!ok) return false;
  try {
    return fs.statSync(real).isFile();
  } catch {
    return false;
  }
}
