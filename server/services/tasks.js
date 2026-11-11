// Tasks: one list for every project, for the user and for Claude. Kept in .data/tasks.json.
// The pages change them through routes/tasks.js, Claude through the MCP tools (services/mcp.js). Every change is logged
// with who made it (and, for Claude, the conversation it came from) and published as a 'tasks' event.
// Guard rails for Claude: it never deletes a task, it cannot set Done (task_finish sends a task to Review), and it may
// drop only a task it created itself, with a reason.
// Every task and target has a uid, the same on every PC; services/taskSync.js shares them through the hub (syncOut,
// syncIn). A deleted one leaves a note in `gone` until the hub has it.
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { publish } from '../lib/events.js';
import { readJson, writeJson, busyError } from '../lib/jsonStore.js';
import { getProject, loadCatalog } from './catalog.js';
import { pcLinkStatus, pcProjectKnown } from './pcLink.js';

const FILE = path.join(DATA_DIR, 'tasks.json');
export const STATUSES = ['inbox', 'todo', 'doing', 'review', 'done', 'dropped'];
export const PEOPLE = ['me', 'claude'];
export const ESTIMATES = ['S', 'M', 'L', 'XL'];
const PERSONAL = 'ME'; // the id key of a task with no project
const MAX_TASKS = 20000;
const MAX_LOG = 200;
const RETRY_MS = 60e3;

let db = null; // { keys: { projectId: 'MC' }, seq: { MC: 12 }, tasks: [...], targets: [...], gone: [{ kind, uid, id, deleted, updated }] }

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

let retryT = null;
function load() {
  if (db) return db;
  const r = readJson(FILE, 'tasks');
  if (!r.ok) {
    if (!retryT) {
      retryT = setTimeout(() => {
        retryT = null;
        if (load()) publish('tasks', { ids: [] });
      }, RETRY_MS);
      if (retryT.unref) retryT.unref();
    }
    return null;
  }
  const o = r.value && typeof r.value === 'object' ? r.value : {};
  db = {
    keys: o.keys && typeof o.keys === 'object' ? o.keys : {},
    seq: o.seq && typeof o.seq === 'object' ? o.seq : {},
    tasks: Array.isArray(o.tasks) ? o.tasks.filter((t) => t && typeof t.id === 'string') : [],
    targets: Array.isArray(o.targets) ? o.targets.filter((t) => t && typeof t.id === 'string') : [],
    gone: Array.isArray(o.gone) ? o.gone.filter((g) => g && typeof g.uid === 'string') : [],
  };
  // tasks made before the sync: each gets its uid once
  let fresh = false;
  for (const x of [...db.tasks, ...db.targets]) if (typeof x.uid !== 'string') { x.uid = crypto.randomUUID(); fresh = true; }
  if (fresh) writeJson(FILE, { v: 1, keys: db.keys, seq: db.seq, tasks: db.tasks, targets: db.targets, gone: db.gone });
  return db;
}

function must() {
  const d = load();
  if (!d) throw busyError(FILE);
  return d;
}

function save(ids) {
  writeJson(FILE, { v: 1, keys: db.keys, seq: db.seq, tasks: db.tasks, targets: db.targets, gone: db.gone });
  publish('tasks', { ids });
}

// ---- Projects ----

function projects() {
  const list = loadCatalog();
  return Array.isArray(list) ? list : [];
}

// A project by id or by name (Claude may say either). Null, '', 'none' or 'personal' is no project. This PC's projects
// come first, then those of the PC it is linked to (services/pcLink.js): a task for one of them keeps that PC's id, so a
// conversation for it starts there.
export function resolveProject(p) {
  if (p === undefined) return undefined;
  if (p === null || p === '' || /^(none|personal|me)$/i.test(String(p))) return null;
  const s = String(p).trim();
  const byId = getProject(s);
  if (byId) return byId.id;
  const low = s.toLowerCase();
  const same = (x) => String(x.name).toLowerCase() === low || String(x.id).toLowerCase() === low;
  const hit = projects().find(same) || (pcLinkStatus().projects || []).find(same);
  if (hit) return hit.id;
  // a project of the other PC while it is off: known by the tasks of it that came here with the sync (its id key)
  const d = load();
  if (d && Object.prototype.hasOwnProperty.call(d.keys, s) && d.tasks.some((t) => t.project === s)) return s;
  throw fail(400, `unknown project: ${s}`);
}

