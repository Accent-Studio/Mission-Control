// Local models asked outside a conversation (services/modelAsk.js): which there are, here and on the linked PC, and one
// request to one of them.
//   GET  /api/models/local           { machine, here: [...], linked: { machine, online, models, gpu, error } | null }
//        ?here=1                     this PC's only, with its graphics card (what the linked PC reads through the link)
//        ?fresh=1                    reads the linked PC's list again now
//   POST /api/models/ask             { prompt | messages, system?, model?, effort?, maxTokens? } -> { ok, text, ... }
//        "here": true                only a model of this PC (a request that came through the link never goes on)
//        Accept: application/x-ndjson  {"wait":s} lines while the model works, then the result line
import { readJson, sendJson } from '../lib/http.js';
import { answer, ask, askHere, checkAsk, hereModels, modelsStatus } from '../services/modelAsk.js';
import { getSystem } from '../services/system.js';

async function gpuOf() {
  try {
    const g = (await getSystem()).gpu;
    return g ? { name: g.name, vramTotalGB: g.vramTotalGB, vramUsedGB: g.vramUsedGB } : null;
  } catch {
    return null;
  }
}

export const routes = [
  {
    method: 'GET',
    path: '/api/models/local',
    handler: async (req, res) => {
      const q = new URL(req.url, 'http://x').searchParams;
      if (q.get('here') === '1') return sendJson(res, 200, { here: await hereModels(), gpu: await gpuOf() });
      sendJson(res, 200, await modelsStatus({ fresh: q.get('fresh') === '1' }));
    },
  },
  {
    method: 'POST',
    path: '/api/models/ask',
    handler: async (req, res) => {
      const b = await readJson(req, 2 * 1024 * 1024);
      const keepalive = /application\/x-ndjson/i.test(String(req.headers.accept || ''));
      let a;
      try {
        a = b && b.here === true ? checkAsk(b) : null;
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, status: err.status || 400, error: err.message });
      }
      await answer(res, (signal) => (a ? askHere(a, signal) : ask(b, signal)), { keepalive });
    },
  },
];
