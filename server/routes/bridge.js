// The private surface of mc-bridge.exe, served only on the bridge listener to a caller that proves the bridge secret
// and carries no device (app.js enforces that before any handler here runs).
import { sendJson, readJson } from '../lib/http.js';
import {
  attachControl, bridgeHello, isDeviceId, setPresence, tryPair,
} from '../services/devices.js';

const bad = (res, message) => sendJson(res, 400, { error: message });

export const bridgeRoutes = [
  // The bridge says it is up. `online` (optional) lists the phones connected right now, for a bridge that
  // outlived a server restart.
  {
    method: 'POST',
    path: '/api/bridge/hello',
    handler: async (req, res) => {
      let body = await readJson(req, 16 * 1024);
      body ??= {};
      if (typeof body !== 'object' || Array.isArray(body)) return bad(res, 'a JSON object is required');
      if (!isDeviceId(body.endpointId)) return bad(res, 'endpointId is required');
      if (body.online !== undefined && (!Array.isArray(body.online) || !body.online.every(isDeviceId))) return bad(res, 'online must be a list of ids');
      bridgeHello(body);
      sendJson(res, 200, { ok: true });
    },
  },
  // A phone connected for the first time or lost its last connection.
  {
    method: 'POST',
    path: '/api/bridge/presence',
    handler: async (req, res) => {
      let body = await readJson(req, 4096);
      body ??= {};
      if (typeof body !== 'object' || Array.isArray(body)) return bad(res, 'a JSON object is required');
      if (!isDeviceId(body.id) || typeof body.online !== 'boolean') return bad(res, 'id and online are required');
      if (!setPresence(body.id, body.online)) return sendJson(res, 404, { error: 'unknown_device' });
      sendJson(res, 200, { ok: true });
    },
  },
  // A phone sent a pairing code. Always answers 200 with ok true/false; the bridge turns it into its reply.
  {
    method: 'POST',
    path: '/api/bridge/pair',
    handler: async (req, res) => {
      let body = await readJson(req, 4096);
      body ??= {};
      if (typeof body !== 'object' || Array.isArray(body)) return bad(res, 'a JSON object is required');
      if (!isDeviceId(body.endpointId) || typeof body.code !== 'string' || body.code.length > 64) return bad(res, 'endpointId and code are required');
      const result = tryPair({ endpointId: body.endpointId, code: body.code, deviceName: body.deviceName });
      if (result.error) return sendJson(res, 500, { error: result.error });
      sendJson(res, 200, result);
    },
  },
  // Server-sent events: the full id list first, then add / revoke / restart / ping.
  {
    method: 'GET',
    path: '/api/bridge/control',
    handler: async (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      const detach = attachControl(res);
      res.on('close', detach);
    },
  },
];
