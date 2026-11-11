// The notes vaults on the hub (design/notes-spec.md): the mirror of each vault a machine owns, one git repo per machine and
// vault. services/notesSync.js is the owner's side. A machine reaches only its own vaults, with git itself, over git's
// smart HTTP protocol (git http-backend run as a CGI program), as a paired device:
//
//   GET  /api/hub/git/:repo/info/refs?service=...    what the hub has
//   POST /api/hub/git/:repo/git-upload-pack          fetch
//   POST /api/hub/git/:repo/git-receive-pack         push
//
// A repo is made on first use. It keeps its files checked out (receive.denyCurrentBranch updateInstead): a push updates
// them, so the hub can show and edit the notes while their machine is off. An edit made on the hub is committed before
// any fetch or push, so the owner picks it up and a push never meets files the hub changed.
//
//   .data/hub/notes/<machine id>/<repo>/
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { run } from '../lib/run.js';
import { saveNote } from '../lib/noteText.js';

const NOTES_DIR = path.join(DATA_DIR, 'hub', 'notes');
const REPO_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);
export const AUTHOR = ['-c', 'user.name=Accent Studio', '-c', 'user.email=163078986+Accent-Studio@users.noreply.github.com'];

const fail = (status, message) => Object.assign(new Error(message), { status });
const machineDir = (m) => path.join(NOTES_DIR, String(m.id).replace(/[^A-Za-z0-9_-]/g, '_'));
export const repoDir = (m, repo) => (REPO_RE.test(repo) ? path.join(machineDir(m), repo) : null);

const git = (dir, args, opts = {}) => run('git', ['-C', dir, ...args], { timeoutMs: 60e3, ...opts });

// One change at a time per repo: a push, a fetch and an edit on the hub wait for each other.
const queues = new Map();
function serial(dir, fn) {
  const prev = queues.get(dir) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(dir, next.catch(() => {}));
  return next;
}

async function ensureRepo(dir) {
  if (fs.existsSync(path.join(dir, '.git'))) return;
  fs.mkdirSync(dir, { recursive: true });
  const steps = [
    ['init', '-q'],
    ['config', 'receive.denyCurrentBranch', 'updateInstead'],
    ['config', 'http.receivepack', 'true'],
    ['config', 'core.autocrlf', 'false'],
    ['config', 'core.quotepath', 'false'],
  ];
  for (const a of steps) {
    const r = await git(dir, a);
    if (r.code !== 0) throw fail(500, `git ${a[0]} failed on the hub: ${r.stderr.trim()}`);
  }
}

// Commits what was edited on the hub itself, if anything.
export async function commitHubEdits(dir, message = 'Edited on the hub') {
  const st = await git(dir, ['status', '--porcelain']);
  if (st.code !== 0 || !st.stdout.trim()) return false;
  await git(dir, ['add', '-A']);
  const r = await git(dir, [...AUTHOR, 'commit', '-q', '-m', message]);
  return r.code === 0;
}

// After a push the files match the new commit. The first push into a new repo names its branch, and git does not check
// out an unborn branch on its own. The hub's own edits were committed before the push, so nothing is lost here.
async function settleHead(dir) {
  const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.code !== 0) {
    const heads = (await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout.split('\n').filter(Boolean);
    if (!heads.length) return;
    const pick = heads.includes('main') ? 'main' : heads.includes('master') ? 'master' : heads[0];
    await git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/' + pick]);
  }
  await git(dir, ['reset', '-q', '--hard']);
}

// Answers one git request from machine `m` for its repo `repo`; `rest` is "info/refs" or a service name.
export async function serveGit(req, res, m, repo, rest, url) {
  const dir = repoDir(m, repo);
  if (!dir) throw fail(400, 'A repo name is lower case letters, digits and dashes');
  const service = rest === 'info/refs' ? url.searchParams.get('service') : rest;
  if (!SERVICES.has(service)) throw fail(403, 'Only the smart git protocol is served');
  await ensureRepo(dir);
  const work = async () => {
    if (rest !== 'info/refs') await commitHubEdits(dir);
    try {
      await cgi(req, res, dir, rest, url);
      // the files are in place before the pusher hears it is done
      if (service === 'git-receive-pack' && rest !== 'info/refs') await settleHead(dir);
    } finally {
      if (res.headersSent) res.end();
    }
  };
  // the ref list is only read; fetch and push take their turn
  return rest === 'info/refs' ? work() : serial(dir, work);
}

// ---- Reading another machine's notes (the other PCs and the phones, from the mirror) ----
//
// A vault says which of its top folders stay off the other PCs in .mc-notes.json at its root: { "homeOnly": ["Visa"] }.
// The owner and the phones see them; another PC does not. The file travels with the vault, so the hub reads it here.

const LIST_MAX = 5000;

// The mirror of `owner`'s vault `repo`, `owner` a machine name ("Home") or id: { dir, id, name } or null.
export function mirrorOf(owner, repo, nameOf) {
  if (!REPO_RE.test(repo)) return null;
  let ids;
  try {
    ids = fs.readdirSync(NOTES_DIR);
  } catch {
    return null;
  }
  const want = String(owner || '').toLowerCase();
  for (const id of ids) {
    const name = nameOf(id) || id;
    if (id.toLowerCase() !== want && name.toLowerCase() !== want) continue;
    const dir = path.join(NOTES_DIR, id, repo);
    if (fs.existsSync(path.join(dir, '.git'))) return { dir, id, name };
  }
  return null;
}

