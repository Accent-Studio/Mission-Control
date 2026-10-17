// Tests for the temp folder on the System page (server/routes/temp.js): the listing, deleting one item, and refusing
// everything else. Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { localReq, makeDataDir, removeTempDirs, seedFixture, startServer } from './harness.mjs';

let s, root, outside;
const post = (body) =>
  localReq(s, { method: 'POST', path: '/api/temp/delete', headers: { 'Content-Type': 'application/json', 'X-MC': '1' }, body: JSON.stringify(body) });
const del = (p) => post({ path: p, confirm: true });

before(async () => {
  const dataDir = makeDataDir('mc-temp');
  seedFixture(dataDir);
  root = path.join(makeDataDir('mc-temproot'), 'Temp');
  fs.mkdirSync(path.join(root, 'builds', 'app', 'debug'), { recursive: true });
  fs.writeFileSync(path.join(root, 'builds', 'app', 'debug', 'app.exe'), Buffer.alloc(3000));
  fs.mkdirSync(path.join(root, 'scratch', '2026-10-17-test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scratch', '2026-10-17-test', 'a.log'), 'hello');
  fs.writeFileSync(path.join(root, 'scratch', 'note.txt'), 'x');
  fs.writeFileSync(path.join(root, 'loose.txt'), 'xy');
  // A junction inside a group that points outside the temp folder: deleting it must not touch what it points at.
  outside = makeDataDir('mc-tempout');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(root, 'scratch', 'link'), 'junction');
  s = await startServer({ dataDir, bridge: false, env: { MC_TEMP_ROOT: root } });
});
after(async () => {
  if (s) await s.stop();
  removeTempDirs();
});

describe('Temp folder', () => {
  test('lists every group and item with its size, and counts a junction as nothing', async () => {
    const r = await localReq(s, { path: '/api/temp?fresh=1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.root, root);
    const names = r.json.groups.map((g) => g.name);
    assert.deepEqual(names, ['builds', 'scratch', '(loose files)']);
    const builds = r.json.groups[0];
    assert.equal(builds.items[0].name, 'app');
    assert.equal(builds.items[0].bytes, 3000);
    assert.equal(builds.items[0].files, 1);
    const link = r.json.groups[1].items.find((i) => i.name === 'link');
    assert.equal(link.isLink, true);
    assert.equal(link.bytes, 0);
    assert.equal(r.json.bytes, 3000 + 5 + 1 + 2);
  });

  test('refuses without confirm, and refuses the root, a group, a nested path and anything outside', async () => {
    assert.equal((await post({ path: path.join(root, 'scratch', 'note.txt') })).status, 400);
    for (const p of [root, path.join(root, 'builds'), path.join(root, 'builds', 'app', 'debug'), path.join(outside, 'keep.txt'),
      path.join(root, 'builds', '..', '..', 'x'), '', 42]) {
      const r = await del(p);
      assert.equal(r.status, 400, `should refuse ${p}`);
      assert.equal(r.json.ok, false);
    }
    assert.ok(fs.existsSync(path.join(root, 'builds', 'app', 'debug', 'app.exe')));
  });

  test('deletes an item folder, an item file and a loose file', async () => {
    for (const p of [path.join(root, 'builds', 'app'), path.join(root, 'scratch', 'note.txt'), path.join(root, 'loose.txt')]) {
      const r = await del(p);
      assert.equal(r.status, 200, `should delete ${p}`);
      assert.equal(fs.existsSync(p), false);
    }
    assert.ok(fs.existsSync(path.join(root, 'builds')), 'the group stays');
    assert.equal((await del(path.join(root, 'loose.txt'))).status, 404);
  });

  test('deleting a junction removes the link only', async () => {
    const r = await del(path.join(root, 'scratch', 'link'));
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(path.join(root, 'scratch', 'link')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  });

  test('the list without fresh comes back at once from the saved result, without the deleted items', async () => {
    const r = await localReq(s, { path: '/api/temp' });
    assert.equal(r.status, 200);
    const names = r.json.groups.flatMap((g) => g.items.map((i) => i.name));
    assert.ok(names.includes('2026-10-17-test'));
    for (const gone of ['app', 'note.txt', 'loose.txt', 'link']) assert.equal(names.includes(gone), false, `${gone} is still listed`);
  });

  test('a phone may read the list but not delete', async () => {
    const policy = await import('../../server/lib/remote-policy.js');
    assert.ok(policy.PC_ONLY.has('POST /api/temp/delete'));
    assert.equal(policy.REMOTE_OK.has('POST /api/temp/delete'), false);
  });
});
