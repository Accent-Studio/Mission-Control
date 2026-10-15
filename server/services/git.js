// Read-only git helpers. Only queries are issued here: never fetch, pull, commit or write.
//
// Every call goes through git() below, which adds:
//   --no-optional-locks   status must not refresh .git/index while the user is committing
//   core.fsmonitor=false  status must not start a background file watcher
// and never uses a shell. Revision names that come from the catalog are checked so they cannot be read as options.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/run.js';

const GIT_TIMEOUT_MS = 10000;
const SEP = '\u001f';
const MAX_PARALLEL = Number(process.env.MC_GIT_PARALLEL) || 6;

// Windows starts a process slowly, so a dozen at once only makes each of them slower.
let active = 0;
const waiting = [];
function slot() {
  if (active < MAX_PARALLEL) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

async function git(folder, args, timeoutMs = GIT_TIMEOUT_MS) {
  await slot();
  try {
    const r = await run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', folder, ...args], {
      timeoutMs,
    });
    return r.code === 0 ? r.stdout : null;
  } finally {
    release();
  }
}

// A ref or branch name taken from the catalog or from git output. Never starts with "-".
function safeRef(name) {
  const s = String(name || '').trim();
  return s && !s.startsWith('-') && !/[\s\u0000-\u001f~^:?*[\\]/.test(s) ? s : null;
}

export function isRepo(folder) {
  try {
    return fs.existsSync(path.join(folder, '.git'));
  } catch {
    return false;
  }
}

// One call for branch, uncommitted count and the upstream comparison.
// { branch, sha, dirty, upstream, ahead, behind }, or null when git did not answer.
// branch is a name, "detached at <sha>", or null (no commits yet shows as the unborn branch name).
export async function status(folder) {
  // Every new file counts, not one per new folder, so the count matches the Commits tab list.
  const out = await git(folder, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
  if (out === null) return null;
  const info = { branch: null, sha: null, dirty: 0, upstream: null, ahead: null, behind: null };
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    if (!line.startsWith('#')) {
      info.dirty++;
      continue;
    }
    const [, key, ...rest] = line.trim().split(' ');
    const val = rest.join(' ');
    if (key === 'branch.oid') info.sha = val === '(initial)' ? null : val;
    else if (key === 'branch.head') info.branch = val === '(detached)' ? null : val;
    else if (key === 'branch.upstream') info.upstream = val;
    else if (key === 'branch.ab') {
      const m = /^\+(\d+) -(\d+)$/.exec(val);
      if (m) {
        info.ahead = Number.parseInt(m[1], 10);
        info.behind = Number.parseInt(m[2], 10);
      }
    }
  }
  if (!info.branch && info.sha) info.branch = `detached at ${info.sha.slice(0, 7)}`;
  return info;
}

// True when the repository's config names no remote at all. A plain file read, so it costs no process.
// Unknown layouts (worktrees, submodules) report false and fall through to git itself.
function hasNoRemote(folder) {
  try {
    const gitDir = path.join(folder, '.git');
    if (!fs.statSync(gitDir).isDirectory()) return false;
    return !/^\s*\[remote /m.test(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'));
  } catch {
    return false;
  }
}

async function remoteBranches(folder) {
  const out = await git(folder, ['for-each-ref', '--format=%(refname)', 'refs/remotes']);
  if (out === null) return null;
  const names = new Set();
  for (const l of out.split('\n')) {
    const n = l.trim().replace(/^refs\/remotes\//, '');
    if (n && !n.endsWith('/HEAD')) names.add(n);
  }
  return names;
}

async function countAgainst(folder, ref) {
  const name = safeRef(ref);
  if (!name) return null;
  const out = await git(folder, ['rev-list', '--left-right', '--count', `${name}...HEAD`, '--']);
  if (out === null) return null;
  const [behind, ahead] = out.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { remote: name, ahead, behind };
}

// { remote, ahead, behind } or null when there is nothing to compare with.
// The ref that stands for "pushed": the catalog's remote if it exists, then the branch's upstream
// (already counted by status), then origin/<branch>, origin/main, origin/master.
// At most two processes: one to list the remote branches, one to count.
export async function aheadBehind(folder, configured, st) {
  if (!st || !st.sha) return null; // git did not answer, or there are no commits yet
  if (hasNoRemote(folder)) return null;
  const want = String(configured || '').trim();
  if (want && st.upstream === want && st.ahead !== null) {
    return { remote: want, ahead: st.ahead, behind: st.behind };
  }
  const remotes = await remoteBranches(folder);
  if (!remotes) return null;
  if (want && remotes.has(want)) return countAgainst(folder, want);
  if (st.upstream && st.ahead !== null) return { remote: st.upstream, ahead: st.ahead, behind: st.behind };
  const candidates = [];
  if (st.branch && !st.branch.startsWith('detached')) candidates.push(`origin/${st.branch}`);
  candidates.push('origin/main', 'origin/master');
  const pick = candidates.find((c) => remotes.has(c));
  return pick ? countAgainst(folder, pick) : null;
}

function parseCommits(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [hash, subject, date, author] = l.split(SEP);
      return { hash, subject, date, author };
    });
}

// Last N commits on HEAD, optionally limited to watch pathspecs.
export async function log(folder, count = 15, watch = []) {
  const n = Math.max(1, Math.min(200, Number.parseInt(count, 10) || 15));
  const args = ['log', `-${n}`, `--format=%H${SEP}%s${SEP}%cI${SEP}%an`, 'HEAD', '--'];
  if (watch.length) args.push(...watch);
  const out = await git(folder, args);
  return out === null ? [] : parseCommits(out);
}

export async function lastCommit(folder, watch = []) {
  return (await log(folder, 1, watch))[0] || null;
}

const MAX_FILES = 300;
const STATE = { A: 'new', '?': 'new', M: 'changed', T: 'changed', D: 'deleted', R: 'renamed', C: 'new', U: 'conflict' };

// "add\tdel\tpath\0", or for a rename "add\tdel\t\0from\0to\0". Binary files give "-" and count as null.
function parseNumstat(text) {
  const map = new Map();
  const parts = (text || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let file = m[3];
    if (!file) {
      file = parts[i + 2];
      i += 2;
    }
    if (file) map.set(file, { add: m[1] === '-' ? null : Number(m[1]), del: m[2] === '-' ? null : Number(m[2]) });
  }
  return map;
}

// A new file's line count, read only when it is small text (a new file has no diff to count from).
function newFileLines(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return null;
    if (!buf.length) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch {
    return null;
  }
}

// Uncommitted files, newest edit first: { files: [{ path, from, state, add, del, mtime }], total }.
// state is new, changed, deleted, renamed or conflict. Null when git did not answer.
export async function changes(folder) {
  const [st, num] = await Promise.all([
    git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(folder, ['diff', '--numstat', '-z', '-M', 'HEAD', '--']),
  ]);
  if (st === null) return null;
  const counts = parseNumstat(num);
  const files = [];
  const parts = st.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const file = e.slice(3);
    let from = null;
    if (/[RC]/.test(xy)) from = parts[++i] || null;
    const code = xy.includes('U') || xy === 'AA' || xy === 'DD' ? 'U' : xy[0] !== ' ' && xy[0] !== '?' ? xy[0] : xy[1];
    files.push({ path: file, from, state: STATE[code] || 'changed' });
  }
  const total = files.length;
  for (const f of files) {
    const abs = path.join(folder, f.path);
    let mtime = null;
    try {
      mtime = fs.statSync(abs).mtime.toISOString();
    } catch {}
    f.mtime = mtime;
  }
  files.sort((a, b) => (Date.parse(b.mtime) || 0) - (Date.parse(a.mtime) || 0));
  const shown = files.slice(0, MAX_FILES);
  for (const f of shown) {
    const c = counts.get(f.path);
    if (c) Object.assign(f, c);
    else if (f.state === 'new') Object.assign(f, { add: newFileLines(path.join(folder, f.path)), del: 0 });
    else Object.assign(f, { add: null, del: null });
  }
  return { files: shown, total };
}

// The files one commit touched: { files: [{ path, from, state, add, del }], total }, or null.
export async function commitFiles(folder, hash) {
  if (!/^[0-9a-f]{7,40}$/i.test(String(hash || ''))) return null;
  const [names, num] = await Promise.all([
    git(folder, ['show', '--format=', '--name-status', '-z', '-M', '--first-parent', hash, '--']),
    git(folder, ['show', '--format=', '--numstat', '-z', '-M', '--first-parent', hash, '--']),
  ]);
  if (names === null) return null;
  const counts = parseNumstat(num);
  const files = [];
  const parts = names.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    let from = null;
    let file = parts[++i];
    if (code[0] === 'R' || code[0] === 'C') {
      from = file;
      file = parts[++i];
    }
    if (!file) continue;
    files.push({ path: file, from, state: STATE[code[0]] || 'changed', ...(counts.get(file) || { add: null, del: null }) });
  }
  return { files: files.slice(0, MAX_FILES), total: files.length };
}

