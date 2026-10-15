// Restart the Mission Control server. Works only when run-server.bat started it (it sets MC_SUPERVISED=1
// and starts the server again when it exits with code 75).
import { sendJson, readJson } from '../lib/http.js';
import { publish } from '../lib/events.js';
import { listRuns as listClaudeRuns } from '../services/runs.js';
import { listRuns as listJobRuns } from '../services/jobs.js';
import { requestRestart } from '../lib/restart.js';

export const RESTART_EXIT_CODE = 75;

function running() {
  return {
    runs: listClaudeRuns().filter((r) => r.running).length, // starting or working (publicRun sets it); a run is never in state "running"
    jobs: listJobRuns().filter((r) => r.state === 'running' && r.mode !== 'window').length,
  };
}

const NOT_SUPERVISED = 'Restart only works when Mission Control was started from its shortcut';

export const routes = [
  {
    method: 'GET',
    path: '/api/server/restart-info',
    handler: async (req, res) => sendJson(res, 200, running()),
  },
  {
    method: 'POST',
    path: '/api/server/restart',
    handler: async (req, res) => {
      const body = await readJson(req).catch(() => null);
      if (!body || body.confirm !== true) return sendJson(res, 400, { error: 'Send {"confirm": true} to restart' });
      if (process.env.MC_SUPERVISED !== '1') return sendJson(res, 409, { error: NOT_SUPERVISED });
      sendJson(res, 200, { ok: true, running: running() });
      // Let the response flush first. process.exit runs the exit handlers that stop Claude runs and jobs.
      res.on('finish', () => {
        publish('server.restarting', {});
        requestRestart(RESTART_EXIT_CODE);
      });
    },
  },
];
