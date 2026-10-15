// Project jobs API: scripts in a folder, run, stop, history, log.
import { sendJson, readJson, notFound } from '../lib/http.js';
import { getProject } from '../services/catalog.js';
import { listRuns, listScripts, readLog, startJob, stopJob } from '../services/jobs.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const routes = [
  {
    method: 'GET',
    path: '/api/projects/:id/scripts',
    handler: async (req, res, params) => {
      const project = getProject(params.id);
      if (!project) return notFound(res, 'Unknown project');
      sendJson(res, 200, { scripts: listScripts(project) });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/jobs/:jobId/run',
    handler: async (req, res, params) => {
      const body = await readJson(req);
      try {
        const out = await startJob({ projectId: params.id, jobId: params.jobId, confirm: body && body.confirm, remote: !!req.mcDevice });
        sendJson(res, 200, out);
      } catch (err) {
        // Expected refusals (409 busy or confirm, 429 limit, 400, 404) are answered quietly; only real faults are logged.
        if (err && err.status && err.status < 500) return sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
        throw err;
      }
    },
  },
  {
    method: 'GET',
    path: '/api/jobs',
    handler: async (req, res) => {
      sendJson(res, 200, { runs: listRuns() });
    },
  },
  {
    method: 'GET',
    path: '/api/jobs/:runId/log',
    handler: async (req, res, params, url) => {
      if (!UUID.test(params.runId)) return notFound(res, 'Unknown run');
      const n = Number(url.searchParams.get('tail') || 400);
      const tail = Number.isInteger(n) && n >= 1 ? Math.min(n, 5000) : 400;
      const log = readLog(params.runId, tail);
      if (!log) return notFound(res, 'No log for this run');
      sendJson(res, 200, log);
    },
  },
  {
    method: 'POST',
    path: '/api/jobs/:runId/stop',
    handler: async (req, res, params) => {
      if (!UUID.test(params.runId)) return notFound(res, 'Unknown run');
      try {
        sendJson(res, 200, await stopJob(params.runId));
      } catch (err) {
        if (err && err.status && err.status < 500) return sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
        throw err;
      }
    },
  },
];
