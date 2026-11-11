// Sync: one button that brings a project's branch in step with its remote, in whichever direction it needs.
//
//   checking    git fetch, then the branch, the uncommitted files and the commits on each side
//   committing  uncommitted changes: Haiku writes the commit in a conversation the lists never show (it reads the
//               diff, leaves junk and secrets out, writes the message the way the project's history does)
//   pulling     only the remote has new commits: a fast-forward
//   merging     both sides have new commits: this side's commits are replayed on top of the remote's (rebase)
//   pushing     this side has commits the remote has not
//   done        in step; or needs: something only the user can decide, with what to do about it
//
// Everything but the commit message is plain git run by the server: the same steps every time, never a force push, never
// a rewrite of anything already pushed (a rebase moves only commits the remote has not), and a rebase that conflicts is
// undone at once, so the folder is left exactly as it was. A public GitHub repository is never pushed from here: that
// goes through Review and push, which checks every file first.
//
// The commit conversation is shown in the lists as soon as it needs the user: a permission question, an answer that
// says it needs them, no answer in time, or a process that ended early. Then its conversation opens from the Overview.
// Without a conversation (a conflict, a refused push), the Overview offers one that starts with what went wrong.
//
// Another of the user's computers can ask for a sync too (POST /api/sync/remote, services/machines.js): then there is no
// commit step at all. Only commits that are already made go out, uncommitted and new files are left exactly as they are,
// and a rebase that would have to move around uncommitted changes is not tried.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { run } from '../lib/run.js';
import { publish, onPublish } from '../lib/events.js';
import { getProject, loadCatalog } from './catalog.js';
import { isRepo } from './git.js';
import { clearCache } from './projects.js';
import { catalogModels } from './sessions.js';
import { setMeta, setSyncHidden, showUnfinishedSyncs } from './sessionMeta.js';
import { hideRun, startRun, stopRun } from './runs.js';

const GIT_MS = 30e3;
const NET_MS = Number(process.env.MC_SYNC_NET_MS) || 120e3; // fetch and push talk to the remote
const COMMIT_MS = Number(process.env.MC_SYNC_COMMIT_MS) || 5 * 60e3; // the commit conversation, start to answer
const SESSION_WAIT_MS = 20e3;
const VIS_TTL_MS = 6 * 3600e3;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' };
const PROMPT_FILE = process.env.MC_SYNC_PROMPT_FILE || path.join(ROOT, 'server', 'prompts', 'sync-commit.md'); // tests: a prompt of their own
// Mission Control's own folder: what a hub pulls, and whose new code needs a restart. Tests point it at a folder of their own.
export const SELF_DIR = path.resolve(process.env.MC_SYNC_SELF_DIR || ROOT);

const states = new Map(); // projectId -> the state the pages show
const leftAlone = new Map(); // projectId -> the untracked files the last commit step chose to leave (no new step for those alone)
const visCache = new Map(); // remote url -> { at, value: 'public'|'private'|'other'|null }

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---- git ----

async function git(folder, args, timeoutMs = GIT_MS) {
  const r = await run('git', ['-c', 'core.fsmonitor=false', '-C', folder, ...args], { timeoutMs, env: GIT_ENV });
  return { ok: r.code === 0, out: r.stdout, err: (r.stderr || '').trim(), timedOut: r.timedOut };
}
const lastLine = (s) => String(s || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] || '';
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// { branch, upstream, tracked: [paths], untracked: [paths], conflicted: [paths] } or null
async function readStatus(folder) {
  const r = await git(folder, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
  if (!r.ok) return null;
  const out = { branch: null, upstream: null, tracked: [], untracked: [], conflicted: [] };
  const parts = r.out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.startsWith('## ')) {
      const head = e.slice(3);
      if (/^HEAD \(no branch\)/.test(head)) continue;
      const m = /^(?:No commits yet on )?([^.\s]+(?:\.(?!\.)[^.\s]*)*)(?:\.\.\.(\S+))?/.exec(head);
      if (m) { out.branch = m[1]; out.upstream = m[2] || null; }
      continue;
    }
    const xy = e.slice(0, 2), file = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the old name follows as its own entry
    if (xy === '??') out.untracked.push(file);
    else if (/U/.test(xy) || xy === 'AA' || xy === 'DD') out.conflicted.push(file);
    else out.tracked.push(file);
  }
  return out;
}

