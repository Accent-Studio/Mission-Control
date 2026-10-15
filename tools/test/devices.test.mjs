// Tests for the devices service: pairing, the device list, removal, the bridge control stream and the SSE event.
// Run: node --test "tools/test/*.test.mjs"        (no npm packages; every server uses free ports and its own data folder)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  KNOWN_DEVICE, bridgeHeaders, bridgeReq, localReq, makeDataDir, request, seedFixture, startServer,
} from './harness.mjs';

const toStop = [];
const streams = [];
after(async () => {
  for (const st of streams) st.close();
  for (const s of toStop) await s.stop().catch(() => {});
});

async function boot(opts = {}) {
  const dataDir = opts.dataDir || makeDataDir();
  if (!opts.noFixture) seedFixture(dataDir);
  const s = await startServer({ dataDir, ...opts });
  toStop.push(s);
  return s;
}

// A tiny Server-Sent Events reader: collects every `data:` line as parsed JSON.
function openSse({ port, path: p, headers = {}, host }) {
  const events = [];
  const waiters = [];
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.request({ host: '127.0.0.1', port, path: p, headers: { ...headers, ...(host ? { Host: host } : {}) }, agent: false }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          events.push(JSON.parse(line.slice(6)));
          for (const w of waiters.splice(0)) w();
        }
      });
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
  const stream = {
    events,
    ready,
    close: () => req.destroy(),
    // Resolves with the first event (from index `from`) that satisfies `pred`, or fails after `ms`.
    async waitFor(pred, { ms = 4000, from = 0 } = {}) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = events.slice(from).find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`event not seen; got ${JSON.stringify(events.slice(from))}`);
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    },
    async expectNone(pred, ms = 400, from = 0) {
      await new Promise((r) => setTimeout(r, ms));
      assert.equal(events.slice(from).find(pred), undefined);
    },
  };
  streams.push(stream);
  return stream;
}

const localEvents = (s) => openSse({ port: s.port, path: '/api/events' });
const controlStream = (s) =>
  openSse({ port: s.bridgePort, path: '/api/bridge/control', host: `127.0.0.1:${s.bridgePort}`, headers: bridgeHeaders(s, { device: null }) });

// Calls as the bridge program (secret, no device).
const asBridge = (s, method, p, body) =>
  bridgeReq(s, { method, path: p, body, hdr: { device: null, post: method !== 'GET' } });
const asPc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
const asPhone = (s, method, p, body, device = KNOWN_DEVICE) =>
  bridgeReq(s, { method, path: p, body, hdr: { device, post: method !== 'GET' } });

const NEW_PHONE = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const OTHER_PHONE = 'bead0000bead0000bead0000bead0000bead0000bead0000bead0000bead0000';
const ENDPOINT = '9f'.repeat(32);
const devicesFile = (s) => path.join(s.dataDir, 'devices.json');
const readDevices = (s) => JSON.parse(fs.readFileSync(devicesFile(s), 'utf8'));

// Connects a fake bridge: hello plus an open control stream. Returns the control stream reader.
async function connectBridge(s) {
  const hello = await asBridge(s, 'POST', '/api/bridge/hello', { endpointId: ENDPOINT, version: '0.0.1-test', startedAt: new Date().toISOString() });
  assert.equal(hello.status, 200);
  const control = controlStream(s);
  await control.waitFor((e) => e.type === 'devices');
  return control;
}

