// This PC's link to another PC's Mission Control (services/pcLink.js): its state and that PC's projects and root
// folders as last read, reading them again now, and a one-use address that opens that PC's own pages here.
// /api/pc/...: that PC's conversations, talked to through the link as its phone would: a message (its files go along),
// the answer to a permission question, Stop, and the questions that wait. The live events come as pc.chat (pcLink.js).
import { readJson, sendJson } from '../lib/http.js';
import { checkBack, enterUrl, linkBack, pairBack, pcCall, pcLinkStatus, pcName, pcProject, pcUpload, readProjects } from '../services/pcLink.js';
import { UPLOAD_BODY_LIMIT } from '../services/uploads.js';
import { markRemote } from '../services/hubSync.js';

const isRunId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);

// rename, archive or throw away one of that PC's conversations, there; this PC's list follows at once
const sessionChange = (what) => ({
  method: 'POST',
  path: `/api/pc/sessions/:id/${what}`,
  handler: async (req, res, params) => {
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return sendJson(res, 400, { error: 'bad session id' });
    const b = (await readJson(req)) || {};
    const body = what === 'meta' ? { title: b.title } : what === 'archive' ? { archived: b.archived === true } : { confirm: true };
    const r = await pcCall('POST', `/api/sessions/${params.id}/${what}`, { json: body });
    if (r.status === 200) markRemote(params.id, what === 'meta' ? { title: b.title } : { gone: what === 'delete' || b.archived === true });
    sendJson(res, r.status, r.json && typeof r.json === 'object' ? r.json : { error: `the other PC answered ${r.status}` });
  },
});

// That PC's answer, as it gave it
async function forward(res, method, p, json, timeout = 20e3) {
  const r = await pcCall(method, p, { json, timeout });
  sendJson(res, r.status, r.json && typeof r.json === 'object' ? r.json : { error: `the other PC answered ${r.status}` });
}


