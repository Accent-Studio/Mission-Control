// The temp folder on the System page: what is in it and deleting one item.
import { sendJson, readJson } from '../lib/http.js';
import { getTemp, deleteItem } from '../services/temp.js';

export const routes = [
  {
    method: 'GET',
    path: '/api/temp',
    handler: async (req, res, params, url) => sendJson(res, 200, await getTemp({ fresh: url.searchParams.get('fresh') === '1' })),
  },
  {
    method: 'POST',
    path: '/api/temp/delete',
    handler: async (req, res) => {
      const body = await readJson(req);
      if (!body || body.confirm !== true) return sendJson(res, 400, { ok: false, error: 'Refused: send {"path": ..., "confirm": true}' });
      const { status, ...result } = await deleteItem(body.path);
      sendJson(res, status, result);
    },
  },
];
