// The hub's mailbox API (services/hub.js), served only by a Mission Control whose role is "hub". The PCs call it through
// the bridge as paired devices, so every caller is known by its device (services/hubSync.js is the PC side).
import { ROLE } from '../config.js';
import { badRequest, notFound, readBytes, readJson, sendJson } from '../lib/http.js';
import { addSend, answerAsk, append, ask, askFiles, askOf, baton, changes, info, machineOf, postsHere, readFrom, sendFiles, setDraft, touch, updateSend, wait } from '../services/hub.js';
import { UPLOAD_BODY_LIMIT } from '../services/uploads.js';
import { startPairing } from '../services/devices.js';
import { postTasks, tasksSince } from '../services/hubTasks.js';
import { putShared, sharedSince } from '../services/hubShared.js';

const POST_MAX = 8 * 1024 * 1024; // one post; a longer transcript goes up in several

function answer(res, err) {
  if (!err || !err.status || err.status >= 500) throw err;
  sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
}

const hubRoutes = [
  {
    // the doorbell: answered at once when the hub changed since `since` or has an ask for the caller, else after `ms`
    method: 'GET',
    path: '/api/hub/wait',
    handler: async (req, res, params, url) => {
      const since = Number(url.searchParams.get('since'));
      const out = await wait(machineOf(req), Number.isFinite(since) ? since : -1, Number(url.searchParams.get('ms')), (stop) => res.on('close', stop));
      if (!res.writableEnded && !res.destroyed) sendJson(res, 200, out);
    },
  },
  {
    method: 'POST',
    path: '/api/hub/asks/:id',
    handler: async (req, res, params) => {
      const body = await readJson(req, UPLOAD_BODY_LIMIT); // the message's pictures and files come with it
      try {
        sendJson(res, 200, await ask(machineOf(req), String(params.id).toLowerCase(), { text: body.text, files: body.files }));
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    method: 'GET',
    path: '/api/hub/asks/:id/:askId',
    handler: async (req, res, params) => {
      touch(machineOf(req));
      const a = askOf(String(params.id).toLowerCase(), String(params.askId));
      if (!a) return sendJson(res, 404, { error: 'No such ask' });
      sendJson(res, 200, a);
    },
  },
  {
    method: 'GET',
    path: '/api/hub/asks/:id/:askId/files',
    handler: async (req, res, params) => {
      touch(machineOf(req));
      const files = askFiles(String(params.id).toLowerCase(), String(params.askId));
      if (!files) return sendJson(res, 404, { error: 'No such ask' });
      sendJson(res, 200, { files });
    },
  },
  {
    method: 'POST',
    path: '/api/hub/asks/:id/:askId',
    handler: async (req, res, params) => {
      const body = await readJson(req);
      try {
        sendJson(res, 200, await answerAsk(machineOf(req), String(params.id).toLowerCase(), String(params.askId), body.state, body.error));
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    // what is typed for a code conversation: { text, at }
    method: 'PUT',
    path: '/api/hub/drafts/:id',
    handler: async (req, res, params) => {
      const body = await readJson(req);
      try {
        sendJson(res, 200, await setDraft(machineOf(req), String(params.id).toLowerCase(), body));
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    // a message for a code conversation, run by its PC when it is on: { text, files }
    method: 'POST',
    path: '/api/hub/sends/:id',
    handler: async (req, res, params) => {
      const body = await readJson(req, UPLOAD_BODY_LIMIT);
      try {
        sendJson(res, 201, await addSend(machineOf(req), String(params.id).toLowerCase(), { text: body.text, files: body.files }));
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/hub/sends/:id/:sendId',
    handler: async (req, res, params) => {
      const body = await readJson(req);
      try {
        sendJson(res, 200, await updateSend(machineOf(req), String(params.id).toLowerCase(), String(params.sendId), body.state, body.error));
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    method: 'GET',
    path: '/api/hub/sends/:id/:sendId/files',
    handler: async (req, res, params) => {
      touch(machineOf(req));
      const files = sendFiles(String(params.id).toLowerCase(), String(params.sendId));
      if (!files) return sendJson(res, 404, { error: 'No such waiting message' });
      sendJson(res, 200, { files });
    },
  },
  {
    // a pairing code for a phone, asked by a PC that posts here (the hub has no page of its own to show one):
    // { code, uri, expiresAt }, shown as a QR code on that PC's Connections page
    method: 'POST',
    path: '/api/hub/pair-phone',
    handler: async (req, res) => {
      await readJson(req, 4096);
      const m = machineOf(req);
      if (!postsHere(m)) return sendJson(res, 403, { error: 'Only a PC that sends its conversations to the hub may pair a phone with it' });
      const opened = startPairing();
      if (opened.error) return sendJson(res, 409, { error: opened.error });
      sendJson(res, 200, opened);
    },
  },
  {
    method: 'GET',
    path: '/api/hub/changes',
    handler: async (req, res, params, url) => {
      const m = machineOf(req);
      touch(m);
      const since = Number(url.searchParams.get('since')) || 0;
      sendJson(res, 200, changes(since, m));
    },
  },
  {
    // the task list the PCs share (services/hubTasks.js): what changed since `since`
    method: 'GET',
    path: '/api/hub/tasks',
    handler: async (req, res, params, url) => {
      touch(machineOf(req));
      try {
        sendJson(res, 200, tasksSince(url.searchParams.get('since')));
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    // a PC's changed tasks and targets: { items: [{ kind, rec }], keys }
    method: 'POST',
    path: '/api/hub/tasks',
    handler: async (req, res) => {
      touch(machineOf(req));
      const body = await readJson(req, 16 * 1024 * 1024);
      try {
        sendJson(res, 200, postTasks(body));
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    // the settings every PC shares (services/hubShared.js): what changed since `since`
    method: 'GET',
    path: '/api/hub/shared',
    handler: async (req, res, params, url) => {
      touch(machineOf(req));
      sendJson(res, 200, sharedSince(url.searchParams.get('since')));
    },
  },
  {
    // a PC's value for one key: { value, at }; kept when newer than the hub's
    method: 'PUT',
    path: '/api/hub/shared/:key',
    handler: async (req, res, params) => {
      const m = machineOf(req);
      touch(m);
      const body = await readJson(req, 4 * 1024 * 1024);
      try {
        sendJson(res, 200, putShared(String(params.key), body, m));
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    method: 'GET',
    path: '/api/hub/sessions/:id',
    handler: async (req, res, params) => {
      touch(machineOf(req));
      const e = info(String(params.id).toLowerCase());
      if (!e) return sendJson(res, 404, { error: 'The hub has no such conversation' });
      sendJson(res, 200, e);
    },
  },
  {
    method: 'GET',
    path: '/api/hub/transcripts/:id',
    handler: async (req, res, params, url) => {
      touch(machineOf(req));
      let r;
      try {
        r = readFrom(String(params.id).toLowerCase(), Number(url.searchParams.get('from')) || 0);
      } catch (err) {
        return answer(res, err);
      }
      if (!r) return sendJson(res, 404, { error: 'The hub has no such conversation' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': r.size - r.start, 'X-Hub-Size': String(r.size), 'Cache-Control': 'no-store' });
      r.stream.on('error', () => res.destroy()).pipe(res);
    },
  },
  {
    method: 'PUT',
    path: '/api/hub/transcripts/:id',
    handler: async (req, res, params, url) => {
      const m = machineOf(req);
      const q = url.searchParams;
      const at = Number(q.get('at'));
      if (!Number.isInteger(at)) return badRequest(res, 'at must be a byte offset');
      const bytes = await readBytes(req, POST_MAX);
      try {
        const e = await append(m, String(params.id).toLowerCase(), at, bytes, { kind: q.get('kind'), head: q.get('head'), title: q.get('title'), project: q.get('project'), lastAt: q.get('lastAt'), replace: q.get('replace') === '1' });
        sendJson(res, 200, e);
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/hub/baton/:id',
    handler: async (req, res, params, url) => {
      const take = url.searchParams.get('take') === '1';
      try {
        const e = await baton(machineOf(req), String(params.id).toLowerCase(), take);
        sendJson(res, 200, e || { id: params.id, holder: null });
      } catch (err) {
        answer(res, err);
      }
    },
  },
];

// Always in the table (so the phone policy can check them), but a PC answers them as if they were not there.
export const routes = ROLE === 'hub' ? hubRoutes : hubRoutes.map((r) => ({ ...r, handler: async (req, res) => notFound(res) }));
