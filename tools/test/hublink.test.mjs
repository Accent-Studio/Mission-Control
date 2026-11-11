// End to end: a PC reaches the hub over the real encrypted link. A hub server with the real bridge (mc-bridge), a PC
// server that pairs with it through the Connections API and runs the real mc-link, then a chat written on the PC that
// arrives in the hub's mailbox. No relay: both ends are on this PC.
// The programs come from MC_TEST_BRIDGE_BIN (a cargo release folder), else bridge/run; without them the test is skipped.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ROOT, freePort, localReq, makeDataDir, startServer } from './harness.mjs';

const EXT = process.platform === 'win32' ? '.exe' : '';
const BIN = [process.env.MC_TEST_BRIDGE_BIN, path.join(ROOT, 'bridge', 'run')].filter(Boolean).find((d) => fs.existsSync(path.join(d, 'mc-bridge' + EXT)) && fs.existsSync(path.join(d, 'mc-link' + EXT)));
const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop.reverse()) await s.stop().catch(() => {});
});
const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
async function waitFor(fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(150);
  }
}

describe('the link to the hub', () => {
  test('a PC pairs with the hub, links over iroh, and its chat reaches the hub', { skip: BIN ? false : 'mc-bridge and mc-link are not built' }, async () => {
    const hub = await startServer({ dataDir: makeDataDir('mc-link-hub'), bridge: true, env: { MC_ROLE: 'hub' } });
    toStop.push(hub);
    const udp = await freePort();
    const bridge = spawn(path.join(BIN, 'mc-bridge' + EXT), ['--data-dir', hub.dataDir, '--server', `127.0.0.1:${hub.bridgePort}`, '--relay', 'off', '--bind', `127.0.0.1:${udp}`, '--orphan-secs', '30'], { windowsHide: true, stdio: 'ignore' });
    toStop.push({ stop: async () => { bridge.kill(); } });
    const code = await waitFor(async () => { const r = await pc(hub, 'POST', '/api/devices/pair'); return r.status === 200 && r.json && r.json.uri && r.json; }, 'a pairing code on the hub');

    const dataDir = makeDataDir('mc-link-home');
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ machineName: 'Home' }));
    const tdir = path.join(dataDir, 'claude-home', 'projects', path.join(dataDir, 'chats').replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(tdir, { recursive: true });
    const home = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '20', FAKE_TRANSCRIPT: tdir, MC_IDLE_MS: '60000', MC_HUB_RETRY_MS: '500', MC_HUB_LINK_EXE: path.join(BIN, 'mc-link' + EXT), MC_HUB_LINK_ARGS: `--relay off --addr 127.0.0.1:${udp}`, MC_HUB_LINK_PORT: String(await freePort()) } });
    toStop.push(home);
    assert.deepEqual((await pc(home, 'GET', '/api/hub-link')).json.paired, null);
    assert.equal((await pc(home, 'POST', '/api/hub-link/pair', { text: 'not a pairing text' })).status, 400);
    const paired = await pc(home, 'POST', '/api/hub-link/pair', { text: code.uri });
    assert.equal(paired.status, 200, paired.text);
    await waitFor(async () => (await pc(home, 'GET', '/api/hub-link')).json.state === 'online', 'the link to be online');
    const devices = (await pc(hub, 'GET', '/api/devices')).json;
    assert.ok(JSON.stringify(devices).includes('Home'), 'the hub lists Home as a paired device');

    const r = await pc(home, 'POST', '/api/chat', { prompt: 'over the real link', chat: true });
    assert.equal(r.status, 200, r.text);
    const run = await waitFor(async () => (await pc(home, 'GET', '/api/runs')).json.find((x) => x.runId === r.json.runId && x.state === 'idle' && x.sessionId), 'the chat to answer');
    const size = () => fs.statSync(path.join(tdir, run.sessionId + '.jsonl')).size;
    const e = await waitFor(async () => { const x = await pc(hub, 'GET', `/api/hub/sessions/${run.sessionId}`); return x.status === 200 && x.json.size === size() && x.json; }, 'the chat in the hub mailbox');
    assert.equal(e.origin.name, 'Home');

    // forgetting the hub stops the link
    assert.equal((await pc(home, 'POST', '/api/hub-link/forget')).json.paired, null);
    assert.ok(!fs.existsSync(path.join(dataDir, 'hub.json')));
  });
});
