// Keeps the notes vaults this machine owns in step with their mirror on the hub (design/notes-spec.md;
// services/notesHub.js is the hub side). Each vault is a git repo listed in .data/config.json as notesRepos.
//
//   saving    a change on disk (Obsidian, Mission Control, Claude) becomes a commit once nothing changed for IDLE_MS
//   syncing   after each commit, and every PULL_MS: fetch the hub's copy, merge it, push the result
//   conflict  the same lines changed on both sides: this machine's version stays in the note, the hub's goes next to it
//             as "<note> (conflict from the hub <date>).md", and the sync carries on
//   no hub    the commits wait, and go up at the next sync that reaches it
//
// The hub is reached with git itself, through the same link as services/hubSync.js (its headers go in http.extraHeader).
// MC_NOTES_DEBUG=1 logs every git command it runs (without the headers).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { MACHINE_NAME, NOTES_REPOS, ROLE } from '../config.js';
import { publish } from '../lib/events.js';
import { hubLink } from './hubSync.js';

const IDLE_MS = Number(process.env.MC_NOTES_IDLE_MS) > 0 ? Number(process.env.MC_NOTES_IDLE_MS) : 10e3;
const PULL_MS = Number(process.env.MC_NOTES_PULL_MS) > 0 ? Number(process.env.MC_NOTES_PULL_MS) : 60e3;
const TIMEOUT_MS = 10 * 60e3; // the first push of a big vault takes a while
const CONFLICTS_KEPT = 20;

function git(dir, args, { buffer = false, timeoutMs = 60e3 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-C', dir, ...args], {
      timeout: timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      encoding: buffer ? 'buffer' : 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }, (err, stdout, stderr) => {
      if (process.env.MC_NOTES_DEBUG) console.log('[notes-dbg]', args.filter((a) => !/extraHeader/.test(a)).join(' '), err ? err.code : 0, String(stderr).slice(0, 300));
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr: String(stderr || (err && err.message) || '') });
    });
  });
}

// The hub's address for a repo, and the -c options that carry the link's headers.
function remote(id) {
  const l = hubLink();
  if (!l) return null;
  const opts = ['-c', 'credential.helper=', '-c', 'http.postBuffer=1073741824'];
  for (const [k, v] of Object.entries({ ...l.headers, 'X-MC': '1' })) opts.push('-c', `http.extraHeader=${k}: ${v}`);
  return { url: `${l.url}/api/hub/git/${id}`, opts };
}

const repos = new Map(); // id -> { id, dir, branch, state, lastSync, lastError, conflicts, timer, busy, again, watcher }

export function notesSyncStatus() {
  return {
    machine: MACHINE_NAME,
    repos: [...repos.values()].map((r) => ({ id: r.id, dir: r.dir, branch: r.branch, state: r.state, lastSync: r.lastSync, lastError: r.lastError, conflicts: r.conflicts })),
  };
}
const changed = () => publish('notes-sync', notesSyncStatus());

function setState(r, state, error = null) {
  r.state = state;
  if (error) r.lastError = `${new Date().toISOString()} ${error}`;
  changed();
}

async function branchOf(r) {
  const b = await git(r.dir, ['symbolic-ref', '--short', 'HEAD']);
  return b.code === 0 ? b.stdout.trim() : null;
}

async function busyByHand(r) {
  const gd = path.join(r.dir, '.git');
  return ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].some((f) => fs.existsSync(path.join(gd, f)));
}

async function commitAll(r) {
  const st = await git(r.dir, ['status', '--porcelain', '-z']);
  if (st.code !== 0) throw new Error('git status failed: ' + st.stderr.trim());
  const files = st.stdout.split('\0').filter(Boolean).map((l) => l.slice(3));
  if (!files.length) return false;
  const add = await git(r.dir, ['add', '-A']);
  if (add.code !== 0) throw new Error('git add failed: ' + add.stderr.trim());
  const what = files.length === 1 ? files[0] : `${files.length} files`;
  const c = await git(r.dir, ['commit', '-q', '--no-verify', '-m', `Saved on ${MACHINE_NAME}: ${what}`]);
  if (c.code !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) throw new Error('git commit failed: ' + c.stderr.trim());
  return true;
}

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
function conflictName(rel) {
  const ext = path.posix.extname(rel);
  return `${rel.slice(0, rel.length - ext.length)} (conflict from the hub ${stamp()})${ext}`;
}

