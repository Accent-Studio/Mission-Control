// Local AI engines (Ollama, llama.cpp, llama-swap, LM Studio, ComfyUI): which models they hold in
// memory and how to unload them with each engine's own API. Killing a process stays a separate,
// last-resort action in system.js.
//
// Rules: loopback only, 1.5 s per probe, all probes in parallel, the list is cached for 5 s and is
// only refreshed when a page asks (no background loop). An engine is identified by what it answers,
// never by its port alone.
import { publish } from '../lib/events.js';
import { listening } from './servers.js';
import { vramOfTree } from './system.js';

const PROBE_TIMEOUT_MS = 1500;
const ACTION_TIMEOUT_MS = 10000;
const CACHE_MS = 5000;
const SETTLE_MS = 1500;
const MAX_BODY = 2 * 1024 * 1024;
const MB = 1048576;

const LABELS = {
  ollama: 'Ollama',
  llamacpp: 'llama.cpp server',
  llamaswap: 'llama-swap',
  lmstudio: 'LM Studio',
  comfyui: 'ComfyUI',
};
// Output order, and the order in which engines claim a port when two answer on the same one.
const ORDER = ['ollama', 'llamaswap', 'lmstudio', 'llamacpp', 'comfyui'];
const OUTPUT_ORDER = ['ollama', 'llamacpp', 'llamaswap', 'lmstudio', 'comfyui'];

const DEFAULT_PORTS = { ollama: [11434], llamacpp: [8080], llamaswap: [8080], lmstudio: [1234], comfyui: [8188, 8000] };

// MC_ENGINE_PORTS="ollama=47301,llamacpp=47302,..." replaces the ports of the named engines (tests).
function readPorts() {
  const ports = { ...DEFAULT_PORTS };
  for (const part of (process.env.MC_ENGINE_PORTS || '').split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    const n = Number(v);
    if (k in DEFAULT_PORTS && Number.isInteger(n) && n > 0 && n < 65536) ports[k] = [n];
  }
  return ports;
}
const PORTS = readPorts();

const round1 = (n) => Math.round(n * 10) / 10;
const toMB = (bytes) => (Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes / MB) : null);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// ---- HTTP to the engines ----

async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Never throws: { status, ok, json } on any HTTP answer, null when nothing answered in time.
async function call(port, path, { method = 'GET', body, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    let json = null;
    try {
      json = JSON.parse(await readCapped(res));
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json };
  } catch {
    return null;
  }
}

const get = (port, path) => call(port, path);

// ---- Adapters ----
// probe(port) -> null when this engine is not there, else { version, models, note?, ctx }.
// A model is { id, label, vramMB|null, canUnload } (adapters may add private fields).
// unload(port, ctx, id) -> true when the engine accepted the request.

const ollama = {
  async probe(port) {
    const [v, ps] = await Promise.all([get(port, '/api/version'), get(port, '/api/ps')]);
    if (!v || !v.ok || !isObj(v.json) || typeof v.json.version !== 'string') return null;
    const list = ps && ps.ok && isObj(ps.json) && Array.isArray(ps.json.models) ? ps.json.models : [];
    const models = list
      .map((m) => ({
        id: String(m.name || m.model || ''),
        label: String(m.name || m.model || ''),
        vramMB: toMB(m.size_vram),
        canUnload: true,
        expiresAt: m.expires_at || null,
      }))
      .filter((m) => m.id);
    return { version: v.json.version, models, ctx: {} };
  },
  async unload(port, ctx, id) {
    // keep_alive 0 on an empty request unloads the model. The id comes from the live list, so this
    // can never load a model by accident.
    const r = await call(port, '/api/generate', { method: 'POST', body: { model: id, keep_alive: 0 }, timeoutMs: ACTION_TIMEOUT_MS });
    return !!(r && r.ok);
  },
};