// The changes of one file, as unified diff text, for the project page reader. With a hash: what that commit changed in
// the file. Without: what is not committed yet (against HEAD; a new file not yet added shows whole). The path is a repo
// path from the Commits tab; it may not start with "-", climb out with "..", or reach into .git. Capped at DIFF_MAX.
const DIFF_MAX = 400 * 1024;
export async function fileDiff(folder, rel, hash = null) {
  const p = String(rel || '');
  // The same names the file route never serves (secrets folders, .env files) and .git itself; no glob characters either.
  // Every git call below also reads the path literally (--literal-pathspecs), so "*" or ".e*" never match other files.
  if (!p || p.length > 1024 || /^[-\\/]|[\0:*?[\]\\]/.test(p.replace(/\\/g, '/')) || bannedPath(p)) return null;
  if (hash !== null && !/^[0-9a-f]{7,40}$/i.test(String(hash))) return null;
  const L = '--literal-pathspecs';
  let out;
  if (hash) {
    // only a commit (a blob or tree id would print other content), and only a path that is one file in it or its parent
    if (String(await git(folder, ['cat-file', '-t', hash])).trim() !== 'commit') return null;
    if (!(await isBlob(folder, hash, p)) && !(await isBlob(folder, hash + '^', p))) return null;
    out = await git(folder, [L, 'show', '--format=', '--no-color', '-M', '--first-parent', hash + '^{commit}', '--', p]);
  } else {
    const onDisk = realFileIn(folder, p);
    if (!onDisk && !(await isBlob(folder, 'HEAD', p))) return null; // one file, here now or deleted since HEAD
    if (!onDisk && !noLinkOnTheWay(folder, p)) return null; // git would read the working tree through a linked folder
    out = await git(folder, [L, 'diff', '--no-color', '-M', 'HEAD', '--', p]);
    if ((out === '' || out === null) && onDisk) {
      // not tracked yet: show it as a new file (only when git does not ignore it)
      const st = await git(folder, [L, 'ls-files', '--others', '--exclude-standard', '-z', '--', p]);
      if (st && st.split('\0').includes(p)) out = newFileDiff(onDisk, p);
      else if (!(await isBlob(folder, 'HEAD', p))) return null; // ignored: not shown at all
    }
  }
  if (out === null) return null;
  const cut = out.length > DIFF_MAX;
  return { path: p, hash: hash || null, diff: cut ? out.slice(0, DIFF_MAX) : out, cut };
}

