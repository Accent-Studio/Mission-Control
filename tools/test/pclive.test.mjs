// A conversation of the PC this one is linked to (services/pcLink.js), talked to through the link as that PC's phone
// would: it is read there with the turn in progress, a message goes straight to it, and its live turn comes back here as
// pc.chat events while Claude writes (to the pages only), not once the turn is over. Run against the FAKE Claude CLI.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

describe('a conversation of the linked PC', () => {
  test('is read there with its turn, and a message sent from here streams back as it is written', async () => {
    const home = makeDataDir('mc-pclive-home');
    seedFixture(home);
    const projDir = path.join(home, 'claude-home', 'projects', 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    const id = crypto.randomUUID();
    const at = (ms) => new Date(Date.now() - ms).toISOString();
    fs.writeFileSync(path.join(projDir, id + '.jsonl'), [
      { type: 'user', cwd: home, sessionId: id, timestamp: at(60000), uuid: crypto.randomUUID(), promptSource: 'sdk', message: { role: 'user', content: 'Redesign the chat page' } },
      { type: 'assistant', cwd: home, sessionId: id, timestamp: at(50000), uuid: crypto.randomUUID(), message: { id: 'msg_old', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Here is the plan.' }], usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 40 } } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const H = await startServer({ dataDir: home, bridge: true, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '400', FAKE_TRANSCRIPT: projDir } });
    toStop.push(H);

    const work = makeDataDir('mc-pclive-work');
    seedFixture(work);
    const link = { name: 'Home', url: `http://127.0.0.1:${H.bridgePort}`, headers: bridgeHeaders(H) };
    const W = await startServer({ dataDir: work, bridge: false, env: { PATH: FAKE_PATH, MC_PC_LINK_TEST: JSON.stringify(link) } });
    toStop.push(W);
    const seen = listen(W);

    // read through the link: Home's own conversation, marked as Home's
    const read = await pc(W, 'GET', `/api/sessions/${id}?limit=40`);
    assert.equal(read.status, 200, read.text);
    assert.equal(read.json.link, true);
    assert.equal(read.json.readOnly, true);
    assert.equal(read.json.machine.name, 'Home');
    assert.deepEqual(read.json.messages.map((m) => m.text), ['Redesign the chat page', 'Here is the plan.']);
    const stats = await pc(W, 'GET', `/api/sessions/${id}/stats`);
    assert.equal(stats.status, 200, stats.text);
    assert.equal(stats.json.contextUsed, 42);

    // a message from here runs there at once, and its turn comes back while it is written
    await sleep(800); // the link's event stream is open
    const sent = await pc(W, 'POST', '/api/pc/chat', { sessionId: id, prompt: 'Make the box bigger' });
    assert.equal(sent.status, 200, sent.text);
    const runId = sent.json.runId;
    const mine = (type) => seen.filter((m) => m.type === type && m.data && m.data.runId === runId);
    await waitFor(() => mine('pc.chat').some((m) => m.data.event && m.data.event.type === 'assistant'), 'an answer streaming in');
    assert.ok(!mine('pc.chat').some((m) => m.data.turnDone), 'it came before the turn was over');
    assert.ok(mine('pc.chat').some((m) => m.data.sent && m.data.sent.text === 'Make the box bigger'), 'the message itself, as Home took it');
    const mid = (await pc(W, 'GET', `/api/sessions/${id}?limit=40`)).json;
    if (mid.live) assert.equal(mid.live.runId, runId, 'read mid-turn: the turn in progress comes with it');
    await waitFor(() => mine('pc.chat').some((m) => m.data.turnDone), 'the end of the turn');
    assert.equal(mine('chat').length, 0, 'never published as this server\'s own run');
    assert.equal((await pc(W, 'GET', '/api/runs')).json.filter((r) => r.runId === runId).length, 0, 'no run here');

    // the questions that wait, and Stop, go there too
    const pend = await pc(W, 'GET', `/api/pc/runs/${runId}/pending`);
    assert.equal(pend.status, 200, pend.text);
    const stop = await pc(W, 'POST', `/api/pc/runs/${runId}/stop`, {});
    assert.ok([200, 404, 409].includes(stop.status), stop.text);
    await waitFor(async () => (await pc(W, 'GET', `/api/sessions/${id}?limit=40`)).json.messages.some((m) => m.text === 'Make the box bigger'), 'the turn saved there');
  });
});
