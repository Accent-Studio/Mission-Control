// The Sync panel: this computer, the other one (through the PC link, services/pcLink.js) and the hub (services/hubSync.js),
// and the repositories they share, matched by their remote's address (sync.js normRemote). Mission Control itself is
// always one of them, and the hub only ever has that one.
//
// Sync all, for one shared repository, goes in this order:
//   1. the other computer pushes the commits it already has (never a commit of its own, never an uncommitted file)
//   2. this computer syncs as the Sync button does: Haiku commits what is uncommitted, then pull, rebase, push
//   3. the other computer and the hub pull what is new
// A computer that is off, or has not allowed this one to sync it, is left out with a note; the rest goes on. A step that
// stops on the other computer (a conflict there) stops the whole sync before anything here changes.
//
// Each computer answers for itself (GET /api/sync/here): its branch and commits after a fresh fetch, the code its server
// runs against the code in its folder (a restart is due when server/ changed), and what is running. The last view is
// kept in .data/machines.json, so the panel still lists the other computer's repositories while it is off.
//
// MC_MACHINES_POLL_MS: how often a step on another computer is asked how it went (default 1 s; tests).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { DATA_DIR, MACHINE_NAME, ROLE } from '../config.js';
import { onPublish, publish } from '../lib/events.js';
import { readJson, writeJson } from '../lib/jsonStore.js';
import { loadCatalog } from './catalog.js';
import { restartDue, serverCodeChanged } from '../lib/codeAge.js';
import { bridgeStatus, bridgeUpdateWaits } from './devices.js';
import { runnerStatus } from './runnerClient.js';
import { listRuns } from './runs.js';
import { enterUrl, pcCall, pcLinkStatus } from './pcLink.js';
import { hubCall, hubLinked } from './hubSync.js';
import { SELF_DIR, askAboutSync, fetchFolder, folderReport, normRemote, remoteUrlOf, syncFolderNow, syncProjectNow, syncState } from './sync.js';

const FILE = path.join(DATA_DIR, 'machines.json');
const POLL_MS = Number(process.env.MC_MACHINES_POLL_MS) || 1000;
const FAR_STEP_MS = 5 * 60e3;
const RESTART_WAIT_MS = Number(process.env.MC_RESTART_WAIT_MS) || 120e3;
const READ_MS = 60e3; // a report fetches every shared repository first

const fail = (status, message) => Object.assign(new Error(message), { status });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESTART_NOTE = /Restart Mission Control to run the new code/;

function gitSync(args) {
  try {
    return execFileSync('git', ['-C', SELF_DIR, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10e3 }).trim();
  } catch {
    return '';
  }
}
const RUNNING_HEAD = gitSync(['rev-parse', 'HEAD']) || null; // the code this server started with
const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

// ---- this computer ----

// The repositories here with a remote: the catalog's projects, and Mission Control's own folder (a hub has no catalog).
function reposHere() {
  const out = [];
  const seen = new Set();
  for (const p of loadCatalog()) {
    if (!p || !p.folder) continue;
    const remote = normRemote(remoteUrlOf(p.folder));
    if (!remote || seen.has(remote)) continue;
    seen.add(remote);
    out.push({ key: p.id, id: p.id, name: p.name, folder: p.folder, remote, self: path.resolve(p.folder) === SELF_DIR });
  }
  const selfRemote = normRemote(remoteUrlOf(SELF_DIR));
  if (selfRemote && !seen.has(selfRemote)) out.push({ key: 'self', id: null, name: 'Mission Control', folder: SELF_DIR, remote: selfRemote, self: true });
  return out;
}

// MC_DUE_TEST ("runner,bridge"): a test server says those two run older code (a test has no runner and no bridge build)
const DUE_TEST = new Set(String(process.env.MC_DUE_TEST || '').split(',').filter(Boolean));

