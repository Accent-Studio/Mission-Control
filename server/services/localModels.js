// Local models in the chat (see lib/localModels.js and llmgate/index.js).
//
// A run on a local model is the same claude program with one more flag: --settings <file>, a file of this folder whose
// "env" points the Anthropic API at the gate, with the model and the effort in the address. Every model role (main,
// small and fast, helpers) is the local model, so nothing of the conversation goes to Anthropic.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GATE_PORT, LOCAL_MODELS_DIR } from '../config.js';
import { loadCatalog } from './catalog.js';
import { LOCAL_EFFORTS, localEffort, localModel, localModels, isLocalModel } from '../lib/localModels.js';

export { LOCAL_EFFORTS, localEffort, localModel, localModels, isLocalModel };

const here = path.dirname(fileURLToPath(import.meta.url));
const GATE_MAIN = path.join(here, '..', 'llmgate', 'index.js');
const GATE_FILES = [GATE_MAIN, path.join(here, '..', 'lib', 'localModels.js'), path.join(here, '..', 'lib', 'vramFit.js'), path.join(here, '..', 'config.js')];
const gateStamp = () => Math.floor(Math.max(...GATE_FILES.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })));

// The settings file of a model and effort, written fresh for every run (the path is what the runner accepts). ctx: the
// context the model has (gatePlan), so that the conversation compacts before it is full.
export function settingsFileFor(id, effort, ctx) {
  const m = localModel(id);
  if (!m) throw new Error('unknown local model');
  const e = localEffort(effort);
  const window = Number.isInteger(ctx) && ctx > 0 ? Math.min(ctx, m.ctx) : m.ctx;
  fs.mkdirSync(LOCAL_MODELS_DIR, { recursive: true });
  const env = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${GATE_PORT}/${encodeURIComponent(m.id)}/${e}`,
    ANTHROPIC_AUTH_TOKEN: 'local', // the gate drops it; it keeps the claude.ai sign-in from being sent anywhere
    ANTHROPIC_MODEL: m.id,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m.id,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m.id,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m.id,
    ANTHROPIC_SMALL_FAST_MODEL: m.id,
    CLAUDE_CODE_SUBAGENT_MODEL: m.id,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    // the gate gives the model its own short prompt (server/prompts/local-model.md); the user's CLAUDE.md and memory
    // would fill a small context, the prompt carries what matters of them
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window), // compact before the model's own context is full, not Claude's
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.min(32000, Math.floor(window / 4))),
  };
  const file = path.join(LOCAL_MODELS_DIR, `${m.id}-${e}.json`);
  // skipWebFetchPreflight: WebFetch would otherwise send each address to Anthropic for its blocklist check first
  const text = JSON.stringify({ env, skipWebFetchPreflight: true }, null, 2);
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  if (old !== text) fs.writeFileSync(file, text);
  return file;
}

// The project list the gate puts in the model's prompt: one line per project, written before each local run.
export function writeProjectsFile() {
  let list = [];
  try {
    list = loadCatalog();
  } catch {
    list = [];
  }
  const lines = list.filter((p) => p && p.name && p.folder).map((p) => `- ${p.name}: ${p.folder}${p.about ? ` (${String(p.about).replace(/\s+/g, ' ').slice(0, 120)})` : ''}`);
  const text = lines.join('\n') + '\n';
  const file = path.join(LOCAL_MODELS_DIR, 'projects.md');
  fs.mkdirSync(LOCAL_MODELS_DIR, { recursive: true });
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  if (old !== text) fs.writeFileSync(file, text);
}

function call(method, p, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: GATE_PORT, method, path: p, timeout: timeoutMs }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(s) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

// The context the model has, or will start with (the gate picks what fits on the card); the model's "ctx" when the gate
// does not say.
export async function gatePlan(id) {
  const m = localModel(id);
  if (!m) return null;
  const r = await call('GET', `/gate/plan/${encodeURIComponent(id)}`, 10000);
  return r && r.json && Number.isInteger(r.json.ctx) ? r.json.ctx : m.ctx;
}

let ensuring = null;

// Makes sure the gate runs, and runs this code: an older gate is replaced when it is not in the middle of an answer.
export function ensureGate() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    let h = await call('GET', '/gate/health');
    if (h && h.json && h.json.gate && h.json.stamp < gateStamp() && !h.json.inFlight) {
      const q = await call('POST', '/gate/quit');
      if (q && q.status === 200) {
        for (let i = 0; i < 20 && (await call('GET', '/gate/health')); i++) await new Promise((r) => setTimeout(r, 150));
        h = null;
      }
    }
    if (h && h.json && h.json.gate) return;
    if (h) throw new Error(`Port ${GATE_PORT} is used by another program, so local models cannot run.`);
    const child = spawn(process.execPath, [GATE_MAIN], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const r = await call('GET', '/gate/health');
      if (r && r.json && r.json.gate) return;
    }
    throw new Error('The local model gate did not start.');
  })().finally(() => { ensuring = null; });
  return ensuring;
}

// For the model list: a local model the chat can offer.
export const localModelOptions = () => localModels().map((m) => ({ id: m.id, label: `${m.label} (local)`, flag: m.id, local: true, efforts: LOCAL_EFFORTS.map(({ id, label }) => ({ id, label })) }));
