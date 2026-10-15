// Claude Code API: sessions, skills, headless chat runs.
import { sendJson, notFound, badRequest, readJson } from '../lib/http.js';
import { getProject } from '../services/catalog.js';
import {
  listSessions,
  getSessionMessages,
  getSessionStats,
  updateSessionMeta,
  updateSessionOrder,
  setSessionArchived,
  countArchivedSessions,
  deleteSession,
  sessionIdleMs,
  resolveAttachment,
  getSessionImages,
  countSessionImages,
  elsewhereFor,
  isUuid,
} from '../services/sessions.js';
import { getUsage, refreshUsage } from '../services/usage.js';
import { listSkills } from '../services/skills.js';
import { startRun, listRuns, stopRun, chatOptions, isSessionBusy, sendToRun, answerPermission, pendingFor, releaseSession, takeSessionOffline, hasLiveSession, liveTurnOf } from '../services/runs.js';
import { isArchived, isLocked } from '../services/sessionMeta.js';
import { serveFile } from '../services/uploads.js';
import { expiryStatus, setExpiryAction } from '../services/expiryAction.js';

const BUSY_MS = 2 * 60 * 1000;
const GUARD_WAIT_MS = Number(process.env.MC_ELSEWHERE_WAIT_MS) > 0 ? Number(process.env.MC_ELSEWHERE_WAIT_MS) : 5000; // the send guard waits this long for a process list, then lets the message through