async function counts(folder) {
  const r = await git(folder, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (!r.ok) return null;
  const [ahead, behind] = r.out.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}

// A merge, rebase or cherry-pick someone left half done: Sync never runs on top of one.
function halfDone(folder) {
  const g = path.join(folder, '.git');
  try {
    if (!fs.statSync(g).isDirectory()) return null; // a worktree or submodule: git itself will say so
  } catch {
    return null;
  }
  for (const [f, what] of [['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase'], ['MERGE_HEAD', 'a merge'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']]) {
    if (fs.existsSync(path.join(g, f))) return what;
  }
  return null;
}

// ---- which repository: the remote's address, the same on every computer ----

// The address of a folder's remote (the one its branch tracks, else "origin", else the first one) from .git/config,
// without running git, or null.
export function remoteUrlOf(folder) {
  let text;
  let g = path.join(folder, '.git');
  try {
    if (fs.statSync(g).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8'));
      if (!m) return null;
      g = path.resolve(folder, m[1].trim());
    }
    text = fs.readFileSync(path.join(g, 'config'), 'utf8');
  } catch {
    return null;
  }
  // the remote the checked-out branch tracks comes first: a PC may keep the public repository as origin and work with
  // a private one (Home: origin public, its branch on dev), and the other computers know it by that private one
  let branch = null;
  try {
    const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(fs.readFileSync(path.join(g, 'HEAD'), 'utf8'));
    if (m) branch = m[1];
  } catch { /* no HEAD */ }
  const urls = {};
  const tracks = {}; // branch -> remote
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[\s*(remote|branch)\s+"([^"]+)"\s*\]/.exec(line);
    if (sec) { cur = { kind: sec[1], name: sec[2] }; continue; }
    if (/^\s*\[/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const kv = cur.kind === 'remote' ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line) : /^\s*remote\s*=\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    if (cur.kind === 'remote' && !urls[cur.name]) urls[cur.name] = kv[1];
    if (cur.kind === 'branch' && !tracks[cur.name]) tracks[cur.name] = kv[1];
  }
  return (branch && urls[tracks[branch]]) || urls.origin || Object.values(urls)[0] || null;
}

// One name for a repository however it is cloned: "github.com/owner/repo" for GitHub (https or ssh, with or without
// .git), else the address without a user name or password, lower case. null for nothing.
export function normRemote(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  const gh = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u);
  if (gh) return `github.com/${gh[1]}/${gh[2]}`.toLowerCase();
  return u.replace(/^[a-z+]+:\/\/[^@/]*@/i, (m) => m.slice(0, m.indexOf('//') + 2)).replace(/\.git\/?$/i, '').replace(/\/+$/, '').toLowerCase();
}

// The folder here that has this remote: { key, id, name, folder } (a project in the catalog first, else Mission
// Control's own folder), or null.
export function folderForRemote(remote) {
  const want = normRemote(remote);
  if (!want) return null;
  for (const p of loadCatalog()) {
    if (p && p.folder && normRemote(remoteUrlOf(p.folder)) === want) return { key: p.id, id: p.id, name: p.name, folder: p.folder };
  }
  if (normRemote(remoteUrlOf(SELF_DIR)) === want) return { key: 'self', id: null, name: 'Mission Control', folder: SELF_DIR };
  return null;
}

// What a folder's branch looks like right now, for the Sync panel: no fetch (the caller fetches first when it wants).
export async function folderReport(folder) {
  const out = { remote: normRemote(remoteUrlOf(folder)), branch: null, head: null, upstreamHead: null, ahead: null, behind: null, tracked: 0, untracked: 0, half: halfDone(folder) };
  const st = await readStatus(folder);
  if (!st) return out;
  out.branch = st.branch;
  out.upstream = st.upstream;
  out.tracked = st.tracked.length + st.conflicted.length;
  out.untracked = st.untracked.length;
  out.head = (await git(folder, ['rev-parse', 'HEAD'])).out.trim() || null;
  if (st.upstream) {
    out.upstreamHead = (await git(folder, ['rev-parse', '@{u}'])).out.trim() || null;
    const ab = await counts(folder);
    if (ab) Object.assign(out, ab);
  }
  return out;
}

// git fetch of a folder's remote, quietly: true when it answered.
export async function fetchFolder(folder) {
  const st = await readStatus(folder);
  const name = st && st.upstream ? st.upstream.split('/')[0] : 'origin';
  return (await git(folder, ['fetch', '--prune', name], NET_MS)).ok;
}

// ---- is the remote a public GitHub repository? ----

// 'public', 'private', 'other' (not GitHub: nothing to check) or null (could not tell).
// GitHub answers a repository's page for anyone only when it is public; a private one is a 404 without a sign-in.
// When that question cannot be asked (offline, rate limit), the gh program is asked, if it is installed and signed in.
async function visibility(url) {
  if (['public', 'private', 'other'].includes(process.env.MC_SYNC_VISIBILITY)) return process.env.MC_SYNC_VISIBILITY; // tests: no network
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || ''));
  if (!m) return 'other';
  const key = `${m[1]}/${m[2]}`.toLowerCase();
  const hit = visCache.get(key);
  if (hit && Date.now() - hit.at < VIS_TTL_MS) return hit.value;
  let value = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mission-Control' },
      signal: AbortSignal.timeout(10e3),
    });
    if (r.status === 404) value = 'private';
    else if (r.ok) value = (await r.json()).private === false ? 'public' : 'private';
  } catch {
    value = null;
  }
  if (!value) {
    const g = await run('gh', ['repo', 'view', `${m[1]}/${m[2]}`, '--json', 'visibility', '-q', '.visibility'], { timeoutMs: 15e3 });
    const v = g.code === 0 ? g.stdout.trim().toUpperCase() : '';
    if (v === 'PUBLIC') value = 'public';
    else if (v === 'PRIVATE' || v === 'INTERNAL') value = 'private';
  }
  if (value) visCache.set(key, { at: Date.now(), value });
  return value;
}

