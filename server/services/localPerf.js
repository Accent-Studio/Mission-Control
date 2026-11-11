// How fast the local models run (System page, Local model speed).
//
// Every answer: llama-server writes its own timings to <id>.server.log (prompt eval time, eval time, and the draft
// acceptance rate when speculative decoding is on). Those lines are read back here, so every answer is counted, whoever
// asked it (a conversation, local_model, the Mac through the link), and today's answers are in it too. A log line's time
// is minutes.seconds.ms since the "=====" line that started that llama-server, which holds the start time and the flags.
//
// The benchmark: the same fixed tests every time, straight to a llama-server (/completion, the prompt as token ids, a
// fixed number of tokens written whatever the model would say, nothing cached), so two runs compare. It can run every
// version of the model in its folder, one after the other: each is started on the model's port with its own file, and
// stopped after; the everyday settings are never changed. Results go to bench.json; its answers are left out of the
// everyday numbers.
import fs from 'node:fs';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { GATE_PORT, LOCAL_MODELS_DIR } from '../config.js';
import { publish } from '../lib/events.js';
import { ensureGate, localModel, localModels } from './localModels.js';
import { parseServerLog, settingsOf } from '../lib/localPerfLog.js';
import { benchTasks } from '../lib/benchTasks.js';
import { CTX_STEPS, chooseCtx, recordStart, vramNow, vramSettled } from '../lib/vramFit.js';

const BENCH_FILE = path.join(LOCAL_MODELS_DIR, 'bench.json');
const BENCH_KEEP = 100;

// One model's log, read again only when it changed (the .old file once, the log from where it stopped).
const cache = new Map(); // model id -> { size, mtime, oldMtime, parsed }
function readModel(m) {
  const file = path.join(LOCAL_MODELS_DIR, `${m.id}.server.log`);
  const old = file + '.old';
  let st = null, os = null;
  try { st = fs.statSync(file); } catch { /* not run yet */ }
  try { os = fs.statSync(old); } catch { /* not rotated yet */ }
  const c = cache.get(m.id);
  if (c && st && c.size === st.size && c.mtime === st.mtimeMs && c.oldMtime === (os ? os.mtimeMs : 0)) return c.parsed;
  let text = '';
  try { if (os) text += fs.readFileSync(old, 'utf8') + '\n'; } catch { /* gone */ }
  try { if (st) text += fs.readFileSync(file, 'utf8'); } catch { /* gone */ }
  const parsed = parseServerLog(text, { model: m.model, ctx: m.ctx });
  cache.set(m.id, { size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0, oldMtime: os ? os.mtimeMs : 0, parsed });
  return parsed;
}

// ---- The numbers ----

const MIN_GEN = 8; // tokens written: fewer is too short to time
const MIN_READ = 128; // tokens read: a short prompt reads slower per token, and most of it came from the cache
const rate = (tok, ms) => (ms > 0 ? (tok / ms) * 1000 : null);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// Writing and reading speed of a list of answers, by tokens (a long answer counts more than a short one).
function speeds(list) {
  let gT = 0, gM = 0, pT = 0, pM = 0, dOk = 0, dAll = 0, n = 0;
  for (const a of list) {
    n++;
    if (a.genTok >= MIN_GEN) { gT += a.genTok; gM += a.genMs; }
    if (a.promptTok >= MIN_READ) { pT += a.promptTok; pM += a.promptMs; }
    if (a.draftAll) { dOk += a.draftOk; dAll += a.draftAll; }
  }
  return { answers: n, writeTps: round1(rate(gT, gM)), readTps: round1(rate(pT, pM)), written: gT, read: pT, draftRate: dAll ? Math.round((dOk / dAll) * 100) : null };
}

function readBench() {
  try { const j = JSON.parse(fs.readFileSync(BENCH_FILE, 'utf8')); return Array.isArray(j.runs) ? j.runs : []; } catch { return []; }
}

