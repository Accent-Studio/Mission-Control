// Tests for the project's display name and subtitle in PUT /api/projects/:id/settings: one line of text each, the folder keeps
// its own name, and an emptied subtitle stays empty.
// Run: node --test "tools/test/*.test.mjs"        (no npm packages; the server uses a free port and its own data folder)
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

const put = (s, body) => localReq(s, { method: 'PUT', path: '/api/projects/fixture/settings', headers: { 'X-MC': '1' }, body });
const get = async (s) => (await localReq(s, { path: '/api/projects/fixture' })).json;

describe('project name and subtitle', () => {
  test('saved, cleaned, checked', async () => {
    const dataDir = makeDataDir('mc-pname');
    const folder = seedFixture(dataDir);
    const s = await startServer({ dataDir, bridge: false });
    toStop.push(s);

    assert.equal((await put(s, { name: '  Sky   Cab ', about: 'A game.' })).status, 200);
    let p = await get(s);
    assert.equal(p.name, 'Sky Cab');
    assert.equal(p.about, 'A game.');
    assert.equal(p.folder, folder);

    assert.equal((await put(s, { name: '   ' })).status, 400);
    assert.equal((await put(s, { name: 'a<b>' })).status, 400);
    assert.equal((await put(s, { about: 'x'.repeat(161) })).status, 400);
    assert.equal((await put(s, { name: 5 })).status, 400);

    assert.equal((await put(s, { about: '' })).status, 200);
    p = await get(s);
    assert.equal(p.about, '');
    assert.equal(p.name, 'Sky Cab');
  });
});
