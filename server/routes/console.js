// The Console module: terminals (services/console.js), the server log (lib/serverLog.js) and one stream that carries both
// to the PC's page. Every route here is for the PC only: a terminal runs any command on this PC, and the server log can
// hold paths and names. A phone, a linked computer and the hub get 403 pc_only, reads included (remote-policy.js lists
// the writes in PC_ONLY and the reads in PC_ONLY_READ; each handler checks again).
import { readJson, sendJson, notFound } from '../lib/http.js';
import { ROLE } from '../config.js';
import { serverLogLines, onServerLog } from '../lib/serverLog.js';
import {
  closeConsole, consoleShell, consoleSnapshot, isConsoleId, listConsoles, onConsole, openConsole, restartConsole, sendLine,
  stopConsole,
} from '../services/console.js';

function refused(req, res) {
  if (!req.mcDevice && ROLE !== 'hub') return false;
  sendJson(res, 403, { error: 'pc_only' });
  return true;
}

const since = (url) => {
  const n = Number(url.searchParams.get('since') || 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

function failed(res, err) {
  if (err && err.status && err.status < 500) return sendJson(res, err.status, { error: err.message });
  throw err;
}

const withId = (fn) => async (req, res, params, url) => {
  if (refused(req, res)) return;
  if (!isConsoleId(params.id)) return notFound(res, 'Unknown console');
  try {
    await fn(req, res, params, url);
  } catch (err) {
    failed(res, err);
  }
};

export const routes = [
  {
    method: 'GET',
    path: '/api/console',
    handler: async (req, res) => {
      if (refused(req, res)) return;
      const sh = consoleShell();
      sendJson(res, 200, { shell: { name: sh.name, kind: sh.kind, prompt: sh.prompt }, consoles: listConsoles() });
    },
  },
  {
    // Server-Sent Events of the consoles' output and state, and of new server log lines. Its own stream, not /api/events:
    // that one goes to the phones too.
    method: 'GET',
    path: '/api/console/stream',
    handler: async (req, res) => {
      if (refused(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      const offA = onConsole(send);
      const offB = onServerLog((line) => send({ type: 'log', line }));
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      send({ type: 'hello', consoles: listConsoles() });
      req.on('close', () => { offA(); offB(); clearInterval(ping); });
    },
  },
  {
    method: 'GET',
    path: '/api/console/server-log',
    handler: async (req, res, params, url) => {
      if (refused(req, res)) return;
      sendJson(res, 200, { lines: serverLogLines(since(url)) });
    },
  },
  {
    method: 'GET',
    path: '/api/console/:id',
    handler: withId(async (req, res, params, url) => {
      const snap = consoleSnapshot(params.id, since(url));
      if (!snap) return notFound(res, 'Unknown console');
      sendJson(res, 200, snap);
    }),
  },
  {
    // Starts the console when it is new (body: { cwd }, the folder of the panel's project) and returns what it has.
    method: 'POST',
    path: '/api/console/:id/open',
    handler: withId(async (req, res, params) => {
      const body = await readJson(req);
      openConsole(params.id, { cwd: body && body.cwd });
      sendJson(res, 200, consoleSnapshot(params.id));
    }),
  },
  {
    // One line typed in (body: { line, cwd }); a console that is new or whose shell ended starts first.
    method: 'POST',
    path: '/api/console/:id/input',
    handler: withId(async (req, res, params) => {
      const body = await readJson(req, 64 * 1024);
      sendJson(res, 200, sendLine(params.id, body && body.line, { cwd: body && body.cwd }));
    }),
  },
  {
    // Stop the running command, as Ctrl+C would (body: { force }); the shell stays
    method: 'POST',
    path: '/api/console/:id/stop',
    handler: withId(async (req, res, params) => {
      const body = await readJson(req);
      sendJson(res, 200, await stopConsole(params.id, { force: !!(body && body.force) }));
    }),
  },
  {
    method: 'POST',
    path: '/api/console/:id/restart',
    handler: withId(async (req, res, params) => {
      restartConsole(params.id);
      sendJson(res, 200, consoleSnapshot(params.id));
    }),
  },
  {
    method: 'POST',
    path: '/api/console/:id/close',
    handler: withId(async (req, res, params) => {
      sendJson(res, 200, { closed: closeConsole(params.id) });
    }),
  },
];
