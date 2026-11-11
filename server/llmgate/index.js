// Mission Control's gate to local models.
//
// A conversation on a local model (lib/localModels.js) still runs the claude program; its settings file points the
// Anthropic API at this gate: ANTHROPIC_BASE_URL = http://127.0.0.1:1705/<model id>/<effort>. The gate
//   - starts the model's llama-server when it is not running (llama-server answers the Anthropic Messages API itself,
//     and sleeps on its own after idleSec without a request, which gives the graphics memory back),
//   - restarts it when its settings in .data/config.json changed since it was started,
//   - turns the effort into the model's thinking settings (none: no thinking; low, medium: a thinking budget; xhigh: no
//     limit) and the sampling values that go with them, and drops what only Claude understands,
//   - never passes the caller's credentials on.
// The server (services/localModels.js) starts it detached on the first local run, so it outlives a restart of the server.
// Listens on 127.0.0.1 only, refuses any other Host and any request from a web page (an Origin header).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ELECTRICITY, GATE_HOST, GATE_PORT, LOCAL_MODELS_DIR } from '../config.js';
import { chooseCtx, recordStart, vramNow, vramSettled } from '../lib/vramFit.js';
import { CORE_TOOLS, ENERGY_FILE, LOAD_TOOLS, LOCAL_EFFORTS, NEVER_TOOLS, expandLoad, groupOf, localModel, localModels, summaryOf } from '../lib/localModels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GATE_FILES = [path.join(here, 'index.js'), path.join(here, '..', 'lib', 'localModels.js'), path.join(here, '..', 'lib', 'vramFit.js'), path.join(here, '..', 'config.js')];
const STAMP = Math.floor(Math.max(...GATE_FILES.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })));

fs.mkdirSync(LOCAL_MODELS_DIR, { recursive: true });
const LOG = path.join(LOCAL_MODELS_DIR, 'gate.log');
try { if (fs.statSync(LOG).size > 5e6) fs.renameSync(LOG, LOG + '.old'); } catch { /* no log yet */ }
const log = (s) => fs.appendFile(LOG, `${new Date().toISOString()} ${s}\n`, () => {});

// Said to the model when its thinking budget runs out, just before its thinking is closed.
const BUDGET_MSG = '\n\nConsidering the limited time, I have to give the answer based on the thinking so far now.\n';
// Sampling per kind of turn (Qwen's own advice); "sampling": { "thinking": {...}, "plain": {...} } in a model's entry replaces them.
const SAMPLING = {
  thinking: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
  plain: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0 },
};
const TOP_LEVEL = ['temperature', 'top_p', 'top_k']; // the Anthropic fields; the rest go in extra_params
const EXTRA_OK = ['min_p', 'presence_penalty', 'repeat_penalty'];
const DROP_HEADERS = ['host', 'authorization', 'x-api-key', 'cookie', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding'];

let inFlight = 0;

// ---- energy ----
// While an answer is being made, nvidia-smi reports the card's draw 4 times a second; joules = the sum of (card watts +
// the rest of the PC) times the time between two readings. A request reads the counter when it starts, at its first
// token and at its end. Stopped 5 s after the last request, so an idle PC runs nothing.
let joules = 0;
let meter = null;
let meterStop = null;
function meterOn() {
  if (meterStop) { clearTimeout(meterStop); meterStop = null; }
  if (meter) return;
  let last = Date.now();
  let watts = 0;
  try {
    meter = spawn('nvidia-smi', ['--query-gpu=power.draw', '--format=csv,noheader,nounits', '-lms', '250'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    meter = null;
    return;
  }
  let buf = '';
  meter.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const w = parseFloat(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const now = Date.now();
      joules += ((watts + ELECTRICITY.otherWatts) * (now - last)) / 1000;
      last = now;
      if (Number.isFinite(w)) watts = w;
    }
  });
  const m = meter;
  m.on('exit', () => { if (meter === m) meter = null; });
  m.on('error', () => { if (meter === m) meter = null; });
}
function meterIdle() {
  if (inFlight || meterStop) return;
  meterStop = setTimeout(() => { meterStop = null; if (!inFlight && meter) { meter.kill(); meter = null; } }, 5000);
}

// Adds one answer to the model's totals (lib/localModels.js ENERGY_FILE) and to the log of answers.
function recordEnergy(m, effort, use, promptJ, outJ, ms) {
  const promptTok = Math.max(0, (use.input_tokens || 0)); // tokens read from llama.cpp's cache are not in input_tokens
  const outTok = use.output_tokens || 0;
  if (!promptTok && !outTok) return;
  let all = {};
  try { all = JSON.parse(fs.readFileSync(ENERGY_FILE, 'utf8')) || {}; } catch { /* first one */ }
  const e = all[m.id] || (all[m.id] = { promptTok: 0, promptJ: 0, outTok: 0, outJ: 0, requests: 0 });
  // an answer whose first token never came (a tool call only) counts all of it as writing
  e.promptTok += promptTok; e.promptJ += promptJ; e.outTok += outTok; e.outJ += outJ; e.requests += 1;
  fs.writeFileSync(ENERGY_FILE, JSON.stringify(all, null, 1));
  fs.appendFile(path.join(LOCAL_MODELS_DIR, 'energy.log'), JSON.stringify({ t: new Date().toISOString(), model: m.id, effort, promptTok, cacheTok: use.cache_read_input_tokens || 0, outTok, promptJ: Math.round(promptJ), outJ: Math.round(outJ), ms }) + '\n', () => {});
}

// The usage numbers of an answer, from its JSON or its event stream (the last value of each wins).
function usageOf(text) {
  const use = {};
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens']) {
    const all = [...text.matchAll(new RegExp(`"${k}"\\s*:\\s*(\\d+)`, 'g'))];
    if (all.length) use[k] = Number(all[all.length - 1][1]);
  }
  return use;
}

