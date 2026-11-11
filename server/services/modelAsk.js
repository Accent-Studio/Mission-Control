// One request to a local model, outside any conversation: a prompt in, the model's text out. For short, self-contained
// jobs that Claude or a script hands off (a translation, a second check of a text), on the PC whose graphics card runs
// the model.
//
// Where it runs: a model of this PC ("localModels" in .data/config.json) goes straight to this PC's gate
// (llmgate/index.js, which loads the model on its first request). Any other model is asked of the PC this one is linked
// to (services/pcLink.js), through the same encrypted link, where that PC's own gate answers; its gate stays on its
// 127.0.0.1. Nothing goes through the hub: with that PC off, the request fails at once and nothing waits anywhere.
//
// Over the link, the answer comes as lines of JSON, a {"wait":s} every few seconds while the model loads or thinks, then
// the result: the link drops a response that says nothing for a minute, and a cold start of a 27B model takes longer.
// Only text goes to the model: no tools, no files, no conversation of this PC.
import http from 'node:http';
import path from 'node:path';
import { GATE_PORT, MACHINE_NAME, ROLE } from '../config.js';
import { ensureGate, localEffort, localModel, localModels } from './localModels.js';
import { LOCAL_EFFORTS } from '../lib/localModels.js';
import { pcCall, pcLinkStatus, pcName, pcOnline, pcPostLines } from './pcLink.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_TOKENS = 32000;
const DEFAULT_TOKENS = 4096;
const RUN_LIMIT_MS = 20 * 60e3; // the model loading, thinking and writing, all of it
const WAIT_EVERY_MS = Number(process.env.MC_MODEL_WAIT_MS) > 0 ? Number(process.env.MC_MODEL_WAIT_MS) : 10e3; // tests: shorter
const STATUS_TTL_MS = 30e3;
const MAX_TEXT = 400e3; // characters of prompt, system and messages together

// ---- The request ----

// The fields a caller may give, checked: { model, effort, system, messages, maxTokens }. A plain "prompt" is one user message.
export function checkAsk(b) {
  if (!b || typeof b !== 'object') throw fail(400, 'The request is empty');
  let messages;
  if (typeof b.prompt === 'string' && b.prompt.trim()) messages = [{ role: 'user', content: b.prompt }];
  else if (Array.isArray(b.messages) && b.messages.length) messages = b.messages;
  else throw fail(400, 'prompt (or messages) is required');
  if (messages.length > 200) throw fail(400, 'Too many messages');
  let size = 0;
  messages = messages.map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw fail(400, 'Each message needs a role of user or assistant');
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : null)) : null;
    if (text === null || (Array.isArray(text) && text.some((t) => t === null))) throw fail(400, 'Messages hold text only');
    const s = Array.isArray(text) ? text.join('\n\n') : text;
    size += s.length;
    return { role: m.role, content: s };
  });
  if (messages[messages.length - 1].role !== 'user') throw fail(400, 'The last message must be the user\'s');
  const system = typeof b.system === 'string' && b.system.trim() ? b.system : undefined;
  size += system ? system.length : 0;
  if (size > MAX_TEXT) throw fail(413, 'The text is too long for one request');
  if (b.model !== undefined && b.model !== null && !(typeof b.model === 'string' && /^[a-z0-9][a-z0-9._-]{0,60}$/i.test(b.model))) throw fail(400, 'model is not a model id');
  if (b.effort !== undefined && b.effort !== null && !LOCAL_EFFORTS.some((e) => e.id === b.effort)) throw fail(400, `effort is one of ${LOCAL_EFFORTS.map((e) => e.id).join(', ')}`);
  const n = Number(b.maxTokens);
  const maxTokens = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_TOKENS) : DEFAULT_TOKENS;
  return { model: b.model || null, effort: b.effort || 'none', system, messages, maxTokens };
}

// ---- On this PC: through its own gate ----

function gatePost(m, effort, body, signal) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port: GATE_PORT, method: 'POST', path: `/${encodeURIComponent(m.id)}/${encodeURIComponent(effort)}/v1/messages`, headers: { 'content-type': 'application/json', 'content-length': data.length, 'anthropic-version': '2023-06-01' } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { if (text.length < 8e6) text += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          if (res.statusCode !== 200) return reject(fail(502, (json && json.error && json.error.message) || `${m.label} answered ${res.statusCode}`));
          if (!json) return reject(fail(502, `${m.label} gave an answer that is not JSON`));
          resolve(json);
        });
        res.on('error', reject);
      },
    );
    const t = setTimeout(() => req.destroy(fail(504, `${m.label} gave no answer in ${RUN_LIMIT_MS / 60e3} minutes`)), RUN_LIMIT_MS);
    req.on('close', () => clearTimeout(t));
    req.on('error', (err) => reject(err.status ? err : fail(502, `The local model gate did not answer: ${err.message}`)));
    if (signal) {
      if (signal.aborted) return req.destroy(fail(499, 'canceled'));
      signal.addEventListener('abort', () => req.destroy(fail(499, 'canceled')), { once: true });
    }
    req.end(data);
  });
}

