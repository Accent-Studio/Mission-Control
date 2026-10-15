// Fake local AI engines (tests only): Ollama, llama.cpp router, llama-swap, LM Studio and ComfyUI,
// each on its own loopback port, with a couple of loaded models and a real unload (the model
// disappears from the list). Every request is logged as one JSON line.
//
//   node fake-engines.js [--ports "ollama=47301,llamacpp=47302,llamaswap=47303,lmstudio=47304,comfyui=47305"]
//                        [--comfy-busy] [--llamacpp-single] [--log <file>]
//
// Ports default to MC_ENGINE_PORTS, then to the example above.
import http from 'node:http';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);

const portSpec =
  opt('--ports') ||
  process.env.MC_ENGINE_PORTS ||
  'ollama=47301,llamacpp=47302,llamaswap=47303,lmstudio=47304,comfyui=47305';
const ports = {};
for (const part of portSpec.split(',')) {
  const [k, v] = part.split('=').map((s) => s.trim());
  if (k && Number(v)) ports[k] = Number(v);
}
const logFile = opt('--log');
let comfyBusy = flag('--comfy-busy');
const llamacppSingle = flag('--llamacpp-single');

const GB = 1024 ** 3;

// ---- State ----

const ollamaModels = [
  { name: 'llama3.1:8b', size: 6.2 * GB, vram: 5.1 * GB },
  { name: 'qwen2.5:14b', size: 10.4 * GB, vram: 9.8 * GB },
];
const routerModels = [
  { id: 'gemma-3-12b-q4', status: 'loaded' },
  { id: 'mistral-7b-q5', status: 'loaded' },
  { id: 'phi-4-q4', status: 'unloaded' },
];
const swapModels = [{ model: 'qwen3-coder-30b' }, { model: 'llama-3.3-70b-q2' }];
const lmInstances = [
  { id: 'qwen2.5-coder-7b-instruct', key: 'qwen/qwen2.5-coder-7b', display_name: 'Qwen2.5 Coder 7B' },
  { id: 'gemma-3-4b-it', key: 'google/gemma-3-4b', display_name: 'Gemma 3 4B' },
];
let comfyFreeBytes = 4 * GB;
const COMFY_TOTAL = 24 * GB;
let comfyUsed = 18 * GB;

// ---- Helpers ----

function log(entry) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  console.log(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch {
      // logging must never stop the fake
    }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function reply(res, status, obj) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function makeServer(engine, handler) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const send = (status, obj) => {
      log({ engine, method: req.method, path: url.pathname, body, status });
      reply(res, status, obj);
    };
    try {
      handler(req.method, url.pathname, body, send);
    } catch (err) {
      send(500, { error: String(err.message) });
    }
  });
}

// ---- Engines ----