// the context is left out: the gate picks it at each start, up to the saved one
const sameSettings = (a, b) => ['model', 'quant', 'kv', 'draft'].every((k) => a[k] === b[k]);

// Everything the panel shows for one model.
function modelPerf(m) {
  const { sessions, answers } = readModel(m);
  const bench = readBench().filter((r) => r.model === m.id);
  const inBench = (t) => bench.some((r) => t >= Date.parse(r.startedAt) - 2000 && t <= Date.parse(r.endedAt || r.startedAt) + 2000);
  const real = answers.filter((a) => !inBench(a.t));
  const last = sessions.filter((x) => !inBench(x.at)).pop(); // the benchmark's own starts are not the everyday settings
  const saved = settingsOf([...m.args, '-m', m.model, '-c', String(m.ctx)]);
  return {
    id: m.id,
    label: m.label,
    // the settings of .data/config.json, and the ones the model last ran with when they differ (it has not started since)
    settings: saved,
    ranWith: last && !sameSettings(last.settings, saved) ? last.settings : null,
    warn: last && sameSettings(last.settings, saved) ? last.warn : null,
    // the last everyday start: its context and what it took on the card
    lastStart: last ? { at: new Date(last.at).toISOString(), ctx: last.settings.ctx, vram: last.vram } : null,
    targetMB: m.vramTargetMB,
    all: speeds(real),
    // [time, write t/s, tokens written, read t/s, tokens read, context after, draft % or null]
    points: real.slice(-5000).map((a) => [a.t, a.genTok >= MIN_GEN ? round1(rate(a.genTok, a.genMs)) : null, a.genTok, a.promptTok >= MIN_READ ? round1(rate(a.promptTok, a.promptMs)) : null, a.promptTok, a.ctx, a.draftAll ? Math.round((a.draftOk / a.draftAll) * 100) : null]),
    sessions: sessions.map((s, i) => ({ at: new Date(s.at).toISOString(), settings: s.settings, vram: s.vram, ...speeds(real.filter((a) => a.s === i)) })).filter((s) => s.answers).reverse().slice(0, 30),
    bench: bench.slice(-30).reverse(),
    versions: modelVersions(m).map(({ file, ...v }) => v),
  };
}

export function getLocalPerf() {
  return { models: localModels().map(modelPerf), benching: running ? { ...running } : null };
}

// ---- The benchmark ----

// The tests, the same every run. read: tokens of prompt; write: tokens written.
export const BENCH_TESTS = [
  { id: 'w512', label: 'Short prompt, 512 written', read: 128, write: 512 },
  { id: 'r4k', label: '4K prompt', read: 4096, write: 128 },
  { id: 'r16k', label: '16K prompt', read: 16384, write: 128 },
  { id: 'r32k', label: '32K prompt', read: 32768, write: 128 },
];

let running = null; // { model, version, vstep, vof, step, of, label, startedAt }

function postJson(port, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (s += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, json: j, text: s.slice(0, 500) }); });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject);
    req.end(data);
  });
}
function getJson(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (s += d));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Text that is the same on every run and does not repeat, so nothing in it is easy to guess.
function benchText(words) {
  const W = 'the a river stone light window paper market engine color garden quiet north winter yellow simple careful number between under across morning evening village signal picture music letter answer system road bridge forest ocean planet table chair door kitchen city train ticket station orange copper silver glass summer spring autumn moment reason result method sample record detail figure pattern balance motion window distance surface pressure season'.split(' ');
  let x = 12345;
  const out = [];
  for (let i = 0; i < words; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push(W[x % W.length]);
    if (x % 13 === 0) out.push('.');
  }
  return out.join(' ');
}

const step = (o) => { running = { ...running, ...o }; publish('localperf.bench', running); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const killPid = (pid) => new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
const stateFile = (m) => path.join(LOCAL_MODELS_DIR, `${m.id}.server.json`);
const logFile = (m) => path.join(LOCAL_MODELS_DIR, `${m.id}.server.log`);
function tail(file, n = 12) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n).join('\n'); } catch { return ''; }
}

