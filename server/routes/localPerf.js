// How fast the local models run, and their benchmark (services/localPerf.js). The System page, Local model speed.
//   GET  /api/local-models/perf          { machine, models: [...], benching } of this PC, or of the linked PC when this
//                                        one has no local model (a Mac); ?here=1 this PC's only (what the link asks)
//   POST /api/local-models/bench         { model?, versions?: [file names], kind?: "real" | "raw" } starts the benchmark of
//                                        those versions (none: the everyday one); it goes to the linked PC the same way
import { MACHINE_NAME } from '../config.js';
import { readJson, sendJson } from '../lib/http.js';
import { getLocalPerf, startBench } from '../services/localPerf.js';
import { localModels } from '../services/localModels.js';
import { pcCall, pcName, pcOnline } from '../services/pcLink.js';

const elsewhere = (here) => !here && !localModels().length && pcOnline();

export const routes = [
  {
    method: 'GET',
    path: '/api/local-models/perf',
    handler: async (req, res, params, url) => {
      if (elsewhere(url.searchParams.get('here') === '1')) {
        try {
          const r = await pcCall('GET', '/api/local-models/perf?here=1', { timeout: 15000 });
          return sendJson(res, r.status, r.status === 200 ? { ...r.json, machine: pcName() } : r.json);
        } catch (err) {
          return sendJson(res, 503, { error: String(err.message || err) });
        }
      }
      sendJson(res, 200, { machine: MACHINE_NAME, ...getLocalPerf() });
    },
  },
  {
    method: 'POST',
    path: '/api/local-models/bench',
    handler: async (req, res) => {
      const b = (await readJson(req)) || {};
      if (elsewhere(b.here === true)) {
        try {
          const r = await pcCall('POST', '/api/local-models/bench', { json: { model: b.model, versions: b.versions, kind: b.kind, here: true }, timeout: 15000 });
          return sendJson(res, r.status, r.json);
        } catch (err) {
          return sendJson(res, 503, { error: String(err.message || err) });
        }
      }
      try {
        sendJson(res, 200, startBench(typeof b.model === 'string' ? b.model : null, Array.isArray(b.versions) ? b.versions.filter((v) => typeof v === 'string') : null, b.kind === 'raw' ? 'raw' : 'real'));
      } catch (err) {
        sendJson(res, err.status || 500, { error: err.message });
      }
    },
  },
];
