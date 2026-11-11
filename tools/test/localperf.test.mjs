// How fast the local models run (services/localPerf.js, lib/localPerfLog.js, the System page's Local model speed): the
// answers read back from llama-server's log, the same numbers on the linked PC, and the benchmark (a fake gate and a fake
// llama-server here, in place of llmgate/index.js and the real model).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { bridgeHeaders, freePort, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';
import { parseServerLog, settingsOf } from '../../server/lib/localPerfLog.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

const START = '2026-11-06T05:00:00.000Z';
const LOG = [
  '',
  `===== ${START} C:\\llama\\llama-server.exe -m D:\\Models\\Qwen-27B-IQ3_XXS.gguf --host 127.0.0.1 --port 8080 -c 131072 --alias qwen-test -np 1 -fa on -ctk q8_0 -ctv q4_0`,
  '0.09.900.737 W ggml_cuda_flash_attn_ext_vec: no FlashAttention vector kernel compiled for K/V types q8_0-q4_0, converting K and V to f16 instead (slow).',
  '0.19.681.483 I slot print_timing: id  0 | task 0 | prompt eval time =     500.00 ms /   500 tokens (    1.00 ms per token,  1000.00 tokens per second)',
  '0.19.681.628 I slot print_timing: id  0 | task 0 |        eval time =    1000.00 ms /    50 tokens (   20.00 ms per token,    50.00 tokens per second)',
  '0.19.682.081 I slot      release: id  0 | task 0 | stop processing: n_tokens = 550, truncated = 0',
  // two minutes later: inside the benchmark of bench.json, so left out of the everyday numbers
  '2.00.000.000 I slot print_timing: id  0 | task 9 | prompt eval time =    1000.00 ms /  4096 tokens (    0.24 ms per token,  4096.00 tokens per second)',
  '2.00.000.100 I slot print_timing: id  0 | task 9 |        eval time =    1000.00 ms /   128 tokens (    7.81 ms per token,   128.00 tokens per second)',
  '',
  `===== 2026-11-06T06:00:00.000Z C:\\llama\\llama-server.exe -m D:\\Models\\Qwen-27B-IQ3_XXS.gguf -c 65536 -md D:\\Models\\Qwen-0.6B-Q8_0.gguf`,
  '1.00.000.000 I slot print_timing: id  0 | task 3 | prompt eval time =     200.00 ms /   400 tokens (    0.50 ms per token,  2000.00 tokens per second)',
  '1.00.000.100 I slot print_timing: id  0 | task 3 |        eval time =    1000.00 ms /    60 tokens (   16.67 ms per token,    60.00 tokens per second)',
  '1.00.000.200 I slot print_timing: id  0 | task 3 | draft acceptance rate = 0.75000 (   30 accepted /    40 generated)',
].join('\n');

describe('the log of a llama-server', () => {
  test('gives each answer with its time, its speeds and its context', () => {
    const { sessions, answers } = parseServerLog(LOG, {});
    assert.equal(sessions.length, 2);
    assert.equal(answers.length, 3);
    const a = answers[0];
    assert.equal(new Date(a.t).toISOString(), '2026-11-06T05:00:19.681Z');
    assert.deepEqual([a.promptTok, a.promptMs, a.genTok, a.genMs, a.ctx], [500, 500, 50, 1000, 550]);
    assert.deepEqual([answers[2].draftOk, answers[2].draftAll], [30, 40]);
  });

  test('gives the settings each start ran with, and a slow cache mix', () => {
    const { sessions } = parseServerLog(LOG, {});
    assert.deepEqual(sessions[0].settings, { model: 'Qwen-27B-IQ3_XXS.gguf', quant: 'IQ3_XXS', ctx: 131072, kv: 'K q8_0, V q4_0', draft: null });
    assert.match(sessions[0].warn, /q8_0-q4_0/);
    assert.equal(sessions[1].settings.kv, 'f16');
    assert.equal(sessions[1].settings.draft, 'Qwen-0.6B-Q8_0.gguf');
    assert.equal(sessions[1].warn, null);
    assert.equal(settingsOf(['--spec-type', 'ngram-simple']).draft, '--spec-type ngram-simple');
    assert.equal(settingsOf(['--spec-type', 'draft-mtp', '--spec-draft-model', 'D:\\m\\mtp-Q4_0.gguf']).draft, 'mtp-Q4_0.gguf');
    assert.equal(settingsOf(['--spec-type', 'none']).draft, null);
  });
});

