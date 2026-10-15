// Wake word training API for the Connections page. Every route that changes something is PC-only
// (see server/lib/remote-policy.js). A paired phone may read the state and the model list, not the voice clips.
import fs from 'node:fs';
import { sendJson, readJson, readBytes } from '../lib/http.js';
import {
  MAX_CLIP_BYTES, clipFile, deleteClip, installModel, isSlug, listClips, listModels, overview, saveClip, startTraining, stopTraining,
} from '../services/waketrainer.js';

const refuseRemote = (req, res) => {
  if (!req.mcDevice) return false;
  sendJson(res, 403, { error: 'pc_only' });
  return true;
};

export const routes = [
  { method: 'GET', path: '/api/waketrain', handler: async (req, res) => sendJson(res, 200, overview()) },
  {
    method: 'POST',
    path: '/api/waketrain/start',
    handler: async (req, res) => {
      const r = startTraining(await readJson(req, 16 * 1024));
      sendJson(res, r.status, r.body);
    },
  },
  {
    method: 'POST',
    path: '/api/waketrain/stop',
    handler: async (req, res) => {
      await readJson(req, 4096);
      const r = stopTraining();
      sendJson(res, r.status, r.body);
    },
  },
  { method: 'GET', path: '/api/waketrain/models', handler: async (req, res) => sendJson(res, 200, listModels()) },
  {
    method: 'POST',
    path: '/api/waketrain/install',
    handler: async (req, res) => {
      const b = await readJson(req, 4096);
      const r = await installModel(b && b.model);
      sendJson(res, r.status, r.body);
    },
  },
  {
    method: 'GET',
    path: '/api/waketrain/clips/:slug',
    handler: async (req, res, params) => {
      if (refuseRemote(req, res)) return;
      if (!isSlug(params.slug)) return sendJson(res, 400, { error: 'Unknown phrase' });
      sendJson(res, 200, { slug: params.slug, clips: listClips(params.slug) });
    },
  },
  {
    method: 'POST',
    path: '/api/waketrain/clips/:slug',
    handler: async (req, res, params) => {
      // The body is the WAV file itself (16kHz mono 16-bit), not JSON.
      const buf = await readBytes(req, MAX_CLIP_BYTES);
      const r = saveClip(params.slug, buf);
      sendJson(res, r.status, r.body);
    },
  },
  {
    method: 'GET',
    path: '/api/waketrain/clips/:slug/:name',
    handler: async (req, res, params) => {
      if (refuseRemote(req, res)) return;
      const file = clipFile(params.slug, params.name);
      if (!file) return sendJson(res, 404, { error: 'Unknown clip' });
      const st = fs.statSync(file);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    },
  },
  {
    method: 'POST',
    path: '/api/waketrain/clips/:slug/:name/delete',
    handler: async (req, res, params) => {
      await readJson(req, 4096);
      const r = deleteClip(params.slug, params.name);
      sendJson(res, r.status, r.body);
    },
  },
];
