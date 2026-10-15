// Tests for GET /api/projects/:id/library and the file route's `root`: the Docs and Screenshots tabs list a project's text files
// and pictures as trees, with its notes folders as extra roots, read only.
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

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('project library', () => {
  test('docs and pictures from the project and its notes folder, skipped folders left out, files served by root', async () => {
    const dataDir = makeDataDir('mc-library');
    const folder = seedFixture(dataDir);
    const put = (rel, data) => { const f = path.join(folder, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
    put('README.md', '# Fixture\n');
    put('docs/notes/plan.txt', 'plan\n');
    put('CMakeLists.txt', 'not a doc\n');
    put('node_modules/pkg/README.md', 'dependency\n');
    put('.snaps/one.png', PNG);
    put('references/images/ref.jpg', PNG);
    put('assets/texture.png', PNG); // app parts, not screenshots
    put('.data/imgcache/x.png', PNG);
    const vault = path.join(dataDir, 'vault');
    fs.mkdirSync(path.join(vault, 'Projects', 'Fixture', 'Sub'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Projects', 'Fixture', 'Hub.md'), '# Hub\n');
    fs.writeFileSync(path.join(vault, 'Projects', 'Fixture', 'Sub', 'shot.png'), PNG);
    fs.writeFileSync(path.join(vault, 'Projects', 'Other.md'), 'not this project\n');
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ notesProjectDir: 'Projects' }));

    const s = await startServer({ dataDir, bridge: false, env: { MC_NOTES_ROOT: vault } });
    toStop.push(s);

    const docs = (await localReq(s, { path: '/api/projects/fixture/library?kind=docs' })).json;
    assert.deepEqual(docs.roots.map((r) => r.id), ['p', 'n0']);
    assert.equal(docs.roots[1].label, 'Notes: Projects/Fixture');
    const dp = docs.files.map((f) => f.root + ':' + f.path).sort();
    assert.deepEqual(dp, ['n0:Hub.md', 'p:README.md', 'p:docs/notes/plan.txt']);

    const imgs = (await localReq(s, { path: '/api/projects/fixture/library?kind=images' })).json;
    const ip = imgs.files.map((f) => f.root + ':' + f.path).sort();
    assert.deepEqual(ip, ['n0:Sub/shot.png', 'p:.snaps/one.png', 'p:references/images/ref.jpg']);

    const hub = await localReq(s, { path: '/api/projects/fixture/file?root=n0&path=Hub.md' });
    assert.equal(hub.status, 200);
    assert.equal(hub.text, '# Hub\n');
    assert.equal((await localReq(s, { path: '/api/projects/fixture/file?root=n0&path=../Other.md' })).status, 403);
    assert.equal((await localReq(s, { path: '/api/projects/fixture/file?root=n7&path=Hub.md' })).status, 404);
    assert.equal((await localReq(s, { path: '/api/projects/fixture/file?path=README.md' })).status, 200);
    assert.equal((await localReq(s, { path: '/api/projects/nope/library?kind=docs' })).status, 404);
  });

  test('no notes root: only the project folder', async () => {
    const dataDir = makeDataDir('mc-library-off');
    seedFixture(dataDir);
    const s = await startServer({ dataDir, bridge: false, env: { MC_NOTES_ROOT: 'off' } });
    toStop.push(s);
    const docs = (await localReq(s, { path: '/api/projects/fixture/library?kind=docs' })).json;
    assert.deepEqual(docs.roots.map((r) => r.id), ['p']);
  });
});
