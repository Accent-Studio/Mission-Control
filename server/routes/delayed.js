// Send later: messages the server sends at a set time, after a timer, or when the 5-hour plan window resets.
import { sendJson, readJson } from '../lib/http.js';
import { listDelayed, addDelayed, cancelDelayed, sendDelayedNow } from '../services/delayed.js';

export const routes = [
  {
    method: 'GET',
    path: '/api/delayed',
    handler: async (req, res) => sendJson(res, 200, listDelayed()),
  },
  {
    method: 'POST',
    path: '/api/delayed',
    handler: async (req, res) => sendJson(res, 200, addDelayed(await readJson(req))),
  },
  {
    method: 'POST',
    path: '/api/delayed/:id/cancel',
    handler: async (req, res, params) => sendJson(res, 200, cancelDelayed(params.id)),
  },
  {
    method: 'POST',
    path: '/api/delayed/:id/now',
    handler: async (req, res, params) => sendJson(res, 200, sendDelayedNow(params.id)),
  },
];
