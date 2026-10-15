// Project layout API: the rings and angles of the planets on Home.
import { sendJson, readJson } from '../lib/http.js';
import { publish } from '../lib/events.js';
import { getLayout, saveLayout } from '../services/layout.js';

export const routes = [
  {
    method: 'GET',
    path: '/api/layout',
    handler: async (req, res) => sendJson(res, 200, getLayout()),
  },
  {
    method: 'PUT',
    path: '/api/layout',
    handler: async (req, res) => {
      const saved = saveLayout(await readJson(req));
      publish('layout.changed', { updatedAt: saved.updatedAt });
      sendJson(res, 200, saved);
    },
  },
];
