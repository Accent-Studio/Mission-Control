// Local paths that Claude writes in a conversation ("D:\x\notes.md", `server/config.js:12`), opened from a link: a text
// file is read for the page's viewer, a folder or any other file is shown in Windows Explorer.
//
// Safety: only an absolute local path on a drive letter is ever used (never a network path, which would make Windows
// send the user's credentials to another machine). Reading is limited to the places Mission Control already works in
// (the discovery roots, the project folders, the notes folder, the open drives and Claude's own folder), never a
// blocked name (.git, .ssh, .env, keys and secrets), only text, and at most READ_MAX bytes. Both checks run on the
// path as written and again on the real path, so a link or junction cannot lead out. Explorer is started with an
// argument array and no shell.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLAUDE_HOME, DATA_DIR, DEFAULT_CWD, DISCOVERY_ROOTS, EXTRA_PROJECTS, NOTES_ROOT, OPEN_DRIVES, ROOT } from '../config.js';
import { loadCatalog } from './catalog.js';

const RAISE_SCRIPT = path.join(ROOT, 'server', 'scripts', 'raise-explorer.ps1');

export const READ_MAX = 2 * 1024 * 1024;
const SNIFF = 8192;
const BLOCKED_SEGMENT = /^(\.git|\.svn|\.hg|\.ssh|\.aws|\.gnupg|\.azure|\.kube)$|^\.env|secret|^id_(rsa|ed25519|ecdsa)|\.(pem|key|pfx|p12|jks|keystore)$|^keystore\.properties$/i;
const BAD_CHARS = /[\u0000-\u001f<>"|?*]/;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
// Files shown in the viewer as Markdown; any other text file is shown as plain text.
const MARKDOWN = /\.(md|markdown|mdx)$/i;

const fail = (status, message) => Object.assign(new Error(message), { status });
const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const isInside = (p, root) => p === root || p.startsWith(root + path.sep);

function realOf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

// The folders reading is allowed in, normalized, real paths included.
function readRoots() {
  const list = [DEFAULT_CWD, ...DISCOVERY_ROOTS, ...EXTRA_PROJECTS.map((x) => x.folder), NOTES_ROOT, CLAUDE_HOME];
  try {
    for (const p of loadCatalog()) if (p && typeof p.folder === 'string') list.push(p.folder);
  } catch {
    // no catalog: the configured roots still apply
  }
  const out = new Set();
  for (const r of list) {
    if (typeof r !== 'string' || !DRIVE_PATH.test(r)) continue;
    out.add(norm(r));
    const real = realOf(r);
    if (real) out.add(norm(real));
  }
  return [...out];
}

// Mission Control's own secrets (runner and bridge keys) stay out of the viewer even when its folder is a project.
function inPrivateData(p) {
  const d = norm(DATA_DIR);
  return ['runner', 'bridge', 'devices', 'uploads'].some((s) => isInside(p, path.join(d, s))) || /secret|\.key$/i.test(path.basename(p));
}

function readAllowed(abs) {
  const p = norm(abs);
  if (inPrivateData(p)) return false;
  if (OPEN_DRIVES.some((d) => p.startsWith(d + ':'))) return true;
  return readRoots().some((root) => isInside(p, root));
}

// "path:12" or "path:12:5" (a line, and a column) is the file itself.
function stripLine(p) {
  return p.replace(/:\d+(?::\d+)?$/, '');
}

// Turns what the link carries into an absolute path, or throws a 400. base: the conversation's folder, for a relative path.
export function resolvePath(raw, base) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) throw fail(400, 'No path');
  let p = stripLine(raw.trim().replace(/^file:\/\/\/?/i, ''));
  if (BAD_CHARS.test(p.slice(2)) || /^[\\/]{2}/.test(p)) throw fail(400, 'Not a local path');
  if (!DRIVE_PATH.test(p)) {
    if (/^[\\/]/.test(p) || typeof base !== 'string' || !DRIVE_PATH.test(base) || BAD_CHARS.test(base.slice(2))) {
      throw fail(400, 'This path has no folder to start from');
    }
    p = path.join(base, p);
  }
  p = path.resolve(p);
  if (!DRIVE_PATH.test(p)) throw fail(400, 'Not a local path');
  return p;
}

// The relative part of what a link carries ("docs/plan.md" from "docs/plan.md:12"), or null when it is absolute.
function relativeOf(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) throw fail(400, 'No path');
  const p = stripLine(raw.trim().replace(/^file:\/\/\/?/i, ''));
  if (DRIVE_PATH.test(p)) return null;
  if (/^[\\/]/.test(p) || BAD_CHARS.test(p) || /(^|[\\/])\.\.([\\/]|$)/.test(p)) throw fail(400, 'Not a local path');
  return p;
}
const goodBase = (b) => typeof b === 'string' && DRIVE_PATH.test(b) && !BAD_CHARS.test(b.slice(2));