// ---- The versions of a model ----
// Every model file in the folder of the model's file is a version the benchmark can run (not the vision projector, a
// separate draft head or the importance matrix). A file whose name ends in "-mtp" carries its MTP head: it runs with
// speculative decoding on. The model's own flags (cache types, vision) go with every version, its speculative ones never.
const NOT_A_MODEL = /mmproj|imatrix|^mtp-|^dflash-|^draft-/i;
export function modelVersions(m) {
  let files = [];
  try { files = fs.readdirSync(path.dirname(m.model)).filter((f) => /\.gguf$/i.test(f) && !NOT_A_MODEL.test(f)); } catch { /* folder gone */ }
  if (!files.includes(path.basename(m.model))) files.push(path.basename(m.model));
  return files.map((f) => {
    const file = path.join(path.dirname(m.model), f);
    let bytes = null;
    try { bytes = fs.statSync(file).size; } catch { /* missing */ }
    const mtp = /-mtp\.gguf$/i.test(f);
    const q = settingsOf(['-m', file]).quant;
    return { id: f, file, bytes, mtp, current: file === m.model, label: (q || f.replace(/\.gguf$/i, '')) + (mtp ? ' + MTP' : '') };
  }).sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
}
const SPEC_WITH_VALUE = ['--spec-type', '--spec-draft-model', '-md', '--model-draft', '--spec-draft-n-max', '--spec-draft-n-min', '--spec-draft-hf', '-hfd', '-hfrd', '--hf-repo-draft'];
function baseArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) { if (SPEC_WITH_VALUE.includes(args[i])) i++; else out.push(args[i]); }
  return out;
}

// Stops the model's llama-server (the gate starts the everyday one again on its next request). False when something
// else holds the port.
async function stopServer(m) {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(stateFile(m), 'utf8')); } catch { /* none */ }
  if (st && st.pid && alive(st.pid)) await killPid(st.pid);
  for (let i = 0; i < 40; i++) { if (!(await getJson(m.port, '/health'))) return true; await sleep(250); }
  return false;
}

// The flags of a version: the model's own (cache types, vision) without its speculative ones; MTP for an "-mtp" file.
const versionArgs = (m, v) => [...baseArgs(m.args), ...(v.mtp ? ['--spec-type', 'draft-mtp'] : [])];

// Starts one version on the model's port, as the gate would but with this file and its flags; { pid, ownMB } or throws
// (err.oom: it did not fit in the graphics memory). Every layer on the card ("-ngl all"): left to itself, llama.cpp moves
// the layers that do not fit to the PC's memory without a word, and writing runs at half speed. slots > 1: that many
// requests at once, sharing one context of ctx tokens.
async function startVersion(m, v, ctx, before, slots = 1) {
  const args = [...versionArgs(m, v), '-m', v.file, '--host', '127.0.0.1', '--port', String(m.port), '-c', String(ctx), '--alias', m.id, '-np', String(slots), '-ngl', 'all'];
  if (slots > 1) args.push('--kv-unified');
  fs.mkdirSync(LOCAL_MODELS_DIR, { recursive: true });
  const fd = fs.openSync(logFile(m), 'a');
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} ${m.server} ${args.join(' ')}\n`);
  const child = spawn(m.server, args, { cwd: path.dirname(m.server), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  child.on('error', (err) => { exited = err.message; });
  child.unref();
  // the gate sees a server of its own with other settings, and replaces it with the everyday one on its next request
  fs.writeFileSync(stateFile(m), JSON.stringify({ pid: child.pid, sig: 'bench', startedAt: new Date().toISOString() }));
  const until = Date.now() + 5 * 60e3;
  for (;;) {
    await sleep(500);
    if (exited !== null) {
      const t = tail(logFile(m));
      throw Object.assign(new Error(`It stopped while loading (exit ${exited}). ${t.split('\n').slice(-2).join(' ')}`), { oom: /out of memory|failed to allocate|cudaMalloc/i.test(t) });
    }
    const h = await getJson(m.port, '/health');
    if (h && h.status === 'ok') {
      // what it took on the card: for the gate's next choice, and the System page
      const after = await vramNow();
      let ownMB = null;
      if (before && after) {
        ownMB = Math.round(after.usedMB - before.usedMB);
        if (slots === 1) recordStart(v.file, versionArgs(m, v), ctx, before.usedMB, after.usedMB);
        fs.appendFileSync(logFile(m), `##### vram ${ownMB} MiB at ${ctx} context, ${Math.round(before.usedMB)} MiB in use before, ${Math.round(after.usedMB)} of ${Math.round(after.totalMB)} MiB after\n`);
      }
      return { pid: child.pid, ownMB, totalMB: after ? Math.round(after.usedMB) : null };
    }
    if (Date.now() > until) { await killPid(child.pid); throw new Error('It took more than 5 minutes to load.'); }
  }
}

