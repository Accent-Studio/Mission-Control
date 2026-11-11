// Tests for the server status window (routes/server.js): it says when the server runs older code than its folder has
// (a pull, a sync or an edit since it started), and when a new build of the phone bridge waits for its next start.
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { localReq, makeDataDir, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop.reverse()) await s.stop().catch(() => {});
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async (s) => (await localReq(s, { method: 'GET', path: '/api/server/status' })).json;

describe('the server status window', () => {
  test('a restart is due once a file of the server code is newer than the server', async () => {
    const dir = makeDataDir('mc-status');
    const code = path.join(dir, 'code');
    fs.mkdirSync(path.join(code, 'services'), { recursive: true });
    const file = path.join(code, 'services', 'a.js');
    fs.writeFileSync(file, '// old\n');
    const old = new Date(Date.now() - 60e3);
    fs.utimesSync(file, old, old);
    const s = await startServer({ dataDir: dir, bridge: false, env: { MC_CODE_DIR: code, MC_CODE_AGE_MS: '50' } });
    toStop.push(s);
    const a = await status(s);
    assert.equal(a.server.old, false);
    assert.equal(a.bridge.old, false);
    await sleep(1200); // a file written in the server's first second counts as the code it started with
    fs.writeFileSync(file, '// new\n');
    await sleep(100);
    assert.equal((await status(s)).server.old, true);
  });
});
