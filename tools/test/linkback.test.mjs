// The link both ways (services/pcLink.js): Work's link to Home is up, Home has none to Work. Work opens a pairing code
// on its own bridge and hands it to Home through its link; Home pairs with Work's bridge (a fake mc-link here, that
// asks Work's server as the real bridge would) and starts its own link; Work marks Home as a linked computer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { KNOWN_DEVICE, bridgeHeaders, bridgeReq, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const toStop = [];
const streams = [];
after(async () => {
  for (const r of streams) r.destroy();
  for (const s of toStop) await s.stop().catch(() => {});
});

const HOME_EP = 'ab'.repeat(32); // Home's key, as Work's bridge would see it
const WORK_EP = 'cd'.repeat(32); // Work's bridge
const PHONE = 'ef'.repeat(32); // a phone paired with Home
const post = (s, p, body = {}) => localReq(s, { method: 'POST', path: p, body, headers: { 'X-MC': '1' } });

let H, W;
before(async () => {
  // Work first: Home's fake mc-link needs the address of Work's bridge listener
  const work = makeDataDir('mc-linkback-work');
  seedFixture(work);
  const home = makeDataDir('mc-linkback-home');
  seedFixture(home);
  // on Home, Work is a paired device and a linked computer (it paired with Home's bridge, as the Mac did)
  fs.writeFileSync(path.join(home, 'devices.json'), JSON.stringify([{ id: KNOWN_DEVICE, name: 'Work', pairedAt: '2026-11-01T00:00:00Z', lastSeen: null, computer: true }, { id: PHONE, name: 'Phone', pairedAt: '2026-11-01T00:00:00Z', lastSeen: null }]));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ machineName: 'Home' }));
  fs.writeFileSync(path.join(work, 'config.json'), JSON.stringify({ machineName: 'Work' }));
  fs.writeFileSync(path.join(work, 'devices.json'), '[]');
  W = await startServer({ dataDir: work, bridge: true, env: { MC_PC_BACK_WAIT_MS: '500' } });
  toStop.push(W);
  const fakeLink = path.join(here, 'fake-mc-link.mjs');
  H = await startServer({
    dataDir: home, bridge: true,
    env: { MC_PC_LINK_EXE: fakeLink, MC_FAKE_LINK: JSON.stringify({ url: `http://127.0.0.1:${W.bridgePort}`, headers: { ...bridgeHeaders(W, { device: null }), Host: `127.0.0.1:${W.bridgePort}` }, endpointId: HOME_EP }) },
  });
  toStop.push(H);
  // Work again, now linked to Home through Home's bridge as the device Work
  await W.stop();
  toStop.splice(toStop.indexOf(W), 1);
  W = await startServer({
    dataDir: work, bridge: W.bridgePort,
    env: { MC_PC_BACK_WAIT_MS: '500', MC_PC_LINK_TEST: JSON.stringify({ name: 'Home', url: `http://127.0.0.1:${H.bridgePort}`, headers: bridgeHeaders(H) }) },
  });
  toStop.push(W);
  // Work's bridge is running: its hello and its control stream
  const hello = await bridgeReq(W, { method: 'POST', path: '/api/bridge/hello', body: { endpointId: WORK_EP, version: 'test', startedAt: new Date().toISOString() }, hdr: { device: null, post: true } });
  assert.equal(hello.status, 200, hello.text);
  await new Promise((ok) => {
    const req = http.get({ host: '127.0.0.1', port: W.bridgePort, path: '/api/bridge/control', headers: { ...bridgeHeaders(W, { device: null }), Host: `127.0.0.1:${W.bridgePort}` } }, (res) => { res.once('data', () => ok()); });
    streams.push(req);
  });
});

describe('the link both ways', () => {
  test('Work sees that Home has no link to it', async () => {
    const r = await post(W, '/api/pc-link/back', { check: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.back.state, 'missing');
    assert.equal(r.json.me, 'Work');
  });

  test('a phone of Home may not hand Home a pairing code, nor ask for the link back', async () => {
    const r = await bridgeReq(H, { method: 'POST', path: '/api/pc-link/pair-back', body: { uri: `missioncontrol-pair:${WORK_EP}:AAAA-AAAA` }, hdr: { device: PHONE, post: true } });
    assert.equal(r.status, 403, r.text);
    const b = await bridgeReq(H, { method: 'POST', path: '/api/pc-link/back', body: {}, hdr: { device: PHONE, post: true } });
    assert.equal(b.status, 403, b.text);
    assert.equal(fs.existsSync(path.join(H.dataDir, 'home-link', 'server.json')), false);
  });

  test('Work links back: Home pairs with Work\'s bridge, and Work marks Home as a linked computer', async () => {
    const r = await post(W, '/api/pc-link/back');
    assert.equal(r.status, 200, r.text);
    // Home's link is set up (its fake link never comes online)
    assert.equal(r.json.back.state, 'paired', JSON.stringify(r.json.back));
    const home = await localReq(H, { path: '/api/pc-link' });
    assert.deepEqual(home.json.paired, { name: 'Work' });
    const devs = JSON.parse(fs.readFileSync(path.join(W.dataDir, 'devices.json'), 'utf8'));
    assert.deepEqual(devs.map((d) => [d.id, d.name, !!d.computer]), [[HOME_EP, 'Home', true]]);
  });

  test('a second time does nothing, and Home refuses a pairing from another computer', async () => {
    const r = await post(W, '/api/pc-link/back');
    assert.equal(r.json.back.state, 'paired');
    assert.equal(JSON.parse(fs.readFileSync(path.join(W.dataDir, 'devices.json'), 'utf8')).length, 1);
    fs.writeFileSync(path.join(H.dataDir, 'devices.json'), JSON.stringify([{ id: KNOWN_DEVICE, name: 'Laptop', pairedAt: '2026-11-01T00:00:00Z', lastSeen: null, computer: true }]));
    await new Promise((ok) => setTimeout(ok, 300));
    const other = await bridgeReq(H, { method: 'POST', path: '/api/pc-link/pair-back', body: { uri: `missioncontrol-pair:${WORK_EP}:AAAA-AAAA` }, hdr: { device: KNOWN_DEVICE, post: true } });
    assert.equal(other.status, 409, other.text);
    assert.match(other.json.error, /already linked to Work/);
  });
});
