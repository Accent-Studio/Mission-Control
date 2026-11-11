// Tests for the PIN lock (services/pcLock.js, server/app.js): with no PIN the other computer keeps its limited access; with
// a PIN it gets only the lock screen until the PIN is typed, then everything this PC's own pages may do, until it is locked
// again. Wrong PINs run out; the PIN is set at the PC only; a phone is never held back.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { bridgeHeaders, bridgeReq, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const WORK = 'c'.repeat(64);
const PHONE = 'd'.repeat(64);
const call = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
const from = (device) => (s, method, p, body) => bridgeReq(s, { method, path: p, body, hdr: { device, post: method !== 'GET' } });
const work = from(WORK);
const phone = from(PHONE);

let H;
before(async () => {
  const dir = makeDataDir('mc-pclock');
  seedFixture(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ machineName: 'Home' }));
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify([
    { id: WORK, name: 'Work', pairedAt: '2026-11-08T00:00:00Z', lastSeen: null, computer: true },
    { id: PHONE, name: 'Phone', pairedAt: '2026-11-08T00:00:00Z', lastSeen: null },
  ]));
  H = await startServer({ dataDir: dir, bridge: true, env: { MC_RUNNER_PORT: 'off', MC_PC_BLOCK_MS: '1500' } });
  toStop.push(H);
});

