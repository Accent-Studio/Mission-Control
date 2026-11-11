// Mission Control's own MCP server (Streamable HTTP, JSON answers only): the tools Claude uses to read and write tasks,
// and to rename its own conversation when the subject moves (conversation_title).
// runs.js gives each Claude process it starts a config that points here, with the run's id in a header (X-MC-Run), so a
// tool call knows its conversation and project. Plain chats and the hub do not get it.
import { runCaller } from './runs.js';
import * as T from './tasks.js';
import { getProject } from './catalog.js';
import { getMeta, setAutoTitle } from './sessionMeta.js';
import { publish } from '../lib/events.js';
import { cleanTitle } from './autoTitle.js';
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_MODELS_DIR } from '../config.js';
import { expandLoad, groupOf } from '../lib/localModels.js';
import { webSearch } from './webSearch.js';
import { ask as askModel, modelsStatus } from './modelAsk.js';

export const SERVER_NAME = 'mc'; // tools show to Claude as mcp__mc__<tool>
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Mission Control's task list, shared by the user and you. The user sees it as a board (Inbox, To do, Doing, Review, Done) next to this conversation.
- Each task has "from" (who created it) and "for" (who should do it): "me" is the user, "claude" is you. You may create tasks for yourself and for the user (for example "test this on the phone").
- When you finish a piece of work and next steps remain, add them as tasks (with notes and doneWhen) instead of only listing them in your reply.
- When you work on a task: task_start, tick its steps with task_step as you go, write progress or findings with task_note, then task_finish with a short summary. task_finish sends it to Review; only the user marks a task done.
- When you cannot go on, use task_block with the reason; the user sees it in Needs you.
- Never delete a task. You may drop only a task you created, with a reason (task_update status "dropped").
- Dates are 2026-11-03 or 2026-11-03T14:00 (local time). Priority: 1 urgent, 2 high, 3 normal, 4 low.
- The project defaults to the one this conversation runs in.`;

// The name of the conversation (conversation_title): Mission Control names it from its first message (autoTitle.js), and
// Claude, who has the whole conversation in front of it, renames it when the subject has moved for good.
const TITLE_RULES = `
Conversation name: Mission Control names this conversation from its first message, and the user finds conversations again by their names. Conversations drift, so after each reply judge in silence whether the name still fits:
- Keep it for an aside: a quick question or two on something else before going back to the main subject. Keep it too when the new subject is a part or the next step of the named one.
- Rename with conversation_title when the conversation has durably moved: the last few exchanges are about something else and the work goes on there. Name what it is about now; when the earlier subject still carries weight, cover both.
- Do it once per shift, never every turn, and do not mention the name or this check in your reply unless the user asks. Not sure what it is called now? Call conversation_title with no title to read it.
- A name the user gave stays; the tool says so. The style: 2 to 6 words, sentence case, American English, no quotes, no period, no emoji, without the project name.`;

const str = (description) => ({ type: 'string', description });
const strs = (description) => ({ type: 'array', items: { type: 'string' }, description });
const FIELDS = {
  title: str('One line'),
  notes: str('Markdown: details, context, links'),
  doneWhen: strs('The checks that must be true before the task may be finished, one per item'),
  steps: strs('The checklist, in order'),
  for: { type: 'string', enum: ['me', 'claude'], description: '"me" is the user, "claude" is you' },
  priority: { type: 'integer', enum: [1, 2, 3, 4], description: '1 urgent, 2 high, 3 normal (default), 4 low' },
  due: str('Deadline: 2026-11-03 or 2026-11-03T14:00, or "" for none'),
  planned: str('When to work on it: a day or a day and time, or "" for none'),
  estimate: { type: 'string', enum: ['S', 'M', 'L', 'XL'] },
  after: strs('Ids of tasks that must be done first'),
  tags: strs('Free words'),
  project: str('Project id or name; "none" for a personal task. Defaults to this conversation\'s project'),
  target: str('Id of the target this task counts toward (TG-3), or "" for none'),
};
const ID = { id: str('Task id, for example MC-12') };

const TOOLS = [
  {
    name: 'tasks_list',
    description: 'List tasks as short rows. By default the open tasks (not done or dropped) of this conversation\'s project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: str('Project id or name, "all" for every project, "none" for personal tasks'),
        status: str('inbox, todo, doing, review, done, dropped, or "open" (default); several with commas'),
        for: FIELDS.for,
        from: { type: 'string', enum: ['me', 'claude'] },
        tag: str('Only tasks with this tag'),
        text: str('Words in the title, notes or id'),
      },
    },
  },
  { name: 'task_get', description: 'One task in full: notes, done-when, steps, links and the last log lines.', inputSchema: { type: 'object', properties: ID, required: ['id'] } },
  {
    name: 'task_add',
    description: 'Create one task, or several with "tasks". Lands in Inbox unless a status is given.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FIELDS,
        status: { type: 'string', enum: ['inbox', 'todo', 'doing', 'review'] },
        tasks: { type: 'array', items: { type: 'object', properties: { ...FIELDS, status: { type: 'string', enum: ['inbox', 'todo', 'doing', 'review'] } }, required: ['title'] }, description: 'Several tasks at once (then leave the other fields out)' },
      },
    },
  },
  {
    name: 'task_update',
    description: 'Change fields of a task. Only the fields given change. "steps" replaces the whole checklist (ticks are kept for steps with the same text).',
    inputSchema: {
      type: 'object',
      properties: { ...ID, ...FIELDS, status: { type: 'string', enum: ['inbox', 'todo', 'doing', 'review', 'dropped'] }, reason: str('Why, when dropping') },
      required: ['id'],
    },
  },
  {
    name: 'task_step',
    description: 'Tick or untick a step (by number, from 1), or add a step.',
    inputSchema: { type: 'object', properties: { ...ID, step: { type: 'integer', description: 'Step number, from 1' }, done: { type: 'boolean', description: 'Default: flip it' }, add: str('Text of a new step to add at the end') }, required: ['id'] },
  },
  { name: 'task_note', description: 'Add a dated line to the task\'s log: progress, a finding, or a question for the user.', inputSchema: { type: 'object', properties: { ...ID, text: str('The note') }, required: ['id', 'text'] } },
  { name: 'task_start', description: 'Mark the task Doing and link it to this conversation.', inputSchema: { type: 'object', properties: ID, required: ['id'] } },
  { name: 'task_finish', description: 'Ask to close the task: it moves to Review with your summary. The user approves it or sends it back.', inputSchema: { type: 'object', properties: { ...ID, summary: str('What was done, how it was checked, the commits') }, required: ['id', 'summary'] } },
  {
    name: 'targets_list',
    description: 'The targets (goals: a group of tasks that belong together, with or without a date) of this conversation\'s project, or "all", with how many of their tasks are done and the pace.',
    inputSchema: { type: 'object', properties: { project: str('Project id or name, or "all"') } },
  },
  {
    name: 'target_add',
    description: 'Make a target (a goal): a group of tasks that belong together, such as one feature or one larger piece of work, with a date if it has one. Its tasks may come from any project. Give the ids of the tasks that make it up (or set "target" on tasks later).',
    inputSchema: { type: 'object', properties: { title: str('One line'), due: str('The date, if it has one: 2026-11-14'), project: FIELDS.project, tasks: strs('Ids of the tasks that count toward it') }, required: ['title'] },
  },
  { name: 'task_block', description: 'The task cannot go on: say why. It shows in the user\'s Needs you.', inputSchema: { type: 'object', properties: { ...ID, reason: str('What is missing or what the user must decide') }, required: ['id', 'reason'] } },
];

// Claude's way to hand a short job to a local model (services/modelAsk.js): on this PC, or on the PC this one is linked
// to, through the link. A conversation that runs on a local model does not get it.
const MODEL_TOOLS = [
  {
    name: 'local_model',
    description: 'Hand a short, self-contained text job to the user\'s local model (Qwen on this PC or on the linked home PC): a translation, an extraction, a second check of a text. Text in, text out: it has no tools, no files and no memory between calls, so put everything it needs in the prompt and ask for a strict output format. Runs at no API cost but is slower and weaker than you; check what it returns. Fails at once when the PC that runs it is off (nothing is queued). Guest or client data: send only text that was already anonymized.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: str('The whole job and its text'),
        system: str('Optional instructions that frame every answer (role, output format)'),
        effort: { type: 'string', enum: ['none', 'low', 'medium', 'xhigh'], description: 'How long it may think first. none (default) answers at once; medium or xhigh for harder reasoning, much slower' },
        maxTokens: { type: 'integer', description: 'Longest answer, in tokens (default 4096)' },
        model: str('Model id; left out, the first local model (this PC\'s, else the linked PC\'s). local_model with list: true shows them'),
        list: { type: 'boolean', description: 'Only list the local models and whether their PC is reachable' },
      },
    },
  },
];
function modelList(st) {
  const out = [];
  for (const m of st.here) out.push(`${m.id} (${m.label}) on this PC (${st.machine}), ${m.loaded ? 'loaded' : 'loads on first use'}`);
  const l = st.linked;
  if (l) {
    if (l.error && !l.models.length) out.push(`${l.machine}: ${l.error}`);
    for (const m of l.models) out.push(`${m.id} (${m.label}) on ${l.machine}, ${l.online ? (m.loaded ? 'online, loaded' : 'online, loads on first use') : 'not reachable now'}`);
  }
  return out.length ? out.join('\n') : 'No local model on this PC or on a linked PC.';
}
async function callModelTool(a) {
  if (a.list) return modelList(await modelsStatus({ fresh: true }));
  const r = await askModel({ prompt: a.prompt, system: a.system, effort: a.effort, maxTokens: a.maxTokens, model: a.model });
  const where = `${r.label} on ${r.machine}, effort ${r.effort}, ${(r.ms / 1000).toFixed(1)} s, ${r.outTokens} tokens out${r.stop === 'max_tokens' ? ', CUT SHORT at maxTokens' : ''}`;
  return `${r.text || '(empty answer)'}\n\n[${where}]`;
}

// Only a conversation on a local model gets these two: it starts with a few tools and loads the others when it needs them
// (llmgate/index.js keeps the list of every tool in tool-catalog.json, and adds the loaded ones to its requests).
const LOCAL_TOOLS = [
  { name: 'tools_list', description: 'List the tools of one group (from the groups in your instructions), one line each.', inputSchema: { type: 'object', properties: { group: str('Group name, for example blender') }, required: ['group'] } },
  { name: 'tools_load', description: 'Load tools by name (or a small group by its name). They can be called from your next step on.', inputSchema: { type: 'object', properties: { names: strs('Tool names from tools_list, or a group name') }, required: ['names'] } },
  { name: 'web_search', description: 'Search the internet (DuckDuckGo). Returns titles, addresses and snippets; read a page with WebFetch.', inputSchema: { type: 'object', properties: { query: str('What to look for') }, required: ['query'] } },
];
function toolCatalog() {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCAL_MODELS_DIR, 'tool-catalog.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}
function callLocalTool(name, a) {
  const catalog = toolCatalog();
  if (name === 'tools_list') {
    const g = String(a.group || '').trim();
    const list = Object.entries(catalog).filter(([n]) => groupOf(n) === g);
    if (!list.length) return `No group "${g}". Groups: ${[...new Set(Object.keys(catalog).map(groupOf))].sort().join(', ')}`;
    return list.map(([n, s]) => `${n}: ${s}`).join('\n');
  }
  const { names, refused } = expandLoad(a.names, catalog);
  const out = [];
  if (names.length) out.push(`Loaded: ${names.join(', ')}. You can call them from your next step on.`);
  if (refused.length) out.push(`Not loaded: ${refused.join(', ')} (unknown tool, or a group too big to load whole: pick tools with tools_list).`);
  return out.join('\n') || 'Nothing to load.';
}

// Reading and changing the conversation's own name (TITLE_RULES). Not for a conversation on a local model.
const TITLE_TOOLS = [
  {
    name: 'conversation_title',
    description: 'The name of this conversation in Mission Control\'s list. Without title: what it is called now. With title: rename it, when the conversation has durably moved to another subject (see the instructions); a short aside is no reason.',
    inputSchema: { type: 'object', properties: { title: str('The new name: 2 to 6 words, sentence case, no quotes or period') } },
  },
];
const sessionsMod = () => import('./sessions.js');
async function callTitleTool(a, caller) {
  if (!caller.sessionId) return 'This conversation has no id yet; try again after this reply.';
  const cur = await (await sessionsMod()).sessionTitle(caller.sessionId).catch(() => null);
  const userNamed = cur && (cur.titleSource === 'mc' || cur.titleSource === 'custom');
  const now = cur ? `"${cur.title}"${userNamed ? ' (named by the user)' : ''}` : 'not known yet';
  if (a.title === undefined || a.title === null || a.title === '') return `This conversation is called ${now}.`;
  if (userNamed) return `The user named this conversation "${cur.title}" themselves, so it keeps that name.`;
  const t = cleanTitle(String(a.title));
  if (!t) return 'That name cannot be used: give 2 to 6 words with letters, on one line.';
  if (cur && cur.title === t) return `It is already called "${t}".`;
  if (!setAutoTitle(caller.sessionId, t, { replace: true })) return `It is already called "${t}".`;
  publish('sessions.changed', { id: caller.sessionId });
  return `Renamed${cur ? ` from "${cur.title}"` : ''} to "${t}".`;
}

// ---- How a task reads to Claude ----

const PRIO = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
const projName = (id) => (id ? (getProject(id) || {}).name || id : 'personal');
function row(t) {
  const done = t.steps.filter((s) => s.done).length;
  const bits = [`${t.id} [${t.status}${t.blocked ? ', blocked' : ''}]`, PRIO[t.priority], `for ${t.for === 'me' ? 'user' : 'claude'}`];
  if (t.due) bits.push(`due ${t.due}`);
  if (t.planned) bits.push(`planned ${t.planned}`);
  if (t.steps.length) bits.push(`${done}/${t.steps.length} steps`);
  return `${bits.join(' · ')} · ${t.title}`;
}
function full(t) {
  const out = [row(t), `project: ${projName(t.project)} · from ${t.from === 'me' ? 'user' : 'claude'}${t.estimate ? ' · size ' + t.estimate : ''}${t.tags.length ? ' · tags ' + t.tags.join(', ') : ''}${t.after.length ? ' · after ' + t.after.join(', ') : ''}`];
  if (t.target) out.push(`target: ${t.target}`);
  if (t.blocked) out.push(`blocked: ${t.blocked}`);
  if (t.notes) out.push('', 'Notes:', t.notes);
  if (t.doneWhen.length) out.push('', 'Done when:', ...t.doneWhen.map((x) => `- ${x}`));
  if (t.steps.length) out.push('', 'Steps:', ...t.steps.map((s, i) => `${i + 1}. [${s.done ? 'x' : ' '}] ${s.text}`));
  const log = (t.log || []).slice(-12);
  if (log.length) out.push('', 'Log:', ...log.map((l) => `${l.at.slice(0, 16).replace('T', ' ')} ${l.who === 'me' ? 'user' : 'claude'}: ${l.text}`));
  return out.join('\n');
}

// How a target is going: the share of its tasks done against the share of its time used.
export function pace(g) {
  const ts = T.listTasks({ project: 'all' }).filter((t) => t.target === g.id && t.status !== 'dropped');
  const total = ts.length, done = ts.filter((t) => t.status === 'done').length;
  if (!g.due) return { total, done, word: total && done === total ? 'done' : !total ? 'no tasks yet' : 'no date' };
  const start = Date.parse(g.created), end = Date.parse(g.due.length === 10 ? g.due + 'T23:59' : g.due), now = Date.now();
  const days = Math.max(1, (end - start) / 864e5);
  let word;
  if (total && done === total) word = 'done';
  else if (now > end) word = 'late';
  else if (!total) word = 'no tasks yet';
  else {
    const behind = Math.round((Math.min(1, Math.max(0, (now - start) / (end - start))) - done / total) * days);
    word = behind >= 1 ? `behind by ${behind} day${behind === 1 ? '' : 's'}` : behind <= -1 ? `ahead by ${-behind} day${behind === -1 ? '' : 's'}` : 'on pace';
  }
  return { total, done, word };
}

// ---- Calls ----

function callTool(name, a, caller) {
  const actor = { who: 'claude', session: caller.sessionId || null };
  const withProject = (x) => (x.project === undefined && caller.projectId !== undefined ? { ...x, project: caller.projectId } : x);
  switch (name) {
    case 'tasks_list': {
      const f = { ...a };
      if (f.project === undefined) f.project = caller.projectId === undefined ? 'all' : caller.projectId;
      if (!f.status) f.status = 'open';
      const list = T.listTasks(f).slice().sort((x, y) => x.priority - y.priority || String(x.due || '9').localeCompare(String(y.due || '9')) || x.order - y.order);
      return list.length ? list.slice(0, 200).map(row).join('\n') + (list.length > 200 ? `\n(${list.length - 200} more)` : '') : 'No tasks match.';
    }
    case 'task_get':
      return full(T.getTask(a.id));
    case 'task_add': {
      const list = Array.isArray(a.tasks) && a.tasks.length ? a.tasks : [a];
      const made = T.createTasks(list.slice(0, 50).map(withProject), actor);
      return 'Created:\n' + made.map(row).join('\n');
    }
    case 'task_update': {
      const { id, ...patch } = a;
      return 'Updated:\n' + row(T.updateTask(id, patch, actor));
    }
    case 'task_step':
      return full(T.stepTask(a.id, a, actor));
    case 'task_note':
      T.noteTask(a.id, a.text, actor);
      return 'Noted.';
    case 'task_start':
      return 'Started:\n' + full(T.startTask(a.id, actor));
    case 'task_finish':
      return 'Sent to Review:\n' + row(T.finishTask(a.id, a.summary, actor));
    case 'targets_list': {
      const project = a.project === undefined ? (caller.projectId === undefined ? 'all' : caller.projectId) : a.project;
      const gs = T.listTargets({ project });
      if (!gs.length) return 'No targets.';
      return gs.map((g) => { const p = pace(g); return `${g.id} · ${g.due ? 'due ' + g.due : 'no date'} · ${projName(g.project)} · ${p.done}/${p.total} tasks done · ${p.word} · ${g.title}`; }).join('\n');
    }
    case 'target_add': {
      const g = T.addTarget(withProject(a), actor);
      const p = pace(g);
      return `Created ${g.id} · ${g.due ? 'due ' + g.due : 'no date'} · ${p.total} tasks · ${g.title}`;
    }
    case 'task_block':
      return 'Blocked:\n' + row(T.blockTask(a.id, a.reason, actor));
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { rpc: -32602 });
  }
}

// Who calls: the run named in the X-MC-Run header (its conversation and project). Unknown: no conversation, every project.
function callerOf(req) {
  const c = runCaller(String(req.headers['x-mc-run'] || ''));
  if (!c) return { sessionId: null, projectId: undefined, local: false };
  // the project it was tagged with by hand (a conversation that changed subject), else the one it was started in, else
  // the one its folder is in
  const tagged = c.sessionId ? ((getMeta(c.sessionId) || {}).tags || []).find((id) => getProject(id)) : null;
  const projectId = tagged || c.projectId || T.projectOfFolder(c.cwd);
  return { sessionId: c.sessionId, projectId: projectId || undefined, local: !!c.local };
}

// One JSON-RPC message in, its answer out (null for a notification).
export function handleRpc(msg, req) {
  const id = msg && msg.id;
  const isNote = id === undefined || id === null;
  const ok = (result) => (isNote ? null : { jsonrpc: '2.0', id, result });
  const err = (code, message) => (isNote ? null : { jsonrpc: '2.0', id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(-32600, 'Invalid request');
  const p = msg.params && typeof msg.params === 'object' ? msg.params : {};
  switch (msg.method) {
    case 'initialize': {
      const answer = (instructions) => ok({
        protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mission-control', version: '1.0.0' },
        instructions,
      });
      const caller = callerOf(req);
      if (caller.local) return answer(INSTRUCTIONS);
      if (!caller.sessionId) return answer(INSTRUCTIONS + TITLE_RULES);
      // a conversation that goes on: its name as this process starts (it may change later; the tool reads it fresh)
      return sessionsMod().then((m) => m.sessionTitle(caller.sessionId)).catch(() => null)
        .then((cur) => answer(INSTRUCTIONS + TITLE_RULES + (cur && cur.title ? `\nIt is called "${cur.title}" as this session starts.` : '')));
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: callerOf(req).local ? [...TOOLS, ...LOCAL_TOOLS] : [...TOOLS, ...MODEL_TOOLS, ...TITLE_TOOLS] });
    case 'tools/call': {
      const name = String(p.name || '');
      const caller = callerOf(req);
      const local = caller.local && LOCAL_TOOLS.some((t) => t.name === name);
      const model = !caller.local && MODEL_TOOLS.some((t) => t.name === name);
      const title = !caller.local && TITLE_TOOLS.some((t) => t.name === name);
      if (!local && !model && !title && !TOOLS.some((t) => t.name === name)) return err(-32602, `Unknown tool: ${name}`);
      const args = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
      try {
        if (model) {
          return callModelTool(args)
            .then((text) => ok({ content: [{ type: 'text', text }] }))
            .catch((e) => ok({ content: [{ type: 'text', text: `The local model gave no answer: ${e.message}` }], isError: true }));
        }
        if (title) {
          return callTitleTool(args, caller)
            .then((text) => ok({ content: [{ type: 'text', text }] }))
            .catch((e) => ok({ content: [{ type: 'text', text: `Could not rename it: ${e.message}` }], isError: true }));
        }
        if (local && name === 'web_search') {
          return webSearch(args.query)
            .then((text) => ok({ content: [{ type: 'text', text }] }))
            .catch((e) => ok({ content: [{ type: 'text', text: `The search failed: ${e.message}` }], isError: true }));
        }
        return ok({ content: [{ type: 'text', text: local ? callLocalTool(name, args) : callTool(name, args, caller) }] });
      } catch (e) {
        if (e.rpc) return err(e.rpc, e.message);
        return ok({ content: [{ type: 'text', text: e.message || 'failed' }], isError: true });
      }
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return err(-32601, `Method not found: ${msg.method}`);
  }
}