describe('pairing: start, cancel, use, burn', () => {
  let s;
  let control;
  let events;
  test('start', async () => {
    s = await boot();
    events = localEvents(s);
    await events.ready;
  });

  test('pairing needs a connected bridge (409 bridge_offline)', async () => {
    const r = await asPc(s, 'POST', '/api/devices/pair', {});
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: 'bridge_offline' });
    const list = await asPc(s, 'GET', '/api/devices');
    assert.equal(list.status, 200);
    assert.equal(list.json.bridge, null);
    assert.equal(list.json.pairing, null);
  });

  test('hello and the control stream bring the bridge online; the snapshot lists the paired ids first', async () => {
    control = await connectBridge(s);
    assert.deepEqual(control.events[0], { type: 'devices', ids: [KNOWN_DEVICE] });
    const list = (await asPc(s, 'GET', '/api/devices')).json;
    assert.deepEqual(list.bridge, { online: true, endpointId: ENDPOINT, version: '0.0.1-test' });
    assert.equal(list.devices.length, 1);
    assert.deepEqual(Object.keys(list.devices[0]).sort(), ['id', 'lastSeen', 'name', 'online', 'pairedAt']);
    assert.equal(list.devices[0].online, false);
    await events.waitFor((e) => e.type === 'devices.changed');
  });

  test('POST /api/devices/pair gives an 8 character code, the uri and an expiry about 10 minutes away', async () => {
    const r = await asPc(s, 'POST', '/api/devices/pair', {});
    assert.equal(r.status, 200);
    assert.match(r.json.code, /^[2346789ACDEFGHJKMNPQRTUVWXYZ]{4}-[2346789ACDEFGHJKMNPQRTUVWXYZ]{4}$/);
    assert.equal(r.json.uri, `missioncontrol-pair:${ENDPOINT}:${r.json.code}`);
    const left = Date.parse(r.json.expiresAt) - Date.now();
    assert.ok(left > 9 * 60 * 1000 && left <= 10 * 60 * 1000, `ttl ${left}`);
    const list = (await asPc(s, 'GET', '/api/devices')).json;
    assert.deepEqual(list.pairing, { expiresAt: r.json.expiresAt });
    assert.ok(!JSON.stringify(list).includes(r.json.code), 'the code is never listed');
  });

  test('cancel closes the code, and a second pair gives a fresh one', async () => {
    const first = (await asPc(s, 'GET', '/api/devices')).json.pairing;
    assert.ok(first);
    const mark = events.events.length;
    const c = await asPc(s, 'POST', '/api/devices/pair/cancel', {});
    assert.deepEqual(c.json, { ok: true, cancelled: true });
    await events.waitFor((e) => e.type === 'devices.changed' && e.data.state === 'cancelled', { from: mark });
    assert.equal((await asPc(s, 'GET', '/api/devices')).json.pairing, null);
    assert.deepEqual((await asPc(s, 'POST', '/api/devices/pair/cancel', {})).json, { ok: true, cancelled: false });
  });

  test('a replaced code stops working', async () => {
    const a = (await asPc(s, 'POST', '/api/devices/pair', {})).json;
    const b = (await asPc(s, 'POST', '/api/devices/pair', {})).json;
    assert.notEqual(a.code, b.code);
    const old = await asBridge(s, 'POST', '/api/bridge/pair', { endpointId: NEW_PHONE, code: a.code, deviceName: 'Old' });
    assert.deepEqual(old.json, { ok: false, code: 'bad_code' });
    await asPc(s, 'POST', '/api/devices/pair/cancel', {});
  });

  test('5 wrong tries burn the code, even the right one afterwards', async () => {
    const p = (await asPc(s, 'POST', '/api/devices/pair', {})).json;
    for (let i = 0; i < 5; i++) {
      const r = await asBridge(s, 'POST', '/api/bridge/pair', { endpointId: NEW_PHONE, code: `AAAA-AAA${i}`, deviceName: 'Guess' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: false, code: 'bad_code' });
    }
    assert.equal((await asPc(s, 'GET', '/api/devices')).json.pairing, null, 'burned');
    const late = await asBridge(s, 'POST', '/api/bridge/pair', { endpointId: NEW_PHONE, code: p.code, deviceName: 'Phone' });
    assert.deepEqual(late.json, { ok: false, code: 'bad_code' });
    assert.equal(readDevices(s).length, 1);
  });

  test('4 wrong tries do not burn it; the right code works once, in any case or with no dash', async () => {
    const p = (await asPc(s, 'POST', '/api/devices/pair', {})).json;
    for (let i = 0; i < 4; i++) await asBridge(s, 'POST', '/api/bridge/pair', { endpointId: NEW_PHONE, code: 'ZZZZ-ZZZZ', deviceName: 'x' });
    const mark = events.events.length;
    const ctlMark = control.events.length;
    const ok = await asBridge(s, 'POST', '/api/bridge/pair', { endpointId: NEW_PHONE, code: p.code.replace('-', '').toLowerCase(), deviceName: '  Pixel 9\u0007  ' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(typeof ok.json.serverName, 'string');
    // devices.json is written, with the cleaned name
    const saved = readDevices(s);
    const mine = saved.find((d) => d.id === NEW_PHONE);
    assert.equal(mine.name, 'Pixel 9');
    assert.ok(Date.parse(mine.pairedAt) > 0);
    assert.equal(saved.length, 2);
    assert.ok(!fs.existsSync(`${devicesFile(s)}.tmp`), 'atomic write leaves no temp file');
    // the PC page is told, the bridge is told
    await events.waitFor((e) => e.type === 'devices.changed' && e.data.reason === 'paired' && e.data.id === NEW_PHONE, { from: mark });
    await control.waitFor((e) => e.type === 'add' && e.id === NEW_PHONE, { from: ctlMark });
    // the code is spent
    const again = await asBridge(s, 'POST', '/api/bridge/pair', { endpointId: OTHER_PHONE, code: p.code, deviceName: 'Thief' });
    assert.deepEqual(again.json, { ok: false, code: 'bad_code' });
    assert.equal((await asPc(s, 'GET', '/api/devices')).json.pairing, null);
    assert.equal(readDevices(s).length, 2);
  });

  test('the new device is accepted on the bridge listener at once (the S1 lookup uses the service)', async () => {
    const r = await asPhone(s, 'GET', '/api/whoami', undefined, NEW_PHONE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { remote: true, device: { id: NEW_PHONE, name: 'Pixel 9' } });
  });

  test('bad input to the bridge pair route is a 400', async () => {
    for (const body of [{}, { endpointId: 'has space', code: 'AAAA-AAAA' }, { endpointId: NEW_PHONE, code: 5 }, { endpointId: NEW_PHONE, code: 'x'.repeat(100) }]) {
      const r = await asBridge(s, 'POST', '/api/bridge/pair', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
    }
  });
});

describe('removing a device', () => {
  let s;
  let control;
  let events;
  test('start', async () => {
    s = await boot();
    events = localEvents(s);
    await events.ready;
    control = await connectBridge(s);
  });

  test('remove: devices.json, devices.changed, a revoke event, and in-flight requests get 403 device_revoked', async () => {
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200);
    const mark = events.events.length;
    const ctlMark = control.events.length;
    const r = await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/remove`, {});
    assert.deepEqual(r.json, { ok: true });
    assert.deepEqual(readDevices(s), []);
    await events.waitFor((e) => e.type === 'devices.changed' && e.data.reason === 'removed' && e.data.id === KNOWN_DEVICE, { from: mark });
    const revoke = await control.waitFor((e) => e.type === 'revoke', { from: ctlMark, ms: 1000 });
    assert.equal(revoke.id, KNOWN_DEVICE);
    const after = await asPhone(s, 'GET', '/api/whoami');
    assert.equal(after.status, 403);
    assert.deepEqual(after.json, { error: 'device_revoked' });
  });

  test('removing an unknown or malformed id is 404', async () => {
    assert.equal((await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/remove`, {})).status, 404);
    assert.equal((await asPc(s, 'POST', '/api/devices/has%20space/remove', {})).status, 404);
  });

  test('a new control stream starts with a snapshot that no longer lists the device', async () => {
    const again = controlStream(s);
    const snap = await again.waitFor((e) => e.type === 'devices');
    assert.deepEqual(snap.ids, []);
    again.close();
  });

  test('a phone can remove itself (not 403) and the revoke follows its answer', async () => {
    const code = (await asPc(s, 'POST', '/api/devices/pair', {})).json.code;
    await asBridge(s, 'POST', '/api/bridge/pair', { endpointId: OTHER_PHONE, code, deviceName: 'Second' });
    const ctlMark = control.events.length;
    const r = await asPhone(s, 'POST', `/api/devices/${OTHER_PHONE}/remove`, {}, OTHER_PHONE);
    assert.equal(r.status, 200);
    await control.waitFor((e) => e.type === 'revoke' && e.id === OTHER_PHONE, { from: ctlMark });
  });

  test('a hand edit of devices.json is picked up: removing a line revokes the phone', async () => {
    const code = (await asPc(s, 'POST', '/api/devices/pair', {})).json.code;
    await asBridge(s, 'POST', '/api/bridge/pair', { endpointId: NEW_PHONE, code, deviceName: 'Edit me' });
    assert.equal((await asPhone(s, 'GET', '/api/whoami', undefined, NEW_PHONE)).status, 200);
    const ctlMark = control.events.length;
    fs.writeFileSync(devicesFile(s), '[]');
    const r = await asPhone(s, 'GET', '/api/whoami', undefined, NEW_PHONE);
    assert.equal(r.status, 403);
    await control.waitFor((e) => e.type === 'revoke' && e.id === NEW_PHONE, { from: ctlMark });
  });
});