// Mission Control's own code: what this server runs, what the folder has, and whether that needs a restart. runner and
// bridge: the runner runs older code, or a new build of the bridge waits; only Restart all three restarts those two (the
// same flags as the server panel's, GET /api/server/status).
function selfCode() {
  const head = gitSync(['rev-parse', 'HEAD']) || null;
  let restart = serverCodeChanged(); // a file in server/ written since the start: pulled, synced or edited
  if (head && RUNNING_HEAD && head !== RUNNING_HEAD) {
    const changed = gitSync(['diff', '--name-only', RUNNING_HEAD, head]).split('\n');
    restart = restart || changed.some((f) => f.startsWith('server/'));
  }
  const rn = runnerStatus();
  const runner = DUE_TEST.has('runner') || !!(rn.old && rn.state === 'connected');
  const bridge = DUE_TEST.has('bridge') || (bridgeUpdateWaits() && bridgeStatus().online);
  return { remote: normRemote(remoteUrlOf(SELF_DIR)), runningHead: RUNNING_HEAD, head, restart, runner, bridge };
}

// GET /api/sync/here: what this computer says about itself. remotes: the repositories to report on (others are only
// named); fetch: fetch those first, so ahead and behind are as of now.
export async function hereReport({ remotes = [], fetch = false } = {}) {
  const want = new Set((remotes || []).map(normRemote).filter(Boolean));
  const repos = reposHere();
  const picked = repos.filter((r) => want.has(r.remote));
  if (fetch) await Promise.all(picked.map((r) => fetchFolder(r.folder).catch(() => false)));
  const projects = [];
  for (const r of picked) {
    const rep = await folderReport(r.folder);
    const s = syncState(r.key);
    projects.push({ ...rep, remote: r.remote, key: r.key, id: r.id, name: r.name, self: r.self, sync: s ? { phase: s.phase, label: s.label, detail: s.detail, busy: s.busy, by: s.by || null, at: s.at } : null });
  }
  return {
    name: MACHINE_NAME,
    role: ROLE,
    platform: process.platform,
    startedAt: STARTED_AT,
    supervised: process.env.MC_SUPERVISED === '1',
    running: listRuns().filter((r) => r.running).length,
    code: selfCode(),
    repos: repos.map((r) => ({ name: r.name, remote: r.remote })),
    projects,
    at: new Date().toISOString(),
  };
}

// ---- the other computers ----

// { call(method, path, opts) -> { status, json }, name, on } for 'pc' and 'hub'
function far(which) {
  if (which === 'pc') {
    const st = pcLinkStatus();
    if (!st.paired) return null;
    return { which, name: st.paired.name, on: st.online, call: (m, p, o) => pcCall(m, p, o) };
  }
  if (which === 'hub') {
    if (ROLE !== 'pc' || !hubLinked()) return null;
    return { which, name: null, on: true, call: async (m, p, o = {}) => { const r = await hubCall(m, p, { json: o.json, timeout: o.timeout }); return { status: r.status, json: r.json }; } };
  }
  return null;
}

const errText = (r) => (r && r.json && r.json.error) || (r ? `answer ${r.status}` : 'no answer');

async function readFar(f, remotes) {
  const q = `/api/sync/here?fetch=1&remotes=${encodeURIComponent(remotes.join(','))}`;
  try {
    const r = await f.call('GET', q, { timeout: READ_MS });
    if (r.status === 404 && (!r.json || r.json.error === 'Not found')) {
      // an older Mission Control: it has no Sync panel yet, but its server status says whether it can restart
      const st = await f.call('GET', '/api/server/status').catch(() => null);
      const sv = st && st.status === 200 && st.json && st.json.server ? st.json : null;
      return { online: true, old: true, status: sv ? { supervised: !!sv.server.supervised, running: sv.running ? sv.running.runs : null, startedAt: sv.server.startedAt ? new Date(sv.server.startedAt).toISOString() : null } : null };
    }
    if (r.status !== 200 || !r.json) return { online: true, error: errText(r) };
    return { online: true, report: r.json };
  } catch (err) {
    return { online: false, error: String((err && err.message) || err).slice(0, 200) };
  }
}