// A gate that says it runs and is not busy. The benchmark starts tools/test/fake-llama-server.mjs itself, once per
// version: the model's "server" is node, and its first flag is that script.
async function fakeGate() {
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/gate/health') return res.end(JSON.stringify({ ok: true, gate: true, pid: process.pid, stamp: 9e15, inFlight: 0, models: ['qwen-test'] }));
    req.resume();
    req.on('end', () => res.end('{}'));
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  toStop.push({ stop: async () => srv.close() });
  return port;
}

let H, W, models;
const FILES = ['Qwen-IQ3_XXS.gguf', 'Qwen-IQ3_XXS-mtp.gguf', 'Qwen-IQ2_S-mtp.gguf', 'mmproj-Qwen-BF16.gguf'];
before(async () => {
  const gatePort = await fakeGate();
  const home = makeDataDir('mc-localperf-home');
  seedFixture(home);
  models = path.join(home, 'models');
  fs.mkdirSync(models);
  FILES.forEach((f, i) => fs.writeFileSync(path.join(models, f), 'x'.repeat(100 - i)));
  const fakeServer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-llama-server.mjs');
  const entry = { id: 'qwen-test', label: 'Qwen Test', server: process.execPath, model: path.join(models, 'Qwen-IQ3_XXS.gguf'), port: await freePort(), ctx: 131072, args: [fakeServer, '-ctk', 'q8_0', '-ctv', 'q8_0', '--spec-type', 'none'] };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ machineName: 'Home', localModels: [entry] }));
  fs.mkdirSync(path.join(home, 'local-models'), { recursive: true });
  fs.writeFileSync(path.join(home, 'local-models', 'qwen-test.server.log'), LOG);
  fs.writeFileSync(path.join(home, 'local-models', 'bench.json'), JSON.stringify({ runs: [{ id: 'old', model: 'qwen-test', startedAt: '2026-11-06T05:01:55.000Z', endedAt: '2026-11-06T05:02:05.000Z', settings: null, tests: [], error: 'stopped' }] }));
  H = await startServer({ dataDir: home, bridge: true, env: { MC_GATE_PORT: String(gatePort), MC_VRAM_TEST: JSON.stringify({ usedMB: 600, totalMB: 16376 }) } });
  toStop.push(H);
  const work = makeDataDir('mc-localperf-work');
  W = await startServer({ dataDir: work, bridge: false, env: { MC_PC_LINK_TEST: JSON.stringify({ name: 'Home', url: `http://127.0.0.1:${H.bridgePort}`, headers: bridgeHeaders(H) }) } });
  toStop.push(W);
});