// Project folders that hold this relative path, those inside the conversation's folder first (a conversation in a parent
// folder often names a file of one of its projects). At most 12: { path, project }.
function projectMatches(rel, base) {
  const folders = [];
  try {
    for (const p of loadCatalog()) if (p && typeof p.folder === 'string' && DRIVE_PATH.test(p.folder)) folders.push({ folder: p.folder, name: p.name || p.id });
  } catch {
    // no catalog
  }
  for (const x of EXTRA_PROJECTS) folders.push({ folder: x.folder, name: x.name });
  const b = goodBase(base) ? norm(base) : null;
  folders.sort((x, y) => (b && isInside(norm(y.folder), b) ? 1 : 0) - (b && isInside(norm(x.folder), b) ? 1 : 0));
  const out = [];
  const seen = new Set();
  for (const f of folders) {
    const abs = path.resolve(f.folder, rel);
    const key = norm(abs);
    if (seen.has(key) || !isInside(key, norm(f.folder))) continue;
    seen.add(key);
    if (fs.existsSync(abs)) out.push({ path: abs, project: f.name });
    if (out.length >= 12) break;
  }
  return out;
}

// What a path is: { path, kind: 'file' | 'folder' | 'missing' | 'choice', name, size, view: 'markdown' | 'text' | null,
// readable }. A relative path that is not in the base folder is looked for in the project folders: one match is used,
// several come back as kind 'choice' with { choices: [{ path, project }] } for the page to offer.
export function pathInfo(raw, base) {
  const rel = relativeOf(raw);
  if (rel === null) return describe(resolvePath(raw, base));
  const here = goodBase(base) ? describe(path.resolve(base, rel)) : null;
  if (here && here.kind !== 'missing') return here;
  const found = projectMatches(rel, base);
  if (found.length === 1) return describe(found[0].path);
  if (found.length > 1) return { path: rel, name: path.basename(rel) || rel, kind: 'choice', choices: found, size: 0, view: null, readable: false };
  if (here) return here;
  throw fail(404, 'Not found in this conversation\'s folder or in any project');
}

function describe(abs) {
  const out = { path: abs, name: path.basename(abs) || abs, kind: 'missing', size: 0, view: null, readable: false };
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return out;
  }
  out.kind = st.isDirectory() ? 'folder' : st.isFile() ? 'file' : 'missing';
  if (out.kind !== 'file') return out;
  out.size = st.size;
  const real = realOf(abs);
  const segs = (real || abs).split(/[\\/]+/);
  out.readable = !!real && readAllowed(abs) && readAllowed(real) && !segs.some((s) => BLOCKED_SEGMENT.test(s)) && st.size <= READ_MAX;
  if (out.readable && isText(real)) out.view = MARKDOWN.test(abs) ? 'markdown' : 'text';
  return out;
}

function isText(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(SNIFF);
    const n = fs.readSync(fd, buf, 0, SNIFF, 0);
    return !buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The text of a viewable file, or throws (403 outside the allowed places, 404 missing, 415 not text).
export function readPathText(raw, base) {
  const info = pathInfo(raw, base);
  if (info.kind === 'missing') throw fail(404, 'Not found');
  if (info.kind === 'choice') throw fail(409, 'Several projects have this file');
  if (info.kind !== 'file') throw fail(415, 'Not a file');
  if (!info.readable) throw fail(403, 'Mission Control only opens files inside your project folders');
  if (!info.view) throw fail(415, 'Not a text file');
  return { ...info, text: fs.readFileSync(realOf(info.path) || info.path, 'utf8').replace(/^\uFEFF/, '') };
}

// Shows a folder, or a file selected in its folder, in Windows Explorer. MC_NO_EXPLORER=1 (tests) only reports it.
export function revealPath(raw, base) {
  const info = pathInfo(raw, base);
  if (info.kind === 'missing') throw fail(404, 'Not found');
  if (info.kind === 'choice') throw fail(409, 'Several projects have this path');
  // Written out verbatim in the form Explorer documents (explorer /select,"C:\a b\c.txt"); the path can hold no quote (BAD_CHARS).
  const arg = info.kind === 'folder' ? `"${info.path}"` : `/select,"${info.path}"`;
  if (process.env.MC_NO_EXPLORER !== '1') {
    const child = spawn('explorer.exe', [arg], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true });
    child.on('error', () => {});
    child.unref();
    // Explorer opens behind the browser, because the server is a background program: a helper brings it to the front.
    const dir = info.kind === 'folder' ? info.path : path.dirname(info.path);
    const raise = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RAISE_SCRIPT], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, MC_REVEAL_DIR: dir },
    });
    raise.on('error', () => {});
    raise.unref();
  }
  return { ok: true, path: info.path, kind: info.kind };
}