// ---- the view ----

let view = readJson(FILE, 'machines').value || null; // { at, machines, shared }
let reading = null;
let crossing = null; // the Sync all running now: its state
const crossStates = new Map(); // remote -> the last Sync all of it

function keep() {
  try {
    writeJson(FILE, view);
  } catch (err) {
    console.error('[machines] could not keep the view:', err.message);
  }
}

// What one computer has to do for one repository: words for the panel and a status.
function rowFor(machine, rep, remote) {
  if (!machine.online || machine.old) return { status: 'off', words: machine.old ? 'Runs an older Mission Control: pull and restart it there once' : 'Off, not checked' };
  const p = rep && rep.projects ? rep.projects.find((x) => x.remote === remote) : null;
  if (!p) return { status: 'none', words: 'Not on this computer' };
  const out = { status: 'ok', branch: p.branch, head: p.head, ahead: p.ahead, behind: p.behind, tracked: p.tracked, untracked: p.untracked, key: p.key, id: p.id, sync: p.sync };
  const said = [];
  if (p.half) said.push(`${p.half} in progress`);
  if (!p.upstream) said.push('no remote branch');
  if (p.ahead) said.push(`${plural(p.ahead, 'commit')} to push`);
  if (p.behind) said.push(`${plural(p.behind, 'commit')} to pull`);
  if (p.tracked) said.push(`${plural(p.tracked, 'uncommitted file')}`);
  if (p.self && rep.code && rep.code.restart) said.push('runs older code: restart');
  if (said.length) out.status = p.half || !p.upstream ? 'stuck' : p.ahead || p.behind ? 'todo' : 'note';
  out.words = said.length ? said.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'In step';
  if (p.self) out.restart = !!(rep.code && rep.code.restart);
  return out;
}

// restart: something there runs older code; restartAll: the runner or the bridge does, so only Restart all three helps
const dueOf = (code) => {
  const d = restartDue(code);
  return { restart: d.server || d.all, restartAll: d.all, runnerOld: d.runner, bridgeOld: d.bridge };
};

function build(here, others) {
  const machines = [
    { which: 'here', name: here.name, online: true, me: true, running: here.running, supervised: here.supervised, startedAt: here.startedAt, ...dueOf(here.code), role: here.role },
  ];
  for (const [which, f, res] of others) {
    const rep = res.report || null;
    machines.push({ which, name: (rep && rep.name) || f.name || (which === 'hub' ? 'Hub' : 'Other PC'), online: res.online, old: !!res.old, error: res.error || null, running: rep ? rep.running : res.status ? res.status.running : null, supervised: rep ? rep.supervised : res.status ? res.status.supervised : null, startedAt: rep ? rep.startedAt : res.status ? res.status.startedAt : null, ...dueOf(rep && rep.code), role: rep ? rep.role : which === 'hub' ? 'hub' : 'pc' });
  }
  const reports = { here, ...Object.fromEntries(others.map(([w, , r]) => [w, r.report || null])) };
  const shared = sharedRemotes(here, others).map((remote) => {
    const mine = here.projects.find((p) => p.remote === remote);
    const rows = machines.map((m) => ({ which: m.which, name: m.name, ...rowFor(m, reports[m.which], remote) })).filter((r) => r.status !== 'none' || r.which === 'here');
    const todo = rows.some((r) => r.status === 'todo' || r.status === 'stuck');
    return { remote, name: (mine && mine.name) || remote.split('/').pop(), self: !!(mine && mine.self), id: mine ? mine.id : null, rows, todo, sync: crossStates.get(remote) || null };
  });
  return { at: new Date().toISOString(), machines, shared };
}

