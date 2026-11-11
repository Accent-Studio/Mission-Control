// Tests for the Console module's server side (routes/console.js, services/console.js, lib/serverLog.js) and for the
// "Paste in the console" mark on command blocks (app/md.js). The terminal runs the real shell of this machine: PowerShell
// on Windows, zsh on a Mac. Every command here only prints text or changes folder.
// Run: npm test (2 test files at a time)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { after, before, describe, test } from 'node:test';
import { ROOT, bridgeReq, localReq, makeDataDir, removeTempDirs, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
  removeTempDirs();
});

const post = (s, p, body = {}) => localReq(s, { method: 'POST', path: p, body, headers: { 'X-MC': '1' } });
const get = (s, p) => localReq(s, { path: p });

// Waits until the console is idle and its output matches `re`.
async function waitFor(s, id, re, ms = 15000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    last = (await get(s, `/api/console/${id}`)).json;
    if (last && !last.busy && re.test(last.text)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`console ${id} never matched ${re}:\n${JSON.stringify(last, null, 1)}`);
}

describe('console: a terminal on the PC', () => {
  let s, dir;
  before(async () => {
    const dataDir = makeDataDir('mc-console');
    seedFixture(dataDir);
    dir = path.join(dataDir, 'work dir');
    fs.mkdirSync(path.join(dir, 'inner'), { recursive: true });
    s = await startServer({ dataDir });
    toStop.push(s);
  });

  test('the shell is the one of this system', async () => {
    const r = await get(s, '/api/console');
    assert.equal(r.status, 200);
    if (process.platform === 'win32') assert.equal(r.json.shell.kind, 'powershell');
    else if (fs.existsSync('/bin/zsh')) assert.equal(r.json.shell.kind, 'zsh');
    assert.ok(r.json.shell.prompt);
  });

  test('a line typed in runs in the folder the console opened in, and its output comes back', async () => {
    const open = await post(s, '/api/console/test-one/open', { cwd: dir });
    assert.equal(open.status, 200);
    await waitFor(s, 'test-one', /^/);
    const r = await post(s, '/api/console/test-one/input', { line: "echo 'hello from the console'" });
    assert.equal(r.status, 200);
    const snap = await waitFor(s, 'test-one', /hello from the console\n/);
    assert.ok(snap.text.includes("echo 'hello from the console'"), 'the line is echoed after the prompt');
    assert.ok(!snap.text.includes('MCDONE'), 'the marker never shows');
    assert.equal(fs.realpathSync(snap.cwd), fs.realpathSync(dir));
  });

  test('cd stays for the next line, and the console knows the new folder', async () => {
    await post(s, '/api/console/test-one/input', { line: 'cd inner' });
    const snap = await waitFor(s, 'test-one', /cd inner/);
    assert.equal(fs.realpathSync(snap.cwd), fs.realpathSync(path.join(dir, 'inner')));
  });

  test('a pasted block of several lines runs as one', async () => {
    const block = process.platform === 'win32' ? "Write-Output 'first'\nWrite-Output 'second'" : "echo first\necho second";
    await post(s, '/api/console/test-one/input', { line: block });
    await waitFor(s, 'test-one', /first\nsecond\n/);
  });

  test('an error in a command still ends it (the console does not stay busy)', async () => {
    const bad = process.platform === 'win32' ? '1 +* 2' : 'if then fi';
    await post(s, '/api/console/test-one/input', { line: bad });
    await waitFor(s, 'test-one', new RegExp(bad.replace(/[*+]/g, '\\$&')));
    await post(s, '/api/console/test-one/input', { line: 'echo still-here' });
    await waitFor(s, 'test-one', /still-here\n/);
  });

  test('the stream carries the output', async () => {
    const got = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: s.port, path: '/api/console/stream', headers: { Host: `127.0.0.1:${s.port}` } }, (res) => {
        assert.equal(res.statusCode, 200);
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          if (buf.includes('"type":"hello"') && !buf.includes('streamed-text')) post(s, '/api/console/test-one/input', { line: 'echo streamed-text' }).catch(reject);
          if (/"type":"out"[^\n]*streamed-text\\n/.test(buf)) { req.destroy(); resolve(buf); }
        });
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
      setTimeout(() => { req.destroy(); reject(new Error('no output on the stream')); }, 15000);
    });
    assert.match(got, /"id":"test-one"/);
  });

  test('stop ends the running command and keeps the shell, its folder and its variables', async () => {
    const win = process.platform === 'win32';
    await post(s, '/api/console/test-one/input', { line: win ? "$kept = 'still-set'" : 'kept=still-set' });
    await waitFor(s, 'test-one', /still-set\n$/);
    const before = (await get(s, '/api/console/test-one')).json;
    // a program of its own (not a cmdlet or a loop inside the shell), so there is something to stop
    await post(s, '/api/console/test-one/input', { line: win ? 'ping -n 60 127.0.0.1' : 'sleep 60' });
    let r;
    for (let i = 0; i < 50; i++) {
      await new Promise((res) => setTimeout(res, 200));
      r = await post(s, '/api/console/test-one/stop');
      if (r.json && r.json.stopped) break;
    }
    assert.equal(r.status, 200);
    assert.ok(r.json.stopped >= 1, JSON.stringify(r.json));
    const snap = await waitFor(s, 'test-one', /\^C/, 10000);
    assert.equal(snap.startedAt, before.startedAt, 'the same shell');
    await post(s, '/api/console/test-one/input', { line: win ? 'Write-Output "var=$kept"' : 'echo "var=$kept"' });
    await waitFor(s, 'test-one', /var=still-set\n/);
  });

  test('stop on a loop inside the shell says so; stop with nothing running does nothing', async () => {
    assert.deepEqual((await post(s, '/api/console/test-one/stop')).json, { stopped: 0, idle: true });
    await post(s, '/api/console/test-one/input', { line: process.platform === 'win32' ? 'while ($true) { }' : 'while true; do :; done' });
    await new Promise((res) => setTimeout(res, 500));
    assert.deepEqual((await post(s, '/api/console/test-one/stop')).json, { stopped: 0, inShell: true });
    assert.equal((await post(s, '/api/console/no-such-one/stop')).status, 404);
  });

  test('restart ends the shell and opens a new one in the same folder', async () => {
    const before = (await get(s, '/api/console/test-one')).json;
    const r = await post(s, '/api/console/test-one/restart');
    assert.equal(r.status, 200);
    const snap = await waitFor(s, 'test-one', /Restarted/);
    assert.ok(snap.startedAt >= before.startedAt);
    assert.equal(fs.realpathSync(snap.cwd), fs.realpathSync(before.cwd));
    await post(s, '/api/console/test-one/input', { line: 'echo after-restart' });
    await waitFor(s, 'test-one', /after-restart\n/);
  });

  test('close ends it; a bad id or a missing line is refused', async () => {
    assert.equal((await post(s, '/api/console/test-one/close')).json.closed, true);
    assert.equal((await get(s, '/api/console/test-one')).status, 404);
    assert.equal((await post(s, '/api/console/x/input', { line: 'echo hi' })).status, 404); // too short to be an id
    assert.equal((await post(s, '/api/console/bad%20id!/input', { line: 'echo hi' })).status, 404);
    assert.equal((await post(s, '/api/console/test-two/input', {})).status, 400);
  });

  test('the server log has what the server printed', async () => {
    const r = await get(s, '/api/console/server-log');
    assert.equal(r.status, 200);
    assert.ok(r.json.lines.some((l) => /Mission Control on http/.test(l.text)), JSON.stringify(r.json.lines.slice(0, 5)));
    const last = r.json.lines[r.json.lines.length - 1].seq;
    assert.deepEqual((await get(s, `/api/console/server-log?since=${last}`)).json.lines, []);
  });

  test('a phone gets 403 pc_only for every console route, reads included, and nothing runs', async () => {
    const marker = path.join(s.dataDir, 'phone-ran-this');
    const cmd = process.platform === 'win32' ? `New-Item -ItemType File '${marker}'` : `touch '${marker}'`;
    const cases = [
      ['GET', '/api/console'], ['GET', '/api/console/stream'], ['GET', '/api/console/server-log'], ['GET', '/api/console/phone-one'],
      ['POST', '/api/console/phone-one/open', { cwd: dir }], ['POST', '/api/console/phone-one/input', { line: cmd }],
      ['POST', '/api/console/phone-one/stop', { force: true }], ['POST', '/api/console/phone-one/restart'], ['POST', '/api/console/phone-one/close'],
    ];
    for (const [method, p, body] of cases) {
      const r = await bridgeReq(s, { method, path: p, body: method === 'POST' ? body || {} : undefined, hdr: { post: method === 'POST' } });
      assert.equal(r.status, 403, `${method} ${p}`);
      assert.deepEqual(r.json, { error: 'pc_only' }, `${method} ${p}`);
    }
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!fs.existsSync(marker));
    assert.equal((await get(s, '/api/console/phone-one')).status, 404, 'no console was started for the phone');
  });
});

