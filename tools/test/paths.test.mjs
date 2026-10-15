// Tests for local paths opened from a conversation (server/routes/paths.js): what a path is, reading a text file for the
// viewer, and Show in Explorer (MC_NO_EXPLORER=1, so no window opens). Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { localReq, makeDataDir, removeTempDirs, seedFixture, startServer } from './harness.mjs';

let s, folder, outside;
const toStop = [];
const get = (p, base) => localReq(s, { path: `/api/path/${p}` + (base !== undefined ? `&base=${encodeURIComponent(base)}` : '') });

before(async () => {
  const dataDir = makeDataDir('mc-paths');
  folder = seedFixture(dataDir);
  fs.mkdirSync(path.join(folder, 'docs', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'docs', 'plan.md'), '# Plan\n\nStep one.\n');
  fs.writeFileSync(path.join(folder, 'app.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(folder, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  fs.writeFileSync(path.join(folder, '.env'), 'TOKEN=nope\n');
  fs.writeFileSync(path.join(folder, 'runner-secret.txt'), 'nope\n');
  // A second project with a README of its own, and a CONTRIBUTING.md only the fixture has.
  fs.writeFileSync(path.join(folder, 'README.md'), '# Fixture\n');
  fs.writeFileSync(path.join(folder, 'CONTRIBUTING.md'), '# How to help\n');
  const second = path.join(dataDir, 'second-project');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, 'README.md'), '# Second\n');
  const cat = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8'));
  cat.projects.push({ id: 'second', name: 'Second', folder: second, about: '', watch: [], checks: [], jobs: [] });
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(cat));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-outside-'));
  fs.writeFileSync(path.join(outside, 'private.md'), '# not yours\n');
  s = await startServer({ dataDir, bridge: false, env: { MC_NO_EXPLORER: '1' } });
  toStop.push(s);
});
after(async () => {
  for (const x of toStop) await x.stop();
  fs.rmSync(outside, { recursive: true, force: true });
  removeTempDirs();
});

describe('path info', () => {
  test('an absolute text file, a markdown file with a line number, a folder, a missing file', async () => {
    const js = (await get('info?p=' + encodeURIComponent(path.join(folder, 'app.js')))).json;
    assert.equal(js.kind, 'file');
    assert.equal(js.view, 'text');
    assert.equal(js.readable, true);
    const md = (await get('info?p=' + encodeURIComponent(path.join(folder, 'docs', 'plan.md') + ':3'))).json;
    assert.equal(md.view, 'markdown');
    assert.equal(md.path, path.join(folder, 'docs', 'plan.md'));
    assert.equal((await get('info?p=' + encodeURIComponent(path.join(folder, 'docs')))).json.kind, 'folder');
    assert.equal((await get('info?p=' + encodeURIComponent(path.join(folder, 'nope.md')))).json.kind, 'missing');
  });
  test('a relative path is taken from the base folder first', async () => {
    const r = (await get('info?p=' + encodeURIComponent('docs/plan.md:1'), folder)).json;
    assert.equal(r.path, path.join(folder, 'docs', 'plan.md'));
    assert.equal(r.view, 'markdown');
  });
  test('a relative path not in the base folder is looked for in the projects', async () => {
    const parent = path.dirname(folder); // a conversation in the folder that holds the projects
    const one = (await get('info?p=' + encodeURIComponent('CONTRIBUTING.md'), parent)).json;
    assert.equal(one.path, path.join(folder, 'CONTRIBUTING.md'));
    assert.equal(one.view, 'markdown');
    assert.equal((await get('info?p=' + encodeURIComponent('docs/plan.md'))).json.path, path.join(folder, 'docs', 'plan.md')); // no base at all
    const two = (await get('info?p=' + encodeURIComponent('README.md'), parent)).json;
    assert.equal(two.kind, 'choice');
    assert.deepEqual(two.choices.map((c) => c.project).sort(), ['Fixture', 'Second']);
    assert.equal((await get('info?p=' + encodeURIComponent('nowhere/at-all.md'), parent)).json.kind, 'missing');
    assert.equal((await get('info?p=' + encodeURIComponent('nowhere/at-all.md'))).status, 404); // no base and no project has it
    assert.equal((await get('info?p=' + encodeURIComponent('../escape.md'), folder)).status, 400);
  });
  test('network paths and odd characters are refused', async () => {
    for (const p of ['\\\\server\\share\\x.md', '//server/share/x.md', 'C:\\a\\b?.md', 'C:\\a\\<b>.md']) {
      assert.equal((await get('info?p=' + encodeURIComponent(p))).status, 400, p);
    }
  });
  test('binary files, secrets and files outside the project folders are not readable', async () => {
    const bin = (await get('info?p=' + encodeURIComponent(path.join(folder, 'blob.bin')))).json;
    assert.equal(bin.kind, 'file');
    assert.equal(bin.view, null);
    for (const f of [path.join(folder, '.env'), path.join(folder, 'runner-secret.txt'), path.join(outside, 'private.md')]) {
      assert.equal((await get('info?p=' + encodeURIComponent(f))).json.readable, false, f);
    }
  });
});

describe('path text', () => {
  test('a text file comes back whole', async () => {
    const r = await get('text?p=' + encodeURIComponent(path.join(folder, 'docs', 'plan.md')));
    assert.equal(r.status, 200);
    assert.equal(r.json.text, '# Plan\n\nStep one.\n');
  });
  test('outside, secret, binary, missing and folder are refused', async () => {
    assert.equal((await get('text?p=' + encodeURIComponent(path.join(outside, 'private.md')))).status, 403);
    assert.equal((await get('text?p=' + encodeURIComponent(path.join(folder, '.env')))).status, 403);
    assert.equal((await get('text?p=' + encodeURIComponent(path.join(folder, 'blob.bin')))).status, 415);
    assert.equal((await get('text?p=' + encodeURIComponent(path.join(folder, 'nope.md')))).status, 404);
    assert.equal((await get('text?p=' + encodeURIComponent(folder))).status, 415);
  });
});

describe('Show in Explorer', () => {
  test('a folder or a file that exists, and only with the Mission Control header', async () => {
    const post = (body, headers = { 'X-MC': '1' }) =>
      localReq(s, { method: 'POST', path: '/api/path/reveal', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const f = await post({ path: path.join(folder, 'docs') });
    assert.equal(f.status, 200);
    assert.equal(f.json.kind, 'folder');
    assert.equal((await post({ path: 'app.js', base: folder })).json.kind, 'file');
    assert.equal((await post({ path: path.join(folder, 'nope') })).status, 404);
    assert.notEqual((await post({ path: path.join(folder, 'docs') }, {})).status, 200);
  });
});
