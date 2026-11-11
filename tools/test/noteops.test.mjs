// Tests for the Documents panel's file actions in a notes folder (server/lib/noteOps.js, POST /api/projects/:id/notes-op):
// a new note or folder, rename, move (drag and drop, also to another notes folder of this PC), duplicate, delete to the
// trash. The project folder stays read only, and no path leaves its notes folder.
// Run: npm test (2 test files at a time)        (no npm packages; the server uses a free port and its own data folder)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { checkName, prefixBody, unprefixAnswer } from '../../server/lib/noteOps.js';
import { localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

describe('note file action helpers', () => {
  test('names', () => {
    assert.equal(checkName('  Plan   for  Monday ').name, 'Plan for Monday');
    for (const bad of ['', 'a/b', 'a\\b', '.hidden', 'trail.', 'CON', 'com1.md', 'what?', 'x'.repeat(121)]) assert.ok(checkName(bad).error, bad);
  });
  test('a notes folder inside a vault: paths go under it and come back', () => {
    assert.deepEqual(prefixBody({ op: 'note', dir: '', name: 'A' }, '01-Acme'), { op: 'note', dir: '01-Acme', name: 'A' });
    assert.deepEqual(prefixBody({ op: 'move', paths: ['a.md', ''], to: 'Sub' }, '01-Acme'), { op: 'move', paths: ['01-Acme/a.md', ''], to: '01-Acme/Sub' });
    assert.deepEqual(prefixBody({ op: 'rename', path: '', name: 'x' }, '01-Acme').path, ''); // the notes folder itself stays refused
    assert.deepEqual(unprefixAnswer({ path: '01-Acme/Sub/a.md', changed: ['x'] }, '01-Acme'), { path: 'Sub/a.md' });
  });
});

describe('note file actions', () => {
  test('make, rename, move, duplicate and delete in a notes folder; the project folder stays read only', async () => {
    const dataDir = makeDataDir('mc-noteops');
    const folder = seedFixture(dataDir);
    fs.writeFileSync(path.join(folder, 'README.md'), '# Fixture\n');
    const vault = path.join(dataDir, 'vault');
    const notes = path.join(vault, 'Projects', 'Fixture');
    const extra = path.join(vault, 'Extra');
    fs.mkdirSync(path.join(notes, 'Sub'), { recursive: true });
    fs.mkdirSync(extra, { recursive: true });
    fs.writeFileSync(path.join(notes, 'Hub.md'), '# Hub\n');
    fs.writeFileSync(path.join(notes, 'Sub', 'Deep.md'), 'deep\n');
    fs.writeFileSync(path.join(vault, 'Projects', 'Other.md'), 'not this project\n');
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ notesProjectDir: 'Projects', notesFolders: { fixture: ['Extra'] } }));
    const s = await startServer({ dataDir, bridge: false, env: { MC_NOTES_ROOT: vault, MC_RECYCLE: 'move' } });
    toStop.push(s);
    const op = (body) => localReq(s, { method: 'POST', path: '/api/projects/fixture/notes-op', headers: { 'X-MC': '1' }, body });
    const lib = async () => (await localReq(s, { path: '/api/projects/fixture/library?kind=docs' })).json;
    const L0 = await lib();
    const nr = L0.roots.find((r) => r.label === 'Notes: Projects/Fixture').id;
    const xr = L0.roots.find((r) => r.label === 'Notes: Extra').id;
    assert.equal(L0.roots.find((r) => r.id === 'p').readOnly, true);

    // a new note gets .md; a second one with the same name is refused; a new folder shows in the list while empty
    let r = await op({ root: nr, op: 'note', dir: 'Sub', name: 'Ideas' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.path, 'Sub/Ideas.md');
    assert.equal(r.json.changed, undefined);
    assert.equal(fs.readFileSync(path.join(notes, 'Sub', 'Ideas.md'), 'utf8'), '');
    assert.equal((await op({ root: nr, op: 'note', dir: 'Sub', name: 'Ideas' })).status, 409);
    r = await op({ root: nr, op: 'folder', dir: '', name: 'Empty' });
    assert.equal(r.json.path, 'Empty');
    assert.ok((await lib()).dirs.some((d) => d.root === nr && d.path === 'Empty'));

    // rename keeps the extension; a case change alone works
    r = await op({ root: nr, op: 'rename', path: 'Sub/Ideas.md', name: 'Plans' });
    assert.equal(r.json.path, 'Sub/Plans.md');
    r = await op({ root: nr, op: 'rename', path: 'Sub/Plans.md', name: 'plans' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.path, 'Sub/plans.md');
    assert.equal((await op({ root: nr, op: 'rename', path: 'Sub/plans.md', name: 'Deep' })).status, 409);

    // move: into a folder, not into itself, and to the other notes folder of this PC
    r = await op({ root: nr, op: 'move', paths: ['Hub.md'], to: 'Empty' });
    assert.deepEqual(r.json.paths, ['Empty/Hub.md']);
    assert.ok(fs.existsSync(path.join(notes, 'Empty', 'Hub.md')));
    assert.equal((await op({ root: nr, op: 'move', paths: ['Empty'], to: 'Empty' })).status, 400);
    r = await op({ root: nr, op: 'move', paths: ['Sub/plans.md'], to: '', toRoot: xr });
    assert.deepEqual(r.json.paths, ['plans.md']);
    assert.ok(fs.existsSync(path.join(extra, 'plans.md')));
    assert.equal((await op({ root: nr, op: 'move', paths: ['Sub/Deep.md'], to: '', toRoot: 'p' })).status, 400);

    // duplicate a note and a folder
    r = await op({ root: nr, op: 'duplicate', path: 'Empty/Hub.md' });
    assert.equal(r.json.path, 'Empty/Hub copy.md');
    r = await op({ root: nr, op: 'duplicate', path: 'Empty/Hub.md' });
    assert.equal(r.json.path, 'Empty/Hub copy 2.md');
    r = await op({ root: nr, op: 'duplicate', path: 'Sub' });
    assert.equal(r.json.path, 'Sub copy');
    assert.equal(fs.readFileSync(path.join(notes, 'Sub copy', 'Deep.md'), 'utf8'), 'deep\n');

    // delete goes to the trash, not away
    r = await op({ root: nr, op: 'delete', paths: ['Sub copy', 'Empty/Hub copy 2.md'] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.paths, ['Sub copy', 'Empty/Hub copy 2.md']);
    assert.ok(!fs.existsSync(path.join(notes, 'Sub copy')));
    const trash = path.join(dataDir, 'trash');
    assert.ok(fs.readdirSync(trash).length >= 1);

    // nothing leaves the notes folder, and the project folder is never changed
    for (const bad of [
      { root: nr, op: 'rename', path: '../Other.md', name: 'x' },
      { root: nr, op: 'delete', paths: [''] },
      { root: nr, op: 'note', dir: '..', name: 'x' },
      { root: nr, op: 'move', paths: ['Sub/Deep.md'], to: '../..' },
      { root: nr, op: 'note', dir: '', name: '../x' },
      { root: nr, op: 'folder', dir: '', name: '.git' },
    ]) assert.ok([400, 403].includes((await op(bad)).status), JSON.stringify(bad));
    assert.ok(fs.existsSync(path.join(vault, 'Projects', 'Other.md')));
    assert.equal((await op({ root: 'p', op: 'note', dir: '', name: 'x' })).status, 403);
    assert.equal((await op({ root: 'p', op: 'delete', paths: ['README.md'] })).status, 403);
    assert.ok(fs.existsSync(path.join(folder, 'README.md')));
    assert.equal((await localReq(s, { method: 'POST', path: '/api/projects/fixture/notes-op', body: { root: nr, op: 'folder', dir: '', name: 'y' } })).status, 403); // no X-MC header
  });
});
