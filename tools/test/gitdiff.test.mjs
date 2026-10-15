// Tests for GET /api/projects/:id/git/diff, the file changes the project page reader shows: one file at a time, from a
// commit or not committed yet, and never a secret, a glob match, a whole folder, a raw object or a path through a link.
// Run: node --test "tools/test/*.test.mjs"        (no npm packages; the server uses a free port and its own data folder)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

describe('file changes for the reader', () => {
  test('one file only, literal paths, commits only, no secrets', async () => {
    const dataDir = makeDataDir('mc-gitdiff');
    seedFixture(dataDir);
    const repo = path.join(dataDir, 'fixture-project');
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', windowsHide: true });
    g('init', '-q');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'Test');
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(repo, 'sub', 'b.txt'), 'bee\n');
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    g('commit', '-q', '-am', 'second');
    const head = g('rev-parse', 'HEAD').trim();
    const envBlob = g('rev-parse', 'HEAD:.env').trim();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n'); // not committed
    fs.writeFileSync(path.join(repo, 'new.txt'), 'fresh\n'); // not tracked
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'hidden\n'); // ignored

    const s = await startServer({ dataDir, bridge: false });
    toStop.push(s);
    const diff = (q) => localReq(s, { path: '/api/projects/fixture/git/diff?' + q });

    const c = await diff(`path=a.txt&commit=${head}`);
    assert.equal(c.status, 200, c.text);
    assert.match(c.json.diff, /\+two/);
    const u = await diff('path=a.txt');
    assert.equal(u.status, 200);
    assert.match(u.json.diff, /\+three/);
    const n = await diff('path=new.txt');
    assert.equal(n.status, 200);
    assert.match(n.json.diff, /\+fresh/);

    // refused: secrets, globs, folders, raw objects, ignored files, climbing out, options
    for (const q of [
      'path=.env', 'path=.e*', 'path=%5B.%5Denv', 'path=*nv', 'path=*', `path=*&commit=${head}`,
      'path=sub', `path=sub&commit=${head}`, `path=a.txt&commit=${envBlob}`, 'path=ignored.txt',
      'path=../x.txt', 'path=-p', 'path=:/a.txt', 'path=a.txt&commit=--help', 'path=.git/config',
    ]) {
      const r = await diff(q);
      assert.equal(r.status, 400, q + ' gave ' + r.status + ' ' + r.text.slice(0, 120));
      assert.ok(!/SECRET|hidden/.test(r.text), q);
    }

    // a tracked folder swapped for a junction to a folder outside the project: never read through it
    const outside = path.join(dataDir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'b.txt'), 'OUTSIDE_SECRET\n');
    fs.rmSync(path.join(repo, 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, 'sub'), 'junction');
    const j = await diff('path=sub/b.txt');
    assert.equal(j.status, 400, j.text.slice(0, 120));
    assert.ok(!/OUTSIDE_SECRET/.test(j.text));
    // the commit view reads git's own copy, never the folder
    const jc = await diff(`path=sub/b.txt&commit=${g('rev-list', '--max-parents=0', 'HEAD').trim()}`);
    assert.ok(!/OUTSIDE_SECRET/.test(jc.text));
  });
});