// The repositories to look at: Mission Control's own, and every one the other computer has too (as last seen, while it
// is off).
function sharedRemotes(here, others) {
  const mine = new Set(here.repos.map((r) => r.remote));
  const out = new Set();
  if (here.code.remote) out.add(here.code.remote);
  for (const [, , res] of others) {
    const theirs = res.report ? res.report.repos.map((r) => r.remote) : (view && view.shared ? view.shared.map((s) => s.remote) : []);
    for (const r of theirs) if (mine.has(r)) out.add(r);
  }
  return [...out].sort((a, b) => (a === here.code.remote ? -1 : b === here.code.remote ? 1 : a.localeCompare(b)));
}

// Reads every computer again: { at, machines, shared }. One read at a time; a second caller gets the same one.
export function readMachines() {
  if (reading) return reading;
  reading = (async () => {
    const mineAll = reposHere().map((r) => r.remote);
    const others = [];
    for (const which of ['pc', 'hub']) {
      const f = far(which);
      if (!f) continue;
      others.push([which, f, f.on ? readFar(f, which === 'hub' ? [normRemote(remoteUrlOf(SELF_DIR))].filter(Boolean) : mineAll) : Promise.resolve({ online: false })]);
    }
    const settled = [];
    for (const [w, f, p] of others) settled.push([w, f, await p]);
    const remotes = sharedRemotes(await hereReport({ remotes: [] }), settled);
    const here = await hereReport({ remotes, fetch: true });
    view = build(here, settled);
    keep();
    publish('machines', view);
    return view;
  })().finally(() => { reading = null; });
  return reading;
}

// stale: the view was read by an earlier run of this server (a restart since), so whatever it says about restarts and
// running code is old: the panel reads every computer again.
export function machinesView() {
  if (!view) return null;
  const me = view.machines && view.machines.find((m) => m.which === 'here');
  const shared = view.shared.map((s) => {
    const sync = crossStates.get(s.remote) || s.sync || null;
    return { ...s, sync: sync && sync.notes ? { ...sync, notes: sync.notes.filter((n) => !RESTART_NOTE.test(n) && !/run older code: restart/.test(n)) } : sync };
  });
  return { ...view, shared, crossing: !!crossing, stale: !me || me.startedAt !== STARTED_AT };
}

// ---- Sync all ----

function setCross(remote, patch) {
  const cur = crossStates.get(remote) || {};
  const next = { ...cur, ...patch, remote, at: new Date().toISOString() };
  next.busy = !['done', 'needs'].includes(next.phase);
  crossStates.set(remote, next);
  publish('machines.sync', next);
  return next;
}

// This computer's own step shows its progress in the Sync all line too.
let following = null; // { pid, remote }
onPublish((type, d) => {
  if (type === 'sync' && following && d && d.projectId === following.pid && d.busy) setCross(following.remote, { detail: `${MACHINE_NAME}: ${d.detail}` });
});

// One step on another computer: start its sync, then ask how it went until it ends. { state } or { skipped, why }.
async function farStep(f, remote) {
  let r;
  try {
    r = await f.call('POST', '/api/sync/remote', { json: { remote } });
  } catch (err) {
    return { skipped: true, why: `${f.label} did not answer` };
  }
  if (r.status === 403) return { skipped: true, why: `${f.label} has not allowed ${MACHINE_NAME} to sync it (on ${f.label}: Connections, paired devices, Linked computer)` };
  if (r.status === 404 && (!r.json || r.json.error === 'Not found')) return { skipped: true, why: `${f.label} runs an older Mission Control: pull and restart it there once` }; // no such route there yet
  if (r.status === 409) { /* one is running there already: follow it */ } else if (r.status !== 200) return { skipped: true, why: `${f.label}: ${errText(r)}` };
  const until = Date.now() + FAR_STEP_MS;
  for (;;) {
    await sleep(POLL_MS);
    let g;
    try {
      g = await f.call('GET', `/api/sync/remote?remote=${encodeURIComponent(remote)}`);
    } catch {
      g = null;
    }
    const st = g && g.status === 200 && g.json ? g.json.state : null;
    if (st && !st.busy) return { state: st };
    if (Date.now() > until) return { state: { phase: 'needs', detail: `${f.label} took too long to answer`, kind: 'timeout' } };
  }
}