// Stops what runs on the port and starts the version with the most context up to maxCtx that fits under the target
// (less if it still does not load). Fills run.ctx, run.vramMB, run.cardMB and run.build; returns the pid.
async function loadVersion(m, v, run, maxCtx, slots) {
  if (!fs.existsSync(v.file)) throw new Error('The file is missing.');
  if (!(await stopServer(m))) throw new Error(`Port ${m.port} is used by another program.`);
  const before = await vramSettled();
  const c = chooseCtx({ file: v.file, args: versionArgs(m, v), maxCtx, targetMB: m.vramTargetMB, usedMB: before ? before.usedMB : NaN });
  if (!c.ctx) throw new Error(`It needs ${(c.needMB / 1024).toFixed(1)} GB of graphics memory at its smallest context, and ${(before.usedMB / 1024).toFixed(1)} GB is in use.`);
  const sizes = [c.ctx, ...CTX_STEPS.filter((x) => x < c.ctx && x >= 16384)];
  for (const ctx of sizes) {
    step({ label: `Loading at ${Math.round(ctx / 1024)}K context` });
    try {
      run.ctx = ctx;
      const s = await startVersion(m, v, ctx, before, slots);
      run.vramMB = s.ownMB; run.cardMB = s.totalMB;
      const props = await getJson(m.port, '/props');
      run.build = (props && props.build_info) || null;
      return s.pid;
    } catch (err) { if (!err.oom || ctx === sizes[sizes.length - 1]) throw err; }
  }
  throw new Error('It did not load.');
}

// Adds a finished run to bench.json, with the settings it ran with.
function saveRun(m, v, run) {
  run.endedAt = new Date().toISOString();
  cache.delete(m.id);
  run.settings = { ...settingsOf([...versionArgs(m, v), '-m', v.file, '-c', String(run.ctx || m.ctx)]), label: v.label };
  const all = readBench();
  all.push(run);
  fs.mkdirSync(LOCAL_MODELS_DIR, { recursive: true });
  fs.writeFileSync(BENCH_FILE, JSON.stringify({ runs: all.slice(-BENCH_KEEP) }, null, 1));
  return run;
}

async function checkFree() {
  await ensureGate();
  const h = await getJson(GATE_PORT, '/gate/health');
  if (h && h.inFlight) throw new Error('The model is answering something else. Try again when it is done.');
}

