// Tests for Remote Control ("Show on claude.ai") and archived conversations, against the FAKE Claude CLI in tools/fakeclaude.
// Nothing here starts a real Claude conversation. Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  const dataDir = makeDataDir('mc-rc');
  seedFixture(dataDir);
  const log = path.join(dataDir, 'fake.log');
  const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_LOG: log, FAKE_STEP_MS: '20', ...fakeEnv } });
  s.log = log;
  s.lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  s.controls = () => s.lines().filter((l) => l.ev === 'stdin-control-request');
  toStop.push(s);
  return s;
}

const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });

async function waitFor(fn, what, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(40);
  }
}

// Sends a message (a new conversation, or a resume) and waits until its process is idle (the turn ended).
async function chat(s, extra = {}) {
  const r = await pc(s, 'POST', '/api/chat', { prompt: 'hello', ...extra });
  assert.equal(r.status, 200, r.text);
  const run = await waitFor(async () => (await pc(s, 'GET', '/api/runs')).json.find((x) => x.runId === r.json.runId && x.state === 'idle'), 'an idle run');
  return run;
}

const runOf = async (s, runId) => (await pc(s, 'GET', '/api/runs')).json.find((x) => x.runId === runId);

// A transcript the session scanner can read, started in the data folder (which exists).
function transcript(s, id = crypto.randomUUID()) {
  const dir = path.join(s.dataDir, 'claude-home', 'projects', 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, id + '.jsonl'),
    JSON.stringify({ type: 'user', cwd: s.dataDir, sessionId: id, timestamp: now, message: { role: 'user', content: 'hello ' + id.slice(0, 4) } }) + '\n',
  );
  return id;
}

describe('Remote Control', () => {
  test('on by default: asked after the first message went out, once per process, answer shown on the run', async () => {
    const s = await boot();
    assert.equal((await pc(s, 'GET', '/api/voice/prefs')).json.remoteControl, true);
    const run = await chat(s);
    const lines = s.lines();
    const asked = lines.findIndex((l) => l.ev === 'stdin-control-request');
    assert.ok(lines.findIndex((l) => l.ev === 'stdin-user') < asked, 'the message is written before the request');
    assert.deepEqual(s.controls().map((c) => [c.subtype, c.enabled]), [['remote_control', true]]);
    const r = await waitFor(async () => {
      const x = await runOf(s, run.runId);
      return x.remote === 'on' && x;
    }, 'remote on');
    assert.match(r.remoteUrl, /^https:\/\/claude\.ai\/code\/session_fake/);
    // a second message to the same process does not ask again
    await pc(s, 'POST', '/api/chat', { prompt: 'again', runId: run.runId });
    await sleep(600);
    assert.equal(s.controls().length, 1);
  });

  test('the switch off takes live conversations offline, on asks again, and a new process obeys it', async () => {
    const s = await boot();
    const run = await chat(s);
    await waitFor(async () => (await runOf(s, run.runId)).remote === 'on', 'remote on');
    assert.equal((await pc(s, 'PUT', '/api/voice/prefs', { readAloud: true })).status, 200);
    await sleep(300);
    assert.equal(s.controls().length, 1, 'an unrelated preference changes nothing');
    assert.equal((await pc(s, 'PUT', '/api/voice/prefs', { remoteControl: false })).json.remoteControl, false);
    await waitFor(() => s.controls().length === 2, 'the disable request');
    assert.equal(s.controls()[1].enabled, false);
    const off = await runOf(s, run.runId);
    assert.equal(off.remote, undefined);
    assert.equal(off.remoteUrl, undefined);
    // a new conversation with the switch off is never asked
    await chat(s);
    await sleep(300);
    assert.equal(s.controls().length, 2);
    // on again: both live processes are asked
    await pc(s, 'PUT', '/api/voice/prefs', { remoteControl: true });
    await waitFor(() => s.controls().length === 4, 'two enable requests');
    assert.deepEqual(s.controls().slice(2).map((c) => c.enabled), [true, true]);
    assert.equal((await pc(s, 'PUT', '/api/voice/prefs', { remoteControl: 'yes' })).status, 400);
  });

  test('a refusal is logged once, shows nothing loud, and the conversation still works', async () => {
    const s = await boot({ FAKE_RC: 'error' });
    const run = await chat(s);
    const r = await waitFor(async () => {
      const x = await runOf(s, run.runId);
      return x.remote === 'failed' && x;
    }, 'remote failed');
    assert.equal(r.remoteUrl, undefined);
    assert.equal(r.state, 'idle');
    await pc(s, 'POST', '/api/chat', { prompt: 'again', runId: run.runId });
    await waitFor(async () => (await runOf(s, run.runId)).state === 'idle' && s.lines().filter((l) => l.ev === 'stdin-user').length === 2, 'the second turn');
    const logged = s.out.text.split('\n').filter((l) => /Remote Control is not on/.test(l));
    assert.equal(logged.length, 1, s.out.text);
    assert.match(logged[0], /claude\.ai subscription/);
    assert.equal(s.controls().length, 1);
  });

  test('no answer in time is a failure; an address that is not claude.ai is never offered', async () => {
    const quiet = await boot({ FAKE_RC: 'silent', MC_REMOTE_ANSWER_MS: '300' });
    const a = await chat(quiet);
    await waitFor(async () => (await runOf(quiet, a.runId)).remote === 'failed', 'a timeout');
    assert.match(quiet.out.text, /Remote Control is not on for run \w+: the CLI did not answer in time/);
    const foreign = await boot({ FAKE_RC: 'foreign' });
    const b = await chat(foreign);
    const r = await waitFor(async () => {
      const x = await runOf(foreign, b.runId);
      return x.remote === 'on' && x;
    }, 'remote on');
    assert.equal(r.remoteUrl, undefined);
  });
});