async function runCross(remote) {
  const notes = [];
  // A restart that is due shows in the panel's table, read live, so it is not kept as a note that outlives the restart
  const note = (n) => { if (!RESTART_NOTE.test(n) && !notes.includes(n)) notes.push(n); };
  const needs = (detail, extra = {}) => setCross(remote, { phase: 'needs', label: 'Needs you', detail, notes, ...extra });
  setCross(remote, { phase: 'checking', label: 'Checking', detail: 'Looking at every computer', notes: [], startedAt: new Date().toISOString(), kind: null, where: null });
  const v = await readMachines();
  const sh = v.shared.find((s) => s.remote === remote);
  if (!sh) return needs('This repository is not shared with another computer any more.');
  const mine = sh.rows.find((r) => r.which === 'here');
  if (!mine || mine.status === 'none' || !mine.key) return needs(`${sh.name} has no folder on this computer to sync.`, { kind: 'setup' });
  const farRows = sh.rows.filter((r) => r.which !== 'here');
  const fars = Object.fromEntries(farRows.map((r) => {
    const f = far(r.which);
    return [r.which, f ? { ...f, label: r.name } : null];
  }));
  for (const r of farRows) if (r.status === 'off') notes.push(`${r.name}: ${r.words === 'Off, not checked' ? 'off, so it was not checked' : r.words.toLowerCase()}`);

  // 1. the other computer's commits go out first
  for (const r of farRows) {
    const f = fars[r.which];
    if (!f || r.status === 'off' || !(r.ahead > 0)) continue;
    setCross(remote, { phase: 'pushing', label: 'Pushing', detail: `${r.name} is pushing ${plural(r.ahead, 'commit')}`, where: r.which });
    const out = await farStep(f, remote);
    if (out.skipped) { notes.push(out.why); continue; }
    if (out.state.phase !== 'done') return needs(`${r.name}: ${out.state.detail}`, { kind: out.state.kind || 'far', where: r.which, files: out.state.files || null });
    for (const n of out.state.notes || []) note(`${r.name}: ${n}`);
  }

  // 2. this computer, with its commit step
  setCross(remote, { phase: 'syncing', label: 'Syncing', detail: `${MACHINE_NAME} is syncing`, where: 'here' });
  let started;
  try {
    started = mine.id ? syncProjectNow(mine.id) : syncFolderNow({ key: mine.key, id: null, name: sh.name, folder: SELF_DIR });
  } catch (err) {
    return needs(err.message, { kind: 'busy', where: 'here' });
  }
  following = { pid: mine.key, remote };
  const here = await started.finished.finally(() => { following = null; });
  if (here.phase !== 'done') return needs(`${MACHINE_NAME}: ${here.detail}`, { kind: here.kind || 'here', where: 'here', projectId: mine.id, sessionId: here.sessionId || null, files: here.files || null });
  for (const n of here.notes || []) note(n);

  // 3. the others take what is new
  for (const r of farRows) {
    const f = fars[r.which];
    if (!f || r.status === 'off') continue;
    setCross(remote, { phase: 'pulling', label: 'Pulling', detail: `${r.name} is pulling`, where: r.which });
    const out = await farStep(f, remote);
    if (out.skipped) { if (!notes.includes(out.why)) notes.push(out.why); continue; }
    if (out.state.phase !== 'done') notes.push(`${r.name} could not pull: ${out.state.detail}`);
    else for (const n of out.state.notes || []) note(`${r.name}: ${n}`);
  }

  const after = await readMachines().catch(() => null);
  const left = after ? (after.shared.find((s) => s.remote === remote) || { rows: [] }).rows.filter((r) => r.status === 'todo' || r.status === 'stuck') : [];
  if (left.length) return needs(left.map((r) => `${r.name}: ${r.words}`).join('; '), { kind: 'left' });
  return setCross(remote, { phase: 'done', label: 'Synced', detail: here.detail === 'Already in step' && !notes.length ? 'Every computer is in step' : 'Every computer that is on is in step', notes, where: null, endedAt: new Date().toISOString() });
}