describe('the PIN lock', () => {
  test('no PIN: the other computer keeps its limited access', async () => {
    assert.equal((await work(H, 'GET', '/api/projects')).status, 200);
    assert.equal((await work(H, 'GET', '/api/console')).status, 403);
    assert.equal((await work(H, 'GET', '/api/whoami')).json.remote, true);
  });

  test('the PIN is set at the PC only', async () => {
    assert.equal((await work(H, 'PUT', '/api/pc-lock/pin', { pin: '1234' })).status, 403);
    assert.equal((await phone(H, 'PUT', '/api/pc-lock/pin', { pin: '1234' })).status, 403);
    assert.equal((await call(H, 'PUT', '/api/pc-lock/pin', { pin: '12' })).status, 400);
    const r = await call(H, 'PUT', '/api/pc-lock/pin', { pin: '482913' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.pin, r.json.unlocked], [true, false]);
    assert.ok(!fs.readFileSync(path.join(H.dataDir, 'pc-lock.json'), 'utf8').includes('482913'));
  });

  test('locked: the other computer gets the lock screen and nothing else; a phone is not held back', async () => {
    const r = await work(H, 'GET', '/api/projects');
    assert.equal(r.status, 423);
    assert.equal(r.json.error, 'pc_locked');
    assert.equal((await work(H, 'GET', '/api/whoami')).json.locked, true);
    assert.equal((await work(H, 'GET', '/api/pc-lock')).status, 200);
    assert.equal((await phone(H, 'GET', '/api/projects')).status, 200);
    assert.equal((await phone(H, 'GET', '/api/whoami')).json.locked, false);
  });

  test('the right PIN opens everything until it is locked again, from anywhere', async () => {
    const bad = await work(H, 'POST', '/api/pc-lock/unlock', { pin: '000000' });
    assert.equal(bad.status, 403);
    assert.equal(bad.json.tries, 4);
    const ok = await work(H, 'POST', '/api/pc-lock/unlock', { pin: '482913' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.unlocked, true);
    assert.equal(ok.json.by, 'Work');
    assert.ok(Date.parse(ok.json.until) > Date.now());
    // everything this PC's own pages may do
    assert.equal((await work(H, 'GET', '/api/whoami')).json.remote, false);
    assert.equal((await work(H, 'GET', '/api/console')).status, 200);
    // but never its PIN
    assert.equal((await work(H, 'PUT', '/api/pc-lock/pin', { pin: null })).status, 403);
    // the phone locks it
    assert.equal((await phone(H, 'POST', '/api/pc-lock/lock', {})).json.unlocked, false);
    assert.equal((await work(H, 'GET', '/api/console')).status, 423);
    // and the other computer locks it before leaving
    await work(H, 'POST', '/api/pc-lock/unlock', { pin: '482913' });
    assert.equal((await work(H, 'POST', '/api/pc-lock/lock', {})).json.unlocked, false);
  });

  test('five wrong PINs close it for a while, even to the right one', async () => {
    for (let i = 0; i < 5; i++) await work(H, 'POST', '/api/pc-lock/unlock', { pin: '111111' });
    const shut = await work(H, 'POST', '/api/pc-lock/unlock', { pin: '482913' });
    assert.equal(shut.status, 429);
    assert.ok(shut.json.outUntil);
    await new Promise((r) => setTimeout(r, 1700));
    assert.equal((await work(H, 'POST', '/api/pc-lock/unlock', { pin: '482913' })).status, 200);
  });

  test('the lock time is set at the PC, and an open lock moves to it', async () => {
    assert.equal((await call(H, 'GET', '/api/pc-lock')).json.lockAt, '03:00');
    assert.equal((await work(H, 'PUT', '/api/pc-lock/time', { at: '23:00' })).status, 403);
    assert.equal((await call(H, 'PUT', '/api/pc-lock/time', { at: '25:00' })).status, 400);
    const r = await call(H, 'PUT', '/api/pc-lock/time', { at: '16:30' });
    assert.equal(r.json.lockAt, '16:30');
    const u = new Date(r.json.until);
    assert.deepEqual([u.getHours(), u.getMinutes()], [16, 30]);
    assert.ok(u - Date.now() <= 24 * 3600e3);
  });

  test('removing the PIN at the PC gives back the limited access', async () => {
    assert.equal((await call(H, 'PUT', '/api/pc-lock/pin', { pin: null })).json.pin, false);
    assert.equal((await work(H, 'GET', '/api/projects')).status, 200);
    assert.equal((await work(H, 'GET', '/api/console')).status, 403);
    assert.equal((await call(H, 'GET', '/api/pc-lock')).json.lockAt, '16:30');
  });
});

describe("the other PC's PIN, seen from this PC", () => {
  let W;
  before(async () => {
    W = await startServer({ dataDir: makeDataDir('mc-pclock-work'), bridge: false, env: { MC_RUNNER_PORT: 'off', MC_PC_LINK_TEST: JSON.stringify({ name: 'Home', url: `http://127.0.0.1:${H.bridgePort}`, headers: bridgeHeaders(H, { device: WORK }) }) } });
    toStop.push(W);
    await call(H, 'PUT', '/api/pc-lock/pin', { pin: '482913' });
  });

  test("its lock is not this PC's: this PC's pages stay open, and say which PC is locked", async () => {
    assert.equal((await call(W, 'GET', '/api/whoami')).json.locked, false);
    assert.equal((await call(W, 'GET', '/api/projects')).status, 200);
    const r = await call(W, 'POST', '/api/pc/sessions/' + 'e'.repeat(36) + '/meta', { title: 'x' });
    assert.equal(r.status, 423);
    assert.deepEqual(r.json, { error: 'peer_locked', pc: 'Home' });
    assert.equal((await call(W, 'GET', '/api/pc-link')).json.locked, true);
  });

  test('its PIN, typed here, opens it', async () => {
    assert.equal((await call(W, 'POST', '/api/pc-link/unlock', { pin: '000000' })).status, 403);
    const ok = await call(W, 'POST', '/api/pc-link/unlock', { pin: '482913' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.unlocked, true);
    assert.equal((await call(W, 'GET', '/api/pc-link')).json.locked, false);
  });

  test('locked from here, nothing of it shows: not its projects, and it remembers the lock', async () => {
    assert.ok((await call(W, 'GET', '/api/pc-link')).json.projects.length > 0);
    assert.equal((await call(W, 'POST', '/api/pc-link/lock', {})).status, 200);
    const st = (await call(W, 'GET', '/api/pc-link')).json;
    assert.equal(st.locked, true);
    assert.deepEqual([st.projects, st.roots], [[], []]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(W.dataDir, 'home-link', 'lock.json'), 'utf8')).pin, true);
  });

  test("locked, that PC ends the other computer's live stream", async () => {
    await call(W, 'POST', '/api/pc-link/unlock', { pin: '482913' });
    const ended = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: H.bridgePort, path: '/api/events', headers: { ...bridgeHeaders(H, { device: WORK }), Accept: 'text/event-stream' } }, (res) => {
        assert.equal(res.statusCode, 200);
        res.resume();
        res.on('end', () => resolve(true));
        setTimeout(() => call(H, 'POST', '/api/pc-lock/lock', {}), 200);
      });
      req.on('error', () => {});
      setTimeout(() => { req.destroy(); resolve(false); }, 4000);
    });
    assert.equal(ended, true);
  });
});
