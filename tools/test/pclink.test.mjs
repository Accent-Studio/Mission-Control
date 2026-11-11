// End to end: a PC (Work) reads another PC's (Home's) projects and root folders over the real encrypted link, the way a
// phone reaches Home. A Home server with the real bridge (mc-bridge), Work paired with it as a device through the real
// mc-link, then a Work server that runs the link itself (services/pcLink.js). No relay: both ends are on this PC.
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
function run(exe, args) {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code, out }));
  });
}

describe('the link to another PC', () => {
  test('Work reads Home\'s projects and root folders over iroh, keeps them, and gets enter addresses', { skip: BIN ? false : 'mc-bridge and mc-link are not built' }, async () => {
    // Home: one root folder with one git project in it
    const homeDir = makeDataDir('mc-pclink-home');
    const devRoot = path.join(homeDir, 'dev');
    fs.mkdirSync(path.join(devRoot, 'Rocket', '.git'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({ machineName: 'Home' }));
    const home = await startServer({ dataDir: homeDir, bridge: true, env: { MC_DISCOVERY_ROOTS: devRoot } });
    toStop.push(home);
    const udp = await freePort();
    const bridge = spawn(path.join(BIN, 'mc-bridge' + EXT), ['--data-dir', home.dataDir, '--server', `127.0.0.1:${home.bridgePort}`, '--relay', 'off', '--bind', `127.0.0.1:${udp}`, '--orphan-secs', '30'], { windowsHide: true, stdio: 'ignore' });
    toStop.push({ stop: async () => { bridge.kill(); } });
    const code = await waitFor(async () => { const r = await pc(home, 'POST', '/api/devices/pair'); return r.status === 200 && r.json && r.json.uri && r.json; }, 'a pairing code on Home');

    // Work pairs with Home as a device, the way the phone does
    const workDir = makeDataDir('mc-pclink-work');
    fs.writeFileSync(path.join(workDir, 'config.json'), JSON.stringify({ machineName: 'Work' }));
    const linkArgs = ['--relay', 'off', '--addr', `127.0.0.1:${udp}`];
    const paired = await run(path.join(BIN, 'mc-link' + EXT), ['--state', path.join(workDir, 'home-link'), ...linkArgs, 'pair', code.uri, '--name', 'Work']);
    assert.equal(paired.code, 0, paired.out);
    assert.match(fs.readFileSync(path.join(workDir, 'home-link', 'server.json'), 'utf8'), /"name"\s*:\s*"Home"/);

    const env = { MC_PC_LINK_EXE: path.join(BIN, 'mc-link' + EXT), MC_PC_LINK_ARGS: linkArgs.join(' '), MC_PC_LINK_PORT: String(await freePort()) };
    const work = await startServer({ dataDir: workDir, bridge: false, env });
    toStop.push(work);
    const st = await waitFor(async () => { const r = (await pc(work, 'GET', '/api/pc-link')).json; return r.online && r.at && r; }, 'Home\'s projects on Work');
    assert.deepEqual(st.paired, { name: 'Home' });
    assert.deepEqual(st.roots, [devRoot]);
    const rocket = st.projects.find((p) => p.name === 'Rocket'); /* Mission Control lists itself too */
    assert.equal(rocket && rocket.folder, path.join(devRoot, 'Rocket'));
    assert.ok(st.projects.every((p) => p.checks === undefined && p.jobs === undefined), 'only what the tree needs is kept');
    const devices = (await pc(home, 'GET', '/api/devices')).json;
    assert.ok(JSON.stringify(devices).includes('Work'), 'Home lists Work as a paired device');

    // a one-use address for Home's own pages, through the same link
    const e1 = await pc(work, 'POST', '/api/pc-link/enter', {});
    assert.equal(e1.status, 200, e1.text);
    assert.match(e1.json.url, new RegExp(`^http://127\\.0\\.0\\.1:${env.MC_PC_LINK_PORT}/__mc/enter\\?t=`));
    const e2 = await pc(work, 'POST', '/api/pc-link/enter', {});
    assert.notEqual(e2.json.url, e1.json.url, 'each address is new');

    // with Home off, Work keeps the last list
    await home.stop();
    bridge.kill();
    await work.stop();
    const again = await startServer({ dataDir: workDir, bridge: false, env });
    toStop.push(again);
    const kept = (await pc(again, 'GET', '/api/pc-link')).json;
    assert.equal(kept.online, false);
    assert.ok(kept.projects.some((p) => p.name === 'Rocket'));
  });
});