describe('time to live', () => {
  test('an unused code expires after MC_PAIR_TTL_MS and the page hears about it', async () => {
    const s = await boot({ env: { MC_PAIR_TTL_MS: '1500' } });
    const events = localEvents(s);
    await events.ready;
    await connectBridge(s);
    const mark = events.events.length; // before the POST, so the expiry event can never fall before the mark
    const p = (await asPc(s, 'POST', '/api/devices/pair', {})).json;
    assert.ok(Date.parse(p.expiresAt) - Date.now() <= 1500);
    await events.waitFor((e) => e.type === 'devices.changed' && e.data.state === 'expired', { from: mark, ms: 4000 });
    assert.equal((await asPc(s, 'GET', '/api/devices')).json.pairing, null);
    const late = await asBridge(s, 'POST', '/api/bridge/pair', { endpointId: NEW_PHONE, code: p.code, deviceName: 'Late' });
    assert.deepEqual(late.json, { ok: false, code: 'bad_code' });
    assert.equal(readDevices(s).length, 1);
  });
});

describe('presence, rename, bridge restart, persistence', () => {
  let s;
  let control;
  let events;
  test('start', async () => {
    s = await boot();
    events = localEvents(s);
    await events.ready;
    control = await connectBridge(s);
  });

  test('presence marks a device online and sets lastSeen; unknown devices are 404', async () => {
    const mark = events.events.length;
    const r = await asBridge(s, 'POST', '/api/bridge/presence', { id: KNOWN_DEVICE, online: true });
    assert.equal(r.status, 200);
    await events.waitFor((e) => e.type === 'devices.changed' && e.data.reason === 'presence', { from: mark });
    let d = (await asPc(s, 'GET', '/api/devices')).json.devices.find((x) => x.id === KNOWN_DEVICE);
    assert.equal(d.online, true);
    assert.ok(Date.parse(d.lastSeen) > Date.now() - 5000);
    await asBridge(s, 'POST', '/api/bridge/presence', { id: KNOWN_DEVICE, online: false });
    d = (await asPc(s, 'GET', '/api/devices')).json.devices.find((x) => x.id === KNOWN_DEVICE);
    assert.equal(d.online, false);
    assert.equal((await asBridge(s, 'POST', '/api/bridge/presence', { id: OTHER_PHONE, online: true })).status, 404);
    assert.equal((await asBridge(s, 'POST', '/api/bridge/presence', { id: KNOWN_DEVICE, online: 'yes' })).status, 400);
  });

  test('a phone request touches lastSeen (in memory, written later)', async () => {
    const before = (await asPc(s, 'GET', '/api/devices')).json.devices[0].lastSeen;
    await new Promise((r) => setTimeout(r, 30));
    await asPhone(s, 'GET', '/api/whoami');
    const after = (await asPc(s, 'GET', '/api/devices')).json.devices[0].lastSeen;
    assert.ok(Date.parse(after) > Date.parse(before));
  });

  test('hello with an online list restores presence after a server restart of the link', async () => {
    await asBridge(s, 'POST', '/api/bridge/hello', { endpointId: ENDPOINT, version: '0.0.2', online: [KNOWN_DEVICE] });
    const list = (await asPc(s, 'GET', '/api/devices')).json;
    assert.equal(list.devices[0].online, true);
    assert.equal(list.bridge.version, '0.0.2');
    assert.equal((await asBridge(s, 'POST', '/api/bridge/hello', { endpointId: 'bad id' })).status, 400);
  });

  test('rename cleans the name; empty is 400; unknown is 404', async () => {
    const r = await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/rename`, { name: '  My   phone  ' });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, 'My   phone');
    assert.equal(readDevices(s)[0].name, 'My   phone');
    assert.equal((await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/rename`, { name: '   ' })).status, 400);
    assert.equal((await asPc(s, 'POST', `/api/devices/${OTHER_PHONE}/rename`, { name: 'x' })).status, 404);
    const long = (await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/rename`, { name: 'n'.repeat(200) })).json.name;
    assert.equal(long.length, 40);
  });

  test('bridge restart sends the restart event; 409 when no bridge is connected', async () => {
    const mark = control.events.length;
    assert.deepEqual((await asPc(s, 'POST', '/api/devices/bridge/restart', {})).json, { ok: true });
    await control.waitFor((e) => e.type === 'restart', { from: mark });
    control.close();
    await new Promise((r) => setTimeout(r, 300));
    const off = await asPc(s, 'POST', '/api/devices/bridge/restart', {});
    assert.equal(off.status, 409);
    assert.equal((await asPc(s, 'GET', '/api/devices')).json.bridge.online, false);
    assert.equal((await asPc(s, 'POST', '/api/devices/pair', {})).status, 409);
  });

  test('the list survives a server restart; an open code does not', async () => {
    control = await connectBridge(s);
    await asPc(s, 'POST', '/api/devices/pair', {});
    await asPhone(s, 'GET', '/api/whoami');
    const dataDir = s.dataDir;
    await s.stop(); // killed from outside: only changes written at once (not lastSeen) are on disk
    const s2 = await boot({ dataDir, noFixture: true });
    const list = (await asPc(s2, 'GET', '/api/devices')).json;
    assert.equal(list.devices.length, 1);
    assert.equal(list.devices[0].id, KNOWN_DEVICE);
    assert.equal(list.pairing, null);
    assert.equal(list.bridge, null);
    assert.equal((await asPhone(s2, 'GET', '/api/whoami')).status, 200);
  });
});

describe('file edits, failed writes, re-pairing, open requests, names', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pairPhone = async (s, id, name = 'P') => {
    const code = (await asPc(s, 'POST', '/api/devices/pair', {})).json.code;
    return asBridge(s, 'POST', '/api/bridge/pair', { endpointId: id, code, deviceName: name });
  };

  test('the periodic flush does not bring back a device removed by hand', async () => {
    const s = await boot({ env: { MC_DEVICES_FLUSH_MS: '250' } });
    await connectBridge(s);
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200); // lastSeen changes: the list is dirty
    fs.writeFileSync(devicesFile(s), '[]');
    await sleep(900); // several flushes
    assert.deepEqual(readDevices(s), []);
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 403);
  });

  test('an idle hand removal is revoked by the ping, with no request at all', async () => {
    const s = await boot({ env: { MC_DEVICES_PING_MS: '200' } });
    const control = await connectBridge(s);
    const mark = control.events.length;
    fs.writeFileSync(devicesFile(s), '[]');
    const ev = await control.waitFor((e) => e.type === 'revoke', { from: mark, ms: 3000 });
    assert.equal(ev.id, KNOWN_DEVICE);
  });

  test('a failed write: remove and pair answer 500 and change nothing; the flush retries later', async () => {
    const s = await boot({ env: { MC_TEST_DEVICES_WRITE: '1', MC_DEVICES_FLUSH_MS: '250' } });
    await connectBridge(s);
    const marker = `${devicesFile(s)}.fail-write`;
    fs.writeFileSync(marker, '');
    const before = fs.readFileSync(devicesFile(s), 'utf8');

    const rm = await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/remove`, {});
    assert.equal(rm.status, 500);
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200, 'still paired in memory');
    assert.equal(fs.readFileSync(devicesFile(s), 'utf8'), before, 'file untouched');

    const code = (await asPc(s, 'POST', '/api/devices/pair', {})).json.code;
    const bad = await asBridge(s, 'POST', '/api/bridge/pair', { endpointId: NEW_PHONE, code, deviceName: 'New' });
    assert.equal(bad.status, 500);
    assert.equal((await asPhone(s, 'GET', '/api/whoami', undefined, NEW_PHONE)).status, 403, 'not paired');
    assert.ok((await asPc(s, 'GET', '/api/devices')).json.pairing, 'the code stays open for a retry');

    // lastSeen is dirty and the flush keeps failing, then succeeds once the marker is gone.
    await sleep(700);
    assert.equal(readDevices(s)[0].lastSeen, null, 'nothing written while the rename fails');
    fs.unlinkSync(marker);
    const ok = await asBridge(s, 'POST', '/api/bridge/pair', { endpointId: NEW_PHONE, code, deviceName: 'New' });
    assert.equal(ok.json.ok, true);
    await sleep(600);
    assert.equal(readDevices(s).length, 2);
    assert.ok(readDevices(s).find((d) => d.id === KNOWN_DEVICE).lastSeen, 'the retried flush wrote lastSeen');
  });

  test('a phone that removed itself and paired again is not revoked by the delayed revoke', async () => {
    const s = await boot();
    const control = await connectBridge(s);
    assert.equal((await asPhone(s, 'POST', `/api/devices/${KNOWN_DEVICE}/remove`, {})).status, 200);
    const mark = control.events.length;
    assert.equal((await pairPhone(s, KNOWN_DEVICE, 'Again')).json.ok, true);
    await sleep(700); // well past the 300 ms delay
    assert.equal(control.events.slice(mark).find((e) => e.type === 'revoke'), undefined);
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200);
  });

  test('removing a device cuts its open requests on the bridge listener', async () => {
    const s = await boot();
    await connectBridge(s);
    const closed = new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: s.bridgePort, path: '/api/events', headers: { Host: `127.0.0.1:${s.bridgePort}`, ...bridgeHeaders(s) }, agent: false },
        (res) => {
          res.on('data', () => {});
          res.on('close', () => resolve('closed'));
          res.on('error', () => {});
        },
      );
      req.on('error', () => resolve('closed'));
      req.end();
    });
    await sleep(300);
    const other = await Promise.race([closed, sleep(100).then(() => 'open')]);
    assert.equal(other, 'open', 'the stream is running');
    assert.equal((await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/remove`, {})).status, 200);
    assert.equal(await Promise.race([closed, sleep(3000).then(() => 'still open')]), 'closed');
  });

  test('device names lose bidi controls and other format characters; the cap stays 40', async () => {
    const s = await boot();
    const r = await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/rename`, { name: 'a‮b⁦c⁩d‎e‏f​g­h i' });
    assert.equal(r.json.name, 'abcdefghi');
    const long = (await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/rename`, { name: '‮' + 'n'.repeat(100) })).json.name;
    assert.equal(long, 'n'.repeat(40));
    assert.equal((await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/rename`, { name: '‮‏' })).json.name, 'Phone');
  });
});