const handlers = {
  ollama(method, path, body, send) {
    if (method === 'GET' && path === '/api/version') return send(200, { version: '0.40.0-fake' });
    if (method === 'GET' && path === '/api/ps') {
      return send(200, {
        models: ollamaModels.map((m) => ({
          name: m.name,
          model: m.name,
          size: Math.round(m.size),
          digest: 'fake',
          details: { family: 'fake', parameter_size: '8B', quantization_level: 'Q4_K_M' },
          expires_at: new Date(Date.now() + 300000).toISOString(),
          size_vram: Math.round(m.vram),
        })),
      });
    }
    if (method === 'POST' && path === '/api/generate') {
      const i = ollamaModels.findIndex((m) => m.name === body.model);
      if (body.keep_alive === 0 && i >= 0) {
        ollamaModels.splice(i, 1);
        return send(200, { model: body.model, response: '', done: true, done_reason: 'unload' });
      }
      return send(200, { model: body.model, response: '', done: true });
    }
    send(404, { error: 'not found' });
  },

  llamacpp(method, path, body, send) {
    if (llamacppSingle) {
      if (method === 'GET' && path === '/props') {
        return send(200, { model_path: 'C:\\models\\qwen2.5-7b-q4.gguf', build_info: 'b9999-fake', total_slots: 1, is_sleeping: false });
      }
      if (method === 'GET' && (path === '/models' || path === '/v1/models')) {
        return send(200, { data: [{ id: 'qwen2.5-7b-q4.gguf', object: 'model' }] });
      }
      return send(404, { error: 'not found' });
    }
    if (method === 'GET' && path === '/props') return send(200, { role: 'router', build_info: 'b9999-fake', total_slots: 1 });
    if (method === 'GET' && path === '/models') {
      return send(200, { data: routerModels.map((m) => ({ id: m.id, path: `/m/${m.id}.gguf`, status: { value: m.status }, args: [] })) });
    }
    if (method === 'POST' && (path === '/models/unload' || path === '/models/load')) {
      const m = routerModels.find((x) => x.id === body.model);
      if (!m) return send(404, { error: 'unknown model' });
      m.status = path.endsWith('unload') ? 'unloaded' : 'loaded';
      return send(200, { success: true });
    }
    send(404, { error: 'not found' });
  },

  llamaswap(method, path, body, send) {
    if (method === 'GET' && path === '/running') {
      return send(200, { running: swapModels.map((m) => ({ model: m.model, state: 'ready', cmd: 'fake', proxy: 'http://127.0.0.1:5800', ttl: 0 })) });
    }
    const one = /^\/api\/models\/unload\/(.+)$/.exec(path);
    if (method === 'POST' && one) {
      const id = decodeURIComponent(one[1]);
      const i = swapModels.findIndex((m) => m.model === id);
      if (i < 0) return send(404, { error: 'not running' });
      swapModels.splice(i, 1);
      return send(200, { msg: 'ok' });
    }
    if (method === 'POST' && path === '/api/models/unload') {
      swapModels.length = 0;
      return send(200, { msg: 'ok' });
    }
    send(404, { error: 'not found' });
  },

  lmstudio(method, path, body, send) {
    if (method === 'GET' && path === '/api/v1/models') {
      const models = [];
      for (const i of lmInstances) {
        models.push({
          type: 'llm',
          publisher: i.key.split('/')[0],
          key: i.key,
          display_name: i.display_name,
          size_bytes: 4 * GB,
          loaded_instances: [{ id: i.id, config: { context_length: 4096 } }],
        });
      }
      models.push({ type: 'llm', publisher: 'meta', key: 'meta/llama-3.2-1b', display_name: 'Llama 3.2 1B', size_bytes: GB, loaded_instances: [] });
      return send(200, { models });
    }
    if (method === 'POST' && path === '/api/v1/models/unload') {
      const i = lmInstances.findIndex((m) => m.id === body.instance_id);
      if (i < 0) return send(404, { error: { message: 'instance not found' } });
      lmInstances.splice(i, 1);
      return send(200, { instance_id: body.instance_id });
    }
    send(404, { error: 'not found' });
  },

  comfyui(method, rawPath, body, send) {
    // Every route also exists under /api, like the real server.
    const path = rawPath.startsWith('/api/') ? rawPath.slice(4) : rawPath;
    if (method === 'GET' && path === '/system_stats') {
      return send(200, {
        system: { os: 'nt', ram_total: 64 * GB, ram_free: 30 * GB, comfyui_version: '0.3.99-fake', pytorch_version: '2.8.0' },
        devices: [{ name: 'cuda:0 Fake RTX', type: 'cuda', index: 0, vram_total: COMFY_TOTAL, vram_free: COMFY_TOTAL - comfyUsed, torch_vram_total: COMFY_TOTAL, torch_vram_free: comfyFreeBytes }],
      });
    }
    if (method === 'GET' && path === '/queue') {
      return send(200, {
        queue_running: comfyBusy ? [[1, 'prompt-1', {}, {}, []]] : [],
        queue_pending: [],
      });
    }
    if (method === 'POST' && path === '/free') {
      if (body.unload_models) comfyUsed = 1 * GB;
      return send(200, undefined);
    }
    // Test control: POST /__busy {busy: true|false}
    if (method === 'POST' && path === '/__busy') {
      comfyBusy = !!body.busy;
      return send(200, { busy: comfyBusy });
    }
    send(404, { error: 'not found' });
  },
};

for (const [engine, handler] of Object.entries(handlers)) {
  if (!ports[engine]) continue;
  const server = makeServer(engine, handler);
  server.on('error', (err) => {
    console.error(`${engine}: port ${ports[engine]}: ${err.message}`);
    process.exit(1);
  });
  server.listen(ports[engine], '127.0.0.1', () => console.log(`fake ${engine} on 127.0.0.1:${ports[engine]}`));
}

console.log(`fake engines pid ${process.pid}${comfyBusy ? ' (ComfyUI busy)' : ''}${llamacppSingle ? ' (llama.cpp single mode)' : ''}`);
