// Local paths in conversations: what a path is, a text file's contents for the viewer, and Show in Explorer.
import { readJson, sendJson } from '../lib/http.js';
import { pathInfo, readPathText, revealPath } from '../services/paths.js';

export const routes = [
  {
    method: 'GET',
    path: '/api/path/info',
    handler: async (req, res, params, url) => sendJson(res, 200, pathInfo(url.searchParams.get('p'), url.searchParams.get('base'))),
  },
  {
    method: 'GET',
    path: '/api/path/text',
    handler: async (req, res, params, url) => sendJson(res, 200, readPathText(url.searchParams.get('p'), url.searchParams.get('base'))),
  },
  {
    // Opens a window on the PC (PC_ONLY in lib/remote-policy.js)
    method: 'POST',
    path: '/api/path/reveal',
    handler: async (req, res) => {
      const body = await readJson(req);
      sendJson(res, 200, revealPath(body && body.path, body && body.base));
    },
  },
];
