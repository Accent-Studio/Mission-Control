// Tests for what one PC does on the other through the link (services/pcLink.js): a picture of the other PC's conversation
// is fetched from it and kept, a message for later goes to a project of the other PC, and the other PC's conversations
// are renamed, archived or thrown away there.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { bridgeHeaders, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const call = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let H, W, work;
before(async () => {
  const home = makeDataDir('mc-parity-home');
  seedFixture(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ machineName: 'Home' }));
  H = await startServer({ dataDir: home, bridge: true, env: { MC_RUNNER_PORT: 'off' } });
  toStop.push(H);
  H.dataDir = home;
  work = makeDataDir('mc-parity-work');
  W = await startServer({ dataDir: work, bridge: false, env: { MC_RUNNER_PORT: 'off', MC_PC_LINK_TEST: JSON.stringify({ name: 'Home', url: `http://127.0.0.1:${H.bridgePort}`, headers: bridgeHeaders(H) }) } });
  toStop.push(W);
  await call(W, 'POST', '/api/pc-link/refresh', {});
});

describe('one PC on the other, through the link', () => {
  test("a picture of the other PC's conversation is fetched from it once, then kept", async () => {
    const name = crypto.createHash('sha1').update(PNG).digest('hex') + '.png';
    fs.mkdirSync(path.join(H.dataDir, 'imgcache'), { recursive: true });
    fs.writeFileSync(path.join(H.dataDir, 'imgcache', name), PNG);
    const r = await call(W, 'GET', '/api/imgcache/' + name);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^image\/png/);
    assert.ok(fs.existsSync(path.join(work, 'imgcache', name)));
    // one the other PC does not have either
    assert.equal((await call(W, 'GET', '/api/imgcache/' + 'a'.repeat(40) + '.png')).status, 404);
  });

  test('a message for later can go to a project of the other PC, and only to one it has', async () => {
    const at = new Date(Date.now() + 3600e3).toISOString();
    const ok = await call(W, 'POST', '/api/delayed', { kind: 'time', at, req: { prompt: 'hello there', projectId: 'm:link:Fixture', pc: 'fixture' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.projectId, 'm:link:Fixture');
    const bad = await call(W, 'POST', '/api/delayed', { kind: 'time', at, req: { prompt: 'hello', pc: 'nope' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Home has no project nope/);
    assert.equal((await call(W, 'POST', `/api/delayed/${ok.json.id}/cancel`, {})).status, 200);
  });

  test("the other PC's conversations are changed there", async () => {
    const id = crypto.randomUUID();
    // the call reaches Home, which does not know that conversation
    for (const what of ['meta', 'archive', 'delete']) {
      const r = await call(W, 'POST', `/api/pc/sessions/${id}/${what}`, what === 'meta' ? { title: 'New name' } : { archived: true });
      assert.ok([404, 400].includes(r.status), `${what}: ${r.status} ${r.text}`);
      assert.notEqual(r.json.error, 'Forbidden');
    }
    assert.equal((await call(W, 'POST', '/api/pc/sessions/not-an-id/archive', { archived: true })).status, 400);
  });
});