describe('who may call what', () => {
  let s;
  test('start', async () => {
    s = await boot();
  });

  test('bridge control and routes: 401 without a secret, 404 on the PC listener, 403 with a device header', async () => {
    const bare = await request({ port: s.bridgePort, host: `127.0.0.1:${s.bridgePort}`, path: '/api/bridge/control' });
    assert.equal(bare.status, 401);
    for (const [method, p] of [['GET', '/api/bridge/control'], ['POST', '/api/bridge/hello'], ['POST', '/api/bridge/pair'], ['POST', '/api/bridge/presence']]) {
      assert.equal((await asPc(s, method, p, {})).status, 404, `${method} ${p} on the PC`);
      assert.equal((await asPhone(s, method, p, {})).status, 403, `${method} ${p} with a device`);
    }
  });

  test('the device routes are not on the bridge program surface and the bridge routes need POST/GET as listed', async () => {
    assert.equal((await asBridge(s, 'GET', '/api/bridge/pair')).status, 404);
    assert.equal((await asBridge(s, 'POST', '/api/bridge/control', {})).status, 404);
  });

  test('a phone cannot pair, cancel, rename or restart the bridge (403 pc_only)', async () => {
    for (const [p, body] of [
      ['/api/devices/pair', {}],
      ['/api/devices/pair/cancel', {}],
      ['/api/devices/bridge/restart', {}],
      [`/api/devices/${KNOWN_DEVICE}/rename`, { name: 'x' }],
    ]) {
      const r = await asPhone(s, 'POST', p, body);
      assert.equal(r.status, 403, p);
      assert.deepEqual(r.json, { error: 'pc_only' }, p);
    }
  });

  test('a phone may list devices, but without the bridge block', async () => {
    const r = await asPhone(s, 'GET', '/api/devices');
    assert.equal(r.status, 200);
    assert.ok(!('bridge' in r.json));
    assert.equal(r.json.devices.length, 1);
    assert.ok(!r.text.includes(ENDPOINT));
  });

  test('POSTs need X-MC: 1 on the PC listener', async () => {
    const r = await localReq(s, { method: 'POST', path: '/api/devices/pair', body: {} });
    assert.equal(r.status, 403);
  });

  test('a phone removing a device is not refused by the policy', async () => {
    const r = await asPhone(s, 'POST', `/api/devices/${OTHER_PHONE}/remove`, {});
    assert.equal(r.status, 404, 'unknown id, but not 403 pc_only');
  });
});

