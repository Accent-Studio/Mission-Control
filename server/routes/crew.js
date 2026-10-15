// Crew API: who is working on a project right now (read only).
import { sendJson, notFound } from '../lib/http.js';
import { getProject } from '../services/catalog.js';
import { getCrew } from '../services/crew.js';

export const routes = [
  {
    method: 'GET',
    path: '/api/projects/:id/crew',
    handler: async (req, res, params) => {
      if (!getProject(params.id)) return notFound(res, 'Unknown project');
      sendJson(res, 200, await getCrew(params.id));
    },
  },
];
