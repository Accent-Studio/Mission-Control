// Restart the Mission Control server. Works only when run-server.bat started it (it sets MC_SUPERVISED=1
// and starts the server again when it exits with code 75).
// "Restart everything" also restarts the phone bridge and the runner. run-server.bat starts those two only on a cold start,
// so this server starts them again itself, the same way (a minimized window each), before it restarts.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sendJson, readJson } from '../lib/http.js';
import { publish } from '../lib/events.js';
import { PORT, ROOT as ROOT_DIR, RUNNER_HOST, RUNNER_PORT } from '../config.js';
import { listRuns as listClaudeRuns } from '../services/runs.js';
import { listRuns as listJobRuns } from '../services/jobs.js';
import { runnerStatus, shutdownRunner } from '../services/runnerClient.js';
import { bridgeStatus, bridgeUpdateWaits, restartBridge } from '../services/devices.js';
import { requestRestart } from '../lib/restart.js';
import { serverCodeChanged } from '../lib/codeAge.js';

export const RESTART_EXIT_CODE = 75;
const STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

function running() {
  return {
    runs: listClaudeRuns().filter((r) => r.running).length, // starting or working (publicRun sets it); a run is never in state "running"
    jobs: listJobRuns().filter((r) => r.state === 'running' && r.mode !== 'window').length,
  };
}

const NOT_SUPERVISED = 'Restart only works when Mission Control was started from its shortcut';

const BRIDGE_BAT = path.join(ROOT_DIR, 'bridge', 'run-bridge.bat');
const RUNNER_BAT = path.join(ROOT_DIR, 'server', 'runner', 'run-runner.bat');
const bridgeBuilt = () => process.platform === 'win32'
  ? fs.existsSync(BRIDGE_BAT) && (fs.existsSync(path.join(ROOT_DIR, 'bridge', 'run', 'mc-bridge.exe')) || fs.existsSync(path.join(ROOT_DIR, 'bridge', 'run', 'mc-bridge.new.exe')))
  : fs.existsSync(path.join(ROOT_DIR, 'bridge', 'run', 'mc-bridge')) || fs.existsSync(path.join(ROOT_DIR, 'bridge', 'run', 'mc-bridge.new'));
// A runner turned off by its launcher (MC_RUNNER_PORT=off, as on the hub): the server starts Claude itself.
const runnerNow = () => { const r = runnerStatus(); return r.state === 'disabled' && !r.reason ? { ...r, reason: 'Turned off here: the server runs Claude itself' } : r; };

// The same line as in run-server.bat: start "<title>" /min cmd /c ""<bat>"", outside this process (it ends in a moment).
function startMinimized(title, bat) {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "${title}" /min cmd /c ""${bat}""`], { cwd: ROOT_DIR, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.on('error', () => {});
  child.unref();
}

// true once nothing answers on the runner's port any more (the old runner is gone), false after `ms`
function portFree(ms) {
  const until = Date.now() + ms;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const s = net.connect({ host: RUNNER_HOST, port: RUNNER_PORT });
      s.once('connect', () => { s.destroy(); if (Date.now() > until) resolve(false); else setTimeout(tryOnce, 200); });
      s.once('error', () => resolve(true));
    };
    tryOnce();
  });
}

async function restartHelpers() {
  if (!restartBridge() && bridgeBuilt()) startMinimized('Mission Control bridge', BRIDGE_BAT); // a running bridge restarts itself (exit 75)
  if (RUNNER_PORT === null) return;
  if (process.platform !== 'win32') {
    // start-mac.command starts the runner again before it starts the server again
    if (shutdownRunner()) await portFree(5000);
    return;
  }
  if (fs.existsSync(RUNNER_BAT)) {
    if (shutdownRunner()) await portFree(5000);
    startMinimized('Mission Control runner', RUNNER_BAT); // a second runner finds the port taken and ends by itself
  }
}

export const routes = [
  {
    method: 'GET',
    path: '/api/server/restart-info',
    handler: async (req, res) => sendJson(res, 200, running()),
  },
  {
    // The status window: the server, the runner (it owns the Claude processes) and the phone bridge.
    method: 'GET',
    path: '/api/server/status',
    handler: async (req, res) => {
      sendJson(res, 200, {
        now: Date.now(),
        // old: its code changed since it started, so a restart is due (the runner's own is in runnerStatus); for the bridge, a
        // new build waits (it is used from its next start)
        server: { pid: process.pid, port: PORT, startedAt: STARTED_AT, supervised: process.env.MC_SUPERVISED === '1', old: serverCodeChanged() },
        runner: runnerNow(),
        bridge: { ...bridgeStatus(), built: bridgeBuilt(), old: bridgeUpdateWaits() },
        running: running(),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/server/restart',
    handler: async (req, res) => {
      const body = await readJson(req).catch(() => null);
      if (!body || body.confirm !== true) return sendJson(res, 400, { error: 'Send {"confirm": true} to restart' });
      const all = body.all === true;
      // a phone restarts the server alone; one of the user's other computers (remote-policy.js COMPUTER_OK) may restart all three
      if (all && req.mcDevice && !req.mcDevice.computer) return sendJson(res, 403, { error: 'pc_only' });
      if (process.env.MC_SUPERVISED !== '1') return sendJson(res, 409, { error: NOT_SUPERVISED });
      sendJson(res, 200, { ok: true, all, running: running() });
      // Let the response flush first. process.exit runs the exit handlers that stop Claude runs and jobs.
      res.on('finish', async () => {
        publish('server.restarting', { all });
        if (all) {
          // through a link the reply goes out through the bridge, which restarts now: give it time to pass the reply on
          if (req.mcDevice) await new Promise((r) => setTimeout(r, 1500));
          try {
            await restartHelpers();
          } catch {
            // restart the server anyway
          }
        }
        requestRestart(RESTART_EXIT_CODE);
      });
    },
  },
];
