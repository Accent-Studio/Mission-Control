// The PIN that guards this PC from the other computer (services/pcLock.js), and the same for the other way: this PC's
// pages type the PIN of the linked PC, or lock it, through the link (services/pcLink.js).
import { readJson, sendJson } from '../lib/http.js';
import { clearPin, lock, lockStatus, setLockAt, setPin, unlock } from '../services/pcLock.js';
import { pcCall, pcPeerLocked } from '../services/pcLink.js';

const answer = (res, err) => {
  if (!err.status) throw err;
  sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
};

// That PC's answer, as it gave it
async function forward(res, p, json) {
  try {
    const r = await pcCall('POST', p, { json });
    if (r.status === 200 && r.json && typeof r.json === 'object') pcPeerLocked(r.json);
    sendJson(res, r.status, r.json && typeof r.json === 'object' ? r.json : { error: `the other PC answered ${r.status}` });
  } catch (err) {
    answer(res, err);
  }
}

export const routes = [
  { method: 'GET', path: '/api/pc-lock', handler: async (req, res) => sendJson(res, 200, lockStatus()) },
  {
    // { pin }: set or change it; { pin: null }: remove it (at this PC only, server/lib/remote-policy.js)
    method: 'PUT',
    path: '/api/pc-lock/pin',
    handler: async (req, res) => {
      const b = (await readJson(req, 4096)) || {};
      try {
        sendJson(res, 200, b.pin === null ? clearPin() : setPin(b.pin));
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    // { at: "16:30" }: the time it locks again each day (at this PC only, server/lib/remote-policy.js)
    method: 'PUT',
    path: '/api/pc-lock/time',
    handler: async (req, res) => {
      const b = (await readJson(req, 4096)) || {};
      try {
        sendJson(res, 200, setLockAt(b.at));
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    // the other computer types the PIN: on its lock screen, or through its own pages (POST /api/pc-link/unlock there)
    method: 'POST',
    path: '/api/pc-lock/unlock',
    handler: async (req, res) => {
      const b = (await readJson(req, 4096)) || {};
      try {
        const dev = req.mcDevice || req.mcFull;
        sendJson(res, 200, unlock(b.pin, dev ? dev.name : null));
      } catch (err) {
        answer(res, err);
      }
    },
  },
  {
    // from here, from a phone, or from the other computer before it is left
    method: 'POST',
    path: '/api/pc-lock/lock',
    handler: async (req, res) => {
      await readJson(req, 4096).catch(() => null);
      sendJson(res, 200, lock());
    },
  },
  {
    // the linked PC's PIN, typed here
    method: 'POST',
    path: '/api/pc-link/unlock',
    handler: async (req, res) => {
      const b = (await readJson(req, 4096)) || {};
      await forward(res, '/api/pc-lock/unlock', { pin: String(b.pin || '') });
    },
  },
  {
    // lock the linked PC from here
    method: 'POST',
    path: '/api/pc-link/lock',
    handler: async (req, res) => {
      await readJson(req, 4096).catch(() => null);
      await forward(res, '/api/pc-lock/lock', {});
    },
  },
];