// Raw speed: random words, a fixed number of tokens written, nothing cached.
async function runRaw(m, v) {
  const run = { id: Date.now().toString(36), kind: 'raw', model: m.id, version: v.id, startedAt: new Date().toISOString(), endedAt: null, settings: null, ctx: null, build: null, tests: [], error: null };
  let pid = null;
  try {
    await checkFree();
    pid = await loadVersion(m, v, run, m.ctx, 1);
    const tok = await postJson(m.port, '/tokenize', { content: benchText(40000) }, 60e3);
    const ids = tok.json && tok.json.tokens;
    if (!Array.isArray(ids) || ids.length < 1000) throw new Error('llama-server did not tokenize the test text.');
    const tests = BENCH_TESTS.filter((t) => t.read + t.write < run.ctx && t.read <= ids.length);
    for (let i = 0; i < tests.length; i++) {
      const t = tests[i];
      step({ step: i + 1, of: tests.length, label: t.label });
      const r = await postJson(m.port, '/completion', { prompt: ids.slice(0, t.read), n_predict: t.write, ignore_eos: true, temperature: 0, cache_prompt: false, stream: false }, 10 * 60e3);
      const tm = r.json && r.json.timings;
      if (r.status !== 200 || !tm) throw new Error(`${t.label}: ${(r.json && r.json.error && r.json.error.message) || r.text || r.status}`);
      run.tests.push({
        id: t.id, label: t.label,
        readTok: tm.prompt_n, readTps: round1(tm.prompt_per_second), writeTok: tm.predicted_n, writeTps: round1(tm.predicted_per_second),
        ms: Math.round((tm.prompt_ms || 0) + (tm.predicted_ms || 0)),
        draftRate: tm.draft_n ? Math.round((tm.draft_n_accepted / tm.draft_n) * 100) : null,
      });
    }
  } catch (err) {
    run.error = String(err.message || err);
  }
  // the graphics memory goes back; the gate loads the everyday version when it is next asked
  if (pid) { await killPid(pid); try { fs.unlinkSync(stateFile(m)); } catch { /* gone */ } }
  return saveRun(m, v, run);
}

// ---- Real work: short prompts and long replies, one at a time or several at once ----
// Thinking off, the everyday sampling of a turn without thinking (Qwen's own advice) and a fixed seed. Queue: one
// request at a time, as a list of jobs sent one after the other. Parallel: REAL_SLOTS requests at once on one model
// (llama.cpp batches them: each is a little slower, all of them together much faster), every task sent at once.
export const REAL_CTX = 32768;
export const REAL_SLOTS = 4;
const ANSWERS_DIR = path.join(LOCAL_MODELS_DIR, 'bench-answers');

async function oneTask(m, t) {
  const t0 = Date.now();
  const r = await postJson(m.port, '/v1/chat/completions', {
    model: m.id, messages: t.messages, max_tokens: t.maxTokens, stream: false, seed: 42,
    temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, chat_template_kwargs: { enable_thinking: false },
  }, 10 * 60e3);
  const ms = Date.now() - t0;
  if (r.status !== 200 || !r.json) throw new Error(`${t.label}: ${(r.json && r.json.error && r.json.error.message) || r.text || r.status}`);
  const tm = r.json.timings || {};
  const use = r.json.usage || {};
  const text = (((r.json.choices || [])[0] || {}).message || {}).content || '';
  return {
    id: t.id, group: t.group, ms, text,
    inTok: tm.prompt_n != null ? tm.prompt_n : use.prompt_tokens || 0, outTok: tm.predicted_n != null ? tm.predicted_n : use.completion_tokens || 0,
    genMs: tm.predicted_ms || 0, readMs: tm.prompt_ms || 0, draftOk: tm.draft_n_accepted || 0, draftAll: tm.draft_n || 0,
  };
}

// One group's numbers: wall time, the average time each task waited for its answer, the speed of one answer (tokens
// per second of its own writing) and the speed of all of them together (tokens written per second of wall time).
function groupStats(res, wallMs) {
  const out = res.reduce((n, x) => n + x.outTok, 0), gen = res.reduce((n, x) => n + x.genMs, 0);
  const dOk = res.reduce((n, x) => n + x.draftOk, 0), dAll = res.reduce((n, x) => n + x.draftAll, 0);
  return {
    n: res.length, wallMs, outTok: out, inTok: res.reduce((n, x) => n + x.inTok, 0),
    avgMs: Math.round(res.reduce((n, x) => n + x.ms, 0) / Math.max(1, res.length)), maxMs: Math.max(0, ...res.map((x) => x.ms)),
    writeTps: round1(rate(out, gen)), totalTps: round1(rate(out, wallMs)), draftRate: dAll ? Math.round((dOk / dAll) * 100) : null,
  };
}