const llamacpp = {
  async probe(port) {
    const [models, props] = await Promise.all([get(port, '/models'), get(port, '/props')]);
    const props_ = props && props.ok && isObj(props.json) ? props.json : null;
    const version = props_ && typeof props_.build_info === 'string' ? props_.build_info : null;
    // Router mode: /models lists every known model with a status, loaded or not.
    const data = models && models.ok && isObj(models.json) && Array.isArray(models.json.data) ? models.json.data : null;
    if (data && data.some((m) => isObj(m) && isObj(m.status) && typeof m.status.value === 'string')) {
      const held = data.filter((m) => isObj(m.status) && ['loaded', 'loading'].includes(m.status.value));
      return {
        version,
        models: held.map((m) => ({
          id: String(m.id),
          label: m.status.value === 'loading' ? `${m.id} (loading)` : String(m.id),
          vramMB: null,
          canUnload: m.status.value === 'loaded',
        })),
        ctx: { mode: 'router' },
      };
    }
    // Single mode: /props has the server signature. No memory figure and no unload call.
    if (props_ && (typeof props_.total_slots === 'number' || version || 'default_generation_settings' in props_)) {
      let id = null;
      const v1 = await get(port, '/v1/models');
      if (v1 && v1.ok && isObj(v1.json) && Array.isArray(v1.json.data) && v1.json.data[0]) id = String(v1.json.data[0].id || '');
      if (!id && typeof props_.model_path === 'string') id = props_.model_path;
      const label = id ? id.split(/[\\/]/).pop() : null;
      return {
        version,
        models: id ? [{ id, label, vramMB: null, canUnload: false }] : [],
        note: 'no safe unload',
        ctx: { mode: 'single' },
      };
    }
    return null;
  },
  async unload(port, ctx, id) {
    if (ctx.mode !== 'router') return false;
    const r = await call(port, '/models/unload', { method: 'POST', body: { model: id }, timeoutMs: ACTION_TIMEOUT_MS });
    return !!(r && r.ok && !(isObj(r.json) && r.json.success === false));
  },
};

const llamaswap = {
  async probe(port) {
    const r = await get(port, '/running');
    if (!r || !r.ok || !isObj(r.json) || !Array.isArray(r.json.running)) return null;
    const models = r.json.running
      .filter((m) => isObj(m) && (m.model || m.name))
      .map((m) => ({ id: String(m.model || m.name), label: String(m.name || m.model), vramMB: null, canUnload: true }));
    return { version: null, models, ctx: {} };
  },
  async unload(port, ctx, id) {
    const r = await call(port, `/api/models/unload/${encodeURIComponent(id)}`, { method: 'POST', timeoutMs: ACTION_TIMEOUT_MS });
    return !!(r && r.ok);
  },
};

const lmstudio = {
  async probe(port) {
    const r = await get(port, '/api/v1/models');
    if (!r || !r.ok || !isObj(r.json) || !Array.isArray(r.json.models)) return null;
    // The signature is a model entry with a "key" and a loaded_instances list.
    const entries = r.json.models.filter((m) => isObj(m));
    if (entries.length && !entries.some((m) => 'key' in m || 'loaded_instances' in m)) return null;
    const models = [];
    for (const m of entries) {
      for (const inst of Array.isArray(m.loaded_instances) ? m.loaded_instances : []) {
        if (!isObj(inst) || !inst.id) continue;
        const name = String(m.display_name || m.key || inst.id);
        models.push({ id: String(inst.id), label: name, vramMB: null, canUnload: true });
      }
    }
    return { version: null, models, ctx: {} };
  },
  async unload(port, ctx, id) {
    const r = await call(port, '/api/v1/models/unload', { method: 'POST', body: { instance_id: id }, timeoutMs: ACTION_TIMEOUT_MS });
    return !!(r && r.ok);
  },
};

// ComfyUI cannot list its loaded models, so it only offers "free everything".
const comfyui = {
  async probe(port) {
    // Every route exists at /x and at /api/x. Ask both at once and remember which one answered.
    const [plain, api] = await Promise.all([get(port, '/system_stats'), get(port, '/api/system_stats')]);
    for (const [prefix, r] of [['', plain], ['/api', api]]) {
      if (!r || !r.ok || !isObj(r.json) || !isObj(r.json.system) || !Array.isArray(r.json.devices)) continue;
      const dev = r.json.devices[0];
      let note = 'cannot list models, free unloads them all';
      if (isObj(dev) && Number.isFinite(dev.vram_total) && Number.isFinite(dev.vram_free)) {
        note = `${round1((dev.vram_total - dev.vram_free) / MB / 1024)} GB in use, cannot list models`;
      }
      const v = r.json.system.comfyui_version;
      return { version: typeof v === 'string' ? v : null, models: [], note, canFree: true, ctx: { prefix } };
    }
    return null;
  },
};