// ---- llama-server ----

const sigOf = (m) => crypto.createHash('sha256').update(JSON.stringify([m.server, m.model, m.port, m.ctx, m.args, m.idleSec])).digest('hex').slice(0, 16);
const stateFile = (m) => path.join(LOCAL_MODELS_DIR, `${m.id}.server.json`);
const readState = (m) => { try { return JSON.parse(fs.readFileSync(stateFile(m), 'utf8')); } catch { return null; } };

function get(port, p, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: timeoutMs }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (s.length < 1e6) s += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const killPid = (pid) => new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tail(file, n = 12) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return s.split(/\r?\n/).filter(Boolean).slice(-n).join('\n');
  } catch {
    return '';
  }
}

const starting = new Map(); // model id -> promise of the start in progress

// ---- the context ----
// A model starts with as much context as fits in the graphics memory free at that moment (lib/vramFit.js), up to its
// "ctx". A conversation asks first (GET /gate/plan/<id>), so that it knows its context before the model starts: that
// answer is kept for PLAN_MS and the start uses it.
const PLAN_MS = 5 * 60e3;
const plans = new Map(); // model id -> { ctx, needMB, usedMB, at }
const running = async (m) => { const st = readState(m); const h = st && st.pid && alive(st.pid) && (await get(m.port, '/health')); return h && h.status === 200 ? st : null; };
async function planCtx(m) {
  const st = await running(m);
  if (st && st.sig === sigOf(m)) return { ctx: st.ctx || m.ctx, running: true };
  const p = plans.get(m.id);
  if (p && Date.now() - p.at < PLAN_MS) return p;
  const card = await vramNow();
  const c = chooseCtx({ file: m.model, args: m.args, maxCtx: m.ctx, targetMB: m.vramTargetMB, usedMB: card ? card.usedMB : NaN });
  const plan = { ...c, ctx: c.ctx || m.ctx, fits: !!c.ctx, usedMB: card ? card.usedMB : null, targetMB: m.vramTargetMB, at: Date.now() };
  plans.set(m.id, plan);
  return plan;
}
const gb = (mb) => (mb / 1024).toFixed(1) + ' GB';

