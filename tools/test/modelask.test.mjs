// One request to a local model outside any conversation (services/modelAsk.js, routes/models.js): Work has no model of
// its own and asks the one of Home, the PC it is linked to, through the link; Home's gate answers (a fake gate here, in
// place of llmgate/index.js and llama-server). Also Claude's tool for it (local_model on Mission Control's MCP server).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { bridgeHeaders, bridgeReq, freePort, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

// A gate that answers like llmgate/index.js would: /gate/health, and /<model>/<effort>/v1/messages after `delay` ms.
const gate = { seen: [], closed: 0, delay: 300 };
async function fakeGate() {
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    if (req.url === '/gate/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, gate: true, pid: process.pid, stamp: 9e15, inFlight: 0, models: ['qwen-test'] }));
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = JSON.parse(body);
      gate.seen.push({ path: req.url, host: req.headers.host, auth: req.headers.authorization || req.headers['x-api-key'] || null, body: json });
      let gone = false;
      res.on('close', () => { if (!res.writableEnded) { gone = true; gate.closed++; } });
      setTimeout(() => {
        if (gone) return;
        const last = json.messages[json.messages.length - 1].content;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `echo: ${last}` }], usage: { input_tokens: 7, output_tokens: 3 }, stop_reason: 'end_turn', timings: { prompt_ms: 12, predicted_ms: 30 } }));
      }, gate.delay);
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  toStop.push({ stop: async () => srv.close() });
  return port;
}

const post = (s, p, body, headers = {}) => localReq(s, { method: 'POST', path: p, body, headers: { 'X-MC': '1', ...headers } });
let H, W, gatePort;

before(async () => {
  gatePort = await fakeGate();
  const home = makeDataDir('mc-modelask-home');
  seedFixture(home);
  const fakeFile = path.join(home, 'Qwen-Test-IQ3_XXS.gguf'); // not there; its name gives the quantization
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ machineName: 'Home', localModels: [{ id: 'qwen-test', label: 'Qwen Test', server: fakeFile, model: fakeFile, port: await freePort() }] }));
  H = await startServer({ dataDir: home, bridge: true, env: { MC_GATE_PORT: String(gatePort), MC_MODEL_WAIT_MS: '200' } });
  toStop.push(H);
  const work = makeDataDir('mc-modelask-work');
  W = await startServer({ dataDir: work, bridge: false, env: { MC_PC_LINK_TEST: JSON.stringify({ name: 'Home', url: `http://127.0.0.1:${H.bridgePort}`, headers: bridgeHeaders(H) }) } });
  toStop.push(W);
});