describe('unreadable or half-written devices.json', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readEnv = { MC_TEST_DEVICES_READ: '1', MC_DEVICES_FLUSH_MS: '250' };
  const badFiles = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('devices.json.bad'));

  test('a busy file (EBUSY style read failure) keeps every device and writes nothing', async () => {
    const s = await boot({ env: readEnv });
    await connectBridge(s);
    const before = fs.readFileSync(devicesFile(s), 'utf8');
    const marker = `${devicesFile(s)}.fail-read`;
    fs.writeFileSync(marker, '');
    fs.utimesSync(devicesFile(s), new Date(), new Date(Date.now() + 5000)); // a new stamp, so the server looks again
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200, 'still paired');
    assert.equal((await asPc(s, 'GET', '/api/devices')).json.devices.length, 1);
    await sleep(800); // several flushes, with lastSeen dirty
    assert.equal(fs.readFileSync(devicesFile(s), 'utf8'), before, 'nothing written');
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200);
    fs.unlinkSync(marker);
    fs.writeFileSync(devicesFile(s), before); // a new stamp again
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200);
    assert.equal(readDevices(s).length, 1);
  });

  test('a file that cannot be read at startup starts empty, writes nothing, and recovers when readable', async () => {
    const dataDir = makeDataDir();
    seedFixture(dataDir);
    const file = path.join(dataDir, 'devices.json');
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(`${file}.fail-read`, '');
    const s = await boot({ dataDir, noFixture: true, env: readEnv });
    assert.equal((await asPc(s, 'GET', '/api/devices')).json.devices.length, 0, 'empty in memory');
    await sleep(800);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing written');
    assert.deepEqual(badFiles(dataDir), [], 'not set aside');
    // The bridge gets no list while the file cannot be read: an empty one would close every phone as removed.
    assert.equal((await asBridge(s, 'POST', '/api/bridge/hello', { endpointId: ENDPOINT, version: '0.0.1-test', startedAt: new Date().toISOString() })).status, 200);
    const control = controlStream(s);
    await control.ready;
    await control.expectNone((e) => e.type === 'devices');
    // Pairing would write the list, and writing now would drop the phones we cannot see: it is refused.
    const refused = await asPc(s, 'POST', '/api/devices/pair', {});
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, 'list_unreadable');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'still nothing written');
    fs.unlinkSync(`${file}.fail-read`);
    assert.equal((await asPc(s, 'GET', '/api/devices')).json.devices.length, 1, 'recovered by a good read');
    const list = await control.waitFor((e) => e.type === 'devices');
    assert.equal(list.ids.length, 1, 'the bridge gets the full list once it can be read');
    assert.equal((await asPc(s, 'POST', '/api/devices/pair', {})).status, 200, 'pairing works once the file reads');
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200);
  });

  test('a truncated file is retried once, then set aside; the devices stay and the owner can write them back', async () => {
    const s = await boot();
    const before = fs.readFileSync(devicesFile(s), 'utf8');
    fs.writeFileSync(devicesFile(s), '[{"id":"a1b2');
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200, 'first look: kept');
    assert.ok(fs.existsSync(devicesFile(s)), 'the retry has not given up yet');
    assert.deepEqual(badFiles(s.dataDir), []);
    // The file is completed before the second look: the retry succeeds and nothing is set aside.
    fs.writeFileSync(devicesFile(s), before);
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200);
    assert.deepEqual(badFiles(s.dataDir), []);
    // Truncated for good: the second look sets it aside, memory keeps the phone.
    fs.writeFileSync(devicesFile(s), '[{"id":"a1b2');
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200);
    assert.equal((await asPhone(s, 'GET', '/api/whoami')).status, 200);
    assert.equal(badFiles(s.dataDir).length, 1);
    assert.equal((await asPc(s, 'GET', '/api/devices')).json.devices.length, 1);
    const r = await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/rename`, { name: 'Kept' });
    assert.equal(r.status, 200);
    assert.deepEqual(readDevices(s).map((d) => d.id), [KNOWN_DEVICE]);
  });

  test('rename answers 500 and rolls back when the write fails; a missing body is a 400', async () => {
    const s = await boot({ env: { MC_TEST_DEVICES_WRITE: '1' } });
    const before = (await asPc(s, 'GET', '/api/devices')).json.devices[0].name;
    fs.writeFileSync(`${devicesFile(s)}.fail-write`, '');
    const r = await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/rename`, { name: 'Nope' });
    assert.equal(r.status, 500);
    assert.equal((await asPc(s, 'GET', '/api/devices')).json.devices[0].name, before);
    assert.equal((await asPc(s, 'POST', `/api/devices/${KNOWN_DEVICE}/rename`, null)).status, 400);
    assert.equal((await asBridge(s, 'POST', '/api/bridge/hello', null)).status, 400);
    assert.equal((await asBridge(s, 'POST', '/api/bridge/presence', null)).status, 400);
    assert.equal((await asBridge(s, 'POST', '/api/bridge/pair', null)).status, 400);
  });
});