// Resolves when the model's llama-server answers, starting it (or restarting it with new settings) when needed.
// Rejects with a message for the conversation.
function ensureServer(m) {
  if (starting.has(m.id)) return starting.get(m.id);
  const p = (async () => {
    const sig = sigOf(m);
    const st = readState(m);
    const up = await get(m.port, '/health');
    if (up) {
      const v1 = await get(m.port, '/v1/models');
      const ids = ((v1 && v1.json && v1.json.data) || []).flatMap((d) => [d.id, ...(Array.isArray(d.aliases) ? d.aliases : [])]);
      const ours = st && st.pid && alive(st.pid);
      if (!ids.includes(m.id) && !ours) throw new Error(`Port ${m.port} is used by another program. Close it, or give ${m.label} another port.`);
      if (ours && st.sig !== sig) {
        log(`${m.id}: settings changed, restarting llama-server (pid ${st.pid})`);
        await killPid(st.pid);
        await sleep(1500);
      } else if (up.status === 200) return;
    }
    if (!fs.existsSync(m.server)) throw new Error(`llama-server is missing: ${m.server}`);
    if (!fs.existsSync(m.model)) throw new Error(`The model file is missing: ${m.model}`);
    if (!(await get(m.port, '/health'))) {
      // the context: the conversation's plan when it asked a moment ago, else what fits now
      const before = await vramSettled();
      let ctx = m.ctx;
      const p = plans.get(m.id);
      if (p && Date.now() - p.at < PLAN_MS) ctx = p.ctx;
      else if (before) {
        const c = chooseCtx({ file: m.model, args: m.args, maxCtx: m.ctx, targetMB: m.vramTargetMB, usedMB: before.usedMB });
        if (!c.ctx) throw new Error(`${m.label} needs ${gb(c.needMB)} of graphics memory, and ${gb(before.usedMB)} of the ${gb(m.vramTargetMB)} it may fill is in use. Unload other models (Ollama, ComfyUI) on the System page and try again.`);
        ctx = c.ctx;
      }
      plans.delete(m.id);
      const args = ['-m', m.model, '--host', '127.0.0.1', '--port', String(m.port), '-c', String(ctx), '--alias', m.id, '-np', '1'];
      if (m.idleSec > 0) args.push('--sleep-idle-seconds', String(m.idleSec));
      args.push(...m.args);
      const outFile = path.join(LOCAL_MODELS_DIR, `${m.id}.server.log`);
      try { if (fs.statSync(outFile).size > 20e6) fs.renameSync(outFile, outFile + '.old'); } catch { /* none yet */ }
      const fd = fs.openSync(outFile, 'a');
      fs.writeSync(fd, `\n===== ${new Date().toISOString()} ${m.server} ${args.join(' ')}\n`);
      const child = spawn(m.server, args, { cwd: path.dirname(m.server), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);
      let exited = null;
      child.on('exit', (code) => { exited = code; });
      child.on('error', (err) => { exited = err.message; });
      child.unref();
      fs.writeFileSync(stateFile(m), JSON.stringify({ pid: child.pid, sig, ctx, startedAt: new Date().toISOString() }));
      log(`${m.id}: started llama-server pid ${child.pid} with ${ctx} context`);
      const until = Date.now() + 5 * 60e3;
      for (;;) {
        await sleep(500);
        if (exited !== null) {
          const t = tail(outFile);
          const vram = /out of memory|failed to allocate|cudaMalloc/i.test(t);
          throw new Error(vram
            ? `${m.label} does not fit in the graphics memory right now. Unload other models (Ollama, ComfyUI) on the System page and try again.`
            : `${m.label} stopped while loading (exit ${exited}). Last lines of ${outFile}:\n${t}`);
        }
        const h = await get(m.port, '/health');
        if (h && h.status === 200) {
          // what this start took on the card, for the next choice and the System page
          const after = await vramNow();
          if (before && after) {
            recordStart(m.model, m.args, ctx, before.usedMB, after.usedMB);
            fs.appendFileSync(outFile, `##### vram ${Math.round(after.usedMB - before.usedMB)} MiB at ${ctx} context, ${Math.round(before.usedMB)} MiB in use before, ${Math.round(after.usedMB)} of ${Math.round(after.totalMB)} MiB after\n`);
          }
          return;
        }
        if (Date.now() > until) throw new Error(`${m.label} took more than 5 minutes to load. See ${outFile}.`);
      }
    }
    // something answered that was not there a moment ago: wait for it to be ready
    const until = Date.now() + 5 * 60e3;
    while (Date.now() < until) {
      const h = await get(m.port, '/health');
      if (h && h.status === 200) return;
      await sleep(500);
    }
    throw new Error(`${m.label} did not become ready.`);
  })().finally(() => starting.delete(m.id));
  starting.set(m.id, p);
  return p;
}

// ---- the prompt and the tools ----
// Claude Code's own prompt, the user's instructions and some 300 tool descriptions would fill most of a local model's
// context. A code conversation gets instead: the short prompt (server/prompts/local-model.md with the user's about.md,
// the project list and the tool groups), the core tools, and the tools it loaded itself (tools_load calls in its history).
const PROMPT_TEMPLATE = path.join(here, '..', 'prompts', 'local-model.md');
const ABOUT_FILE = path.join(LOCAL_MODELS_DIR, 'about.md');
const PROJECTS_FILE = path.join(LOCAL_MODELS_DIR, 'projects.md');
export const CATALOG_FILE = path.join(LOCAL_MODELS_DIR, 'tool-catalog.json');
const readText = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };

