// Tests for the settings every PC shares through the hub (services/sharedSync.js, services/hubShared.js), such as the
// panel layouts: a value saved on one PC reaches the other, both ways, also when that PC was off at the time; the newest
// save wins.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { localReq, makeDataDir, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const call = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
const HOME_DEV = 'h'.repeat(40);
const WORK_DEV = 'w'.repeat(40);
const ENV = { MC_HUB_RETRY_MS: '500', MC_HUB_SYNC_MS: '60000', MC_SHARED_SYNC_MS: '100', MC_RUNNER_PORT: 'off' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startHub() {
  const dataDir = makeDataDir('mc-shared-hub');
  fs.writeFileSync(path.join(dataDir, 'devices.json'), JSON.stringify([
    { id: HOME_DEV, name: 'Home', pairedAt: '2026-11-08T00:00:00Z', lastSeen: null },
    { id: WORK_DEV, name: 'Work', pairedAt: '2026-11-08T00:00:00Z', lastSeen: null },
  ]));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ machineName: 'Hub' }));
  const s = await startServer({ dataDir, bridge: true, env: { MC_ROLE: 'hub', ...ENV } });
  toStop.push(s);
  return s;
}
async function startPc(hub, name, device) {
  const dataDir = makeDataDir('mc-shared-' + name.toLowerCase());
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ machineName: name }));
  const secret = fs.readFileSync(hub.secretFile, 'utf8').trim();
  fs.writeFileSync(path.join(dataDir, 'hub.json'), JSON.stringify({ url: `http://127.0.0.1:${hub.bridgePort}`, headers: { 'X-MC-Bridge': secret, 'X-MC-Device': device } }));
  const s = await startServer({ dataDir, bridge: false, env: ENV });
  toStop.push(s);
  return s;
}
// waits until `s` has `want` for the layouts (it picks it up at the hub's ring)
async function until(s, want) {
  for (let i = 0; i < 100; i++) {
    const d = (await call(s, 'GET', '/api/shared/layouts')).json;
    if (JSON.stringify(d.value) === JSON.stringify(want)) return d;
    await sleep(100);
  }
  throw new Error('the layouts never arrived');
}

describe('settings shared by every PC', () => {
  test('a layout saved on one PC reaches the other, both ways, and the newest wins', async () => {
    const hub = await startHub();
    const home = await startPc(hub, 'Home', HOME_DEV);

    // nothing saved yet
    assert.deepEqual((await call(home, 'GET', '/api/shared/layouts')).json, { value: null, at: null, by: null });

    // Home saves while Work is off; Work gets it when it comes on
    const a = { wsn: ['Talk', 'Plan'], own: {}, subs: {}, proj: { BlitzRaw: { Talk: { base: 'Talk', cols: [{ rows: [{ mod: 'docs' }] }] } } } };
    const put = await call(home, 'PUT', '/api/shared/layouts', { value: a });
    assert.equal(put.status, 200);
    assert.equal(put.json.by, 'Home');
    assert.equal((await call(home, 'POST', '/api/shared/sync', {})).json.ok, true);
    const work = await startPc(hub, 'Work', WORK_DEV);
    const got = await until(work, a);
    assert.equal(got.by, 'Home');

    // Work changes it: Home gets it at the hub's ring
    const b = { ...a, wsn: ['Plan', 'Talk', 'Code'] };
    await call(work, 'PUT', '/api/shared/layouts', { value: b });
    await until(home, b);

    // the hub keeps the newest, named after the PC that saved it
    const hubSays = (await localReq(hub, { method: 'GET', path: '/api/hub/shared?since=0', headers: {} })).json;
    assert.deepEqual(hubSays.items.layouts.value, b);
    assert.equal(hubSays.items.layouts.by, 'Work');

    // keys are checked
    assert.equal((await call(home, 'PUT', '/api/shared/Bad_Key', { value: 1 })).status, 400);
    assert.equal((await call(home, 'PUT', '/api/shared/layouts', {})).status, 400);
  });
});