async function benchDone() {
  for (let i = 0; i < 300; i++) {
    await sleep(100);
    const p = await localReq(H, { path: '/api/local-models/perf' });
    if (!p.json.benching) return p.json.models[0];
  }
  throw new Error('the benchmark did not end');
}
const seenStarts = () => fs.readFileSync(path.join(models, 'seen.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('Local model speed', () => {
  test('averages the answers by tokens and leaves out the benchmark\'s', async () => {
    const r = await localReq(H, { path: '/api/local-models/perf' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.machine, 'Home');
    const m = r.json.models[0];
    assert.equal(m.id, 'qwen-test');
    assert.equal(m.all.answers, 2);
    assert.equal(m.all.writeTps, 55); // 110 tokens in 2 s
    assert.equal(m.all.readTps, 1285.7); // 900 tokens in 0.7 s
    assert.equal(m.all.draftRate, 75);
    assert.equal(m.points.length, 2);
    // what config.json says now, and what it last ran with (another file, a draft model)
    assert.deepEqual(m.settings, { model: 'Qwen-IQ3_XXS.gguf', quant: 'IQ3_XXS', ctx: 131072, kv: 'q8_0', draft: null });
    assert.equal(m.ranWith.draft, 'Qwen-0.6B-Q8_0.gguf');
    assert.equal(m.warn, null); // the slow cache mix was an older start's
    assert.deepEqual(m.sessions.map((s) => s.answers), [1, 1]);
  });

  test('lists every version in the model\'s folder, biggest first, MTP from the file name', async () => {
    const m = (await localReq(H, { path: '/api/local-models/perf' })).json.models[0];
    assert.deepEqual(m.versions.map((v) => [v.id, v.label, v.mtp, v.current]), [
      ['Qwen-IQ3_XXS.gguf', 'IQ3_XXS', false, true],
      ['Qwen-IQ3_XXS-mtp.gguf', 'IQ3_XXS + MTP', true, false],
      ['Qwen-IQ2_S-mtp.gguf', 'IQ2_S + MTP', true, false],
    ]);
  });

  test('a PC without a local model shows the linked PC\'s', async () => {
    const r = await localReq(W, { path: '/api/local-models/perf' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.machine, 'Home');
    assert.equal(r.json.models[0].id, 'qwen-test');
  });

  test('the benchmark runs the everyday version through the same tests and keeps its results', async () => {
    const r = await localReq(W, { method: 'POST', path: '/api/local-models/bench', body: { kind: 'raw' }, headers: { 'X-MC': '1' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.versions, ['Qwen-IQ3_XXS.gguf']);
    const m = await benchDone();
    const run = m.bench[0];
    assert.equal(run.error, null);
    assert.equal(run.build, 'b9999-fake');
    assert.equal(run.settings.label, 'IQ3_XXS');
    assert.deepEqual(run.tests.map((t) => [t.id, t.readTok, t.writeTok, t.writeTps]), [['w512', 128, 512, 50], ['r4k', 4096, 128, 50], ['r16k', 16384, 128, 50], ['r32k', 32768, 128, 50]]);
    // its own flags, without the model's speculative ones
    const s = seenStarts().pop();
    assert.equal(s.spec, null);
    assert.ok(s.args.includes('-ctv') && !s.args.includes('none'));
    // what it last ran with is still the last start that was not the benchmark's
    assert.equal(m.ranWith.draft, 'Qwen-0.6B-Q8_0.gguf');
  });

  test('queues every version; an "-mtp" one runs with MTP, one that does not fit runs with less context', async () => {
    const all = ['Qwen-IQ3_XXS.gguf', 'Qwen-IQ3_XXS-mtp.gguf', 'Qwen-IQ2_S-mtp.gguf'];
    const r = await localReq(H, { method: 'POST', path: '/api/local-models/bench', body: { versions: all, kind: 'raw' }, headers: { 'X-MC': '1' } });
    assert.equal(r.status, 200, r.text);
    const m = await benchDone();
    const runs = m.bench.slice(0, 3).reverse();
    assert.deepEqual(runs.map((x) => [x.version, x.error, x.ctx, x.settings.draft ? 'mtp' : '']), [
      ['Qwen-IQ3_XXS.gguf', null, 131072, ''],
      ['Qwen-IQ3_XXS-mtp.gguf', null, 131072, 'mtp'],
      ['Qwen-IQ2_S-mtp.gguf', null, 65536, 'mtp'],
    ]);
    assert.equal(runs[1].tests[0].writeTps, 80);
    assert.equal(runs[1].tests[0].draftRate, 75);
    const starts = seenStarts().slice(-5);
    assert.deepEqual(starts.map((x) => [x.model, x.ctx, x.spec]), [
      ['Qwen-IQ3_XXS.gguf', 131072, null],
      ['Qwen-IQ3_XXS-mtp.gguf', 131072, 'draft-mtp'],
      ['Qwen-IQ2_S-mtp.gguf', 131072, 'draft-mtp'],
      ['Qwen-IQ2_S-mtp.gguf', 98304, 'draft-mtp'],
      ['Qwen-IQ2_S-mtp.gguf', 65536, 'draft-mtp'],
    ]);
    // every layer on the card, so a version that does not fit fails instead of running slowly
    assert.ok(starts.every((x) => x.args.join(' ').includes('-ngl all')));
  });

  test('real work: every task one at a time, then 4 at once on one model, thinking off, at 32K at most', async () => {
    const r = await localReq(H, { method: 'POST', path: '/api/local-models/bench', body: { versions: ['Qwen-IQ3_XXS-mtp.gguf'] }, headers: { 'X-MC': '1' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.kind, 'real');
    const m = await benchDone();
    const [par, queue] = m.bench.slice(0, 2);
    assert.deepEqual([queue.mode, queue.slots, queue.ctx, queue.error], ['queue', 1, 32768, null]);
    assert.deepEqual([par.mode, par.slots, par.ctx, par.error], ['parallel', 4, 32768, null]);
    for (const run of [queue, par]) {
      assert.equal(run.groups.translate.n, 24);
      assert.equal(run.groups.write.n, 2);
      assert.equal(run.groups.translate.outTok, 24 * 20);
      assert.equal(run.groups.translate.writeTps, 80);
      assert.equal(run.groups.translate.draftRate, 50);
      assert.ok(fs.existsSync(path.join(H.dataDir, 'local-models', 'bench-answers', `${run.id}.json`)));
    }
    // 4 at once is faster in all: 24 answers of 20 ms each, 4 by 4
    assert.ok(par.groups.translate.wallMs < queue.groups.translate.wallMs);
    const chats = fs.readFileSync(path.join(models, 'chats.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(chats.length, 52);
    assert.ok(chats.every((c) => c.thinking === false));
    assert.deepEqual([...new Set(chats.map((c) => `${c.np} ${c.unified}`))], ['1 false', '4 true']);
  });
});