const ADAPTERS = { ollama, llamacpp, llamaswap, lmstudio, comfyui };

// ---- Port owner ----

// The listener of a port on a loopback or wildcard address.
async function portOwners(ports) {
  const out = new Map();
  try {
    const rows = await listening();
    for (const r of rows) {
      if (!ports.has(r.port)) continue;
      if (!['127.0.0.1', '0.0.0.0', '::', '::1'].includes(r.address)) continue;
      if (!out.has(r.port)) out.set(r.port, r.pid);
    }
  } catch {
    // no pid information, the engines are still listed
  }
  return out;
}

// ---- Listing ----

let state = null; // { at, engines: [public], internal: Map(id -> { port, ctx, models }) }
let pending = null;

async function refresh() {
  const found = new Map(); // engine id -> { port, result }
  await Promise.all(
    ORDER.flatMap((id) =>
      PORTS[id].map(async (port, i) => {
        let result = null;
        try {
          result = await ADAPTERS[id].probe(port);
        } catch {
          result = null;
        }
        if (!result) return;
        const prev = found.get(id);
        if (!prev || i < prev.index) found.set(id, { port, result, index: i });
      }),
    ),
  );
  // One port belongs to one engine: llama-swap before llama.cpp, and so on.
  const claimed = new Set();
  const winners = [];
  for (const id of ORDER) {
    const f = found.get(id);
    if (!f || claimed.has(f.port)) continue;
    claimed.add(f.port);
    winners.push({ id, ...f });
  }
  // The pid lookup spawns netstat, so it only happens when an engine was actually found.
  const owners = winners.length ? await portOwners(claimed) : new Map();
  const internal = new Map();
  const engines = [];
  for (const w of winners) {
    internal.set(w.id, { port: w.port, ctx: w.result.ctx, models: w.result.models });
    engines.push({
      id: w.id,
      label: LABELS[w.id],
      port: w.port,
      pid: owners.get(w.port) ?? null,
      version: w.result.version ?? null,
      // An engine reports no memory per model, but with a single model the process total is the answer.
      models: w.result.models.map((m, _, all) => ({
        id: m.id,
        label: m.label,
        vramMB: m.vramMB ?? (all.length === 1 && owners.has(w.port) ? vramOfTree(owners.get(w.port)) : null),
        canUnload: m.canUnload,
      })),
      canFree: !!w.result.canFree,
      note: w.result.note ?? null,
    });
  }
  engines.sort((a, b) => OUTPUT_ORDER.indexOf(a.id) - OUTPUT_ORDER.indexOf(b.id));
  state = { at: Date.now(), engines, internal };
  return state;
}

function startRefresh() {
  if (!pending) {
    pending = refresh().finally(() => {
      pending = null;
    });
  }
  return pending;
}

// The engine list no older than 5 s. fresh=true always probes again.
export async function getEngines({ fresh = false } = {}) {
  if (!fresh && state && Date.now() - state.at < CACHE_MS) return { at: state.at, engines: state.engines };
  if (fresh && pending) await pending.catch(() => {}); // an in-flight probe may predate the change
  const s = await startRefresh();
  return { at: s.at, engines: s.engines };
}

// For /api/system: what is known right now, as a Map(pid -> models). A stale cache starts a refresh
// in the background and the old answer is returned, so /api/system never waits for the engines.
export function peekEngineModels() {
  if (!state || Date.now() - state.at >= CACHE_MS) startRefresh().catch(() => {});
  const byPid = new Map();
  if (!state) return byPid;
  for (const e of state.engines) {
    if (e.pid == null || !e.models.length) continue;
    const list = byPid.get(e.pid) || [];
    for (const m of e.models) list.push({ engine: e.id, id: m.id, label: m.label, vramMB: m.vramMB, canUnload: m.canUnload });
    byPid.set(e.pid, list);
  }
  return byPid;
}