// POST /api/sync/machines/sync { remote }: answers with the first state; the rest arrives as 'machines.sync' events.
export function startCross(remote) {
  const want = normRemote(remote);
  if (!want) throw fail(400, 'remote is required');
  if (crossing) throw fail(409, 'A sync is already running');
  crossing = runCross(want)
    .catch((err) => {
      console.error('[machines] sync failed:', err);
      return setCross(want, { phase: 'needs', label: 'Needs you', detail: `Sync failed: ${err.message}`, kind: 'error' });
    })
    .finally(() => { crossing = null; });
  return crossStates.get(want);
}

// POST /api/sync/machines/restart { which: 'pc' | 'hub', all }: that computer's server restarts (its own supervisor starts
// it again). Running conversations there keep going where a runner holds them. all: its runner and bridge restart too, so
// its running conversations stop; it answers before its bridge restarts, as the link runs through that bridge.
export async function restartFar(which, all = false) {
  const f = far(which);
  if (!f) throw fail(404, which === 'hub' ? 'This PC has no hub' : 'This PC is not paired with another PC');
  const before = await startedOf(f);
  let r;
  try {
    r = await f.call('POST', '/api/server/restart', { json: all ? { confirm: true, all: true } : { confirm: true } });
  } catch (err) {
    throw fail(503, `It did not answer: ${err.message}`);
  }
  if (r.status !== 200) throw fail(r.status === 409 || r.status === 403 ? r.status : 502, r.status === 403 ? `It has not allowed ${MACHINE_NAME} to restart all three (there: Connections, paired devices, Linked computer)` : errText(r));
  afterRestart(f, before);
  return r.json;
}

async function startedOf(f) {
  const st = await f.call('GET', '/api/server/status', { timeout: 5e3 }).catch(() => null);
  return st && st.status === 200 && st.json && st.json.server ? String(st.json.server.startedAt) : null;
}

// Once that server is back (it started again), every computer is read again, so the panel stops saying a restart is due
// without a click on its refresh button.
async function afterRestart(f, before) {
  const until = Date.now() + RESTART_WAIT_MS;
  await sleep(Math.min(3000, RESTART_WAIT_MS));
  while (Date.now() < until) {
    const now = await startedOf(f);
    if (now && (!before || now !== before)) break;
    await sleep(Math.min(2000, RESTART_WAIT_MS));
  }
  await readMachines().catch(() => {});
}

// POST /api/sync/machines/ask { remote, model }: a conversation about what stopped Sync all, where it stopped. Here: its
// session id, to open in the Talk layout. On the other computer: it starts there, and the answer has a one-use address
// that opens that computer's own pages, where the conversation is. Sonnet, or Opus for a hard one; nothing is pushed
// without the user's yes in that conversation.
export async function askCross(remote, model) {
  const want = normRemote(remote);
  const st = want ? crossStates.get(want) : null;
  if (!st || st.phase !== 'needs') throw fail(409, 'This sync has nothing to ask about');
  const family = model === 'opus' ? 'opus' : 'sonnet';
  if (st.where === 'here' || !st.where) {
    if (!st.projectId) throw fail(409, 'This stop has no project here to talk about');
    const r = await askAboutSync(st.projectId, family);
    return { where: 'here', projectId: st.projectId, sessionId: r.sessionId };
  }
  const f = far(st.where);
  if (!f || !f.on) throw fail(503, 'That computer is not online');
  let r;
  try {
    r = await f.call('POST', '/api/sync/remote/ask', { json: { remote: want, model: family }, timeout: 40e3 });
  } catch (err) {
    throw fail(503, `It did not answer: ${err.message}`);
  }
  if (r.status !== 200) throw fail(r.status === 403 ? 403 : 502, errText(r));
  let url = null;
  if (st.where === 'pc') url = (await enterUrl().catch(() => null))?.url || null;
  return { where: st.where, sessionId: r.json && r.json.sessionId, url };
}
