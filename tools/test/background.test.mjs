// Idle close and background work. A run whose process still has background work (a helper agent started with
// run_in_background, a background shell command) is idle but must not be closed: closing the process ends that work.
// Runs against the FAKE Claude CLI in tools/fakeclaude, which reports background tasks the way the real CLI's stream-json
// output does (system events background_tasks_changed, task_started, task_updated, task_notification; or, in
// FAKE_BG_MODE=text, only the tool_result text and the <task-notification> message). Nothing here starts a real Claude conversation.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ROOT, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

async function boot(fakeEnv = {}) {
  const dataDir = makeDataDir('mc-bg');
  seedFixture(dataDir);
  const log = path.join(dataDir, 'fake.log');
  const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_LOG: log, FAKE_STEP_MS: '60', FAKE_TRANSCRIPT: path.join(dataDir, 'claude-home', 'projects', 'proj'), ...fakeEnv } });
  s.lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  toStop.push(s);
  return s;
}

const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
const runOf = async (s, runId) => (await pc(s, 'GET', '/api/runs')).json.find((x) => x.runId === runId);

async function waitFor(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(30);
  }
}

const idleRun = (s, runId) => waitFor(async () => {
  const r = await runOf(s, runId);
  return r && r.state === 'idle' && r;
}, 'an idle run');

