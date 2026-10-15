// Tests for the phone bridge listener (second port), the bridge secret, device identity and the remote policy.
// Run: node --test "tools/test/*.test.mjs"        (no npm packages; every server uses free ports and its own data folder)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import {
  KNOWN_DEVICE, ROOT, bridgeReq, localReq, makeDataDir, portClosed, removeTempDirs, request, seedFixture, startServer,
} from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
  removeTempDirs();
});

async function boot(opts = {}) {
  const dataDir = opts.dataDir || makeDataDir();
  if (!opts.noFixture) seedFixture(dataDir);
  const s = await startServer({ dataDir, ...opts });
  toStop.push(s);
  return s;
}

describe('bridge listener: auth, Host, Origin, X-MC', () => {
  let s;
  before(async () => {
    s = await boot();
  });

  test('no secret gives a bare 401 and closes the connection', async () => {
    const r = await request({ port: s.bridgePort, host: `127.0.0.1:${s.bridgePort}`, path: '/api/whoami' });
    assert.equal(r.status, 401);
    assert.equal(r.text, '');
    assert.equal(r.headers.connection, 'close');
  });

  test('wrong secrets give 401 (different length, same length, duplicated header, empty)', async () => {
    const real = fs.readFileSync(s.secretFile, 'utf8').trim();
    const sameLength = (real[0] === 'a' ? 'b' : 'a') + real.slice(1);
    for (const secret of ['nope', sameLength, real + 'x', `${real}, ${real}`, '']) {
      const r = await request({ port: s.bridgePort, host: `127.0.0.1:${s.bridgePort}`, path: '/api/whoami', headers: { 'X-MC-Bridge': secret } });
      assert.equal(r.status, 401, `secret ${JSON.stringify(secret.slice(0, 8))}`);
    }
  });

  test('right secret with a wrong Host is refused before anything else', async () => {
    for (const host of [`localhost:${s.bridgePort}`, `127.0.0.1:${s.port}`, 'evil.example', `127.0.0.1:${s.bridgePort}.evil.example`]) {
      const r = await bridgeReq(s, { path: '/api/whoami', host });
      assert.equal(r.status, 403, `Host ${JSON.stringify(host)}`);
      assert.equal(r.text, 'Forbidden host');
    }
  });

  test('right secret, no device: only the bridge own routes, everything else is 403 device_required', async () => {
    const none = { device: null };
    for (const p of ['/api/whoami', '/api/projects', '/', '/index.html', '/api/events', '/api/bridgeish', '/api/bridge/../projects', '/api/bridge/%2e%2e/projects']) {
      const r = await bridgeReq(s, { path: p, hdr: none });
      assert.equal(r.status, 403, p);
      assert.deepEqual(r.json, { error: 'device_required' }, p);
    }
    const post = await bridgeReq(s, { method: 'POST', path: '/api/chat', body: {}, hdr: { ...none, post: true } });
    assert.equal(post.status, 403);
    assert.deepEqual(post.json, { error: 'device_required' });
    // The bridge namespace itself is let through (404 until a route exists, never 403).
    assert.equal((await bridgeReq(s, { path: '/api/bridge/nothing-here', hdr: none })).status, 404);
  });

  test('right secret with an unknown, malformed or empty device is 403 device_revoked', async () => {
    for (const device of ['f'.repeat(64), 'has space', 'x'.repeat(200), '../../etc', '']) {
      const r = await bridgeReq(s, { path: '/api/whoami', hdr: { device } });
      assert.equal(r.status, 403, `device ${JSON.stringify(device.slice(0, 10))}`);
      assert.deepEqual(r.json, { error: 'device_revoked' });
    }
  });

  test('right secret with a known device: normal answers, req.mcDevice set, secret not leaked', async () => {
    const r = await bridgeReq(s, { path: '/api/whoami' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { remote: true, device: { id: KNOWN_DEVICE, name: 'Test Phone' } });
    assert.ok(!r.text.includes(fs.readFileSync(s.secretFile, 'utf8').trim()));
    const page = await bridgeReq(s, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    const data = await bridgeReq(s, { path: '/api/projects' });
    assert.equal(data.status, 200);
  });

  test('a device removed from devices.json stops working on the next request', async () => {
    const file = `${s.dataDir}\\devices.json`;
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '[]');
    try {
      const r = await bridgeReq(s, { path: '/api/whoami' });
      assert.equal(r.status, 403);
      assert.deepEqual(r.json, { error: 'device_revoked' });
    } finally {
      fs.writeFileSync(file, before);
    }
    assert.equal((await bridgeReq(s, { path: '/api/whoami' })).status, 200);
  });

  test('non-GET needs X-MC: 1 on the bridge listener too', async () => {
    const r = await bridgeReq(s, { method: 'POST', path: '/api/runs/none/stop', body: {} });
    assert.equal(r.status, 403);
    const ok = await bridgeReq(s, { method: 'POST', path: '/api/runs/none/stop', body: {}, hdr: { post: true } });
    assert.notEqual(ok.status, 403);
  });

  test('Origin on the bridge listener: only its own address, or none', async () => {
    const post = (origin) => bridgeReq(s, { method: 'POST', path: '/api/runs/none/stop', body: {}, hdr: { post: true, origin } });
    assert.notEqual((await post(`http://127.0.0.1:${s.bridgePort}`)).status, 403);
    assert.equal((await post(`http://127.0.0.1:${s.port}`)).status, 403, 'the PC listener origin is not valid here');
    assert.equal((await post(`http://localhost:${s.bridgePort}`)).status, 403);
    assert.equal((await post('http://evil.example')).status, 403);
    assert.equal((await post('null')).status, 403);
  });

  test('HEAD works for a device (no body) and is refused without one', async () => {
    const ok = await bridgeReq(s, { method: 'HEAD', path: '/api/whoami' });
    assert.equal(ok.status, 200);
    assert.equal(ok.text, '');
    const page = await bridgeReq(s, { method: 'HEAD', path: '/' });
    assert.equal(page.status, 200);
    assert.equal(page.text, '');
    assert.equal((await bridgeReq(s, { method: 'HEAD', path: '/api/whoami', hdr: { device: null } })).status, 403);
    assert.equal((await request({ port: s.bridgePort, method: 'HEAD', host: `127.0.0.1:${s.bridgePort}`, path: '/api/whoami' })).status, 401);
  });

  test('an oversized body through the bridge is 413 and the server keeps answering', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) });
    const r = await bridgeReq(s, { method: 'POST', path: '/api/sessions/order', body: big, hdr: { post: true } }).catch(() => ({ status: 0 }));
    assert.ok(r.status === 413 || r.status === 0, `status ${r.status}`); // a reset connection is also a refusal
    assert.equal((await bridgeReq(s, { path: '/api/whoami' })).status, 200);
  });

  test('the secret works on GET only through the header (no query or cookie fallback)', async () => {
    const real = fs.readFileSync(s.secretFile, 'utf8').trim();
    const r = await request({ port: s.bridgePort, host: `127.0.0.1:${s.bridgePort}`, path: `/api/whoami?x-mc-bridge=${real}`, headers: { Cookie: `x-mc-bridge=${real}` } });
    assert.equal(r.status, 401);
  });
});

