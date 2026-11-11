// Sync (services/sync.js and services/machines.js): one project's sync and a conversation about what stopped it; what
// this computer says about itself to the others; a sync another computer asks for; and the Sync panel's view of every
// computer, its Sync all and its restarts.
import { readJson, sendJson } from '../lib/http.js';
import { getProject } from '../services/catalog.js';
import { askAboutRemoteSync, askAboutSync, remoteSyncState, startRemoteSync, startSync, syncState } from '../services/sync.js';
import { askCross, hereReport, machinesView, readMachines, restartFar, startCross } from '../services/machines.js';

const answer = async (res, fn) => {
  try {
    sendJson(res, 200, await fn());
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message });
  }
};
const body = async (req) => {
  const b = await readJson(req, 16 * 1024).catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
};

export const routes = [
  {
    // { state }: the last sync of this project (null before the first one); the pages follow it with 'sync' events
    method: 'GET',
    path: '/api/projects/:id/sync',
    handler: async (req, res, params) => {
      if (!getProject(params.id)) return sendJson(res, 404, { error: 'Unknown project' });
      sendJson(res, 200, { state: syncState(params.id) });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/sync',
    handler: async (req, res, params) => answer(res, () => ({ state: startSync(params.id) })),
  },
  {
    // { sessionId }: the conversation to open about it (the commit step's own, or a new one that is told what happened)
    method: 'POST',
    path: '/api/projects/:id/sync/ask',
    handler: async (req, res, params) => {
      const b = await body(req);
      return answer(res, () => askAboutSync(params.id, b.model === 'opus' ? 'opus' : 'sonnet'));
    },
  },
  {
    // This computer, for the others' Sync panel: ?remotes=a,b (the repositories to report on) and fetch=1 (fetch them first)
    method: 'GET',
    path: '/api/sync/here',
    handler: async (req, res, params, url) => answer(res, () => hereReport({
      remotes: String(url.searchParams.get('remotes') || '').split(',').filter(Boolean).slice(0, 50),
      fetch: url.searchParams.get('fetch') === '1',
    })),
  },
  {
    // { remote }: another computer asks this one to sync the folder with that repository, committed work only
    method: 'POST',
    path: '/api/sync/remote',
    handler: async (req, res) => {
      const b = await body(req);
      return answer(res, () => startRemoteSync(String(b.remote || ''), req.mcDevice ? req.mcDevice.name : null));
    },
  },
  {
    // { remote, model }: that sync stopped here; a conversation about it, on this computer (its session id)
    method: 'POST',
    path: '/api/sync/remote/ask',
    handler: async (req, res) => {
      const b = await body(req);
      return answer(res, () => askAboutRemoteSync(String(b.remote || ''), b.model === 'opus' ? 'opus' : 'sonnet'));
    },
  },
  {
    method: 'GET',
    path: '/api/sync/remote',
    handler: async (req, res, params, url) => answer(res, () => remoteSyncState(String(url.searchParams.get('remote') || ''))),
  },
  {
    // The Sync panel: the last view of every computer (null before the first read)
    method: 'GET',
    path: '/api/sync/machines',
    handler: async (req, res) => sendJson(res, 200, { view: machinesView() }),
  },
  {
    method: 'POST',
    path: '/api/sync/machines/refresh',
    handler: async (req, res) => {
      await body(req);
      return answer(res, async () => { await readMachines(); return { view: machinesView() }; });
    },
  },
  {
    // { remote }: Sync all for that repository
    method: 'POST',
    path: '/api/sync/machines/sync',
    handler: async (req, res) => {
      const b = await body(req);
      return answer(res, () => ({ state: startCross(String(b.remote || '')) }));
    },
  },
  {
    // { remote, model }: a conversation about what stopped Sync all, on the computer where it stopped
    method: 'POST',
    path: '/api/sync/machines/ask',
    handler: async (req, res) => {
      const b = await body(req);
      return answer(res, () => askCross(String(b.remote || ''), b.model));
    },
  },
  {
    // { which: 'pc' | 'hub', all }: restart that computer's server (all: its runner and bridge too)
    method: 'POST',
    path: '/api/sync/machines/restart',
    handler: async (req, res) => {
      const b = await body(req);
      if (b.confirm !== true) return sendJson(res, 400, { error: 'Send {"confirm": true} to restart' });
      return answer(res, () => restartFar(String(b.which || ''), b.all === true));
    },
  },
];