describe('a local model of the linked PC', () => {
  test('is listed on this PC with that PC\'s name', async () => {
    const r = await localReq(W, { path: '/api/models/local?fresh=1' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.here, []);
    assert.equal(r.json.linked.machine, 'Home');
    assert.equal(r.json.linked.online, true);
    assert.deepEqual(r.json.linked.models.map((m) => m.id), ['qwen-test']);
  });

  test('answers a request made here, through the link and that PC\'s gate', async () => {
    gate.seen.length = 0;
    const r = await post(W, '/api/models/ask', { prompt: 'Guten Morgen', system: 'Translate to English.' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.text, 'echo: Guten Morgen');
    assert.equal(r.json.machine, 'Home');
    assert.equal(r.json.model, 'qwen-test');
    assert.equal(r.json.effort, 'none', 'no thinking unless asked');
    assert.equal(r.json.outTokens, 3);
    assert.deepEqual(r.json.timings, { prompt_ms: 12, predicted_ms: 30 }, "llama-server's timings pass through");
    assert.equal(r.json.quant, 'IQ3_XXS', "the quantization, from the model file's name");
    assert.equal(gate.seen.length, 1);
    const g = gate.seen[0];
    assert.equal(g.path, '/qwen-test/none/v1/messages');
    assert.equal(g.host, `127.0.0.1:${gatePort}`, 'the gate only takes its own address');
    assert.equal(g.auth, null, 'no credentials go to the gate');
    assert.equal(g.body.stream, false);
    assert.equal(g.body.system, 'Translate to English.');
    assert.equal(g.body.tools, undefined, 'text only, no tools');
  });

  test('keeps the link alive while the model works, then gives the result', async () => {
    gate.delay = 1200;
    try {
      const r = await bridgeReq(H, { method: 'POST', path: '/api/models/ask', body: { prompt: 'slow', here: true, effort: 'medium' }, hdr: { post: true }, headers: { Accept: 'application/x-ndjson' } });
      assert.equal(r.status, 200, r.text);
      const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(lines.filter((l) => l.wait !== undefined).length >= 3, `wait lines while it works: ${r.text}`);
      const last = lines[lines.length - 1];
      assert.equal(last.ok, true);
      assert.equal(last.text, 'echo: slow');
      assert.equal(gate.seen[gate.seen.length - 1].path, '/qwen-test/medium/v1/messages');
    } finally {
      gate.delay = 300;
    }
  });

  test('a caller that hangs up stops the model there', async () => {
    gate.delay = 4000;
    const before = gate.closed;
    try {
      const req = http.request({ host: '127.0.0.1', port: W.port, method: 'POST', path: '/api/models/ask', headers: { Host: `127.0.0.1:${W.port}`, 'X-MC': '1', 'Content-Type': 'application/json' } });
      req.on('error', () => {});
      req.end(JSON.stringify({ prompt: 'never mind' }));
      await sleep(1000);
      req.destroy();
      const t0 = Date.now();
      while (gate.closed === before && Date.now() - t0 < 3000) await sleep(50);
      assert.equal(gate.closed, before + 1, 'the gate\'s request was closed before its answer');
    } finally {
      gate.delay = 300;
    }
  });

  test('refuses what it cannot do, with a reason', async () => {
    const none = await post(W, '/api/models/ask', {});
    assert.equal(none.status, 400, none.text);
    assert.match(none.json.error, /prompt/);
    const effort = await post(W, '/api/models/ask', { prompt: 'x', effort: 'max' });
    assert.equal(effort.status, 400, effort.text);
    const unknown = await bridgeReq(H, { method: 'POST', path: '/api/models/ask', body: { prompt: 'x', model: 'other', here: true }, hdr: { post: true } });
    assert.equal(unknown.status, 404, unknown.text);
    assert.match(unknown.json.error, /no local model other/);
    // text only: an image (or a tool result) is refused before anything is sent
    const tools = await post(W, '/api/models/ask', { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] });
    assert.equal(tools.status, 400, tools.text);
  });

  test('Claude can hand it a job with the local_model tool', async () => {
    const list = await post(W, '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(list.json.result.tools.some((t) => t.name === 'local_model'));
    const r = await post(W, '/api/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'local_model', arguments: { prompt: 'Bonjour' } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.result.isError, undefined, r.text);
    assert.match(r.json.result.content[0].text, /^echo: Bonjour\n\n\[Qwen Test on Home, effort none, /);
    const l = await post(W, '/api/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'local_model', arguments: { list: true } } });
    assert.match(l.json.result.content[0].text, /qwen-test \(Qwen Test\) on Home, online/);
  });
});

describe('with the linked PC off', () => {
  test('fails at once and says so', async () => {
    const work = makeDataDir('mc-modelask-off');
    const dead = await freePort();
    const S = await startServer({ dataDir: work, bridge: false, env: { MC_PC_LINK_TEST: JSON.stringify({ name: 'Home', url: `http://127.0.0.1:${dead}`, headers: {} }) } });
    toStop.push(S);
    const t0 = Date.now();
    const r = await post(S, '/api/models/ask', { prompt: 'Hello' });
    assert.ok(Date.now() - t0 < 5000, 'no waiting');
    assert.equal(r.status, 503, r.text);
    assert.match(r.json.error, /Home did not answer .*Nothing waits on the hub/);
  });
});
