// This PC's link to the hub (services/hubLink.js): its state and what the sync is doing (services/hubSync.js), pairing
// with the hub, and forgetting it.
import { readJson, sendJson } from '../lib/http.js';
import { forgetHub, linkStatus, pairWithHub } from '../services/hubLink.js';
import { pairPhoneWithHub, syncStatus } from '../services/hubSync.js';

export const routes = [
  { method: 'GET', path: '/api/hub-link', handler: async (req, res) => sendJson(res, 200, { ...linkStatus(), sync: syncStatus() }) },
  {
    method: 'POST',
    path: '/api/hub-link/pair',
    handler: async (req, res) => {
      const body = await readJson(req);
      sendJson(res, 200, await pairWithHub(body.text));
    },
  },
  { method: 'POST', path: '/api/hub-link/forget', handler: async (req, res) => sendJson(res, 200, forgetHub()) },
  {
    // a pairing code from the hub, so a phone can reach the chats there when every PC is off
    method: 'POST',
    path: '/api/hub-link/pair-phone',
    handler: async (req, res) => {
      await readJson(req, 4096);
      sendJson(res, 200, await pairPhoneWithHub());
    },
  },
];