// ---- the state the pages see ----

const PHASE_LABEL = { checking: 'Checking', committing: 'Committing', pulling: 'Pulling', merging: 'Merging', pushing: 'Pushing', done: 'Done', needs: 'Needs you' };

function setState(pid, patch) {
  const cur = states.get(pid) || {};
  const next = { ...cur, ...patch, projectId: pid, at: new Date().toISOString() };
  next.label = PHASE_LABEL[next.phase] || next.phase;
  next.busy = !['done', 'needs'].includes(next.phase);
  states.set(pid, next);
  publish('sync', next);
  return next;
}

export function syncState(projectId) {
  return states.get(projectId) || null;
}

// ---- watching a conversation Sync started ----

const watchers = new Map(); // runId -> watcher
onPublish((type, data) => {
  if (type !== 'chat' || !data || !watchers.has(data.runId)) return;
  const w = watchers.get(data.runId);
  const ev = data.event;
  const sid = (ev && typeof ev.session_id === 'string' && ev.session_id) || (typeof data.sessionId === 'string' && data.sessionId) || null;
  if (sid && !w.sessionId) {
    w.sessionId = sid.toLowerCase();
    w.onSession(w.sessionId);
  }
  if (ev && ev.type === 'assistant' && !ev.parent_tool_use_id && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b && b.type === 'text' && String(b.text || '').trim()) w.text = String(b.text);
      if (b && b.type === 'tool_use') w.onTool(b);
    }
  }
  if (data.permission) w.finish({ kind: 'permission', summary: String(data.permission.summary || data.permission.tool || '').slice(0, 200) });
  else if (data.turnDone) w.finish({ kind: 'answer', text: w.text || '' });
  else if (data.done) w.finish({ kind: 'ended', state: data.state, error: data.error || null });
});

