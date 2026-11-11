// Settings shared by every PC through the hub (services/sharedSync.js), such as the panel layouts.
import { readJson, sendJson } from '../lib/http.js';
import { getShared, setShared, syncShared } from '../services/sharedSync.js';

const answer = (res, fn) => {
  try {
    sendJson(res, 200, fn());
  } catch (err) {
    if (!err.status) throw err;
    sendJson(res, err.status, { error: err.message });
  }
};

export const routes = [
  {
    method: 'GET',
    path: '/api/shared/:key',
    handler: async (req, res, params) => answer(res, () => getShared(String(params.key))),
  },
  {
    method: 'PUT',
    path: '/api/shared/:key',
    handler: async (req, res, params) => {
      const body = await readJson(req, 4 * 1024 * 1024);
      answer(res, () => setShared(String(params.key), body ? body.value : undefined));
    },
  },
  {
    // the hub's latest now, without waiting for its ring (tests, and a page that wants to be sure)
    method: 'POST',
    path: '/api/shared/sync',
    handler: async (req, res) => {
      await readJson(req, 4096).catch(() => null);
      sendJson(res, 200, { ok: await syncShared() });
    },
  },
];
