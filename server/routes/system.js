import { sendJson, badRequest, readJson } from '../lib/http.js';
import { publish, clientCount } from '../lib/events.js';
import { getSystem, killProcess, getOllama, unloadOllama, validModelName } from '../services/system.js';
import { getServers } from '../services/servers.js';
import { getEngines, unloadModel, freeComfyui } from '../services/engines.js';
import { startVramHistory, getVramHistory, VRAM_RANGES } from '../services/vramHistory.js';

// The VRAM history is sampled all the time, with or without a page open.
startVramHistory();

// The tick spawns nvidia-smi and PowerShell, so it runs only while at least one browser is connected
// to /api/events. With nobody connected the interval does nothing.
let polling = false;
const timer = setInterval(async () => {
  if (polling || clientCount() === 0) return;
  polling = true;
  try {
    publish('system.tick', await getSystem());
  } catch {
    // A failed tick is skipped; the next one retries.
  } finally {
    polling = false;
  }
}, 5000);
timer.unref();

// A body must be a JSON object, not null, an array or a primitive.
async function readBody(req) {
  const body = await readJson(req);
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

export const routes = [
  {
    method: 'GET',
    path: '/api/system',
    handler: async (req, res) => {
      sendJson(res, 200, await getSystem());
    },
  },
  {
    method: 'GET',
    path: '/api/system/vram-history',
    handler: async (req, res, params, url) => {
      const range = url.searchParams.get('range') || '1h';
      const h = getVramHistory(range);
      if (!h) return badRequest(res, `range must be one of ${VRAM_RANGES.join(', ')}`);
      sendJson(res, 200, h);
    },
  },
  {
    method: 'GET',
    path: '/api/engines',
    handler: async (req, res, params, url) => {
      sendJson(res, 200, await getEngines({ fresh: url.searchParams.get('fresh') === '1' }));
    },
  },
  {
    method: 'POST',
    path: '/api/engines/comfyui/free',
    handler: async (req, res) => {
      const result = await freeComfyui();
      const { status, ...body } = result;
      sendJson(res, status, body);
    },
  },
  {
    method: 'POST',
    path: '/api/engines/:engine/unload',
    handler: async (req, res, params) => {
      const body = await readBody(req);
      if (typeof body.model !== 'string' || !body.model) return badRequest(res, 'model (a string) is required');
      const { status, ...result } = await unloadModel(params.engine, body.model);
      sendJson(res, status, result);
    },
  },
  {
    method: 'GET',
    path: '/api/servers',
    handler: async (req, res, params, url) => {
      const all = url.searchParams.get('all') === '1';
      sendJson(res, 200, await getServers({ all }));
    },
  },
  {
    method: 'POST',
    path: '/api/processes/:pid/kill',
    handler: async (req, res, params) => {
      // Plain decimal digits only: no sign, no exponent, no hex, no leading zero, at most 32 bits.
      if (!/^[1-9]\d{0,9}$/.test(params.pid) || Number(params.pid) > 0xffffffff) {
        return badRequest(res, 'pid must be a positive integer');
      }
      const body = await readBody(req);
      if (body.confirm !== true) {
        return sendJson(res, 400, { ok: false, error: 'Refused: send {"confirm": true} to kill a process' });
      }
      const result = await killProcess(Number(params.pid));
      sendJson(res, result.status, result);
    },
  },
  {
    method: 'GET',
    path: '/api/ollama',
    handler: async (req, res) => sendJson(res, 200, await getOllama()),
  },
  {
    method: 'POST',
    path: '/api/ollama/unload',
    handler: async (req, res) => {
      const body = await readBody(req);
      if (!validModelName(body.model)) return badRequest(res, 'model (a valid model name) is required');
      const result = await unloadOllama(body.model);
      sendJson(res, result.status, result);
    },
  },
];
