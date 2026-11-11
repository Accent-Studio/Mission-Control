// Tests for tasks (server/services/tasks.js), their routes, and Mission Control's MCP endpoint (server/services/mcp.js).
// Claude is the FAKE CLI in tools/fakeclaude. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ROOT, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';
import { checkSpawnArgs, FIXED_ARGS } from '../../server/runner/shared.js';

const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

let shared = null;
async function boot() {
  if (shared) return shared;
  const dataDir = makeDataDir('mc-tasks');
  seedFixture(dataDir);
  shared = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '20', MC_TASK_REMIND_MS: '300' } });
  toStop.push(shared);
  return shared;
}

const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
let rpcId = 0;
async function rpc(s, method, params, run) {
  const headers = { 'X-MC': '1', Accept: 'application/json, text/event-stream' };
  if (run) headers['X-MC-Run'] = run;
  const r = await localReq(s, { method: 'POST', path: '/api/mcp', headers, body: { jsonrpc: '2.0', id: ++rpcId, method, params } });
  assert.equal(r.status, 200, r.text);
  return r.json;
}
const call = async (s, name, args, run) => {
  const r = await rpc(s, 'tools/call', { name, arguments: args }, run);
  return { text: r.result.content[0].text, error: !!r.result.isError };
};

describe('tasks', () => {
  test('the page adds, changes, ticks and deletes a task; ids carry the project key', async () => {
    const s = await boot();
    let r = await pc(s, 'POST', '/api/tasks', { title: 'Write the spec', project: 'fixture', steps: ['one', 'two'], due: '2026-11-03' });
    assert.equal(r.status, 200, r.text);
    const t = r.json.tasks[0];
    assert.match(t.id, /^F\w*-1$/);
    assert.equal(t.from, 'me');
    assert.equal(t.for, 'me');
    assert.equal(t.status, 'todo');
    r = await pc(s, 'PUT', `/api/tasks/${t.id}`, { priority: 1, for: 'claude', status: 'doing' });
    assert.equal(r.json.priority, 1);
    assert.equal(r.json.status, 'doing');
    r = await pc(s, 'POST', `/api/tasks/${t.id}/step`, { step: 2 });
    assert.equal(r.json.steps[1].done, true);
    r = await pc(s, 'PUT', `/api/tasks/${t.id}`, { due: 'friday' });
    assert.equal(r.status, 400);
    r = await pc(s, 'GET', '/api/tasks?project=fixture');
    assert.equal(r.json.tasks.length, 1);
    r = await pc(s, 'POST', `/api/tasks/${t.id}/delete`, {});
    assert.equal(r.status, 200);
    r = await pc(s, 'GET', '/api/tasks?project=fixture');
    assert.equal(r.json.tasks.length, 0);
  });

  test('a change without the X-MC header is refused', async () => {
    const s = await boot();
    const r = await localReq(s, { method: 'POST', path: '/api/tasks', body: { title: 'x' } });
    assert.equal(r.status, 403);
  });

  test('the MCP endpoint answers initialize and lists the tools', async () => {
    const s = await boot();
    const init = await rpc(s, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.instructions.includes('Review'));
    const note = await localReq(s, { method: 'POST', path: '/api/mcp', headers: { 'X-MC': '1' }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(note.status, 202);
    const list = await rpc(s, 'tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['tasks_list', 'task_get', 'task_add', 'task_update', 'task_step', 'task_note', 'task_start', 'task_finish', 'task_block']) assert.ok(names.includes(n), n);
  });

  test('Claude works a task through, and the guard rails hold', async () => {
    const s = await boot();
    let r = await call(s, 'task_add', { title: 'Port the board', project: 'fixture', steps: ['lanes', 'drag'], doneWhen: ['cards move'] });
    assert.equal(r.error, false, r.text);
    const id = /(\S+-\d+) \[inbox\]/.exec(r.text)[1];
    r = await call(s, 'task_add', { tasks: [{ title: 'Test it on the phone', for: 'me', project: 'fixture' }, { title: 'Bad', due: 'soon' }] });
    assert.equal(r.error, true); // all or nothing
    r = await pc(s, 'GET', '/api/tasks?project=fixture');
    assert.equal(r.json.tasks.length, 1);
    r = await call(s, 'task_start', { id });
    assert.match(r.text, /\[doing\]/);
    r = await call(s, 'task_step', { id, step: 1 });
    assert.match(r.text, /1\. \[x\] lanes/);
    r = await call(s, 'task_update', { id, status: 'done' });
    assert.equal(r.error, true);
    r = await call(s, 'task_finish', { id, summary: 'Lanes work; drag works.' });
    assert.match(r.text, /\[review\]/);
    r = await pc(s, 'GET', `/api/tasks/${id}`);
    assert.equal(r.json.from, 'claude');
    assert.ok(r.json.log.some((l) => l.who === 'claude' && /finished: Lanes work/.test(l.text)));
    // the user's task: Claude may not drop it
    r = await pc(s, 'POST', '/api/tasks', { title: 'Mine', project: 'fixture' });
    const mine = r.json.tasks[0].id;
    r = await call(s, 'task_update', { id: mine, status: 'dropped', reason: 'no' });
    assert.equal(r.error, true);
    r = await call(s, 'task_block', { id: mine, reason: 'Which color?' });
    assert.match(r.text, /blocked/);
    r = await call(s, 'tasks_list', { project: 'fixture' });
    assert.match(r.text, new RegExp(mine));
  });

  test('a code run gets its own MCP config, and the tools know its project', async () => {
    const s = await boot();
    const r = await pc(s, 'POST', '/api/chat', { prompt: 'hello', projectId: 'fixture' });
    assert.equal(r.status, 200, r.text);
    const runId = r.json.runId;
    const file = path.join(s.dataDir, 'mcp', `${runId}.json`);
    for (let i = 0; i < 50 && !fs.existsSync(file); i++) await sleep(50);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(cfg.mcpServers.mc.headers['X-MC-Run'], runId);
    assert.ok(cfg.mcpServers.mc.url.endsWith(`:${s.port}/api/mcp`));
    const add = await call(s, 'task_add', { title: 'From the run' }, runId);
    assert.equal(add.error, false, add.text);
    const list = await pc(s, 'GET', '/api/tasks?project=fixture&text=From%20the%20run');
    assert.equal(list.json.tasks.length, 1);
  });

  test('targets: Claude makes one from tasks, and its pace is reported', async () => {
    const s = await boot();
    const a = await pc(s, 'POST', '/api/tasks', { tasks: [{ title: 'Part A', project: 'fixture' }, { title: 'Part B', project: 'fixture' }] });
    const ids = a.json.tasks.map((t) => t.id);
    const due = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    let r = await call(s, 'target_add', { title: 'Ship the beta', due, project: 'fixture', tasks: ids });
    assert.equal(r.error, false, r.text);
    const gid = /Created (TG-\d+)/.exec(r.text)[1];
    await pc(s, 'PUT', `/api/tasks/${ids[0]}`, { status: 'done' });
    r = await call(s, 'targets_list', { project: 'fixture' });
    assert.match(r.text, new RegExp(`${gid} .* 1/2 tasks done · ahead by`));
    const st = await pc(s, 'GET', '/api/tasks');
    assert.ok(st.json.targets.some((g) => g.id === gid));
    r = await pc(s, 'POST', `/api/targets/${gid}/delete`, {});
    assert.equal(r.status, 200);
    assert.equal((await pc(s, 'GET', `/api/tasks/${ids[1]}`)).json.target, null);
  });

  test('a goal needs no date, and holds tasks of any project', async () => {
    const s = await boot();
    const a = await pc(s, 'POST', '/api/tasks', { tasks: [{ title: 'In the project', project: 'fixture' }, { title: 'Personal one' }] });
    const [inProj, personal] = a.json.tasks.map((t) => t.id);
    let r = await pc(s, 'POST', '/api/targets', { title: 'Things together', project: null });
    assert.equal(r.status, 200, r.text);
    const gid = r.json.id;
    assert.equal(r.json.due, null);
    for (const id of [inProj, personal]) assert.equal((await pc(s, 'PUT', `/api/tasks/${id}`, { target: gid })).json.target, gid);
    r = await call(s, 'targets_list', { project: 'all' });
    assert.match(r.text, new RegExp(`${gid} · no date · .* 0/2 tasks done · no date · Things together`));
    r = await pc(s, 'PUT', `/api/targets/${gid}`, { due: '2026-12-01' });
    assert.equal(r.json.due, '2026-12-01');
    r = await pc(s, 'PUT', `/api/targets/${gid}`, { due: null });
    assert.equal(r.json.due, null);
    r = await call(s, 'target_add', { title: 'No date from Claude', project: 'fixture' });
    assert.equal(r.error, false, r.text);
    assert.match(r.text, /Created TG-\d+ · no date/);
  });

  test('a task that comes due is announced once', async () => {
    const s = await boot();
    const d = new Date(Date.now() - 60e3), p = (n) => String(n).padStart(2, '0');
    const due = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    const r = await pc(s, 'POST', '/api/tasks', { title: 'Call the bank', due });
    const id = r.json.tasks[0].id;
    let t;
    for (let i = 0; i < 40; i++) { t = (await pc(s, 'GET', `/api/tasks/${id}`)).json; if (t.reminded) break; await sleep(100); }
    assert.equal(t.reminded.due, due);
  });

  test('the runner accepts only its own MCP config', () => {
    assert.match(checkSpawnArgs([...FIXED_ARGS, '--mcp-config', 'C:\\Windows\\evil.json']), /mcp-config/);
    assert.match(checkSpawnArgs([...FIXED_ARGS, '--allowedTools', 'Bash']), /allowedTools/);
    assert.equal(checkSpawnArgs([...FIXED_ARGS, '--allowedTools', 'mcp__mc']), null);
  });
});