// A project's name, here or on the linked PC; its id when neither knows it.
function projectName(id) {
  const p = getProject(id) || pcProjectKnown(id);
  return (p && p.name) || id;
}

// The project whose folder holds this one (a conversation started in a project folder, or below it).
export function projectOfFolder(folder) {
  if (!folder) return null;
  const f = path.resolve(String(folder)).toLowerCase();
  let best = null;
  for (const p of projects()) {
    if (!p.folder) continue;
    const root = path.resolve(p.folder).toLowerCase();
    if ((f === root || f.startsWith(root + path.sep)) && (!best || root.length > best.root.length)) best = { id: p.id, root };
  }
  return best ? best.id : null;
}

// The short key of a project's task ids: the capitals of its name (MissionControl: MC), else its first letters.
function keyFor(projectId) {
  const d = db;
  if (!projectId) return PERSONAL;
  if (d.keys[projectId]) return d.keys[projectId];
  const name = String(projectName(projectId));
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let k = words.length > 1 ? words.map((w) => w[0]).join('') : (name.match(/[A-Z]/g) || []).join('');
  if (k.length < 2) k = name.replace(/[^A-Za-z]/g, '').slice(0, 3);
  k = (k || 'T').toUpperCase().slice(0, 4);
  const taken = new Set([PERSONAL, ...Object.values(d.keys)]);
  let key = k;
  for (let n = 2; taken.has(key); n++) key = k + n;
  d.keys[projectId] = key;
  return key;
}