function limitOf(url, fallback) {
  const n = Number(url.searchParams.get('limit'));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const routes = [
  {
    method: 'GET',
    path: '/api/sessions',
    handler: async (req, res, params, url) => {
      const project = url.searchParams.get('project') || null;
      if (project && !getProject(project)) return notFound(res, 'Unknown project');
      // archived=hide leaves archived conversations out, archived=only lists just those; without it every one is listed
      const a = url.searchParams.get('archived');
      sendJson(res, 200, await listSessions({ project, limit: limitOf(url, 50), archived: a === 'hide' || a === 'only' ? a : 'all' }));
    },
  },
  {
    // How many archived conversations there are (in a project, when one is given). Before /api/sessions/:id so it is not read as an id.
    method: 'GET',
    path: '/api/sessions/archived-count',
    handler: async (req, res, params, url) => {
      const project = url.searchParams.get('project') || null;
      if (project && !getProject(project)) return notFound(res, 'Unknown project');
      sendJson(res, 200, { count: await countArchivedSessions(project) });
    },
  },
  {
    // How many pictures each of these conversations has (?ids=a,b,c, at most 60), for the Screenshots tab's folder counts.
    // Counted once and then only the new part of each transcript. Before /api/sessions/:id so it is not read as an id.
    method: 'GET',
    path: '/api/sessions/image-counts',
    handler: async (req, res, params, url) => {
      const ids = String(url.searchParams.get('ids') || '').split(',').filter(isUuid).slice(0, 60);
      const out = {};
      for (const id of ids) { const n = await countSessionImages(id); if (n !== null) out[id] = n; } // one at a time: a first count reads whole files
      sendJson(res, 200, { counts: out });
    },
  },
  {
    method: 'GET',
    path: '/api/sessions/:id',
    handler: async (req, res, params, url) => {
      if (!isUuid(params.id)) return badRequest(res, 'Session id must be a uuid');
      const before = url.searchParams.get('before'); // opaque cursor from an earlier page
      const limit = limitOf(url, 40);
      // A process is answering this conversation right now. The CLI saves the turn to the transcript as it goes, and the
      // page shows the turn from the live events, so the saved part sent here stops where the turn began (the turn's own
      // events come in "live"). Taking the events first and reading the file after means nothing can fall in both.
      const live = before === null ? liveTurnOf(params.id) : null;
      let s = null;
      let cut = false;
      if (live && live.mark !== null && !live.truncated) {
        try {
          // upTo: the file may not have grown since the mark, and a read that ends exactly at the mark is what is wanted
          s = await getSessionMessages(params.id, limit, String(live.mark), { upTo: true });
          cut = !!s;
        } catch (err) {
          if (err.status !== 400) throw err; // 400: the mark is not a line start (a record was half written), or the file shrank
        }
      }
      if (!s) s = await getSessionMessages(params.id, limit, before === null ? null : before);
      if (!s) return notFound(res, 'Unknown session');
      // The byte mark can fall just after a message that belongs to the turn: one sent while Claude wrote the end of the
      // previous turn is saved before that turn's result is read, so the new mark lands behind it and it is in the saved part
      // and in the live events. The two are matched by message id, and the live one stays.
      if (cut && s.messages.length) {
        const ids = new Set();
        for (const e of live.events) if (e.sent) for (const k of [e.uuid, e.alias]) if (typeof k === 'string') ids.add(k);
        if (ids.size) s = { ...s, messages: s.messages.filter((m) => !(m.role === 'user' && Array.isArray(m.uuids) && m.uuids.some((k) => ids.has(k)))) };
      }
      const liveOut = live
        ? { runId: live.runId, state: live.state, upto: live.upto, cut, truncated: live.truncated, events: cut ? live.events : [], turn: live.turn }
        : undefined;
      const where = await elsewhereFor(params.id);
      sendJson(res, 200, { ...s, archived: isArchived(params.id), locked: isLocked(params.id), ...(where ? { elsewhere: where } : {}), ...(liveOut ? { live: liveOut } : {}) });
    },
  },
  {
    // Serves a file Claude sent in this conversation (SendUserFile), and only such a file: the exact path must be
    // in a SendUserFile result of this session, exist, and be an image or a PDF.
    method: 'GET',
    path: '/api/sessions/:id/attachment',
    handler: async (req, res, params, url) => {
      if (!isUuid(params.id)) return badRequest(res, 'Session id must be a uuid');
      const hit = await resolveAttachment(params.id, url.searchParams.get('path'));
      if (!hit) return notFound(res, 'No such file in this conversation');
      serveFile(req, res, hit);
    },
  },
  {
    // Every picture the two people shared in this conversation, oldest first, for the page's gallery.
    // ?tools=1 adds the pictures Claude looked at with a tool (a project's Screenshots tab).
    method: 'GET',
    path: '/api/sessions/:id/images',
    handler: async (req, res, params, url) => {
      if (!isUuid(params.id)) return badRequest(res, 'Session id must be a uuid');
      const items = await getSessionImages(params.id, { tools: url.searchParams.get('tools') === '1' });
      if (!items) return notFound(res, 'Unknown session');
      sendJson(res, 200, { images: items });
    },
  },
  {
    method: 'GET',
    path: '/api/sessions/:id/stats',
    handler: async (req, res, params) => {
      if (!isUuid(params.id)) return badRequest(res, 'Session id must be a uuid');
      const s = await getSessionStats(params.id);
      if (!s) return notFound(res, 'Unknown session');
      sendJson(res, 200, s);
    },
  },
  {
    method: 'POST',
    path: '/api/sessions/order',
    handler: async (req, res) => {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, 'Body must be a JSON object');
      sendJson(res, 200, updateSessionOrder(body.ids));
    },
  },
  {
    method: 'POST',
    path: '/api/sessions/:id/meta',
    handler: async (req, res, params) => {
      if (!isUuid(params.id)) return badRequest(res, 'Session id must be a uuid');
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, 'Body must be a JSON object');
      const patch = {};
      if ('title' in body) patch.title = body.title;
      if ('pinned' in body) patch.pinned = body.pinned;
      if ('tags' in body) patch.tags = body.tags;
      if ('locked' in body) patch.locked = body.locked;
      sendJson(res, 200, await updateSessionMeta(params.id, patch));
    },
  },
  {
    // Archive or unarchive a conversation: { archived: true|false }. Archiving also takes the conversation offline on
    // claude.ai (Remote Control), and the Com Link end phrase calls this. A conversation with no transcript yet is
    // accepted while a live Claude process holds it.
    method: 'POST',
    path: '/api/sessions/:id/archive',
    handler: async (req, res, params) => {
      if (!isUuid(params.id)) return badRequest(res, 'Session id must be a uuid');
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.archived !== 'boolean') return badRequest(res, 'Send {"archived": true} or {"archived": false}');
      const r = await setSessionArchived(params.id, body.archived, { allowUnknown: hasLiveSession(params.id) });
      sendJson(res, 200, { ...r, ...(body.archived ? { offline: takeSessionOffline(params.id) } : {}) });
    },
  },
  {
    // At 5 min left: what is sent once before the prompt cache runs out (expiryAction.js). GET tells what is planned,
    // POST { action: 'none' | 'handoff' | 'compact' } sets it.
    method: 'GET',
    path: '/api/sessions/:id/expiry-action',
    handler: async (req, res, params) => {
      if (!isUuid(params.id)) return badRequest(res, 'Session id must be a uuid');
      sendJson(res, 200, expiryStatus(params.id));
    },
  },
  {
    method: 'POST',
    path: '/api/sessions/:id/expiry-action',
    handler: async (req, res, params) => {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, 'Body must be a JSON object');
      sendJson(res, 200, await setExpiryAction(params.id, body.action));
    },
  },
  {
    method: 'POST',
    path: '/api/sessions/:id/delete',
    handler: async (req, res, params) => {
      if (!isUuid(params.id)) return badRequest(res, 'Session id must be a uuid');
      const body = await readJson(req);
      if (!body || body.confirm !== true) return badRequest(res, 'Send {"confirm": true} to move this session to the Recycle Bin');
      if (isSessionBusy(params.id)) {
        return sendJson(res, 409, { error: 'A run is using this session. Stop it first.' });
      }
      // A session run from the user's own terminal is not tracked as a run, but its transcript is being written.
      const idle = await sessionIdleMs(params.id);
      if (idle !== null && idle < BUSY_MS) {
        return sendJson(res, 409, { error: 'This conversation was active in the last 2 minutes' });
      }
      await releaseSession(params.id); // an idle process still holds the conversation open
      sendJson(res, 200, await deleteSession(params.id));
    },
  },
  {
    method: 'GET',
    path: '/api/skills',
    handler: async (req, res, params, url) => {
      const id = url.searchParams.get('project');
      let folder = null;
      if (id) {
        const p = getProject(id);
        if (!p) return notFound(res, 'Unknown project');
        folder = p.folder;
      }
      sendJson(res, 200, await listSkills(folder));
    },
  },
  {
    method: 'POST',
    path: '/api/chat',
    handler: async (req, res) => {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, 'Body must be a JSON object');
      // A message for a run goes straight to its process: it joins the turn in progress, or starts the next one.
      if (typeof body.runId === 'string' && body.runId) {
        return sendJson(res, 200, await sendToRun(body.runId, { prompt: body.prompt, attachments: body.attachments }));
      }
      // Resuming a conversation that is open in Claude Desktop would put two claude processes on one transcript and split it
      // in two. Only a resume from the Talk page or a Sessions tab is checked: a new conversation has no session, the Com Link
      // (persona) and the one-off tasks (remote: false) are always new sessions, and a conversation Mission Control already
      // holds a live process for is not asked about again. { elsewhereOk: true } is the user's answer to "Send anyway".
      // The Com Link panel (source: 'comlink', also its Commit and Review and push tasks) is never blocked, with or without the persona.
      if (isUuid(body.sessionId) && body.elsewhereOk !== true && body.source !== 'comlink' && !body.persona && body.remote !== false && !hasLiveSession(body.sessionId)) {
        const where = await elsewhereFor(body.sessionId, { waitMs: GUARD_WAIT_MS });
        if (where) return sendJson(res, 409, { error: 'elsewhere', where });
      }
      sendJson(
        res,
        200,
        await startRun({
          prompt: body.prompt,
          attachments: body.attachments,
          projectId: body.projectId,
          sessionId: body.sessionId,
          model: body.model,
          mode: body.mode,
          effort: body.effort,
          persona: body.persona,
          remote: body.remote, // false for a one-off task: it stays off claude.ai
        }),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/chat/options',
    handler: async (req, res) => sendJson(res, 200, await chatOptions()),
  },
  {
    method: 'GET',
    path: '/api/usage',
    handler: async (req, res) => sendJson(res, 200, getUsage()),
  },
  {
    method: 'POST',
    path: '/api/usage/refresh',
    handler: async (req, res) => {
      try {
        sendJson(res, 200, await refreshUsage());
      } catch (err) {
        sendJson(res, 502, { error: String((err && err.message) || 'Could not read the plan usage').slice(0, 200) });
      }
    },
  },
  {
    method: 'GET',
    path: '/api/runs',
    handler: async (req, res) => sendJson(res, 200, listRuns()),
  },
  {
    method: 'GET',
    path: '/api/runs/:id/pending',
    handler: async (req, res, params) => sendJson(res, 200, pendingFor(params.id)),
  },
  {
    method: 'POST',
    path: '/api/runs/:id/permission',
    handler: async (req, res, params) => {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, 'Body must be a JSON object');
      sendJson(res, 200, answerPermission(params.id, body));
    },
  },
  {
    method: 'POST',
    path: '/api/runs/:id/stop',
    handler: async (req, res, params) => sendJson(res, 200, await stopRun(params.id)),
  },
];
