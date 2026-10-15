// Tests for the shared unsent message box (GET/PUT /api/drafts): one draft per conversation or "new", kept by the server for
// every device, a number per write, an event so other pages take it, and an emptied draft kept empty (so others clear too).
// Run: node --test "tools/test/*.test.mjs"        (no npm packages; the server uses a free port and its own data folder)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const SID = '11111111-2222-4333-8444-555555555555';
const UP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const put = (s, body) => localReq(s, { method: 'PUT', path: '/api/drafts', headers: { 'X-MC': '1' }, body });
const get = async (s, key) => (await localReq(s, { path: '/api/drafts?key=' + encodeURIComponent(key) })).json;

describe('shared drafts', () => {
  test('saved per key, numbered, cleaned, kept through a restart', async () => {
    const dataDir = makeDataDir('mc-drafts');
    seedFixture(dataDir);
    let s = await startServer({ dataDir, bridge: false });
    toStop.push(s);

    assert.deepEqual(await get(s, 'new'), { key: 'new', text: '', atts: [], at: 0, rev: 0 });
    const a = await put(s, { key: SID, text: 'Hello from the phone', atts: [{ id: UP, name: 'shot.png', kind: 'image', size: 12 }, { id: 'not-an-upload', name: 'x' }], tab: 'tab1' });
    assert.equal(a.status, 200);
    const d = await get(s, SID);
    assert.equal(d.text, 'Hello from the phone');
    assert.deepEqual(d.atts, [{ id: UP, name: 'shot.png', kind: 'image', size: 12 }], 'only real upload ids are kept');
    assert.equal(d.rev, a.json.rev);

    const b = await put(s, { key: SID, text: '', atts: [] });
    assert.ok(b.json.rev > a.json.rev);
    const e = await get(s, SID);
    assert.equal(e.text, '');
    assert.equal(e.rev, b.json.rev, 'an emptied draft keeps its number, so other devices clear too');

    assert.equal((await put(s, { key: '../x', text: 'a' })).status, 400);
    assert.equal((await put(s, { key: SID, text: 5 })).status, 400);
    assert.equal((await localReq(s, { method: 'PUT', path: '/api/drafts', body: { key: SID, text: 'no header' } })).status, 403);

    // new conversations not sent yet: one key each, listed newest first with their project; empty ones are not listed
    const NK = 'n-99999999-2222-4333-8444-555555555555';
    assert.equal((await put(s, { key: NK, text: 'A new idea\nwith two lines', project: 'fixture' })).status, 200);
    assert.equal((await put(s, { key: 'n-88888888-2222-4333-8444-555555555555', text: '' })).status, 200);
    assert.equal((await put(s, { key: NK, text: 'x', project: 'bad id!' })).status, 400);
    const list = (await localReq(s, { path: '/api/drafts/new' })).json.drafts;
    assert.deepEqual(list.map((x) => [x.key, x.preview, x.project]), [[NK, 'A new idea with two lines', 'fixture']]);
    assert.equal((await get(s, NK)).project, 'fixture');
    assert.ok(!list.some((x) => x.key === SID), 'a conversation that exists is not a new draft');

    await put(s, { key: 'new', text: 'kept' });
    await s.stop();
    assert.ok(fs.existsSync(path.join(dataDir, 'drafts.json')));
    s = await startServer({ dataDir, bridge: false });
    toStop.push(s);
    assert.equal((await get(s, 'new')).text, 'kept');
  });
});
