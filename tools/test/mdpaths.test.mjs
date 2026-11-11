// Tests for local paths in the markdown renderer (app/md.js): which paths become md-path links, and that nothing else
// changes. Run: npm test (2 test files at a time)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, test } from 'node:test';
import { ROOT } from './harness.mjs';

const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'md.js'), 'utf8'), sandbox, { filename: 'md.js' });
const md = sandbox.MC.md;

// The data-path values of every md-path link, in order.
const paths = (h) => [...h.matchAll(/<a class="md-path" href="#" data-path="([^"]*)"/g)].map((m) => m[1]);

describe('md: local paths become links', () => {
  test('an absolute Windows path in the text, without the punctuation after it', () => {
    const h = md('See D:\\Dev\\App\\README.md, then C:/x/y.txt.');
    assert.deepEqual(paths(h), ['D:\\Dev\\App\\README.md', 'C:/x/y.txt']);
    assert.match(h, /README\.md<\/a>, then/);
  });
  test('backslashes in a path are not taken as markdown escapes', () => {
    assert.deepEqual(paths(md('Open D:\\Dev\\_notes\\draft_1.md now')), ['D:\\Dev\\_notes\\draft_1.md']);
    assert.deepEqual(paths(md('Open D:\\Dev\\.data\\config.json now')), ['D:\\Dev\\.data\\config.json']);
  });
  test('in a code span: absolute (with spaces), relative with a line, a folder, a known file name', () => {
    const h = md('`G:\\My Folder\\notes.md` and `server/config.js:12` and `app/` and `./x/y.ts` and `README.md` and `app.js:2`');
    assert.deepEqual(paths(h), ['G:\\My Folder\\notes.md', 'server/config.js:12', 'app/', './x/y.ts', 'README.md', 'app.js:2']);
    assert.match(h, /<a class="md-path"[^>]*><code class="md-ic">server\/config\.js:12<\/code><\/a>/);
  });
  test('in a code span: a relative path whose later parts hold spaces', () => {
    const h = md('`01-Acme/Map - Acme systems.html` and `My Notes/a.md` and `docs/Old plans/` and `node tools/x.js` and `app/x.js and app/y.js`');
    assert.deepEqual(paths(h), ['01-Acme/Map - Acme systems.html', 'docs/Old plans/']);
  });
  test('a [text](path) link to a relative or absolute path', () => {
    assert.deepEqual(paths(md('[the renderer](app/md.js) and [notes](D:/Notes/a.md)')), ['app/md.js', 'D:/Notes/a.md']);
  });
});

describe('md: macOS paths become links', () => {
  test('an absolute path under the usual local folders, in the text, without the punctuation after it', () => {
    const h = md('See /Users/me/Dev/App/README.md, then /Volumes/Disk/x.txt. Also /private/tmp/a.log and /tmp/b.md:12 and ~/notes/c.md.');
    assert.deepEqual(paths(h), ['/Users/me/Dev/App/README.md', '/Volumes/Disk/x.txt', '/private/tmp/a.log', '/tmp/b.md:12', '~/notes/c.md']);
    assert.match(h, /README\.md<\/a>, then/);
  });
  test('in a code span (with spaces) and as a [text](path) link', () => {
    assert.deepEqual(paths(md('`/Users/me/My Folder/notes.md` and [plan](/Users/me/Dev/docs/PLAN.md)')), ['/Users/me/My Folder/notes.md', '/Users/me/Dev/docs/PLAN.md']);
  });
  test('routes, other root folders and paths inside a web address or a word stay as they were', () => {
    const h = md('GET /api/projects and /usr/bin/node, `/api/path/info`, https://a.example/Users/x, a/Users/b, x~/y and ~~/tmp/z~~');
    assert.deepEqual(paths(h), []);
    assert.match(h, /<a href="https:\/\/a\.example\/Users\/x" target="_blank"/);
  });
  test('long runs stay fast', () => {
    for (const src of ['/Users/'.repeat(20000), '/Users/' + 'a'.repeat(50000), 'x /tmp/a '.repeat(5000), '~/'.repeat(30000)]) {
      const t0 = process.hrtime.bigint();
      assert.equal(typeof md(src), 'string');
      assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 300, 'slow');
    }
  });
});

describe('md: addresses in a code span become web links', () => {
  const hrefs = (h) => [...h.matchAll(/<a href="([^"]*)" target="_blank"/g)].map((m) => m[1]);
  test('a web address, a local server without http, a www address', () => {
    const h = md('`https://a.example/x` `localhost:3000` `127.0.0.1:1700/api` `192.168.1.20` `10.0.0.5:8080` `www.a.example`');
    assert.deepEqual(hrefs(h), ['https://a.example/x', 'http://localhost:3000', 'http://127.0.0.1:1700/api', 'http://192.168.1.20', 'http://10.0.0.5:8080', 'https://www.a.example']);
    assert.deepEqual(paths(h), []);
  });
  test('versions, times and other code stay as they were', () => {
    const h = md('`1.2.3` `8.8.8.8` `10:30` `npm test` `javascript:alert(1)`');
    assert.deepEqual(hrefs(h), []);
  });
});

describe('md: what stays as it was', () => {
  test('words with a slash, commands, times, a lone drive letter and web addresses', () => {
    const h = md('`and/or` `npm test` `1/2` 10:30 the C: drive, and `https://a.example/x.md`, https://a.example/C:/x');
    assert.deepEqual(paths(h), []);
    assert.match(h, /<a href="https:\/\/a\.example\/C:\/x" target="_blank"/);
  });
  test('a path is escaped inside the attribute and the text', () => {
    const h = md('D:\\a\\"><img src=x onerror=1>.md');
    assert.ok(!/<img/i.test(h));
    for (const p of paths(h)) assert.ok(!/[<>"]/.test(p));
  });
  test('escapes still work outside paths', () => {
    assert.match(md('a \\*star\\* here'), /a \*star\* here/);
  });
  test('long runs stay fast', () => {
    for (const src of ['C:\\'.repeat(20000), 'C:/' + 'a'.repeat(50000), '`' + 'a/'.repeat(20000) + '`', 'x C:\\a '.repeat(5000)]) {
      const t0 = process.hrtime.bigint();
      assert.equal(typeof md(src), 'string');
      assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 300, 'slow');
    }
  });
});