// A machine that keeps a vault here is a PC (a phone never has one).
export const ownsVault = (m) => m.id !== 'hub' && fs.existsSync(machineDir(m));

function homeOnly(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, '.mc-notes.json'), 'utf8'));
    return new Set((Array.isArray(v.homeOnly) ? v.homeOnly : []).filter((s) => typeof s === 'string').map((s) => s.toLowerCase()));
  } catch {
    return new Set();
  }
}

// A path inside the mirror the caller may read, as an absolute path, or null.
function readable(mirror, caller, rel, { isPc }) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = clean ? clean.split('/') : [];
  if (parts.some((p) => p === '..' || p === '.git' || p.includes('\0'))) return null;
  if (parts.length && caller.id !== mirror.id && isPc(caller) && homeOnly(mirror.dir).has(parts[0].toLowerCase())) return null;
  const abs = path.resolve(mirror.dir, ...parts);
  if (abs !== mirror.dir && !abs.startsWith(mirror.dir + path.sep)) return null;
  return abs;
}

// Every file under `folder` of the mirror: { files: [{ path, size, mtime }], cut }, paths relative to `folder`.
export async function listNotes(mirror, caller, folder, opts) {
  const base = readable(mirror, caller, folder, opts);
  if (!base) throw fail(403, 'That folder is not shared with this computer');
  const hidden = caller.id !== mirror.id && opts.isPc(caller) && !String(folder || '').replace(/^[\\/]+/, '') ? homeOnly(mirror.dir) : new Set();
  const files = [];
  async function go(dir, rel, depth) {
    if (depth > 12 || files.length >= LIST_MAX) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.obsidian' || e.name === '.trash') continue;
      if (!rel && hidden.has(e.name.toLowerCase())) continue;
      const p = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await go(p, r, depth + 1);
      else if (e.isFile() && files.length < LIST_MAX) {
        const st = await fs.promises.stat(p).catch(() => null);
        if (st) files.push({ path: r, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  }
  await go(base, '', 0);
  return { owner: mirror.name, files, cut: files.length >= LIST_MAX };
}

// One file of the mirror, for reading: { file, size } or a 403/404.
export function noteFile(mirror, caller, rel, opts) {
  const abs = readable(mirror, caller, rel, opts);
  if (!abs || !String(rel || '').trim()) throw fail(403, 'That file is not shared with this computer');
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw fail(404, 'No such note');
  }
  if (!st.isFile()) throw fail(404, 'No such note');
  return { file: abs, size: st.size };
}

// An edit of one note of the mirror, made from another machine while the owner is off: written and committed at once, in
// turn with the owner's fetches and pushes, so its next sync takes it. { hash } or { conflict, text, hash }.
export function editNote(mirror, caller, rel, edit, opts) {
  const abs = readable(mirror, caller, rel, opts);
  const parts = String(rel || '').replace(/\\/g, '/').split('/');
  if (!abs || !String(rel || '').trim() || parts.some((p) => p.startsWith('.'))) throw fail(403, 'That file is not shared with this computer');
  return serial(mirror.dir, async () => {
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      throw fail(404, 'No such note');
    }
    if (!st.isFile()) throw fail(404, 'No such note');
    const r = saveNote(abs, edit.text, edit.base);
    if (!r.conflict) await commitHubEdits(mirror.dir, `Edited on ${opts.nameOf(caller) || 'another device'} (the hub's copy): ${parts.join('/')}`);
    return r;
  });
}

function cgi(req, res, dir, rest, url) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: path.dirname(dir),
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: '/' + path.basename(dir) + '/' + rest,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.replace(/^\?/, ''),
      CONTENT_TYPE: req.headers['content-type'] || '',
      REMOTE_USER: 'mission-control',
      REMOTE_ADDR: '127.0.0.1',
    };
    if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol'];
    const p = spawn('git', ['http-backend'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let head = Buffer.alloc(0);
    let started = false;
    let errText = '';
    p.stderr.on('data', (d) => (errText = (errText + d).slice(-2000)));
    p.stdout.on('data', (chunk) => {
      if (started) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      let end = head.indexOf('\r\n\r\n');
      let sep = 4;
      if (end < 0) {
        end = head.indexOf('\n\n');
        sep = 2;
      }
      if (end < 0) return;
      let status = 200;
      const headers = { 'Cache-Control': 'no-store' };
      for (const line of head.subarray(0, end).toString('latin1').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 500;
        else headers[k] = v;
      }
      started = true;
      res.writeHead(status, headers);
      const body = head.subarray(end + sep);
      if (body.length) res.write(body);
    });
    p.on('error', (err) => reject(fail(500, 'git is not installed on the hub: ' + err.message)));
    p.on('close', (code) => {
      if (!started) {
        if (errText) console.error('[notes-hub]', errText.trim());
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.write('git http-backend failed');
      }
      if (code !== 0 && errText) console.error('[notes-hub]', errText.trim());
      resolve();
    });
    req.pipe(p.stdin);
    p.stdin.on('error', () => {}); // git closed its input early (an error answer)
  });
}