// Long descriptions cut short: one tool of a big MCP server can be tens of thousands of tokens.
function trimSchema(x) {
  if (Array.isArray(x)) return x.map(trimSchema);
  if (!x || typeof x !== 'object') return x;
  const o = {};
  for (const [k, v] of Object.entries(x)) o[k] = k === 'description' && typeof v === 'string' && v.length > 300 ? v.slice(0, 297) + '...' : trimSchema(v);
  return o;
}
function trimTool(t) {
  const o = { ...t };
  if (typeof o.description === 'string' && o.description.length > 1500) o.description = o.description.slice(0, 1497) + '...';
  if (o.input_schema) o.input_schema = trimSchema(o.input_schema);
  return o;
}

let catalogText = '';
function writeCatalog(catalog) {
  const text = JSON.stringify(catalog);
  if (text === catalogText) return;
  catalogText = text;
  fs.writeFile(CATALOG_FILE, text, () => {});
}

function loadedIn(messages, catalog) {
  const asked = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b && b.type === 'tool_use' && b.name === 'mcp__mc__tools_load' && b.input && Array.isArray(b.input.names)) asked.push(...b.input.names);
  }
  return new Set(expandLoad(asked, catalog).names);
}

// The lines of Claude Code's prompt that say where the model works.
function environmentOf(system) {
  const t = Array.isArray(system) ? system.map((b) => (b && b.text) || '').join('\n') : String(system || '');
  const keep = t.split('\n').filter((l) => /^\s*-?\s*(Primary working directory|Additional working directories|Is a git repository|Platform|Shell|OS Version)\b/i.test(l));
  return keep.join('\n') || ' - Platform: win32';
}

function buildPrompt(groupLines, env) {
  const fill = { about: readText(ABOUT_FILE), projects: readText(PROJECTS_FILE) || '(none listed)', groups: groupLines, environment: env, date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) };
  return readText(PROMPT_TEMPLATE).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
}

function shapeTools(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length <= 8) return; // a plain chat (its two web tools and its own short prompt): unchanged
  const catalog = {};
  for (const t of tools) if (t && t.name && !CORE_TOOLS.includes(t.name) && !LOAD_TOOLS.includes(t.name) && !NEVER_TOOLS.includes(t.name)) catalog[t.name] = summaryOf(t.description);
  writeCatalog(catalog);
  const canLoad = LOAD_TOOLS.every((n) => tools.some((t) => t.name === n));
  const loaded = canLoad ? loadedIn(body.messages, catalog) : new Set();
  body.tools = tools.filter((t) => CORE_TOOLS.includes(t.name) || (canLoad && LOAD_TOOLS.includes(t.name)) || loaded.has(t.name)).map(trimTool);
  const groups = {};
  for (const n of Object.keys(catalog)) groups[groupOf(n)] = (groups[groupOf(n)] || 0) + 1;
  const groupLines = canLoad ? Object.entries(groups).sort().map(([g, n]) => `- ${g} (${n} tool${n === 1 ? '' : 's'})`).join('\n') : '- (none in this conversation)';
  body.system = buildPrompt(groupLines, environmentOf(body.system));
}

// ---- the request ----

// What a local model gets instead of Claude's options: its own name, the thinking the effort asks for, and its sampling.
function shape(body, m, effort) {
  const e = LOCAL_EFFORTS.find((x) => x.id === effort);
  body.model = m.id;
  shapeTools(body);
  for (const k of ['thinking', 'output_config', 'context_management', 'container', 'mcp_servers', 'service_tier']) delete body[k];
  const extra = body.extra_params && typeof body.extra_params === 'object' && !Array.isArray(body.extra_params) ? body.extra_params : {};
  const kind = e.budget === 0 ? 'plain' : 'thinking';
  const conf = (m.sampling && m.sampling[kind]) || SAMPLING[kind];
  for (const [k, v] of Object.entries(conf)) {
    if (typeof v !== 'number') continue;
    if (TOP_LEVEL.includes(k)) body[k] = v;
    else if (EXTRA_OK.includes(k)) extra[k] = v;
  }
  if (e.budget === 0) body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: false };
  else if (e.budget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: e.budget };
    extra.reasoning_budget_message = BUDGET_MSG;
  }
  body.extra_params = extra;
  return body;
}

function sendError(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: status === 404 ? 'not_found_error' : 'invalid_request_error', message } }));
}