// ---- Values ----

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAYTIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
function when(v, field) {
  if (v === null || v === '') return null;
  const s = String(v).trim();
  if ((DAY.test(s) || DAYTIME.test(s)) && !Number.isNaN(Date.parse(s.length === 10 ? s + 'T00:00' : s))) return s;
  throw fail(400, `${field} must be a date (2026-11-03) or a date and time (2026-11-03T14:00)`);
}
const text = (v, max, field) => {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') throw fail(400, `${field} must be text`);
  return v.slice(0, max);
};
const lines = (v, field) => {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : String(v).split('\n');
  return arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 50).map((x) => x.slice(0, 500));
};
const tags = (v) => [...new Set(lines(v, 'tags').map((x) => x.replace(/^#/, '').slice(0, 40)).filter(Boolean))].slice(0, 20);
function steps(v, old) {
  const arr = Array.isArray(v) ? v : lines(v, 'steps');
  return arr.slice(0, 100).map((s, i) => {
    if (typeof s === 'string') {
      const was = old && old.find((o) => o.text === s.trim());
      return { text: s.trim().slice(0, 500), done: was ? !!was.done : false };
    }
    if (s && typeof s === 'object' && typeof s.text === 'string') return { text: s.text.trim().slice(0, 500), done: !!s.done };
    throw fail(400, `step ${i + 1} must be text`);
  }).filter((s) => s.text);
}
function priority(v) {
  const n = Number(v);
  if (![1, 2, 3, 4].includes(n)) throw fail(400, 'priority must be 1 (urgent), 2 (high), 3 (normal) or 4 (low)');
  return n;
}
function person(v, field) {
  if (!PEOPLE.includes(v)) throw fail(400, `${field} must be "me" or "claude"`);
  return v;
}

// ---- Reading ----

export function getTask(id) {
  const d = must();
  const t = d.tasks.find((x) => x.id.toLowerCase() === String(id || '').trim().toLowerCase());
  if (!t) throw fail(404, `no task ${id}`);
  return t;
}

// filter: { project (id, 'all', or null for personal), status (one or a list, 'open' = not done or dropped), for, from, tag, text }
export function listTasks(filter = {}) {
  const d = must();
  let out = d.tasks;
  if (filter.project !== undefined && filter.project !== 'all') {
    const pid = resolveProject(filter.project);
    out = out.filter((t) => (t.project || null) === pid);
  }
  if (filter.status) {
    const want = Array.isArray(filter.status) ? filter.status : String(filter.status).split(',');
    const open = want.includes('open');
    out = out.filter((t) => want.includes(t.status) || (open && t.status !== 'done' && t.status !== 'dropped'));
  }
  if (filter.for) out = out.filter((t) => t.for === filter.for);
  if (filter.from) out = out.filter((t) => t.from === filter.from);
  if (filter.tag) out = out.filter((t) => (t.tags || []).includes(String(filter.tag).replace(/^#/, '')));
  if (filter.text) {
    const q = String(filter.text).toLowerCase();
    out = out.filter((t) => (t.title + '\n' + t.notes + '\n' + t.id).toLowerCase().includes(q));
  }
  return out;
}

// ---- Changing ----

// actor: { who: 'me'|'claude', session: conversation id or null }
function logLine(t, actor, line) {
  t.log = t.log || [];
  t.log.push({ at: new Date().toISOString(), who: actor.who, ...(actor.session ? { session: actor.session } : {}), text: String(line).slice(0, 2000) });
  if (t.log.length > MAX_LOG) t.log.splice(0, t.log.length - MAX_LOG);
}

function link(t, actor) {
  if (!actor.session) return;
  t.links = t.links || [];
  if (!t.links.some((l) => l.kind === 'session' && l.id === actor.session)) t.links.push({ kind: 'session', id: actor.session, at: new Date().toISOString() });
}

function lastOrder(d, status) {
  return d.tasks.filter((t) => t.status === status).reduce((m, t) => Math.max(m, t.order || 0), 0);
}

export function addTask(input, actor) {
  const d = must();
  if (d.tasks.length >= MAX_TASKS) throw fail(409, 'too many tasks');
  const title = text(input.title, 300, 'title').trim();
  if (!title) throw fail(400, 'title is required');
  const project = input.project === undefined ? null : resolveProject(input.project);
  const status = input.status === undefined ? (actor.who === 'claude' ? 'inbox' : 'todo') : input.status;
  if (!STATUSES.includes(status)) throw fail(400, `status must be one of ${STATUSES.join(', ')}`);
  if (actor.who === 'claude' && (status === 'done' || status === 'dropped')) throw fail(403, 'Claude cannot create a task that is already done or dropped');
  const key = keyFor(project);
  d.seq[key] = (Number(d.seq[key]) || 0) + 1;
  const now = new Date().toISOString();
  const t = {
    id: `${key}-${d.seq[key]}`,
    uid: crypto.randomUUID(),
    project,
    title,
    notes: text(input.notes, 20000, 'notes'),
    doneWhen: lines(input.doneWhen, 'doneWhen'),
    steps: steps(input.steps || []),
    status,
    from: actor.who,
    for: input.for === undefined ? actor.who : person(input.for, 'for'),
    priority: input.priority === undefined || input.priority === null ? 3 : priority(input.priority),
    due: input.due === undefined ? null : when(input.due, 'due'),
    planned: input.planned === undefined ? null : when(input.planned, 'planned'),
    estimate: input.estimate ? (ESTIMATES.includes(input.estimate) ? input.estimate : null) : null,
    target: input.target ? targetRef(input.target) : null,
    after: lines(input.after, 'after'),
    tags: tags(input.tags),
    blocked: null,
    session: actor.session || null,
    links: [],
    log: [],
    order: lastOrder(d, status) + 1,
    created: now,
    updated: now,
  };
  link(t, actor);
  logLine(t, actor, 'created');
  d.tasks.push(t);
  return t;
}

export function createTasks(list, actor) {
  const d = must();
  const before = d.tasks.length;
  let made;
  try {
    made = list.map((x) => addTask(x, actor));
  } catch (err) {
    d.tasks.length = before; // all or nothing
    throw err;
  }
  save(made.map((t) => t.id));
  return made;
}

export function createTask(input, actor) {
  return createTasks([input], actor)[0];
}

// The fields a page or Claude may change. Status changes go through setStatus (it holds the rules).
export function updateTask(id, patch, actor) {
  must();
  const t = getTask(id);
  const said = [];
  if (patch.title !== undefined) {
    const v = text(patch.title, 300, 'title').trim();
    if (!v) throw fail(400, 'title cannot be empty');
    if (v !== t.title) said.push('renamed');
    t.title = v;
  }
  if (patch.notes !== undefined) { t.notes = text(patch.notes, 20000, 'notes'); said.push('notes changed'); }
  if (patch.doneWhen !== undefined) { t.doneWhen = lines(patch.doneWhen, 'doneWhen'); said.push('done-when changed'); }
  if (patch.steps !== undefined) { t.steps = steps(patch.steps, t.steps); said.push('steps changed'); }
  if (patch.priority !== undefined) { t.priority = priority(patch.priority); said.push(`priority ${t.priority}`); }
  if (patch.due !== undefined) { t.due = when(patch.due, 'due'); said.push(t.due ? `due ${t.due}` : 'no due date'); }
  if (patch.planned !== undefined) { t.planned = when(patch.planned, 'planned'); said.push(t.planned ? `planned ${t.planned}` : 'not planned'); }
  if (patch.estimate !== undefined) { t.estimate = ESTIMATES.includes(patch.estimate) ? patch.estimate : null; }
  if (patch.after !== undefined) t.after = lines(patch.after, 'after');
  if (patch.tags !== undefined) t.tags = tags(patch.tags);
  if (patch.for !== undefined) { t.for = person(patch.for, 'for'); said.push(`for ${t.for === 'me' ? 'you' : 'Claude'}`); }
  if (patch.project !== undefined) {
    const pid = resolveProject(patch.project);
    if (pid !== t.project) { t.project = pid; said.push('moved to ' + (pid ? projectName(pid) : 'personal')); }
  }
  if (patch.target !== undefined) { t.target = patch.target ? targetRef(patch.target) : null; said.push(t.target ? `target ${t.target}` : 'no target'); }
  if (patch.blocked !== undefined) t.blocked = patch.blocked ? text(patch.blocked, 2000, 'blocked') : null;
  if (patch.status !== undefined && patch.status !== t.status) setStatus(t, patch.status, actor, patch.reason);
  if (patch.order !== undefined && Number.isFinite(Number(patch.order))) t.order = Number(patch.order);
  if (said.length) logLine(t, actor, said.join(', '));
  link(t, actor);
  t.updated = new Date().toISOString();
  save([t.id]);
  return t;
}

function setStatus(t, status, actor, reason) {
  if (!STATUSES.includes(status)) throw fail(400, `status must be one of ${STATUSES.join(', ')}`);
  if (actor.who === 'claude') {
    if (status === 'done') throw fail(403, 'Only the user marks a task done. Use task_finish: it sends the task to Review.');
    if (status === 'dropped' && t.from !== 'claude') throw fail(403, 'Claude may drop only a task it created itself.');
    if (status === 'dropped' && !reason) throw fail(400, 'Say why the task is dropped (reason).');
  }
  const from = t.status;
  t.status = status;
  if (status !== 'doing') t.blocked = status === 'review' || status === 'done' || status === 'dropped' ? null : t.blocked;
  logLine(t, actor, `${from} → ${status}${reason ? ': ' + reason : ''}`);
}

export function deleteTask(id) {
  const d = must();
  const t = getTask(id);
  d.tasks = d.tasks.filter((x) => x !== t);
  d.gone.push({ kind: 'task', uid: t.uid, id: t.id, deleted: true, updated: new Date().toISOString() });
  save([t.id]);
  return { ok: true, id: t.id };
}

// Tick a step (by number, from 1) or add one.
export function stepTask(id, { step, done, add }, actor) {
  must();
  const t = getTask(id);
  if (add) {
    const s = text(add, 500, 'add').trim();
    if (!s) throw fail(400, 'the new step is empty');
    t.steps.push({ text: s, done: false });
    logLine(t, actor, `step added: ${s}`);
  } else {
    const i = Number(step) - 1;
    if (!Number.isInteger(i) || !t.steps[i]) throw fail(400, `step must be a number from 1 to ${t.steps.length}`);
    t.steps[i].done = done === undefined ? !t.steps[i].done : !!done;
    logLine(t, actor, `${t.steps[i].done ? 'ticked' : 'unticked'}: ${t.steps[i].text}`);
  }
  link(t, actor);
  t.updated = new Date().toISOString();
  save([t.id]);
  return t;
}

export function noteTask(id, line, actor) {
  must();
  const t = getTask(id);
  const s = text(line, 2000, 'note').trim();
  if (!s) throw fail(400, 'the note is empty');
  logLine(t, actor, s);
  link(t, actor);
  t.updated = new Date().toISOString();
  save([t.id]);
  return t;
}

export function startTask(id, actor) {
  must();
  const t = getTask(id);
  if (t.status === 'done' || t.status === 'dropped') throw fail(409, `${t.id} is ${t.status}`);
  if (t.status !== 'doing') setStatus(t, 'doing', actor);
  t.blocked = null;
  link(t, actor);
  t.updated = new Date().toISOString();
  save([t.id]);
  return t;
}

export function finishTask(id, summary, actor) {
  must();
  const t = getTask(id);
  if (t.status === 'done' || t.status === 'dropped') throw fail(409, `${t.id} is ${t.status}`);
  const s = text(summary, 4000, 'summary').trim();
  if (actor.who === 'claude') {
    if (!s) throw fail(400, 'Give a short summary of what was done.');
    setStatus(t, 'review', actor);
    logLine(t, actor, `finished: ${s}`);
  } else {
    setStatus(t, 'done', actor);
    if (s) logLine(t, actor, s);
  }
  link(t, actor);
  t.updated = new Date().toISOString();
  save([t.id]);
  return t;
}

export function blockTask(id, reason, actor) {
  must();
  const t = getTask(id);
  const s = text(reason, 2000, 'reason').trim();
  if (!s) throw fail(400, 'Say why the task cannot go on.');
  t.blocked = s;
  logLine(t, actor, `blocked: ${s}`);
  link(t, actor);
  t.updated = new Date().toISOString();
  save([t.id]);
  return t;
}

// The order of the tasks in one lane, top to bottom (a drag on the board). A task dragged in from another lane moves there.
export function orderLane(status, ids, actor) {
  const d = must();
  if (!STATUSES.includes(status)) throw fail(400, 'unknown lane');
  if (!Array.isArray(ids) || ids.length > 2000) throw fail(400, 'ids must be a list');
  const changed = [];
  ids.forEach((id, i) => {
    const t = d.tasks.find((x) => x.id === id);
    if (!t) return;
    if (t.status !== status) setStatus(t, status, actor);
    t.order = i + 1;
    t.updated = new Date().toISOString();
    changed.push(t.id);
  });
  save(changed);
  return { ok: true };
}

// What a page needs to show tasks: the tasks, and the project names and keys.
export function tasksState(filter) {
  const d = must();
  return { tasks: listTasks(filter), keys: d.keys, targets: d.targets };
}

// ---- Targets (Goals on the pages): a group of tasks that belong together, with a date or without one. Its tasks
// point at it (task.target) and may come from any project; its own project only says where it is listed. ----

function targetRef(id) {
  const d = must();
  const g = d.targets.find((x) => x.id.toLowerCase() === String(id).trim().toLowerCase());
  if (!g) throw fail(400, `no target ${id}`);
  return g.id;
}

export function listTargets(filter = {}) {
  const d = must();
  if (filter.project === undefined || filter.project === 'all') return d.targets;
  const pid = resolveProject(filter.project);
  return d.targets.filter((g) => (g.project || null) === pid);
}

export function addTarget(input, actor) {
  const d = must();
  const title = text(input.title, 200, 'title').trim();
  if (!title) throw fail(400, 'title is required');
  const n = d.targets.reduce((m, g) => Math.max(m, Number(String(g.id).split('-').pop()) || 0), 0) + 1;
  const now = new Date().toISOString();
  const g = { id: `TG-${n}`, uid: crypto.randomUUID(), project: input.project === undefined ? null : resolveProject(input.project), title, due: input.due ? when(input.due, 'due') : null, from: actor.who, created: now, updated: now };
  d.targets.push(g);
  for (const id of lines(input.tasks, 'tasks')) {
    const t = d.tasks.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (t) { t.target = g.id; logLine(t, actor, `target ${g.id}`); t.updated = now; }
  }
  save([]);
  return g;
}

export function updateTarget(id, patch) {
  must();
  const g = db.targets.find((x) => x.id === targetRef(id));
  if (patch.title !== undefined) { const v = text(patch.title, 200, 'title').trim(); if (!v) throw fail(400, 'title cannot be empty'); g.title = v; }
  if (patch.due !== undefined) g.due = patch.due ? when(patch.due, 'due') : null;
  if (patch.project !== undefined) g.project = resolveProject(patch.project);
  g.updated = new Date().toISOString();
  save([]);
  return g;
}

export function deleteTarget(id) {
  const d = must();
  const gid = targetRef(id);
  const g = d.targets.find((x) => x.id === gid);
  d.targets = d.targets.filter((x) => x !== g);
  const now = new Date().toISOString();
  d.gone.push({ kind: 'target', uid: g.uid, id: gid, deleted: true, updated: now });
  for (const t of d.tasks) if (t.target === gid) { t.target = null; t.updated = now; }
  save([]);
  return { ok: true, id: gid };
}

// ---- Reminders: once when an open task comes due (a date alone: at 9:00 that day), and when its planned time comes ----

const REMIND_MS = Number(process.env.MC_TASK_REMIND_MS) > 0 ? Number(process.env.MC_TASK_REMIND_MS) : 30e3; // tests look more often
const at = (s) => new Date(s.length === 10 ? s + 'T09:00' : s).getTime();
function remind() {
  const d = load();
  if (!d) return;
  const now = Date.now();
  const hits = [];
  let marked = false;
  for (const t of d.tasks) {
    if (t.status === 'done' || t.status === 'dropped') continue;
    for (const k of ['due', 'planned']) {
      const v = t[k];
      if (!v || (t.reminded || {})[k] === v || at(v) > now) continue;
      t.reminded = { ...(t.reminded || {}), [k]: v };
      marked = true;
      // a date long past (the server was off, or the task was made late) is marked without a notice
      if (now - at(v) < 12 * 3600e3) hits.push({ id: t.id, title: t.title, project: t.project, for: t.for, kind: k, when: v });
    }
  }
  if (!marked) return;
  save(hits.map((h) => h.id));
  for (const h of hits) publish('task.due', h);
}
setInterval(() => {
  try {
    remind();
  } catch (err) {
    console.error('[tasks] reminders:', err.message);
  }
}, REMIND_MS).unref();

// ---- Sharing with the other PCs (services/taskSync.js) ----

const listOf = (kind) => (kind === 'task' ? db.tasks : db.targets);
const numOf = (id) => Number(String(id).split('-').pop()) || 0;
const prefixOf = (id) => String(id).replace(/-\d+$/, '');
// what the hub gets: the record without what stays on this PC (its reminders)
const outRec = (x) => { const { reminded, ...rec } = x; return rec; };

// Every record, as the hub takes them: { keys, items: [{ kind, rec }] }.
export function syncOut() {
  const d = load();
  if (!d) return null;
  return { keys: d.keys, items: [...d.tasks.map((t) => ({ kind: 'task', rec: outRec(t) })), ...d.targets.map((g) => ({ kind: 'target', rec: outRec(g) })), ...d.gone.map((g) => ({ kind: g.kind, rec: { uid: g.uid, id: g.id, deleted: true, updated: g.updated } }))] };
}

// The hub has the deletes up to here: their notes can go.
export function forgetGone(uids) {
  const d = load();
  if (!d || !uids.length) return;
  const set = new Set(uids);
  const before = d.gone.length;
  d.gone = d.gone.filter((g) => !set.has(g.uid));
  if (d.gone.length !== before) writeJson(FILE, { v: 1, keys: d.keys, seq: d.seq, tasks: d.tasks, targets: d.targets, gone: d.gone });
}

// Both logs, each line once, oldest first.
export function mergeLogs(a, b) {
  const seen = new Set();
  const out = [];
  for (const l of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!l || typeof l !== 'object') continue;
    const k = `${l.at}\u0000${l.who}\u0000${l.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  out.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  return out.slice(-MAX_LOG);
}

// A record takes another id (the hub's), and whatever points at it follows.
function renumber(kind, x, to) {
  const from = x.id;
  if (from === to) return;
  x.id = to;
  const p = prefixOf(to);
  if (kind === 'task') {
    db.seq[p] = Math.max(Number(db.seq[p]) || 0, numOf(to));
    for (const t of db.tasks) if (Array.isArray(t.after) && t.after.includes(from)) t.after = t.after.map((a) => (a === from ? to : a));
  } else {
    for (const t of db.tasks) if (t.target === from) t.target = to;
  }
}

// One past the highest number with these letters, on this PC.
function freeId(kind, id) {
  const p = prefixOf(id);
  const n = listOf(kind).reduce((m, x) => (prefixOf(x.id) === p ? Math.max(m, numOf(x.id)) : m), kind === 'task' ? Number(db.seq[p]) || 0 : 0);
  return `${p}-${n + 1}`;
}

// The records the hub sent ({ kind, rec }), and its project keys. The newer `updated` wins; the logs are put together.
// A record of this PC that has the id of one from the hub, and another uid, takes the next free number.
// Answers the ids that changed (for the 'tasks' event), or [] when nothing did.
export function syncIn(items, keys, renames = []) {
  const d = must();
  const ids = [];
  for (const r of renames) {
    const x = listOf(r.kind).find((y) => y.uid === r.uid);
    if (x && x.id === r.from) { renumber(r.kind, x, r.to); ids.push(r.to); }
  }
  for (const { kind, rec } of items) {
    if (!rec || (kind !== 'task' && kind !== 'target')) continue;
    const list = listOf(kind);
    const here = list.find((x) => x.uid === rec.uid);
    if (kind === 'task' && !rec.deleted) { const p = prefixOf(rec.id); d.seq[p] = Math.max(Number(d.seq[p]) || 0, numOf(rec.id)); }
    if (rec.deleted) {
      if (!here || here.updated > rec.updated) continue;
      list.splice(list.indexOf(here), 1);
      if (kind === 'target') for (const t of d.tasks) if (t.target === here.id) t.target = null;
      ids.push(here.id);
      continue;
    }
    if (d.gone.some((g) => g.uid === rec.uid)) continue; // deleted here, the hub hears it next
    if (here) {
      if (here.id !== rec.id) { renumber(kind, here, rec.id); ids.push(rec.id); }
      if (rec.updated > here.updated) {
        const keep = { reminded: here.reminded };
        if (kind === 'task') rec.log = mergeLogs(here.log, rec.log);
        for (const k of Object.keys(here)) delete here[k];
        Object.assign(here, rec, keep.reminded ? keep : {});
        ids.push(here.id);
      }
      continue;
    }
    const clash = list.find((x) => x.id === rec.id);
    if (clash) renumber(kind, clash, freeId(kind, rec.id));
    list.push({ ...rec });
    ids.push(rec.id);
  }
  for (const [pid, key] of Object.entries(keys && typeof keys === 'object' ? keys : {})) {
    if (!d.keys[pid] && !Object.values(d.keys).includes(key)) { d.keys[pid] = key; ids.push(''); }
  }
  if (ids.length) save([...new Set(ids.filter(Boolean))]);
  return ids;
}

// For tests: forget the cached file.
export function _reset() {
  db = null;
}