describe('console: never on the hub', () => {
  test('every console route answers 403 pc_only on a hub, even from its own listener', async () => {
    const s = await startServer({ dataDir: makeDataDir('mc-console-hub'), bridge: false, env: { MC_ROLE: 'hub' } });
    toStop.push(s);
    for (const p of ['/api/console', '/api/console/stream', '/api/console/server-log', '/api/console/hub-one']) {
      const r = await get(s, p);
      assert.equal(r.status, 403, p);
    }
    for (const p of ['/api/console/hub-one/open', '/api/console/hub-one/input', '/api/console/hub-one/stop', '/api/console/hub-one/restart', '/api/console/hub-one/close']) {
      const r = await post(s, p, { line: 'echo hi' });
      assert.equal(r.status, 403, p);
      assert.deepEqual(r.json, { error: 'pc_only' }, p);
    }
  });
});

describe('console: the policy table', () => {
  test('the console reads are refused for a device, other reads are not', async () => {
    const { remoteAllowed, PC_ONLY } = await import('../../server/lib/remote-policy.js');
    for (const p of ['/api/console', '/api/console/stream', '/api/console/server-log', '/api/console/:id']) {
      assert.equal(remoteAllowed('GET', { path: p }, { id: 'x' }), false, p);
      assert.equal(remoteAllowed('HEAD', { path: p }, { id: 'x', computer: true }), false, p);
    }
    assert.equal(remoteAllowed('GET', { path: '/api/projects' }, { id: 'x' }), true);
    for (const p of ['open', 'input', 'stop', 'restart', 'close']) assert.ok(PC_ONLY.has(`POST /api/console/:id/${p}`), p);
  });
});