export const routes = [
  { method: 'GET', path: '/api/pc-link', handler: async (req, res) => sendJson(res, 200, pcLinkStatus()) },
  {
    method: 'POST',
    path: '/api/pc-link/refresh',
    handler: async (req, res) => {
      await readJson(req, 4096);
      sendJson(res, 200, await readProjects());
    },
  },
  {
    // Both ways: { check: true } only reads whether that PC's link to here is set up; otherwise it is made when missing
    method: 'POST',
    path: '/api/pc-link/back',
    handler: async (req, res) => {
      const b = (await readJson(req, 4096)) || {};
      try {
        if (b.check) await checkBack(); else await linkBack();
        sendJson(res, 200, pcLinkStatus());
      } catch (err) {
        sendJson(res, err.status || 500, { error: err.message });
      }
    },
  },
  {
    // That PC (a linked computer, through its link) hands this one a pairing code of its bridge: this PC pairs with it
    method: 'POST',
    path: '/api/pc-link/pair-back',
    handler: async (req, res) => {
      const b = (await readJson(req, 4096)) || {};
      try {
        sendJson(res, 200, await pairBack(b.uri, req.mcDevice ? req.mcDevice.name : null));
      } catch (err) {
        sendJson(res, err.status || 500, { error: err.message });
      }
    },
  },
  {
    method: 'POST',
    path: '/api/pc-link/enter',
    handler: async (req, res) => {
      await readJson(req, 4096);
      sendJson(res, 200, await enterUrl());
    },
  },
  {
    // { sessionId, prompt, attachments?, mode? } starts that PC's conversation; { runId, prompt } goes into its running Claude;
    // { projectId, prompt, attachments?, model?, mode?, effort? } starts a new conversation in that PC's project (its id there).
    // mode is the permission mode picked here for it; left out, that PC uses the one the conversation last ran with.
    method: 'POST',
    path: '/api/pc/chat',
    handler: async (req, res) => {
      const b = await readJson(req, UPLOAD_BODY_LIMIT);
      if (!b || typeof b.prompt !== 'string' || !b.prompt.trim()) return sendJson(res, 400, { error: 'prompt is required' });
      const resume = typeof b.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(b.sessionId);
      const fresh = !resume && !isRunId(b.runId) && typeof b.projectId === 'string' && !!b.projectId;
      if (!resume && !isRunId(b.runId) && !fresh) return sendJson(res, 400, { error: 'sessionId, runId or projectId is required' });
      if (b.attachments !== undefined && !Array.isArray(b.attachments)) return sendJson(res, 400, { error: 'attachments must be a list' });
      if (b.mode !== undefined && !(typeof b.mode === 'string' && /^[A-Za-z]{1,30}$/.test(b.mode))) return sendJson(res, 400, { error: 'mode must be a permission mode' });
      for (const k of ['model', 'effort']) if (b[k] !== undefined && b[k] !== null && !(typeof b[k] === 'string' && /^[A-Za-z0-9._:\[\]-]{1,80}$/.test(b[k]))) return sendJson(res, 400, { error: `${k} is not one I know` });
      let body;
      if (isRunId(b.runId)) body = { prompt: b.prompt, runId: b.runId };
      else if (resume) body = { prompt: b.prompt, sessionId: b.sessionId, ...(b.mode ? { mode: b.mode } : {}) };
      else {
        // only a project that PC listed: an id from here (or a typo) never becomes a folder there
        if (!(await pcProject(b.projectId))) return sendJson(res, 400, { error: `${pcName() || 'The other PC'} has no project ${b.projectId}` });
        body = { prompt: b.prompt, projectId: b.projectId, ...(b.mode ? { mode: b.mode } : {}), ...(b.model ? { model: b.model } : {}), ...(b.effort ? { effort: b.effort } : {}) };
      }
      if (b.attachments && b.attachments.length) body.attachments = await pcUpload(b.attachments);
      await forward(res, 'POST', '/api/chat', body, 60e3);
    },
  },
  {
    // the permission mode picked here for one of that PC's conversations
    method: 'POST',
    path: '/api/pc/sessions/:id/mode',
    handler: async (req, res, params) => {
      if (!/^[0-9a-f-]{36}$/i.test(params.id)) return sendJson(res, 400, { error: 'bad session id' });
      const b = await readJson(req, 4096);
      await forward(res, 'POST', `/api/sessions/${params.id}/mode`, { mode: b && b.mode });
    },
  },
  sessionChange('meta'),
  sessionChange('archive'),
  sessionChange('delete'),
  {
    // that PC's Claude processes, so this PC's pages can show which of its conversations wait for an answer
    method: 'GET',
    path: '/api/pc/runs',
    handler: async (req, res) => forward(res, 'GET', '/api/runs'),
  },
  {
    method: 'GET',
    path: '/api/pc/runs/:id/pending',
    handler: async (req, res, params) => (isRunId(params.id) ? forward(res, 'GET', `/api/runs/${params.id}/pending`) : sendJson(res, 400, { error: 'bad run id' })),
  },
  {
    method: 'POST',
    path: '/api/pc/runs/:id/permission',
    handler: async (req, res, params) => {
      if (!isRunId(params.id)) return sendJson(res, 400, { error: 'bad run id' });
      await forward(res, 'POST', `/api/runs/${params.id}/permission`, await readJson(req));
    },
  },
  {
    method: 'POST',
    path: '/api/pc/runs/:id/permission/typing',
    handler: async (req, res, params) => {
      if (!isRunId(params.id)) return sendJson(res, 400, { error: 'bad run id' });
      await forward(res, 'POST', `/api/runs/${params.id}/permission/typing`, await readJson(req));
    },
  },
  {
    method: 'POST',
    path: '/api/pc/runs/:id/stop',
    handler: async (req, res, params) => {
      if (!isRunId(params.id)) return sendJson(res, 400, { error: 'bad run id' });
      await readJson(req, 4096).catch(() => null);
      await forward(res, 'POST', `/api/runs/${params.id}/stop`, {});
    },
  },
];
