// Tests for local paths in the markdown renderer (app/md.js): which paths become md-path links, and that nothing else
// changes. Run: node --test "tools/test/*.test.mjs"
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
  test('a [text](path) link to a relative or absolute path', () => {
    assert.deepEqual(paths(md('[the renderer](app/md.js) and [notes](D:/Notes/a.md)')), ['app/md.js', 'D:/Notes/a.md']);
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
