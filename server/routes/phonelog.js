// The phone app's own link log, sent each time it connects: what its side saw (paths, silences, why a link closed).
// Kept in .data/logs/phone-<device>.log next to the bridge's bridge.log, so both sides of a stall can be read together.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { badRequest, readJson, sendJson } from '../lib/http.js';

const LOG_DIR = path.join(DATA_DIR, 'logs');
const MAX_BYTES = 2 * 1024 * 1024; // past this the file becomes .old and a new one starts
const MAX_LINES = 1000;

function stamp(ms) {
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? '????-??-??T??:??:??Z' : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const routes = [
  {
    method: 'POST',
    path: '/api/phone-log',
    handler: async (req, res) => {
      if (!req.mcDevice) return badRequest(res, 'Only a phone sends its log');
      const body = await readJson(req, 512 * 1024);
      const lines = Array.isArray(body && body.lines) ? body.lines.slice(-MAX_LINES) : null;
      if (!lines) return badRequest(res, 'lines is required');
      const text = lines
        .filter((l) => Array.isArray(l) && l.length === 2)
        .map(([ms, t]) => `${stamp(ms)} ${String(t).replace(/[\r\n]+/g, ' ').slice(0, 2000)}\n`)
        .join('');
      const id = String(req.mcDevice.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'unknown';
      const file = path.join(LOG_DIR, `phone-${id}.log`);
      await fs.promises.mkdir(LOG_DIR, { recursive: true });
      try {
        const st = await fs.promises.stat(file);
        if (st.size > MAX_BYTES) await fs.promises.rename(file, file + '.old');
      } catch { /* no file yet */ }
      await fs.promises.appendFile(file, text);
      sendJson(res, 200, { ok: true, saved: lines.length });
    },
  },
];