const bannedPath = (p) => p.split(/[\\/]/).some((s) => s === '..' || /^(\.git|\.svn|\.hg|\.ssh|\.aws|\.gnupg|node_modules)$|^\.env/i.test(s));

// true when <rev>:<path> names a file (a blob) in git
async function isBlob(folder, rev, p) {
  return String(await git(folder, ['cat-file', '-t', `${rev}:${p}`])).trim() === 'blob';
}

// The real path of a regular file inside the folder, or null. The real path must be the asked path itself (no link or
// junction on the way, same letters apart from case), so an alias can never reach a banned or ignored place.
function realFileIn(folder, p) {
  try {
    const root = fs.realpathSync.native(folder);
    const real = fs.realpathSync.native(path.join(root, p));
    const inside = path.relative(root, real);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
    if (inside.replace(/\\/g, '/').toLowerCase() !== p.replace(/\\/g, '/').toLowerCase() || bannedPath(inside)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

// Every part of the path that exists on disk is a plain folder or file at the place its name says (no symlink or
// junction), so a missing or deleted file is never read from somewhere else through a linked parent folder.
function noLinkOnTheWay(folder, p) {
  try {
    const root = fs.realpathSync.native(folder);
    const segs = p.split(/[\\/]+/).filter(Boolean);
    for (let i = 1; i <= segs.length; i++) {
      const want = path.join(root, ...segs.slice(0, i));
      let st;
      try {
        st = fs.lstatSync(want);
      } catch {
        return true; // nothing further exists: nothing to follow
      }
      if (st.isSymbolicLink()) return false;
      const real = fs.realpathSync.native(want); // a junction is not a symlink to lstat, but realpath sees where it goes
      if (real.toLowerCase() !== want.toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// A file git does not track yet (real: its checked real path), written as an all-added diff.
function newFileDiff(real, p) {
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return null;
    const fd = fs.openSync(real, 'r');
    let buf;
    try {
      buf = Buffer.alloc(Math.min(st.size, DIFF_MAX));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (buf.includes(0)) return `new file ${p}\nBinary file, not shown\n`;
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return `new file ${p}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n') + '\n';
  } catch {
    return null;
  }
}

// Tracked files plus new files that are not ignored, as absolute paths.
export async function sourceFiles(folder, watch = []) {
  const specs = watch.length ? watch : ['.'];
  const out = await git(
    folder,
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...specs],
    30000,
  );
  if (out === null) return null;
  const seen = new Set();
  const files = [];
  for (const rel of out.split('\0')) {
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    files.push(path.join(folder, rel));
  }
  return files;
}