describe('idle close waits for background work', () => {
  for (const [word, mode] of [['BGAGENT', 'system'], ['BGBASH', 'system'], ['BGAGENT', 'text']]) {
    test(`${word} (${mode} events): the process stays open while the task runs, and is closed after it ends and the idle time passes`, async () => {
      const s = await boot({ MC_IDLE_MS: '700', FAKE_BG_MS: '3000', FAKE_BG_MODE: mode });
      const r = await pc(s, 'POST', '/api/chat', { prompt: `${word} please` });
      assert.equal(r.status, 200, r.text);
      const id = r.json.runId;
      const idle = await idleRun(s, id);
      assert.equal(idle.background, 1, 'the run says it has one background task');
      // Longer than twice the idle time: without the fix the process would be closed by now.
      await sleep(1700);
      const still = await runOf(s, id);
      assert.equal(still.state, 'idle');
      assert.equal(still.background, 1);
      assert.equal(s.lines().filter((l) => l.ev === 'stdin-end').length, 0, 'stdin was not closed while the task ran');

      // The task ends: the CLI starts a turn of its own to answer the notification, then the run is idle with nothing running.
      await waitFor(async () => s.lines().some((l) => l.ev === 'bg-end'), 'the task to end');
      const after = await waitFor(async () => {
        const x = await runOf(s, id);
        return x && x.state === 'idle' && x.background === undefined && x;
      }, 'idle with no background work');
      assert.ok(after);
      const end = await waitFor(async () => {
        const x = await runOf(s, id);
        return x && (x.state === 'done' || x.state === 'failed' || x.state === 'stopped') && x;
      }, 'the idle close');
      assert.equal(end.state, 'done');
      const lines = s.lines();
      const bgEnd = lines.find((l) => l.ev === 'bg-end').t;
      const closed = lines.find((l) => l.ev === 'stdin-end').t;
      assert.ok(closed > bgEnd, 'closed after the task ended');
      assert.ok(closed - bgEnd >= 600, `the idle time counted from the end of the task (${closed - bgEnd} ms)`);
    });
  }

  test('a run with background work does not count toward the cap on idle processes', async () => {
    const s = await boot({ MC_IDLE_MS: '60000', MC_IDLE_MAX: '1', FAKE_BG_MS: '60000' });
    const a = await pc(s, 'POST', '/api/chat', { prompt: 'BGAGENT long' });
    await idleRun(s, a.json.runId);
    const b = await pc(s, 'POST', '/api/chat', { prompt: 'plain' });
    await idleRun(s, b.json.runId);
    await sleep(1000);
    // One idle process that can be closed, cap 1: nothing is closed (before the fix the helper's process counted and one went).
    assert.equal(s.lines().filter((l) => l.ev === 'stdin-end').length, 0);
    assert.equal((await runOf(s, a.json.runId)).state, 'idle');
    assert.equal((await runOf(s, b.json.runId)).state, 'idle');
    // A third, plain run: two closable processes, cap 1: the older plain one goes, the helper's process stays.
    const c = await pc(s, 'POST', '/api/chat', { prompt: 'plain too' });
    await waitFor(async () => (await runOf(s, b.json.runId)).state === 'done', 'the cap to close the older plain run');
    assert.equal((await runOf(s, a.json.runId)).state, 'idle', 'the run with the helper stays');
    assert.equal((await runOf(s, c.json.runId)).state === 'idle' || (await runOf(s, c.json.runId)).state === 'working', true);
    await pc(s, 'POST', `/api/runs/${a.json.runId}/stop`);
  });

  test('a task whose end is never reported is forgotten after the ceiling, then the idle close follows', async () => {
    const s = await boot({ MC_IDLE_MS: '500', MC_BG_MAX_MS: '1500', FAKE_BG_MS: '600000', FAKE_BG_MODE: 'lost' });
    const t0 = Date.now();
    const r = await pc(s, 'POST', '/api/chat', { prompt: 'BGAGENT forever' });
    const idle = await idleRun(s, r.json.runId);
    assert.equal(idle.background, 1);
    await waitFor(async () => (await runOf(s, r.json.runId)).background === undefined, 'the ceiling');
    const end = await waitFor(async () => {
      const x = await runOf(s, r.json.runId);
      return (x.state === 'done' || x.state === 'failed') && x;
    }, 'the idle close after the ceiling');
    assert.equal(end.state, 'done');
    const closed = s.lines().find((l) => l.ev === 'stdin-end').t;
    assert.ok(closed - t0 >= 1500, `not closed before the ceiling (${closed - t0} ms)`);
  });

  test('a changed model or effort does not replace a process that still has background work (the message joins it)', async () => {
    const s = await boot({ MC_IDLE_MS: '60000', FAKE_BG_MS: '60000' });
    const a = await pc(s, 'POST', '/api/chat', { prompt: 'BGAGENT keep', effort: 'low' });
    const idle = await idleRun(s, a.json.runId);
    assert.ok(idle.sessionId);
    const b = await pc(s, 'POST', '/api/chat', { prompt: 'another thing', sessionId: idle.sessionId, effort: 'high' });
    assert.equal(b.status, 200, b.text);
    assert.equal(b.json.runId, a.json.runId);
    assert.equal(b.json.joined, true);
    assert.equal(b.json.optionsIgnored, true);
    assert.equal(s.lines().filter((l) => l.ev === 'spawn').length, 1, 'no second process');
    await pc(s, 'POST', `/api/runs/${a.json.runId}/stop`);
  });

  test('a warm idle process: the same options join it, a new effort starts one that keeps the model', async () => {
    const s = await boot({ MC_IDLE_MS: '60000' });
    const a = await pc(s, 'POST', '/api/chat', { prompt: 'plain', model: 'claude-haiku-5-5', effort: 'low' });
    assert.equal(a.status, 200, a.text);
    const idle = await idleRun(s, a.json.runId);
    // What the Talk page sends for a conversation: its id, the mode and effort, and no model unless one was switched.
    const b = await pc(s, 'POST', '/api/chat', { prompt: 'same options', sessionId: idle.sessionId, mode: 'default', effort: 'low' });
    assert.equal(b.json.runId, a.json.runId);
    assert.equal(b.json.joined, true);
    await idleRun(s, a.json.runId);
    const c = await pc(s, 'POST', '/api/chat', { prompt: 'think harder', sessionId: idle.sessionId, mode: 'default', effort: 'high' });
    assert.equal(c.status, 200, c.text);
    assert.notEqual(c.json.runId, a.json.runId);
    await waitFor(() => s.lines().filter((l) => l.ev === 'spawn').length === 2, 'the second process');
    const args = s.lines().filter((l) => l.ev === 'spawn')[1].args;
    assert.equal(args[args.indexOf('--effort') + 1], 'high');
    assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-5-5', 'the model of the conversation is kept');
    await pc(s, 'POST', `/api/runs/${c.json.runId}/stop`);
  });

  test('an explicit Stop still ends a process that has background work', async () => {
    const s = await boot({ MC_IDLE_MS: '60000', FAKE_BG_MS: '60000' });
    const a = await pc(s, 'POST', '/api/chat', { prompt: 'BGBASH stop me' });
    await idleRun(s, a.json.runId);
    const stopped = await pc(s, 'POST', `/api/runs/${a.json.runId}/stop`);
    assert.equal(stopped.status, 200, stopped.text);
    assert.equal((await runOf(s, a.json.runId)).state, 'stopped');
  });
});