describe('archived conversations', () => {
  test('archive hides, the count and the filters follow, unarchive brings it back', async () => {
    const s = await boot();
    const [a, b, c] = [transcript(s), transcript(s), transcript(s)];
    const ids = async (q) => (await pc(s, 'GET', '/api/sessions?limit=50' + q)).json.map((x) => x.id).sort();
    // the server's file scan is cached for 3 s, and a scan at start-up may predate the files
    await waitFor(async () => (await ids('')).length === 3, 'the scan to see the three transcripts');
    assert.deepEqual(await ids(''), [a, b, c].sort());
    const r = await pc(s, 'POST', `/api/sessions/${b}/archive`, { archived: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.archived, true);
    assert.deepEqual(await ids('&archived=hide'), [a, c].sort());
    assert.deepEqual(await ids('&archived=only'), [b]);
    const all = (await pc(s, 'GET', '/api/sessions?limit=50')).json;
    assert.equal(all.find((x) => x.id === b).archived, true);
    assert.equal(all.find((x) => x.id === a).archived, false);
    assert.equal((await pc(s, 'GET', '/api/sessions/archived-count')).json.count, 1);
    assert.equal((await pc(s, 'GET', `/api/sessions/${b}`)).json.archived, true);
    // the flag is kept in the same file as renames and pins, and survives a restart of the file read
    const meta = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'sessions-meta.json'), 'utf8'));
    assert.equal(meta[b].archived, true);
    assert.equal((await pc(s, 'POST', `/api/sessions/${b}/archive`, { archived: false })).status, 200);
    assert.deepEqual(await ids('&archived=hide'), [a, b, c].sort());
    assert.equal((await pc(s, 'GET', '/api/sessions/archived-count')).json.count, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'sessions-meta.json'), 'utf8'))[b], undefined);
  });

  test('bad requests: no body flag, not a uuid, unknown conversation', async () => {
    const s = await boot();
    const id = transcript(s);
    assert.equal((await pc(s, 'POST', `/api/sessions/${id}/archive`, {})).status, 400);
    assert.equal((await pc(s, 'POST', `/api/sessions/${id}/archive`, { archived: 'yes' })).status, 400);
    assert.equal((await pc(s, 'POST', '/api/sessions/nope/archive', { archived: true })).status, 400);
    assert.equal((await pc(s, 'POST', `/api/sessions/${crypto.randomUUID()}/archive`, { archived: true })).status, 404);
    // the meta route does not archive (one door only)
    assert.equal((await pc(s, 'POST', `/api/sessions/${id}/meta`, { archived: true })).status, 400);
  });

  test('archiving takes a live conversation off claude.ai, and a resume of an archived one is never put back on', async () => {
    const s = await boot();
    const run = await chat(s);
    await waitFor(async () => (await runOf(s, run.runId)).remote === 'on', 'remote on');
    // the fake never wrote a transcript, but a live process holds the conversation
    const r = await pc(s, 'POST', `/api/sessions/${run.sessionId}/archive`, { archived: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.offline, 1);
    await waitFor(() => s.controls().length === 2, 'the disable request');
    assert.equal(s.controls()[1].enabled, false);
    assert.equal((await runOf(s, run.runId)).remote, undefined);
    // a transcript-backed conversation that is archived and then resumed: its new process is not asked
    const id = transcript(s);
    await pc(s, 'POST', `/api/sessions/${id}/archive`, { archived: true });
    const before = s.controls().length;
    await chat(s, { sessionId: id });
    await sleep(400);
    assert.equal(s.controls().length, before);
    // unarchived and resumed by a new process (the old one is closed first): it is asked again
    await pc(s, 'POST', `/api/sessions/${id}/archive`, { archived: false });
    const live = (await pc(s, 'GET', '/api/runs')).json.find((x) => x.sessionId === id);
    await pc(s, 'POST', `/api/runs/${live.runId}/stop`, {});
    await chat(s, { sessionId: id });
    await waitFor(() => s.controls().length === before + 1, 'an enable request after unarchive');
  });
});