function readBody(req, max = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (d) => { n += d.length; if (n > max) { reject(new Error('request too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

const HOSTS = new Set([`127.0.0.1:${GATE_PORT}`, `localhost:${GATE_PORT}`]);

const server = http.createServer(async (req, res) => {
  if (!HOSTS.has(String(req.headers.host || '').toLowerCase()) || req.headers.origin) return sendError(res, 403, 'forbidden');
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/gate/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, gate: true, pid: process.pid, stamp: STAMP, inFlight, models: localModels().map((m) => m.id) }));
  }
  const planned = /^\/gate\/plan\/([^/]+)$/.exec(url.pathname);
  if (planned) {
    const m = localModel(decodeURIComponent(planned[1]));
    if (!m) return sendError(res, 404, 'unknown local model');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(await planCtx(m)));
  }
  if (url.pathname === '/gate/quit' && req.method === 'POST') {
    // the server replaces a gate older than its code; never in the middle of an answer
    if (inFlight) return sendError(res, 409, 'busy');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    log('quit asked by the server');
    server.close();
    setTimeout(() => process.exit(0), 200);
    return;
  }
  const m1 = /^\/([^/]+)\/([^/]+)(\/v1\/.*)$/.exec(url.pathname);
  const m = m1 && localModel(decodeURIComponent(m1[1]));
  const effort = m1 && decodeURIComponent(m1[2]);
  if (!m || !LOCAL_EFFORTS.some((e) => e.id === effort)) return sendError(res, 404, 'unknown local model or effort');
  const rest = m1[3] + url.search;
  const t0 = Date.now();
  inFlight++;
  let done = false;
  const finish = (status) => { if (done) return; done = true; inFlight--; meterIdle(); log(`${m.id} ${effort} ${req.method} ${m1[3]} ${status} ${Date.now() - t0}ms`); };
  try {
    let body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
    if (body && req.method === 'POST' && /^\/v1\/messages(\/count_tokens)?$/.test(m1[3])) {
      let json;
      try { json = JSON.parse(body.toString('utf8')); } catch { finish(400); return sendError(res, 400, 'the request is not JSON'); }
      body = Buffer.from(JSON.stringify(shape(json, m, effort)));
      if (process.env.MC_GATE_DUMP) fs.writeFileSync(path.join(LOCAL_MODELS_DIR, `last-request-${effort}.json`), body); // tests: what the model got
    }
    try {
      await ensureServer(m);
    } catch (err) {
      log(`${m.id}: ${err.message}`);
      finish(400);
      return sendError(res, 400, err.message);
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_HEADERS.includes(k)) headers[k] = v;
    if (body) headers['content-length'] = String(body.length);
    // an answer (not a token count): its energy is measured from here, split at its first token
    const answer = req.method === 'POST' && m1[3] === '/v1/messages';
    if (answer) meterOn();
    const j0 = joules;
    const up = http.request({ host: '127.0.0.1', port: m.port, method: req.method, path: rest, headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      let text = '';
      let jFirst = null;
      if (answer && ur.statusCode === 200) {
        ur.on('data', (d) => {
          const s = d.toString('utf8');
          if (jFirst === null && s.includes('content_block_delta')) jFirst = joules;
          if (text.length < 4e6) text += s;
        });
      }
      ur.pipe(res);
      ur.on('end', () => {
        if (answer && ur.statusCode === 200) {
          const j1 = joules;
          const split = jFirst === null ? j0 : jFirst;
          try { recordEnergy(m, effort, usageOf(text), split - j0, j1 - split, Date.now() - t0); } catch (err) { log(`energy: ${err.message}`); }
        }
        finish(ur.statusCode);
      });
      ur.on('error', () => { finish(502); res.destroy(); });
    });
    up.on('error', (err) => { finish(502); sendError(res, 502, `${m.label} did not answer: ${err.message}`); });
    // the conversation stopped the answer: stop the model too
    res.on('close', () => { if (!res.writableEnded) up.destroy(); finish(499); });
    up.end(body || undefined);
  } catch (err) {
    finish(500);
    sendError(res, 500, String(err.message || err));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('another gate already listens; this one exits');
    process.exit(73);
  }
  log(`server error: ${err.message}`);
});
server.listen(GATE_PORT, GATE_HOST, () => log(`gate listening on ${GATE_HOST}:${GATE_PORT}, pid ${process.pid}, models: ${localModels().map((m) => m.id).join(', ') || 'none'}`));