describe('local listener behaves as before and ignores forged bridge headers', () => {
  let s;
  before(async () => {
    s = await boot();
  });

  test('forged X-MC-Device and X-MC-Bridge are stripped: still remote false', async () => {
    const real = fs.readFileSync(s.secretFile, 'utf8').trim();
    const r = await localReq(s, { path: '/api/whoami', headers: { 'X-MC-Device': KNOWN_DEVICE, 'X-MC-Bridge': real } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { remote: false, device: null });
  });

  test('a forged device does not put the policy on a local caller', async () => {
    // A phone would get 403 pc_only here. Unsupervised servers answer 409 to a restart (and nothing restarts).
    const r = await localReq(s, {
      method: 'POST', path: '/api/server/restart', body: { confirm: true },
      headers: { 'X-MC': '1', 'X-MC-Device': KNOWN_DEVICE },
    });
    assert.equal(r.status, 409);
  });

  test('Host and X-MC rules are unchanged', async () => {
    assert.equal((await localReq(s, { path: '/api/whoami', host: `127.0.0.1:${s.bridgePort}` })).status, 403);
    assert.equal((await localReq(s, { path: '/api/whoami', host: 'evil.example' })).status, 403);
    for (const host of [`localhost:${s.port}`, `[::1]:${s.port}`]) assert.equal((await localReq(s, { path: '/api/whoami', host })).status, 200);
    assert.equal((await localReq(s, { method: 'POST', path: '/api/runs/none/stop', body: {} })).status, 403);
    const ok = (origin) => localReq(s, { method: 'POST', path: '/api/runs/none/stop', body: {}, headers: { 'X-MC': '1', ...(origin ? { Origin: origin } : {}) } });
    assert.notEqual((await ok()).status, 403);
    assert.notEqual((await ok(`http://127.0.0.1:${s.port}`)).status, 403);
    assert.equal((await ok(`http://127.0.0.1:${s.bridgePort}`)).status, 403);
    assert.equal((await ok('http://evil.example')).status, 403);
  });

  test('the secret file is never served', async () => {
    for (const p of ['/bridge/secret', '/.data/bridge/secret', '/../.data/bridge/secret']) {
      const r = await localReq(s, { path: p });
      assert.ok(r.status === 404 || r.status === 403, p);
      assert.ok(!/^[0-9a-f]{64}$/.test(r.text.trim()));
    }
  });
});

describe('/api/bridge isolation', () => {
  let s;
  before(async () => {
    s = await boot();
  });

  test('404 on the local listener, GET and POST', async () => {
    assert.equal((await localReq(s, { path: '/api/bridge/control' })).status, 404);
    assert.equal((await localReq(s, { path: '/api/bridge' })).status, 404);
    assert.equal((await localReq(s, { method: 'POST', path: '/api/bridge/hello', body: {}, headers: { 'X-MC': '1' } })).status, 404);
  });

  test('on the bridge listener a request that carries a device gets 403, GET or POST', async () => {
    assert.equal((await bridgeReq(s, { path: '/api/bridge/control' })).status, 403);
    assert.equal((await bridgeReq(s, { path: '/api/bridge' })).status, 403);
    assert.equal((await bridgeReq(s, { method: 'POST', path: '/api/bridge/pair', body: {}, hdr: { post: true } })).status, 403);
  });

  test('without a secret the bridge namespace is 401, with a secret and no device it is the bridge program (404 until a route exists)', async () => {
    const bare = await request({ port: s.bridgePort, host: `127.0.0.1:${s.bridgePort}`, path: '/api/bridge/control' });
    assert.equal(bare.status, 401);
    const prog = await bridgeReq(s, { path: '/api/bridge/nothing-here', hdr: { device: null } });
    assert.equal(prog.status, 404);
  });
});

describe('remote policy', () => {
  let s;
  before(async () => {
    s = await boot();
  });

  test('startup walk: every state-changing route in the real table is classified', async () => {
    assert.match(s.out.text, /Mission Control on http/);
    assert.doesNotMatch(s.out.text, /\[policy\]/, s.out.text);
    // Also read the real route files in a child with its own data folder, so a silent log cannot hide a gap.
    const dataDir = makeDataDir('mc-routes');
    const script = [
      "import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';",
      "const dir = process.argv[1]; const out = [];",
      "for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {",
      "  const m = await import(pathToFileURL(path.join(dir, f)).href);",
      "  for (const r of m.routes || []) out.push({ method: r.method, path: r.path });",
      "}",
      "console.log('ROUTES ' + JSON.stringify(out)); process.exit(0);",
    ].join('\n');
    const text = execFileSync(process.execPath, ['--input-type=module', '-e', script, path.join(ROOT, 'server', 'routes')], {
      encoding: 'utf8', cwd: ROOT, env: { ...process.env, MC_DATA_DIR: dataDir, MC_PORT: '0', MC_VOICE_CONTROL_FILE: path.join(dataDir, 'none.json') }, // never the real BlitzVoice link
    });
    const table = JSON.parse(text.split('\n').find((l) => l.startsWith('ROUTES ')).slice(7));
    assert.ok(table.length > 20, `only ${table.length} routes found`);
    const { unclassifiedRoutes, REMOTE_OK, PC_ONLY } = await import('../../server/lib/remote-policy.js');
    assert.deepEqual(unclassifiedRoutes(table), []);
    // The other way round: a policy entry that no route has any more is stale (device routes live in another file).
    const have = new Set(table.map((r) => `${r.method.toUpperCase()} ${r.path}`));
    const stale = [...REMOTE_OK, ...PC_ONLY].filter((k) => !have.has(k) && !k.includes('/api/devices/'));
    assert.deepEqual(stale, []);
  });

  test('the walk really fails when a route is missing (unit)', async () => {
    const { unclassifiedRoutes, REMOTE_OK, PC_ONLY } = await import('../../server/lib/remote-policy.js');
    const missing = unclassifiedRoutes([
      { method: 'GET', path: '/api/anything' },
      { method: 'HEAD', path: '/api/anything' },
      { method: 'POST', path: '/api/chat' },
      { method: 'POST', path: '/api/processes/:pid/kill' },
      { method: 'POST', path: '/api/brand-new-thing' },
      { method: 'delete', path: '/api/other-new-thing' },
    ]);
    assert.deepEqual(missing, ['POST /api/brand-new-thing', 'DELETE /api/other-new-thing']);
    for (const key of REMOTE_OK) assert.ok(!PC_ONLY.has(key), `${key} is in both lists`);
  });

  test('every PC-only and phone-ok entry is a real shape: METHOD /api/...', async () => {
    const { REMOTE_OK, PC_ONLY } = await import('../../server/lib/remote-policy.js');
    for (const key of [...REMOTE_OK, ...PC_ONLY]) assert.match(key, /^(POST|PUT|DELETE|PATCH) \/api\/\S+$/, key);
  });

  const pcOnly = (method, p, body = {}) => bridgeReq(s, { method, path: p, body, hdr: { post: true } });

  test('PC-only routes answer 403 pc_only for a device', async () => {
    const cases = [
      ['POST', '/api/processes/4294967290/kill', { confirm: true }],
      ['POST', '/api/server/restart', { confirm: true }],
      ['PUT', '/api/projects/fixture/settings', { jobs: [] }],
      ['POST', '/api/projects/fixture/checks/dev/launch', {}],
      ['POST', '/api/voice/start', {}],
      ['POST', '/api/voice/stop', {}],
      ['POST', '/api/voice/cancel', {}],
      ['POST', '/api/voice/wake', {}],
      ['POST', '/api/voice/focus', {}],
      ['POST', '/api/voice/speak', { text: 'hi' }],
      ['POST', '/api/voice/speak/stop', {}],
    ];
    for (const [m, p, b] of cases) {
      const r = await pcOnly(m, p, b);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.deepEqual(r.json, { error: 'pc_only' }, `${m} ${p}`);
    }
  });

  test('an unknown state-changing route is not reachable for a device either (404, never run)', async () => {
    assert.equal((await pcOnly('POST', '/api/not-a-route')).status, 404);
  });

  test('phone-ok routes are not refused by the policy', async () => {
    const cases = [
      ['POST', '/api/chat', { runId: 'none', prompt: 'x' }],
      ['POST', '/api/runs/none/permission', {}],
      ['POST', '/api/runs/none/stop', {}],
      ['POST', '/api/uploads', {}],
      ['POST', '/api/sessions/order', {}],
      ['POST', '/api/schedules/none/run', {}],
      ['PUT', '/api/voice/prefs', {}],
    ];
    for (const [m, p, b] of cases) {
      const r = await pcOnly(m, p, b);
      assert.notEqual(r.status, 403, `${m} ${p} -> ${r.status} ${r.text}`);
    }
  });

  test('jobs: an outward job is refused for a phone, the same job on the PC asks for confirmation', async () => {
    const remote = await pcOnly('POST', '/api/projects/fixture/jobs/ship/run', {});
    assert.equal(remote.status, 403);
    assert.equal(remote.json.error, 'pc_only');
    // Typing the right confirmation from a phone changes nothing.
    const typed = await pcOnly('POST', '/api/projects/fixture/jobs/ship/run', { confirm: 'Fixture' });
    assert.equal(typed.status, 403);
    const local = await localReq(s, { method: 'POST', path: '/api/projects/fixture/jobs/ship/run', body: {}, headers: { 'X-MC': '1' } });
    assert.equal(local.status, 409);
    assert.equal(local.json.needsConfirm, true);
  });

  test('jobs: outward kinds and the built-in git push are refused for a phone even with the flag off', async () => {
    for (const id of ['kind-push-github', 'kind-publish-website', 'kind-release', 'kind-deploy', 'kind-sync', 'gitpush']) {
      const r = await pcOnly('POST', `/api/projects/fixture/jobs/${id}/run`, { confirm: 'Fixture' });
      assert.equal(r.status, 403, id);
      assert.equal(r.json.error, 'pc_only', id);
    }
  });

  test('jobs: a non-outward job passes the gate for a phone (it then fails on its missing script, nothing runs)', async () => {
    const r = await pcOnly('POST', '/api/projects/fixture/jobs/build/run', {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /cannot be run/);
  });

  test('device remove is allowed for a paired device (policy only; the route itself arrives with the devices service)', async () => {
    const { remoteAllowed } = await import('../../server/lib/remote-policy.js');
    assert.equal(remoteAllowed('POST', { path: '/api/devices/:id/remove' }), true);
    for (const p of ['/api/devices/pair', '/api/devices/pair/cancel', '/api/devices/bridge/restart', '/api/devices/:id/rename']) {
      assert.equal(remoteAllowed('POST', { path: p }), false, p);
    }
    assert.equal(remoteAllowed('GET', { path: '/api/anything' }), true);
    assert.equal(remoteAllowed('HEAD', { path: '/api/anything' }), true);
    assert.equal(remoteAllowed('POST', { path: '/api/never-heard-of-it' }), false);
  });
});

describe('bridge secret file', () => {
  test('created on first start, not rewritten on the second, readable only by the current user', async () => {
    const dataDir = makeDataDir();
    seedFixture(dataDir);
    const a = await boot({ dataDir });
    const first = fs.readFileSync(a.secretFile, 'utf8');
    assert.match(first.trim(), /^[0-9a-f]{64}$/);
    await a.stop();
    const b = await boot({ dataDir });
    assert.equal(fs.readFileSync(b.secretFile, 'utf8'), first);
    if (process.platform === 'win32') {
      for (const target of [b.secretFile, `${dataDir}\\bridge`]) {
        const text = execFileSync('icacls', [target], { encoding: 'utf8' });
        const entries = text.split(/\r?\n/).filter((l) => /:\(/.test(l));
        assert.equal(entries.length, 1, `${target}\n${text}`);
        assert.ok(entries[0].toLowerCase().includes(`\\${String(process.env.USERNAME).toLowerCase()}:`), entries[0]);
      }
    }
  });

  test('a damaged secret file keeps the bridge listener off and the dashboard on', async () => {
    const dataDir = makeDataDir();
    seedFixture(dataDir);
    fs.mkdirSync(`${dataDir}\\bridge`, { recursive: true });
    fs.writeFileSync(`${dataDir}\\bridge\\secret`, 'not a secret');
    const s = await boot({ dataDir, wantBridgeLine: false });
    assert.match(s.out.text, /not 64 hex characters/);
    assert.equal((await localReq(s, { path: '/api/whoami' })).status, 200);
    assert.equal(await portClosed(s.bridgePort), true);
    assert.equal(fs.readFileSync(`${dataDir}\\bridge\\secret`, 'utf8'), 'not a secret', 'never overwritten');
  });

  test('icacls failure on a new secret: the file is deleted, the bridge stays off, the log has no secret', async () => {
    const dataDir = makeDataDir();
    seedFixture(dataDir);
    const s = await boot({ dataDir, wantBridgeLine: false, env: { MC_TEST_ICACLS: 'fail' } });
    assert.match(s.out.text, /could not restrict/);
    assert.equal((await localReq(s, { path: '/api/whoami' })).status, 200);
    assert.equal(await portClosed(s.bridgePort), true);
    assert.ok(!fs.existsSync(s.secretFile), 'no secret file may be left behind');
    assert.doesNotMatch(s.out.text, /[0-9a-f]{64}/i);
  });

  test('an existing secret whose ACL is too wide and cannot be fixed keeps the bridge off (and is left in place)', async () => {
    const dataDir = makeDataDir();
    seedFixture(dataDir);
    const a = await boot({ dataDir });
    const first = fs.readFileSync(a.secretFile, 'utf8');
    await a.stop();
    const b = await boot({ dataDir, wantBridgeLine: false, env: { MC_TEST_ICACLS: 'widen' } });
    assert.match(b.out.text, /not private|could not be fixed/);
    assert.equal(await portClosed(b.bridgePort), true);
    assert.equal(fs.readFileSync(b.secretFile, 'utf8'), first);
    assert.ok(!b.out.text.includes(first.trim()));
  });

  test('MC_BRIDGE_PORT=off starts only the local listener and creates no secret', async () => {
    const dataDir = makeDataDir();
    seedFixture(dataDir);
    const s = await boot({ dataDir, bridge: false });
    assert.equal((await localReq(s, { path: '/api/whoami' })).status, 200);
    assert.ok(!fs.existsSync(`${dataDir}\\bridge\\secret`));
  });

  test('a taken bridge port is logged and the dashboard still starts', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    try {
      const s = await boot({ bridge: blocker.address().port, wantBridgeLine: false });
      const started = Date.now();
      while (!/listener on .* failed/.test(s.out.text) && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 50));
      assert.match(s.out.text, /listener on 127\.0\.0\.1:\d+ failed/);
      assert.equal((await localReq(s, { path: '/api/whoami' })).status, 200);
    } finally {
      blocker.close();
    }
  });

  test('after a taken port, a restart on a free port brings the bridge up with the same secret', async () => {
    const dataDir = makeDataDir();
    seedFixture(dataDir);
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    let first;
    try {
      const a = await boot({ dataDir, bridge: blocker.address().port, wantBridgeLine: false });
      const started = Date.now();
      while (!/listener on .* failed/.test(a.out.text) && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 50));
      assert.match(a.out.text, /failed/);
      first = fs.readFileSync(a.secretFile, 'utf8');
      await a.stop();
    } finally {
      blocker.close();
    }
    const b = await boot({ dataDir });
    assert.equal(fs.readFileSync(b.secretFile, 'utf8'), first);
    assert.equal((await bridgeReq(b, { path: '/api/whoami' })).status, 200);
  });
});

