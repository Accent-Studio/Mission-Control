// Tests for Send later (server/services/delayed.js), against the FAKE Claude CLI in tools/fakeclaude.
// Nothing here starts a real Claude conversation. Run: node --test "tools/test/*.test.mjs"
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

async function boot(prepare) {
  const dataDir = makeDataDir('mc-delayed');
  seedFixture(dataDir);
  if (prepare) prepare(dataDir);
  const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '20' } });
  toStop.push(s);
  return s;
}

const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });

async function waitFor(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}

describe('send later', () => {
  test('a timed message is sent by the server at its time, then leaves the list', async () => {
    const s = await boot();
    const at = new Date(Date.now() + 6000).toISOString();
    const r = await pc(s, 'POST', '/api/delayed', { kind: 'timer', at, req: { prompt: 'later hello' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'waiting');
    assert.equal((await pc(s, 'GET', '/api/delayed')).json.items.length, 1);
    assert.equal((await pc(s, 'GET', '/api/runs')).json.length, 0, 'nothing is sent before the time');
    await waitFor(async () => (await pc(s, 'GET', '/api/runs')).json.length > 0, 'the run of the delayed message');
    await waitFor(async () => (await pc(s, 'GET', '/api/delayed')).json.items.length === 0, 'the list to empty');
  });

  test('cancel hands the words back; send now sends at once', async () => {
    const s = await boot();
    const at = new Date(Date.now() + 3600e3).toISOString();
    const a = await pc(s, 'POST', '/api/delayed', { kind: 'time', at, req: { prompt: 'keep these words' } });
    const c = await pc(s, 'POST', `/api/delayed/${a.json.id}/cancel`, {});
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.text, 'keep these words');
    assert.equal((await pc(s, 'GET', '/api/delayed')).json.items.length, 0);

    const b = await pc(s, 'POST', '/api/delayed', { kind: 'time', at, req: { prompt: 'now please' } });
    assert.equal((await pc(s, 'POST', `/api/delayed/${b.json.id}/now`, {})).status, 200);
    await waitFor(async () => (await pc(s, 'GET', '/api/runs')).json.length > 0, 'the run of send now');
  });

  test('bad requests are refused', async () => {
    const s = await boot();
    const past = await pc(s, 'POST', '/api/delayed', { kind: 'time', at: new Date(Date.now() - 1000).toISOString(), req: { prompt: 'x' } });
    assert.equal(past.status, 400);
    const far = await pc(s, 'POST', '/api/delayed', { kind: 'time', at: new Date(Date.now() + 8 * 86400e3).toISOString(), req: { prompt: 'x' } });
    assert.equal(far.status, 400);
    const empty = await pc(s, 'POST', '/api/delayed', { kind: 'timer', at: new Date(Date.now() + 60e3).toISOString(), req: { prompt: '  ' } });
    assert.equal(empty.status, 400);
    const reset = await pc(s, 'POST', '/api/delayed', { kind: 'reset', req: { prompt: 'x' } });
    assert.equal(reset.status, 409, 'no usage measured yet, so no reset time');
  });

  test('the reset time comes from the plan usage', async () => {
    const resetsAt = new Date(Date.now() + 2 * 3600e3).toISOString();
    const s = await boot((dir) => fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ fiveHour: { pct: 100, resetsAt }, source: 'run' })));
    const r = await pc(s, 'POST', '/api/delayed', { kind: 'reset', req: { prompt: 'after the reset' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(Date.parse(r.json.at), Date.parse(resetsAt) + 60e3);
  });

  test('a send cut off by a stop is never sent twice', async () => {
    const s = await boot((dir) =>
      fs.writeFileSync(
        path.join(dir, 'delayed.json'),
        JSON.stringify({ items: [{ id: 'x1', kind: 'timer', at: new Date().toISOString(), createdAt: new Date().toISOString(), req: { prompt: 'half sent' }, preview: 'half sent', atts: [], status: 'sending' }] }),
      ),
    );
    const it = (await pc(s, 'GET', '/api/delayed')).json.items[0];
    assert.equal(it.status, 'failed');
    await sleep(500);
    assert.equal((await pc(s, 'GET', '/api/runs')).json.length, 0);
  });
});