async function runReal(m, v, mode) {
  const slots = mode === 'parallel' ? REAL_SLOTS : 1;
  const run = { id: Date.now().toString(36) + mode[0], kind: 'real', mode, slots, model: m.id, version: v.id, startedAt: new Date().toISOString(), endedAt: null, settings: null, ctx: null, build: null, groups: {}, error: null };
  let pid = null;
  try {
    await checkFree();
    pid = await loadVersion(m, v, run, Math.min(m.ctx, REAL_CTX), slots);
    const tasks = benchTasks();
    const answers = [];
    for (const group of ['translate', 'write']) {
      const list = tasks.filter((t) => t.group === group);
      const label = group === 'translate' ? 'Short prompts' : 'Long replies';
      let done = 0;
      step({ step: 0, of: list.length, label: `${label}, ${mode === 'parallel' ? `${slots} at once` : 'one at a time'}` });
      const tick = (x) => { done++; step({ step: done, of: list.length }); answers.push(x); return x; };
      const t0 = Date.now();
      const res = mode === 'parallel'
        ? await Promise.all(list.map((t) => oneTask(m, t).then(tick)))
        : await list.reduce((p, t) => p.then(async (acc) => [...acc, tick(await oneTask(m, t))]), Promise.resolve([]));
      run.groups[group] = groupStats(res, Date.now() - t0);
    }
    // the answers themselves, to compare what each version wrote
    fs.mkdirSync(ANSWERS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ANSWERS_DIR, `${run.id}.json`), JSON.stringify({ version: v.id, mode, answers: answers.map(({ id, text, outTok, ms }) => ({ id, ms, outTok, text })) }, null, 1));
  } catch (err) {
    run.error = String(err.message || err);
  }
  if (pid) { await killPid(pid); try { fs.unlinkSync(stateFile(m)); } catch { /* gone */ } }
  return saveRun(m, v, run);
}

// Starts the benchmark of some of a model's versions (ids from modelVersions; none given: the everyday one), one after
// the other, and returns at once; the page reads its progress in GET /api/local-models/perf.
// kind "real" (the default): each version does the real work one at a time, then several at once. "raw": raw speed.
export function startBench(id, versions, kind = 'real') {
  const m = id ? localModel(id) : localModels()[0];
  if (!m) throw Object.assign(new Error('No local model on this PC'), { status: 404 });
  if (running) throw Object.assign(new Error('A benchmark is already running'), { status: 409 });
  const all = modelVersions(m);
  const list = Array.isArray(versions) && versions.length ? all.filter((v) => versions.includes(v.id)) : all.filter((v) => v.current);
  if (!list.length) throw Object.assign(new Error('None of those versions is in the model\'s folder'), { status: 400 });
  const jobs = kind === 'raw' ? list.map((v) => ({ v, go: () => runRaw(m, v) })) : list.flatMap((v) => ['queue', 'parallel'].map((mode) => ({ v, go: () => runReal(m, v, mode) })));
  running = { model: m.id, kind, version: list[0].label, vstep: 1, vof: jobs.length, step: 0, of: 0, label: 'Starting', startedAt: new Date().toISOString() };
  publish('localperf.bench', running);
  (async () => {
    const errors = [];
    for (let i = 0; i < jobs.length; i++) {
      step({ version: jobs[i].v.label, vstep: i + 1, vof: jobs.length, step: 0, label: 'Loading' });
      const r = await jobs[i].go().catch((err) => ({ error: String(err.message || err) }));
      if (r.error) errors.push(`${jobs[i].v.label}: ${r.error}`);
    }
    return errors.join('; ') || null;
  })()
    .catch((err) => String(err.message || err))
    .then((error) => { running = null; publish('localperf.bench', { done: true, model: m.id, error }); });
  return { started: true, model: m.id, kind, versions: list.map((v) => v.id) };
}
