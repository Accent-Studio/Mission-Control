// Devices API for the PC's Connections page: pair a phone, list, remove. The policy file decides who may call what
// (pairing is PC-only; removing is allowed from a paired phone, because it only reduces access).
import { sendJson, readJson } from '../lib/http.js';
import {
  cancelPairing, isDeviceId, listView, removeDevice, renameDevice, restartBridge, startPairing,
} from '../services/devices.js';

export const routes = [
  {
    method: 'GET',
    path: '/api/devices',
    handler: async (req, res) => sendJson(res, 200, listView({ remote: !!req.mcDevice })),
  },
  {
    method: 'POST',
    path: '/api/devices/pair',
    handler: async (req, res) => {
      await readJson(req, 4096);
      const opened = startPairing();
      if (opened.error) return sendJson(res, 409, { error: opened.error });
      sendJson(res, 200, opened);
    },
  },
  {
    method: 'POST',
    path: '/api/devices/pair/cancel',
    handler: async (req, res) => {
      await readJson(req, 4096);
      sendJson(res, 200, { ok: true, cancelled: cancelPairing() });
    },
  },
  {
    method: 'POST',
    path: '/api/devices/bridge/restart',
    handler: async (req, res) => {
      await readJson(req, 4096);
      if (!restartBridge()) return sendJson(res, 409, { error: 'bridge_offline' });
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/devices/:id/remove',
    handler: async (req, res, params) => {
      await readJson(req, 4096);
      if (!isDeviceId(params.id)) return sendJson(res, 404, { error: 'Unknown device' });
      // A phone removing itself gets its answer before its connection is cut.
      const self = !!req.mcDevice && req.mcDevice.id === params.id;
      const removed = removeDevice(params.id, { revokeDelayMs: self ? 300 : 0 });
      if (removed === 'write_failed') return sendJson(res, 500, { error: 'write_failed' });
      if (!removed) return sendJson(res, 404, { error: 'Unknown device' });
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/devices/:id/rename',
    handler: async (req, res, params) => {
      let body = await readJson(req, 4096);
      body ??= {};
      if (typeof body !== 'object' || Array.isArray(body) || typeof body.name !== 'string' || !body.name.trim()) {
        return sendJson(res, 400, { error: 'name is required' });
      }
      const renamed = isDeviceId(params.id) ? renameDevice(params.id, body.name) : null;
      if (renamed === 'write_failed') return sendJson(res, 500, { error: 'write_failed' });
      if (!renamed) return sendJson(res, 404, { error: 'Unknown device' });
      sendJson(res, 200, renamed);
    },
  },
];
