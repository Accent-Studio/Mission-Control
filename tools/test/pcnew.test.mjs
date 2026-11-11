// A new conversation in a project of the PC this one is linked to (services/pcLink.js) starts there, through the link,
// the way that PC's phone starts one, and its live turn comes back here as pc.chat events. A task here may name one of
// that PC's projects, so a conversation for it starts there too. Run against the FAKE Claude CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ROOT, bridgeHeaders, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });

async function waitFor(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(40);
  }
}

// Every event the pages of one server receive: [{ type, data }]
function listen(s) {
  const events = [];
  const req = http.get({ host: '127.0.0.1', port: s.port, path: '/api/events', headers: { Host: `127.0.0.1:${s.port}` } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!block.startsWith('data: ')) continue;
        try { events.push(JSON.parse(block.slice(6))); } catch { /* not JSON */ }
      }
    });
  });
  req.on('error', () => {});
  toStop.push({ stop: async () => req.destroy() });
  return events;
}

describe('a new conversation on the linked PC', () => {
  test('starts in that PC\'s project, streams back here, and a task here can name that project', async () => {
    // Home has the project "fixture"; Work has no projects of its own
    const home = makeDataDir('mc-pcnew-home');
    seedFixture(home);
    const tdir = path.join(home, 'claude-home', 'projects', 'proj');
    fs.mkdirSync(tdir, { recursive: true });
    const H = await startServer({ dataDir: home, bridge: true, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '200', FAKE_TRANSCRIPT: tdir } });
    toStop.push(H);
    const work = makeDataDir('mc-pcnew-work');
    const link = { name: 'Home', url: `http://127.0.0.1:${H.bridgePort}`, headers: bridgeHeaders(H) };
    const W = await startServer({ dataDir: work, bridge: false, env: { PATH: FAKE_PATH, MC_PC_LINK_TEST: JSON.stringify(link) } });
    toStop.push(W);
    const seen = listen(W);

    const st = await pc(W, 'POST', '/api/pc-link/refresh', {});
    assert.equal(st.status, 200, st.text);
    assert.ok(st.json.projects.some((p) => p.id === 'fixture'), 'Home\'s projects read through the link');

    // only a project Home listed, and something to say
    const unknown = await pc(W, 'POST', '/api/pc/chat', { projectId: 'nope', prompt: 'Hello' });
    assert.equal(unknown.status, 400, unknown.text);
    assert.match(unknown.json.error, /Home has no project nope/);
    const none = await pc(W, 'POST', '/api/pc/chat', { prompt: 'Hello' });
    assert.equal(none.status, 400, none.text);
    const badModel = await pc(W, 'POST', '/api/pc/chat', { projectId: 'fixture', prompt: 'Hello', model: 'x y' });
    assert.equal(badModel.status, 400, badModel.text);

    // a new conversation there, in its project folder, its turn coming back here
    await sleep(800); // the link's event stream is open
    const sent = await pc(W, 'POST', '/api/pc/chat', { projectId: 'fixture', prompt: 'Start the beta checklist' });
    assert.equal(sent.status, 200, sent.text);
    const runId = sent.json.runId;
    assert.ok(runId, 'a run id from Home');
    const hr = (await pc(H, 'GET', '/api/runs')).json.find((r) => r.runId === runId);
    assert.ok(hr, 'the run is Home\'s');
    assert.equal(hr.projectId, 'fixture');
    const mine = (type) => seen.filter((m) => m.type === type && m.data && m.data.runId === runId);
    const done = await waitFor(() => mine('pc.chat').find((m) => m.data.turnDone && m.data.sessionId), 'the end of the first turn, with its session id');
    assert.ok(mine('pc.chat').some((m) => m.data.sent && m.data.sent.text === 'Start the beta checklist'), 'the message itself, as Home took it');
    assert.equal((await pc(W, 'GET', '/api/runs')).json.filter((r) => r.runId === runId).length, 0, 'no run here');

    // the conversation is Home's, read here through the link
    const read = await waitFor(async () => { const r = await pc(W, 'GET', `/api/sessions/${done.data.sessionId}?limit=40`); return r.status === 200 && r.json.messages.length && r; }, 'the conversation read through the link');
    assert.equal(read.json.link, true);
    assert.equal(read.json.machine.name, 'Home');

    // a task here names Home's project by id or by name; a project neither PC has is refused
    let r = await pc(W, 'POST', '/api/tasks', { title: 'Beta checklist', project: 'fixture' });
    assert.equal(r.status, 200, r.text);
    const t = r.json.tasks[0];
    assert.equal(t.project, 'fixture');
    r = await pc(W, 'POST', '/api/tasks', { title: 'By name', project: 'Fixture' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tasks[0].project, 'fixture');
    r = await pc(W, 'PUT', `/api/tasks/${t.id}`, { project: 'nope' });
    assert.equal(r.status, 400, r.text);
    r = await pc(W, 'PUT', `/api/tasks/${t.id}`, { project: null });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.project, null);
    r = await pc(W, 'PUT', `/api/tasks/${t.id}`, { project: 'fixture' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.project, 'fixture');
    assert.match(r.json.log.at(-1).text, /moved to Fixture/, 'named as Home calls it');
  });
});