// ---- Unload and free ----

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Unloads a model that is in the latest list. status 404 for an unknown engine or model, 409 when the
// engine has no safe unload, 502 when the engine refuses. Answers { ok, stillLoaded } after a re-list.
export async function unloadModel(engineId, modelId, { settleMs = SETTLE_MS } = {}) {
  if (!Object.hasOwn(ADAPTERS, engineId)) return { ok: false, status: 404, error: 'Unknown engine' };
  if (typeof modelId !== 'string' || !modelId || modelId.length > 500) {
    return { ok: false, status: 400, error: 'model (a string) is required' };
  }
  const find = (list) => {
    const e = list.engines.find((x) => x.id === engineId);
    return { e, m: e && e.models.find((x) => x.id === modelId) };
  };
  let { e, m } = find(await getEngines());
  if (!m) ({ e, m } = find(await getEngines({ fresh: true }))); // the cache may predate the load
  if (!e) return { ok: false, status: 404, error: `${LABELS[engineId]} is not running`, engineDown: true };
  if (!m) return { ok: false, status: 404, error: `${modelId} is not loaded` };
  if (!m.canUnload) return { ok: false, status: 409, error: `${LABELS[engineId]} has no safe unload for this model` };
  // A refresh in between may have dropped the engine.
  const info = state && state.internal.get(engineId);
  if (!info) return { ok: false, status: 404, error: `${LABELS[engineId]} is not running`, engineDown: true };
  const accepted = await ADAPTERS[engineId].unload(info.port, info.ctx, modelId);
  if (settleMs) await wait(settleMs);
  const after = find(await getEngines({ fresh: true }));
  const stillLoaded = !!after.m;
  publish('system.changed', { action: 'engine.unload', engine: engineId, model: modelId });
  return accepted
    ? { ok: true, status: 200, stillLoaded }
    : { ok: false, status: 502, error: `${LABELS[engineId]} did not accept the unload`, stillLoaded };
}

// ComfyUI: unload every model and free cached memory, unless it is busy.
export async function freeComfyui() {
  let list = await getEngines();
  let e = list.engines.find((x) => x.id === 'comfyui');
  if (!e) {
    list = await getEngines({ fresh: true });
    e = list.engines.find((x) => x.id === 'comfyui');
  }
  if (!e) return { ok: false, status: 404, error: 'ComfyUI is not running' };
  // A refresh in between may have dropped the engine.
  const info = state && state.internal.get('comfyui');
  if (!info) return { ok: false, status: 404, error: 'ComfyUI is not running' };
  const prefix = info.ctx.prefix || '';
  const q = await get(info.port, `${prefix}/queue`);
  const queue = q && q.ok && isObj(q.json) ? q.json : null;
  if (!queue || !Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) {
    return { ok: false, status: 502, error: 'Could not read the ComfyUI queue' };
  }
  if (queue.queue_running.length || queue.queue_pending.length) {
    return { ok: false, status: 409, error: 'ComfyUI is running a job' };
  }
  const r = await call(info.port, `${prefix}/free`, {
    method: 'POST',
    body: { unload_models: true, free_memory: true },
    timeoutMs: ACTION_TIMEOUT_MS,
  });
  const ok = !!(r && r.ok);
  if (ok) publish('system.changed', { action: 'engine.free', engine: 'comfyui' });
  return ok ? { ok, status: 200 } : { ok: false, status: 502, error: 'ComfyUI did not accept the request' };
}

// ---- Ollama, for the older /api/ollama routes ----

export async function ollamaState() {
  // Only Ollama is probed here (not every engine), through the same adapter as the engine list.
  let r = null;
  try {
    r = await ollama.probe(PORTS.ollama[0]);
  } catch {
    r = null;
  }
  if (!r) return { running: false, models: [] };
  return {
    running: true,
    models: r.models.map((m) => ({
      name: m.id,
      sizeVRAMGB: m.vramMB == null ? 0 : Math.round((m.vramMB / 1024) * 100) / 100,
      expiresAt: m.expiresAt || null,
    })),
  };
}
