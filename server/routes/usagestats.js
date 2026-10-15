// The Usage page: tokens, API-equivalent cost and time from every Claude transcript (usageIndex.js reads them in the
// background), and the plan windows over time. Read only.
import { sendJson, badRequest } from '../lib/http.js';
import { startUsageIndex } from '../services/usageIndex.js';
import { usageStats } from '../services/usageStats.js';

startUsageIndex();

function msParam(url, name, fallback) {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export const routes = [
  {
    // ?from=&to= in ms (to exclusive); without them, the last 30 days
    method: 'GET',
    path: '/api/usage/stats',
    handler: async (req, res, params, url) => {
      const to = msParam(url, 'to', Date.now() + 3600e3);
      const from = msParam(url, 'from', to - 30 * 24 * 3600e3);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return badRequest(res, 'from and to must be times in ms, from before to');
      sendJson(res, 200, await usageStats({ from: Math.max(0, from), to }));
    },
  },
];