describe('environment clamps', () => {
  test('clampMs pulls values into range and falls back on non-numbers', async () => {
    process.env.MC_DATA_DIR = makeDataDir();
    const { clampMs } = await import('../../server/services/devices.js');
    assert.equal(clampMs('5', 25000, 100, 25000), 100);
    assert.equal(clampMs('999999999', 25000, 100, 25000), 25000);
    assert.equal(clampMs('99999999', 60000, 100, 60000), 60000);
    assert.equal(clampMs('99999999', 600000, 100, 600000), 600000);
    assert.equal(clampMs('1500', 600000, 100, 600000), 1500);
    for (const bad of ['abc', '', 'NaN', 'Infinity', '-5', '0', undefined]) assert.equal(clampMs(bad, 777, 100, 1000), 777, String(bad));
  });

  test('the pairing TTL is clamped: a huge value is capped at 10 minutes, junk gives the default', async () => {
    for (const value of ['99999999999', 'junk']) {
      const s = await boot({ env: { MC_PAIR_TTL_MS: value } });
      await connectBridge(s);
      const p = (await asPc(s, 'POST', '/api/devices/pair', {})).json;
      const left = Date.parse(p.expiresAt) - Date.now();
      assert.ok(left > 590000 && left <= 600000, `${value}: ${left}`);
    }
  });

  test('the ping interval is clamped: a 1 ms setting still pings at most about every 100 ms', async () => {
    const s = await boot({ env: { MC_DEVICES_PING_MS: '1' } });
    const control = await connectBridge(s);
    const mark = control.events.length;
    await new Promise((r) => setTimeout(r, 1000));
    const pings = control.events.slice(mark).filter((e) => e.type === 'ping').length;
    assert.ok(pings >= 3 && pings <= 12, `pings ${pings}`);
  });
});
