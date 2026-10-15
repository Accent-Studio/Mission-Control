import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { sendJson } from '../lib/http.js';

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export const routes = [
  {
    method: 'GET',
    path: '/api/health',
    handler: async (req, res) => {
      sendJson(res, 200, { ok: true, version, uptimeSec: Math.round(process.uptime()) });
    },
  },
];
