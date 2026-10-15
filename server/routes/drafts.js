// The Talk page's unsent message box, shared by every device (see services/drafts.js).
import { sendJson, readJson } from '../lib/http.js';
import { getDraft, listNewDrafts, putDraft } from '../services/drafts.js';

export const routes = [
  {
    // the new conversations typed but never sent, for the Talk page's list (before /api/drafts so the paths stay apart)
    method: 'GET',
    path: '/api/drafts/new',
    handler: async (req, res) => sendJson(res, 200, { drafts: listNewDrafts() }),
  },
  {
    method: 'GET',
    path: '/api/drafts',
    handler: async (req, res, params, url) => sendJson(res, 200, getDraft(url.searchParams.get('key'))),
  },
  {
    method: 'PUT',
    path: '/api/drafts',
    handler: async (req, res) => sendJson(res, 200, putDraft(await readJson(req))),
  },
];
