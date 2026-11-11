// Tests for what a run is started with when the page names nothing: never "Default" (no --model, no --permission-mode),
// which let ~/.claude/settings.json decide (the last /model picked in a terminal, a "defaultMode"). A new conversation gets
// Opus 5.5 and Ask first by name; a resumed one keeps the model its transcript last answered with. Also: the Com Link's
// runs are not counted against the limit of runs at once.
// Runs against the FAKE Claude CLI in tools/fakeclaude. Run: npm test (2 test files at a time)
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

async function boot(dataDir, env = {}, logName = 'fake.log') {
  const log = path.join(dataDir, logName);
  const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_LOG: log, FAKE_STEP_MS: '20', FAKE_TRANSCRIPT: path.join(dataDir, 'claude-home', 'projects', 'proj'), ...env } });
  s.spawns = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((l) => l.ev === 'spawn').map((l) => l.args);
  toStop.push(s);
  return s;
}
function fresh(label) {
  const dataDir = makeDataDir(label);
  seedFixture(dataDir);
  return dataDir;
}

const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
const runOf = async (s, runId) => (await pc(s, 'GET', '/api/runs')).json.find((x) => x.runId === runId);
const flagOf = (args, f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
async function waitFor(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(50);
  }
}

describe('run defaults', () => {
  test('the model list has no Default, and Opus 5.5 is the default model', async () => {
    const s = await boot(fresh('mc-dflt-opts'));
    const o = (await pc(s, 'GET', '/api/chat/options')).json;
    assert.ok(!o.models.some((m) => m.id === 'default'), 'no Default model');
    assert.equal(o.defaults.model, 'claude-opus-5-5');
    assert.ok(o.modes.some((m) => m.id === 'default' && m.label === 'Ask first'));
    assert.equal(o.defaults.mode, 'auto', 'Auto is the default permission mode');
  });

  test('a new conversation with nothing named runs on Opus 5.5 and Auto, by name; "default" from an older page is Ask first', async () => {
    const s = await boot(fresh('mc-dflt-new'));
    const a = await pc(s, 'POST', '/api/chat', { prompt: 'hello' });
    assert.equal(a.status, 200, a.text);
    await waitFor(() => s.spawns().length === 1, 'the first process');
    const b = await pc(s, 'POST', '/api/chat', { prompt: 'hello again', model: 'default', mode: 'default' });
    assert.equal(b.status, 200, b.text);
    await waitFor(() => s.spawns().length === 2, 'two processes');
    const [one, two] = s.spawns();
    for (const args of [one, two]) assert.equal(flagOf(args, '--model'), 'claude-opus-5-5');
    assert.equal(flagOf(one, '--permission-mode'), 'auto');
    assert.equal(flagOf(two, '--permission-mode'), 'default');
  });

  test('a resumed conversation keeps the model its transcript last used, even one the list no longer offers', async () => {
    const dataDir = fresh('mc-dflt-resume');
    const s1 = await boot(dataDir, { MC_IDLE_MS: '60000' });
    const a = await pc(s1, 'POST', '/api/chat', { prompt: 'on an old model', model: 'claude-opus-4-6' });
    assert.equal(a.status, 200, a.text);
    const run = await waitFor(async () => { const r = await runOf(s1, a.json.runId); return r && r.state === 'idle' && r.sessionId && r; }, 'idle');
    assert.equal(flagOf(s1.spawns()[0], '--model'), 'claude-opus-4-6');
    await s1.stop();

    // a new server: its memory of the last run is empty, only the transcript says which model it was
    const s2 = await boot(dataDir, {}, 'fake2.log');
    const b = await pc(s2, 'POST', '/api/chat', { prompt: 'and again', sessionId: run.sessionId, mode: 'default' });
    assert.equal(b.status, 200, b.text);
    await waitFor(() => s2.spawns().length === 1, 'the resumed process');
    assert.equal(flagOf(s2.spawns()[0], '--model'), 'claude-opus-4-6');
  });

  test('the Com Link still answers when the limit of runs at once is reached', async () => {
    const s = await boot(fresh('mc-dflt-limit'), { FAKE_STEP_MS: '4000' });
    for (let i = 0; i < 3; i++) assert.equal((await pc(s, 'POST', '/api/chat', { prompt: 'busy ' + i })).status, 200);
    const fourth = await pc(s, 'POST', '/api/chat', { prompt: 'one too many' });
    assert.equal(fourth.status, 429, fourth.text);
    const comlink = await pc(s, 'POST', '/api/chat', { prompt: 'status?', persona: 'comlink' });
    assert.equal(comlink.status, 200, comlink.text);
    for (const r of (await pc(s, 'GET', '/api/runs')).json) await pc(s, 'POST', `/api/runs/${r.runId}/stop`);
  });
});