// Asks a model of this PC. Returns { text, thinking, model, label, machine, effort, ms, inTokens, outTokens, stop, timings, quant }.
export async function askHere(a, signal) {
  if (ROLE === 'hub') throw fail(404, 'A hub runs no local models');
  const m = a.model ? localModel(a.model) : localModels()[0];
  if (!m) throw fail(404, a.model ? `This PC has no local model ${a.model}` : 'This PC has no local model');
  const effort = localEffort(a.effort);
  const t0 = Date.now();
  await ensureGate().catch((err) => { throw fail(503, err.message); });
  const body = { model: m.id, max_tokens: a.maxTokens, messages: a.messages, stream: false };
  if (a.system) body.system = a.system;
  const r = await gatePost(m, effort, body, signal);
  const blocks = Array.isArray(r.content) ? r.content : [];
  const use = r.usage || {};
  return {
    text: blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim(),
    thinking: blocks.filter((b) => b && b.type === 'thinking').map((b) => b.thinking || '').join('').trim() || undefined,
    model: m.id,
    label: m.label,
    machine: MACHINE_NAME,
    effort,
    ms: Date.now() - t0,
    inTokens: use.input_tokens || 0,
    outTokens: use.output_tokens || 0,
    stop: r.stop_reason || null,
    timings: r.timings || null, // llama-server's prompt_ms, predicted_ms, predicted_per_second, when its answer has them
    quant: (/(?:^|[-_.])(I?Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32)(?=[-_.]|$)/i.exec(path.basename(m.model)) || [])[1] || '',
  };
}

// ---- Which PC: this one or the linked one ----

let remote = null; // { at, machine, models: [...] } as the linked PC last listed them
let remoteReading = null;

// The linked PC's models, read through the link (kept for STATUS_TTL_MS; the last list stays while it is off).
export function remoteModels({ fresh = false } = {}) {
  if (!pcLinkStatus().paired) return Promise.resolve(null);
  if (!pcOnline()) return Promise.resolve(remote ? { ...remote, online: false } : null);
  if (!fresh && remote && Date.now() - Date.parse(remote.at) < STATUS_TTL_MS) return Promise.resolve({ ...remote, online: true });
  if (remoteReading) return remoteReading;
  remoteReading = pcCall('GET', '/api/models/local?here=1', { timeout: 8000 })
    .then((r) => {
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.here)) {
        // an older Mission Control there has no such route: it offers no models through the link yet
        remote = { at: new Date().toISOString(), machine: pcName(), models: [], gpu: null, error: r.status === 404 ? `${pcName()} runs an older Mission Control: update it to use its models from here` : `${pcName()} answered ${r.status}` };
      } else {
        remote = { at: new Date().toISOString(), machine: pcName(), models: r.json.here, gpu: r.json.gpu || null, error: null };
      }
      return { ...remote, online: true };
    })
    .catch((err) => (remote ? { ...remote, online: false, error: err.message } : { at: null, machine: pcName(), models: [], gpu: null, online: false, error: err.message }))
    .finally(() => { remoteReading = null; });
  return remoteReading;
}

// This PC's models and whether each is in the graphics memory now (its llama-server answers).
function healthOf(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}
export async function hereModels() {
  if (ROLE === 'hub') return [];
  return Promise.all(localModels().map(async (m) => ({ id: m.id, label: m.label, ctx: m.ctx, efforts: LOCAL_EFFORTS.map((e) => e.id), loaded: await healthOf(m.port) })));
}

// Both lists, for the Connections page and for Claude: { here: [...], linked: { machine, online, models, error } | null }
export async function modelsStatus({ fresh = false } = {}) {
  const [here, linked] = await Promise.all([hereModels(), remoteModels({ fresh })]);
  return { machine: MACHINE_NAME, here, linked };
}

// Asks the model named (or the first one: this PC's, else the linked PC's). The linked PC is asked only when this PC has
// no such model; it never passes the request on again.
export async function ask(input, signal) {
  const a = checkAsk(input);
  if (ROLE === 'hub') throw fail(404, 'A hub runs no local models');
  if ((a.model && localModel(a.model)) || (!a.model && localModels().length)) return askHere(a, signal);
  const st = pcLinkStatus();
  const name = pcName();
  if (!st.paired) throw fail(404, a.model ? `No PC here has the model ${a.model}` : 'This PC has no local model and is linked to no other PC');
  if (!pcOnline()) throw fail(503, `${name} is not reachable (off, asleep or its link is down), so nothing was sent. Try again when it is on.`);
  let r;
  try {
    r = await pcPostLines('/api/models/ask', { ...a, here: true }, { signal, limitMs: RUN_LIMIT_MS + 60e3 });
  } catch (err) {
    if (err.status === 499) throw err;
    throw fail(err.status === 504 ? 504 : 503, `${name} did not answer (${err.message}). Nothing waits on the hub: try again when it is on.`);
  }
  if (r && r.ok !== true && r.status === 404 && r.error === 'Not found') throw fail(501, `${name} runs an older Mission Control: update it to use its models from here`);
  if (!r || r.ok !== true) throw fail((r && r.status) || 502, (r && r.error) || `${name} gave no answer`);
  const { ok, ...rest } = r;
  return rest;
}

// The answer of a route: plain JSON, or (keepalive) lines of JSON with a {"wait":s} every few seconds and then the
// result line, { ok: true, ...result } or { ok: false, status, error }. A caller that hangs up cancels the model's work.
export async function answer(res, run, { keepalive = false } = {}) {
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  if (!keepalive) {
    try {
      const out = await run(ctl.signal);
      return send(res, 200, { ok: true, ...out });
    } catch (err) {
      return send(res, err.status || 500, { ok: false, status: err.status || 500, error: String(err.message || err) });
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const t0 = Date.now();
  const tick = setInterval(() => { if (!res.writableEnded) res.write(JSON.stringify({ wait: Math.round((Date.now() - t0) / 1000) }) + '\n'); }, WAIT_EVERY_MS);
  res.write(JSON.stringify({ wait: 0 }) + '\n');
  let line;
  try {
    line = { ok: true, ...(await run(ctl.signal)) };
  } catch (err) {
    line = { ok: false, status: err.status || 500, error: String(err.message || err) };
  } finally {
    clearInterval(tick);
  }
  if (!res.writableEnded && !res.destroyed) res.end(JSON.stringify(line) + '\n');
}

function send(res, status, obj) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
