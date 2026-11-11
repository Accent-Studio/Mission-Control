// Conversations and attachments on the System page (services/storage.js): what is kept, and moving picked items to the
// Recycle Bin.
import { readJson, sendJson } from '../lib/http.js';
import { deleteItems, getStorage, shrinkEstimate, shrinkItems } from '../services/storage.js';

export const routes = [
  {
    method: 'GET',
    path: '/api/storage',
    handler: async (req, res, params, url) => sendJson(res, 200, await getStorage({ fresh: url.searchParams.get('fresh') === '1' })),
  },
  {
    method: 'POST',
    path: '/api/storage/delete',
    handler: async (req, res) => {
      const body = await readJson(req);
      if (!body || body.confirm !== true) return sendJson(res, 400, { error: 'Refused: send {"items": [{ "type", "id" }], "confirm": true}' });
      sendJson(res, 200, await deleteItems(body.items));
    },
  },
  // What each part would save (it only reads): a POST because the list of conversations can be long
  {
    method: 'POST',
    path: '/api/storage/shrink-estimate',
    handler: async (req, res) => sendJson(res, 200, await shrinkEstimate((await readJson(req)).items)),
  },
  {
    method: 'POST',
    path: '/api/storage/shrink',
    handler: async (req, res) => {
      const body = await readJson(req);
      if (!body || body.confirm !== true) return sendJson(res, 400, { error: 'Refused: send {"items": [{ "type": "code", "id" }], "confirm": true}' });
      sendJson(res, 200, await shrinkItems(body.items, body.parts));
    },
  },
];