// Merges the hub's commits. The same lines changed on both sides: ours stays, theirs goes next to it.
async function mergeHub(r, ref) {
  const m = await git(r.dir, ['merge', '--no-edit', '-m', `Merged the hub's changes on ${MACHINE_NAME}`, ref]);
  if (m.code === 0) return [];
  const u = await git(r.dir, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const files = u.stdout.split('\0').filter(Boolean);
  if (!files.length) {
    await git(r.dir, ['merge', '--abort']);
    throw new Error('merge failed: ' + (m.stderr || m.stdout).trim().split('\n').pop());
  }
  const kept = [];
  for (const rel of files) {
    const ours = await git(r.dir, ['show', ':2:' + rel], { buffer: true });
    const theirs = await git(r.dir, ['show', ':3:' + rel], { buffer: true });
    if (ours.code === 0 && theirs.code === 0) {
      const side = conflictName(rel);
      fs.writeFileSync(path.join(r.dir, ...side.split('/')), theirs.stdout);
      await git(r.dir, ['checkout', '--ours', '--', rel]);
      kept.push({ path: rel, copy: side, at: new Date().toISOString() });
    } else if (theirs.code === 0) {
      await git(r.dir, ['checkout', '--theirs', '--', rel]); // deleted here, changed there: keep it
    } else {
      await git(r.dir, ['checkout', '--ours', '--', rel]);
    }
  }
  await git(r.dir, ['add', '-A']);
  const c = await git(r.dir, ['commit', '-q', '--no-verify', '-m', `Merged the hub's changes on ${MACHINE_NAME} (${kept.length} conflict${kept.length === 1 ? '' : 's'} kept side by side)`]);
  if (c.code !== 0) throw new Error('merge commit failed: ' + c.stderr.trim());
  return kept;
}

async function syncOnce(r) {
  if (!fs.existsSync(path.join(r.dir, '.git'))) return setState(r, 'not a git repo', `${r.dir} is not a git repo`);
  if (await busyByHand(r)) return setState(r, 'waiting: a merge or rebase is open in this repo');
  r.branch = (await branchOf(r)) || r.branch;
  if (!r.branch) return setState(r, 'no branch', 'the repo has no branch checked out');
  await commitAll(r);
  const rem = remote(r.id);
  if (!rem) return setState(r, 'no hub');
  setState(r, 'syncing');
  const track = `refs/mc-hub/${r.branch}`;
  const f = await git(r.dir, [...rem.opts, 'fetch', '-q', '--no-tags', rem.url, `+refs/heads/${r.branch}:${track}`], { timeoutMs: TIMEOUT_MS });
  let hubHas = f.code === 0;
  if (!hubHas && !/couldn't find remote ref/i.test(f.stderr)) throw new Error('fetch failed: ' + f.stderr.trim().split('\n').pop());
  if (hubHas) {
    const behind = await git(r.dir, ['merge-base', '--is-ancestor', track, 'HEAD']);
    if (behind.code !== 0) {
      const kept = await mergeHub(r, track);
      if (kept.length) r.conflicts = [...kept, ...r.conflicts].slice(0, CONFLICTS_KEPT);
    }
    const same = await git(r.dir, ['rev-parse', 'HEAD', track]);
    const [a, b] = same.stdout.trim().split('\n');
    if (a && a === b) return done(r);
  }
  const p = await git(r.dir, [...rem.opts, 'push', '-q', '--no-verify', rem.url, `HEAD:refs/heads/${r.branch}`], { timeoutMs: TIMEOUT_MS });
  if (p.code !== 0) {
    // the hub moved on meanwhile (an edit there): the next round merges it first
    if (/rejected|fetch first|non-fast-forward/i.test(p.stderr)) {
      r.again = true;
      return setState(r, 'syncing');
    }
    // the hub link takes at most 48 MB in one request (bridge/src/forward.rs, MAX_REQUEST_BODY); git only says it hung up
    if (/remote end hung up|HTTP 413/i.test(p.stderr)) throw new Error('push failed: the change is too big for the hub link (48 MB at most at once). Commit it in smaller parts.');
    throw new Error('push failed: ' + p.stderr.trim().split('\n').pop());
  }
  await git(r.dir, ['update-ref', track, 'HEAD']);
  done(r);
}

function done(r) {
  r.lastSync = new Date().toISOString();
  setState(r, 'in step');
}

// A sync asked for while one runs makes that one go round once more, and waits for it.
function sync(r) {
  if (r.busy) {
    r.again = true;
    return r.running;
  }
  r.running = syncRounds(r);
  return r.running;
}

async function syncRounds(r) {
  r.busy = true;
  try {
    for (let i = 0; i < 3; i++) {
      r.again = false;
      try {
        await syncOnce(r);
      } catch (err) {
        setState(r, 'failed', err.message);
      }
      if (!r.again) break;
    }
  } finally {
    r.busy = false;
    r.quietUntil = Date.now() + 1000; // our own merge and checkout touched the files
  }
}

function soon(r, ms = IDLE_MS) {
  clearTimeout(r.timer);
  r.timer = setTimeout(() => sync(r), ms);
  r.timer.unref();
}

// Sync one repo now (the page's button), or every repo.
export async function syncNow(id) {
  const list = id ? [repos.get(id)].filter(Boolean) : [...repos.values()];
  for (const r of list) {
    clearTimeout(r.timer);
    await sync(r);
  }
  return notesSyncStatus();
}

// Mission Control saved a note itself (the Documents panel's editor): its vault syncs after the idle time even when the
// watcher let the change pass (it is deaf for a moment after each sync, and while one runs).
export function noteSaved(file) {
  const key = path.resolve(file).toLowerCase();
  const r = [...repos.values()].filter((x) => key.startsWith(path.resolve(x.dir).toLowerCase() + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0];
  if (!r) return;
  if (r.busy) r.again = true;
  else soon(r);
}

function start() {
  if (ROLE !== 'pc') return;
  for (const { id, dir } of NOTES_REPOS) {
    const r = { id, dir, branch: null, state: 'starting', lastSync: null, lastError: null, conflicts: [], timer: null, busy: false, again: false, quietUntil: 0 };
    repos.set(id, r);
    try {
      r.watcher = fs.watch(dir, { recursive: true }, (ev, name) => {
        const n = String(name || '').replace(/\\/g, '/');
        if (n === '.git' || n.startsWith('.git/') || n.includes('/.git/')) return;
        if (r.busy || Date.now() < r.quietUntil) return;
        soon(r);
      });
      r.watcher.on('error', () => {});
    } catch (err) {
      r.lastError = `${new Date().toISOString()} cannot watch ${dir}: ${err.message}`;
    }
    soon(r, 2000);
    setInterval(() => sync(r), PULL_MS).unref();
  }
}

start();