function watch(runId, { onSession = () => {}, onTool = () => {}, timeoutMs = COMMIT_MS } = {}) {
  let resolve;
  const outcome = new Promise((r) => (resolve = r));
  const w = {
    sessionId: null,
    text: '',
    onSession,
    onTool,
    finish: (o) => {
      if (!watchers.has(runId)) return;
      watchers.delete(runId);
      clearTimeout(timer);
      resolve({ ...o, sessionId: w.sessionId });
    },
  };
  const timer = setTimeout(() => w.finish({ kind: 'timeout' }), timeoutMs);
  if (timer.unref) timer.unref();
  watchers.set(runId, w);
  return { w, outcome };
}

// The newest model of a family by its id, or undefined (the default model) when the catalog has none.
function modelOf(family) {
  try {
    const m = (catalogModels() || []).find((x) => x.family === family);
    return m ? m.id : undefined;
  } catch {
    return undefined;
  }
}

// The last line of the commit step's answer: "SYNC: done ..." or "SYNC: needs-you ...".
export function readVerdict(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
    const m = /^[*`_]*SYNC:\s*(done|needs[- ]you)[*`_]*\s*(?:[-:.]\s*)?(.*)$/i.exec(lines[i]);
    if (m) return { ok: /^done$/i.test(m[1]), why: m[2].replace(/[*`_]+$/, '').trim() };
  }
  return null;
}

// ---- the commit step ----

async function commitStep(pid, project, st) {
  const files = [...st.tracked, ...st.untracked];
  const list = files.slice(0, 60).map((f) => `- ${f}`).join('\n') + (files.length > 60 ? `\n- and ${files.length - 60} more` : '');
  const tmpl = fs.readFileSync(PROMPT_FILE, 'utf8');
  const prompt = tmpl.replace('{{project}}', project.name).replace('{{branch}}', st.branch).replace('{{files}}', list);
  setState(pid, { phase: 'committing', detail: `Haiku is writing the commit for ${plural(files.length, 'file')}` });
  let started;
  try {
    started = await startRun({ prompt, projectId: pid, model: modelOf('haiku'), mode: 'auto', remote: false });
  } catch (err) {
    return { needs: true, detail: `The commit step did not start: ${err.message}` };
  }
  const runId = started.runId;
  hideRun(runId, true);
  const { outcome } = watch(runId, {
    onSession: (sid) => {
      setSyncHidden(sid, 'working');
      try {
        setMeta(sid, { title: `Sync: commit in ${project.name}`.slice(0, 120) });
      } catch {
        /* the name is only for the Usage page */
      }
      setState(pid, { sessionId: sid });
    },
    onTool: (b) => {
      const cmd = String((b.input && b.input.command) || '');
      if (/\bgit\s+commit\b/.test(cmd)) setState(pid, { detail: 'Haiku is committing' });
      else if (/\bgit\s+(diff|status|log|show)\b/.test(cmd)) setState(pid, { detail: 'Haiku is reading the changes' });
    },
  });
  const o = await outcome;
  const show = (why) => {
    hideRun(runId, false);
    if (o.sessionId) {
      setSyncHidden(o.sessionId, null);
      publish('sessions.changed', { id: o.sessionId });
    }
    return { needs: true, detail: why, sessionId: o.sessionId || null };
  };
  if (o.kind === 'permission') return show(`Haiku is waiting for your OK: ${o.summary}`);
  if (o.kind === 'timeout') return show('The commit step took too long. Its conversation is open for you.');
  if (o.kind === 'ended') return show(`The commit step ended early${o.error ? ': ' + o.error.slice(0, 160) : ''}`);
  const v = readVerdict(o.text);
  if (!v) return show('Haiku did not say how the commit went. Read its answer.');
  if (!v.ok) return show(v.why || 'Haiku needs you for the commit.');
  // done: the conversation stays out of the lists, and its process is not kept waiting
  if (o.sessionId) setSyncHidden(o.sessionId, 'done');
  stopRun(runId).catch(() => {});
  hideRun(runId, false);
  return { needs: false, why: v.why };
}

// ---- one sync ----

// target: { key, id (the catalog project, needed for the commit step), name, folder }. commit: false for a sync
// another computer asked for: no commit step, and uncommitted files are left alone.
async function runSync(target, { commit = true } = {}) {
  const pid = target.key;
  const project = target;
  const folder = target.folder;
  const done = { committed: 0, pulled: 0, pushed: 0 };
  const notes = [];
  const needs = (detail, extra = {}) => setState(pid, { phase: 'needs', detail, done, notes, endedAt: new Date().toISOString(), ...extra });

  if (!isRepo(folder)) return needs('This folder is not a git repository.', { kind: 'setup' });
  const half = halfDone(folder);
  if (half) return needs(`There is ${half} in progress in this folder. Finish or abort it first.`, { kind: 'stuck' });
  let st = await readStatus(folder);
  if (!st) return needs('git did not answer in this folder.', { kind: 'setup' });
  if (!st.branch) return needs('The folder is not on a branch (detached HEAD), so there is nothing to sync.', { kind: 'setup' });
  if (!st.upstream) return needs(`The branch ${st.branch} has no remote branch to sync with. Push it once with git push -u.`, { kind: 'setup' });
  if (st.conflicted.length) return needs(`${plural(st.conflicted.length, 'file')} still ${st.conflicted.length === 1 ? 'has' : 'have'} a conflict: ${st.conflicted.slice(0, 5).join(', ')}`, { kind: 'conflict', files: st.conflicted });
  const remoteName = st.upstream.split('/')[0];

  setState(pid, { detail: `Fetching from ${remoteName}` });
  const f = await git(folder, ['fetch', '--prune', remoteName], NET_MS);
  if (!f.ok) return needs(`Could not reach ${remoteName}: ${f.timedOut ? 'no answer in time' : lastLine(f.err)}`, { kind: 'network' });

  // uncommitted work first, so what is pushed is everything
  const untrackedKey = st.untracked.slice().sort().join('\n');
  if (!commit) {
    if (st.tracked.length) notes.push(`${plural(st.tracked.length, 'uncommitted file')} left as ${st.tracked.length === 1 ? 'it is' : 'they are'}: ${st.tracked.slice(0, 3).join(', ')}${st.tracked.length > 3 ? ' ...' : ''}`);
  } else if (st.tracked.length || (st.untracked.length && leftAlone.get(pid) !== untrackedKey)) {
    const before = (await git(folder, ['rev-parse', 'HEAD'])).out.trim();
    const c = await commitStep(pid, project, st);
    if (c.needs) return needs(c.detail, { kind: 'commit', sessionId: c.sessionId || null });
    const after = (await git(folder, ['rev-parse', 'HEAD'])).out.trim();
    if (after && before !== after) done.committed = Number.parseInt((await git(folder, ['rev-list', '--count', `${before}..${after}`])).out, 10) || 1;
    st = await readStatus(folder);
    if (!st) return needs('git did not answer after the commit.', { kind: 'setup' });
    if (st.tracked.length) {
      const sid = states.get(pid).sessionId || null;
      if (sid) {
        setSyncHidden(sid, null); // Haiku said done, yet changes are left: its conversation explains why
        publish('sessions.changed', { id: sid });
      }
      return needs(`${plural(st.tracked.length, 'changed file')} ${st.tracked.length === 1 ? 'was' : 'were'} left uncommitted: ${st.tracked.slice(0, 5).join(', ')}`, { kind: 'commit', sessionId: sid });
    }
    leftAlone.set(pid, st.untracked.slice().sort().join('\n'));
    if (st.untracked.length) notes.push(`${plural(st.untracked.length, 'new file')} left out of git: ${st.untracked.slice(0, 3).join(', ')}${st.untracked.length > 3 ? ' ...' : ''}`);
  }

  let ab = await counts(folder);
  if (!ab) return needs('Could not compare the branch with the remote.', { kind: 'setup' });

  if (ab.behind > 0) {
    const old = (await git(folder, ['rev-parse', 'HEAD'])).out.trim();
    if (ab.ahead === 0) {
      setState(pid, { phase: 'pulling', detail: `Pulling ${plural(ab.behind, 'commit')}` });
      const m = await git(folder, ['merge', '--ff-only', '@{u}']);
      if (!m.ok) return needs(`The pull stopped: ${lastLine(m.err)}`, { kind: 'pull' });
    } else if (st.tracked.length) {
      // only without a commit step: a rebase would have to move the uncommitted changes around, and they are not Sync's
      return needs(`${project.name} has ${plural(ab.ahead, 'commit')} to put on top of ${plural(ab.behind, 'new one')}, but also ${plural(st.tracked.length, 'uncommitted file')}, so nothing was changed. Commit or put away the changes there first.`, { kind: 'dirty', files: st.tracked.slice(0, 30) });
    } else {
      setState(pid, { phase: 'merging', detail: `Putting your ${plural(ab.ahead, 'commit')} on top of ${plural(ab.behind, 'new one')}` });
      const r = await git(folder, ['rebase', '--no-autostash', '@{u}'], 120e3);
      if (!r.ok) {
        const u = await git(folder, ['diff', '--name-only', '--diff-filter=U']);
        const files = u.out.split('\n').map((s) => s.trim()).filter(Boolean);
        await git(folder, ['rebase', '--abort']);
        return needs(
          files.length
            ? `Your commits and the new ones change the same lines in ${plural(files.length, 'file')}: ${files.slice(0, 5).join(', ')}. Nothing was changed.`
            : `The merge stopped: ${lastLine(r.err)}. Nothing was changed.`,
          { kind: 'conflict', files },
        );
      }
    }
    done.pulled = ab.behind;
    const ch = await git(folder, ['diff', '--name-only', old, 'HEAD']);
    const changed = ch.ok ? ch.out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    if (changed.some((p) => /(^|\/)package(-lock)?\.json$/.test(p))) notes.push('package.json changed: run npm install');
    if (path.resolve(folder) === SELF_DIR && changed.some((p) => p.startsWith('server/'))) notes.push('Restart Mission Control to run the new code');
    ab = (await counts(folder)) || { ahead: ab.ahead, behind: 0 };
  }

  if (ab.ahead > 0) {
    const url = (await git(folder, ['remote', 'get-url', remoteName])).out.trim();
    const vis = await visibility(url);
    if (vis === 'public') return needs(`${project.name} is a public repository, so its ${plural(ab.ahead, 'commit')} go${ab.ahead === 1 ? 'es' : ''} out through Review and push, which checks every file first.`, { kind: 'public', ahead: ab.ahead });
    if (!vis) return needs(`Could not tell whether ${project.name} is public on GitHub, so nothing was pushed.`, { kind: 'network', ahead: ab.ahead });
    setState(pid, { phase: 'pushing', detail: `Pushing ${plural(ab.ahead, 'commit')} to ${remoteName}` });
    const p = await git(folder, ['push', remoteName, `HEAD:refs/heads/${st.upstream.slice(remoteName.length + 1)}`], NET_MS);
    if (!p.ok) return needs(`The push was refused: ${p.timedOut ? 'no answer in time' : lastLine(p.err)}`, { kind: 'push' });
    done.pushed = ab.ahead;
  }

  const said = [done.committed && `committed ${done.committed}`, done.pulled && `pulled ${done.pulled}`, done.pushed && `pushed ${done.pushed}`].filter(Boolean);
  const detail = said.length ? said.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'Already in step';
  return setState(pid, { phase: 'done', detail, done, notes, endedAt: new Date().toISOString(), kind: null });
}

// Starts a sync and answers at once with its first state; `finished` is the last one. by: the computer that asked, if
// not this one.
function launch(target, { commit = true, by = null } = {}) {
  const cur = states.get(target.key);
  if (cur && cur.busy) throw fail(409, `A sync of ${target.name} is already running`);
  const first = setState(target.key, { phase: 'checking', detail: 'Looking at the branch', name: target.name, by, startedAt: new Date().toISOString(), endedAt: null, sessionId: null, kind: null, files: null, done: null, notes: [] });
  const finished = runSync(target, { commit })
    .catch((err) => {
      console.error('[sync] failed:', err);
      return setState(target.key, { phase: 'needs', detail: `Sync failed: ${err.message}`, kind: 'error', endedAt: new Date().toISOString() });
    })
    .finally(() => {
      clearCache();
      if (target.id) publish('projects.changed', { id: target.id });
    });
  return { first, finished };
}

// A project here, by its id, for the Sync panel: { first, finished }.
export function syncProjectNow(projectId) {
  const project = typeof projectId === 'string' ? getProject(projectId) : null;
  if (!project) throw fail(404, 'Unknown project');
  if (!fs.existsSync(project.folder)) throw fail(400, 'The project folder does not exist');
  return launch({ key: project.id, id: project.id, name: project.name, folder: project.folder });
}

// A folder that is not a catalog project (Mission Control's own on a hub): no commit step.
export function syncFolderNow(target) {
  return launch(target, { commit: false });
}

// Asked by another computer (POST /api/sync/remote): the folder with this remote, committed work only.
export function startRemoteSync(remote, by) {
  const target = folderForRemote(remote);
  if (!target) throw fail(404, 'No folder here has that repository');
  return { key: target.key, state: launch(target, { commit: false, by }).first };
}

// Asked by another computer: a conversation about the sync it asked for that stopped here.
export async function askAboutRemoteSync(remote, family) {
  const target = folderForRemote(remote);
  if (!target) throw fail(404, 'No folder here has that repository');
  if (!target.id) throw fail(409, 'That folder is not a project here, so there is no conversation for it');
  return askAboutSync(target.id, family);
}

// The last sync of the folder with this remote, for the computer that asked for it.
export function remoteSyncState(remote) {
  const target = folderForRemote(remote);
  if (!target) throw fail(404, 'No folder here has that repository');
  return { key: target.key, state: states.get(target.key) || null };
}

// Starts a sync of one project and answers at once with its first state; the rest arrives as 'sync' events.
export function startSync(projectId) {
  return syncProjectNow(projectId).first;
}

// A conversation about what stopped the sync, started by the user from the Overview: Sonnet, in the project's folder,
// told what happened and that nothing goes out without their yes. Answers with its session id once it has one.
export async function askAboutSync(projectId, family = 'sonnet') {
  const project = typeof projectId === 'string' ? getProject(projectId) : null;
  if (!project) throw fail(404, 'Unknown project');
  const s = states.get(project.id);
  if (!s || s.phase !== 'needs') throw fail(409, 'This project has no sync problem to ask about');
  if (s.sessionId) return { sessionId: s.sessionId };
  const lines = [
    `Mission Control's Sync button stopped in ${project.name} (this folder) and needs my decision.`,
    '',
    `What it said: ${s.detail}`,
    ...(s.files && s.files.length ? ['', 'Files:', ...s.files.slice(0, 30).map((f) => `- ${f}`)] : []),
    '',
    'Sync fetched from the remote and changed nothing after that point. Look at the state of the repository, explain the problem to me in plain words, and propose how to solve it.',
    s.kind === 'conflict'
      ? 'For a conflict: rebase my unpushed commits on the remote branch and resolve the conflicts, keeping both sides\' intent. Show me each resolution and run the tests if the project has any.'
      : s.kind === 'dirty'
        ? 'The uncommitted changes are mine: never discard, stash or commit them without asking me. Tell me what they are, and ask what to do with them.'
        : '',
    s.by ? `${s.by} (my other computer) asked for this sync from its Sync panel; I am reading this conversation from there.` : '',
    'Never force-push and never rewrite commits that are already pushed. Do not push anything until I say yes in this conversation.',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  let gotSession;
  const sessionKnown = new Promise((r) => (gotSession = r));
  const started = await startRun({ prompt: lines.join('\n'), projectId: project.id, model: modelOf(family === 'opus' ? 'opus' : 'sonnet'), mode: 'auto', remote: false });
  // only its session id is wanted: the watch ends once it is known (or after a while without one)
  const { w } = watch(started.runId, { onSession: (id) => gotSession(id), timeoutMs: SESSION_WAIT_MS });
  const sid = await Promise.race([sessionKnown, new Promise((r) => setTimeout(() => r(null), SESSION_WAIT_MS).unref())]);
  w.finish({ kind: 'known' });
  if (sid) setState(project.id, { sessionId: sid });
  return { sessionId: sid, runId: started.runId };
}

// At start: a commit step the last server did not see end is shown again.
setTimeout(() => {
  try {
    const ids = showUnfinishedSyncs();
    for (const id of ids) publish('sessions.changed', { id });
  } catch (err) {
    console.error('[sync] could not show unfinished commit steps:', err.message);
  }
}, 5000).unref();
