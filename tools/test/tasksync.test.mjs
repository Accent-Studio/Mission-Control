// Tests for the shared task list (services/taskSync.js, services/hubTasks.js): a hub and two PCs, Home and Work, that
// reach it as paired devices. A task made on Home shows up on Work, a change on Work comes back to Home, two tasks made
// at the same moment with the same number both survive (one is renumbered), and a delete reaches the other PC.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { localReq, makeDataDir, startServer } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const call = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
async function waitFor(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}
const HOME_DEV = 'h'.repeat(40);
const WORK_DEV = 'w'.repeat(40);
const ENV = { MC_HUB_RETRY_MS: '500', MC_HUB_SYNC_MS: '1000', MC_TASK_SYNC_MS: '200', MC_RUNNER_PORT: 'off' };

async function startHub() {
  const dataDir = makeDataDir('mc-tsync-hub');
  fs.writeFileSync(path.join(dataDir, 'devices.json'), JSON.stringify([
    { id: HOME_DEV, name: 'Home', pairedAt: '2026-11-02T00:00:00Z', lastSeen: null },
    { id: WORK_DEV, name: 'Work', pairedAt: '2026-11-02T00:00:00Z', lastSeen: null },
  ]));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ machineName: 'Hub' }));
  const s = await startServer({ dataDir, bridge: true, env: { MC_ROLE: 'hub', ...ENV } });
  toStop.push(s);
  return s;
}
async function startPc(hub, name, device) {
  const dataDir = makeDataDir('mc-tsync-' + name.toLowerCase());
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ machineName: name }));
  const secret = fs.readFileSync(hub.secretFile, 'utf8').trim();
  fs.writeFileSync(path.join(dataDir, 'hub.json'), JSON.stringify({ url: `http://127.0.0.1:${hub.bridgePort}`, headers: { 'X-MC-Bridge': secret, 'X-MC-Device': device } }));
  const s = await startServer({ dataDir, bridge: false, env: ENV });
  toStop.push(s);
  return s;
}
const tasksOf = async (s) => (await call(s, 'GET', '/api/tasks')).json.tasks;
const byTitle = async (s, title) => (await tasksOf(s)).find((t) => t.title === title);

describe('the shared task list', () => {
  test('tasks and targets go both ways between two PCs through the hub', async () => {
    const hub = await startHub();
    const home = await startPc(hub, 'Home', HOME_DEV);
    const work = await startPc(hub, 'Work', WORK_DEV);

    // Home makes a task and a target: Work gets both, with the same ids
    let r = await call(home, 'POST', '/api/tasks', { title: 'Made at home', for: 'claude', priority: 2, steps: ['one', 'two'] });
    assert.equal(r.status, 200, r.text);
    const id = r.json.tasks[0].id;
    r = await call(home, 'POST', '/api/targets', { title: 'Ship it', due: '2026-12-01' });
    assert.equal(r.status, 200, r.text);
    const onWork = await waitFor(() => byTitle(work, 'Made at home'), 'the task on Work');
    assert.equal(onWork.id, id);
    assert.equal(onWork.for, 'claude');
    assert.equal(onWork.uid, (await byTitle(home, 'Made at home')).uid);
    const tg = await waitFor(async () => (await call(work, 'GET', '/api/tasks')).json.targets.find((g) => g.title === 'Ship it'), 'the target on Work');

    // Work changes it: the change comes back to Home, with both log lines
    r = await call(work, 'PUT', `/api/tasks/${id}`, { status: 'doing', target: tg.id });
    assert.equal(r.status, 200, r.text);
    await call(work, 'POST', `/api/tasks/${id}/step`, { step: 1, done: true });
    const back = await waitFor(async () => { const t = await byTitle(home, 'Made at home'); return t && t.status === 'doing' && t.steps[0].done && t; }, 'Work\'s change on Home');
    assert.equal(back.target, tg.id);
    assert.ok(back.log.some((l) => l.text === 'created'));
    assert.ok(back.log.some((l) => /ticked: one/.test(l.text)));

    // both make a task at the same moment, with the same number: both survive, each with its own number, on both PCs
    const [a, b] = await Promise.all([
      call(home, 'POST', '/api/tasks', { title: 'Twin from home' }),
      call(work, 'POST', '/api/tasks', { title: 'Twin from work' }),
    ]);
    assert.equal(a.json.tasks[0].id, b.json.tasks[0].id, 'the same number, made apart');
    const twins = async (s) => { const l = await tasksOf(s); const x = l.find((t) => t.title === 'Twin from home'); const y = l.find((t) => t.title === 'Twin from work'); return x && y && x.id !== y.id && `${x.id} ${y.id}`; };
    const seenHome = await waitFor(() => twins(home), 'both twins on Home');
    const seenWork = await waitFor(() => twins(work), 'both twins on Work');
    assert.equal(seenHome, seenWork, 'the same numbers on both PCs');

    // a delete on Work reaches Home
    r = await call(work, 'POST', `/api/tasks/${id}/delete`, {});
    assert.equal(r.status, 200, r.text);
    await waitFor(async () => !(await byTitle(home, 'Made at home')), 'the delete on Home');

    // the hub runs as one more place, and has the same list
    await sleep(500);
    const hubList = (await call(hub, 'GET', '/api/tasks')).json.tasks.map((t) => t.id).sort().join(' ');
    assert.equal(hubList, (await tasksOf(home)).map((t) => t.id).sort().join(' '), 'the hub\'s own list is the same');
  });
});