describe('console: Paste in the console on command blocks (md.js)', () => {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'md.js'), 'utf8'), sandbox, { filename: 'md.js' });
  const md = sandbox.MC.md;

  test('powershell, ps1, shell and bash blocks get the button', () => {
    for (const lang of ['powershell', 'PowerShell', 'ps1', 'pwsh', 'shell', 'bash', 'sh', 'zsh']) {
      const h = md('```' + lang + '\ngit status\n```');
      assert.match(h, /class="md-code md-cmd"/, lang);
      assert.match(h, /class="md-paste"/, lang);
      assert.match(h, /<pre><code>git status<\/code><\/pre>/, lang);
    }
  });

  test('a block marked as a command gets it too', () => {
    assert.match(md('```text command\nnpm test\n```'), /md-paste/);
    assert.match(md('```command\nnpm test\n```'), /md-paste/);
  });

  test('other blocks do not', () => {
    for (const src of ['```js\nconst a = 1\n```', '```\nplain\n```', '```json\n{}\n```', '```text\ncommands are here\n```']) {
      assert.ok(!/md-paste|md-cmd/.test(md(src)), src);
    }
  });

  test('a block with no language whose lines are commands gets it', () => {
    for (const src of [
      '```\nnpx wrangler login\nnpx wrangler pages deploy /Users/me/site --project-name x\n```',
      '```\n# first sign in\ngit status\n\nnpm test\n```',
      '```\nNODE_ENV=production node server/index.js\n```',
      '```\ncurl -s https://example.com \\\n  -o out.html\n```',
      '```\nGet-ChildItem C:\\x\n```',
    ]) {
      const h = md(src);
      assert.match(h, /class="md-code md-cmd"/, src);
      assert.match(h, /class="md-paste"/, src);
    }
  });

  test('a block with no language that holds anything else does not', () => {
    for (const src of ['```\nnpm test\nthen open the page\n```', '```\nconst a = require(1)\n```', '```\n' + 'git status\n'.repeat(21) + '```', '```\n# only a comment\n```']) {
      assert.ok(!/md-paste|md-cmd/.test(md(src)), src);
    }
  });

  test('the button carries no text, so copying the block by hand gets the command only', () => {
    assert.match(md('```bash\nls\n```'), /<button type="button" class="md-paste"[^>]*><\/button>/);
  });
});
