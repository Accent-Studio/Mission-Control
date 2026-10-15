import { sendJson, notFound } from '../lib/http.js';
import { getConnections, findService, getLocalApps } from '../services/connections.js';

export const routes = [
  {
    method: 'GET',
    path: '/api/connections',
    handler: async (req, res) => sendJson(res, 200, await getConnections()),
  },
  {
    method: 'GET',
    path: '/api/connections/local',
    handler: async (req, res) => sendJson(res, 200, { apps: await getLocalApps() }),
  },
  {
    method: 'POST',
    path: '/api/connections/:id/test',
    handler: async (req, res, params) => {
      if (!findService(params.id)) return notFound(res, 'Unknown service');
      sendJson(res, 200, { ok: false, reason: 'not implemented yet' });
    },
  },
];