describe('restart', () => {
  test('exit 75 closes both listeners and drops open connections', async () => {
    const s = await boot({ env: { MC_SUPERVISED: '1' } });
    // An open event stream on each listener must be cut by the restart.
    const sse = (port, headers) =>
      new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          const lines = [`GET /api/events HTTP/1.1`, `Host: 127.0.0.1:${port}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''];
          sock.write(lines.join('\r\n'));
        });
        const done = { opened: false, closed: new Promise((r) => sock.once('close', r)) };
        sock.on('data', (d) => {
          if (!done.opened && /200 OK/.test(String(d))) {
            done.opened = true;
            resolve(done);
          }
        });
        sock.on('error', () => {});
        setTimeout(() => reject(new Error('no event stream')), 5000);
      });
    const local = await sse(s.port, {});
    const bridge = await sse(s.bridgePort, { 'X-MC-Bridge': fs.readFileSync(s.secretFile, 'utf8').trim(), 'X-MC-Device': KNOWN_DEVICE });
    const r = await localReq(s, { method: 'POST', path: '/api/server/restart', body: { confirm: true }, headers: { 'X-MC': '1' } });
    assert.equal(r.status, 200);
    const code = await Promise.race([s.exited, new Promise((res) => setTimeout(() => res('timeout'), 8000))]);
    assert.equal(code, 75);
    await Promise.all([local.closed, bridge.closed]);
    assert.equal(await portClosed(s.port), true);
    assert.equal(await portClosed(s.bridgePort), true);
  });
});
