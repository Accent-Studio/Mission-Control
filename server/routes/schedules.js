import { sendJson } from '../lib/http.js';
import { getSchedules, runSchedule } from '../services/schedules.js';

export const routes = [
  {
    method: 'GET',
    path: '/api/schedules',
    handler: async (req, res) => sendJson(res, 200, await getSchedules()),
  },
  {
    method: 'POST',
    path: '/api/schedules/:name/run',
    handler: async (req, res, params) => {
      const r = await runSchedule(params.name);
      const { status = 200, ...body } = r;
      sendJson(res, r.ok ? 200 : status, body);
    },
  },
];
