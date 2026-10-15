// The runner (server/runner/index.js): the program that owns the Claude processes so they survive a restart of the server.
// Runs against the FAKE Claude CLI in tools/fakeclaude. Nothing here starts a real Claude conversation. The runner and the
// servers of these tests live on ports 488xx (MC_TEST_PORTS), with their own data folders; every process started here is
// stopped by its exact process id when the tests end.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ROOT, freePort, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';
import { handshakeProof, makeNonce } from '../../server/lib/privateSecret.js';

const FAKE_DIR = path.join(ROOT, 'tools', 'fakeclaude');
const FAKE_PATH = FAKE_DIR + path.delimiter + process.env.PATH;
process.env.PATH = FAKE_PATH; // so resolveClaude() below finds the fake, like the runner and the servers started here do
const { resolveClaude } = await import('../../server/lib/claudeExe.js');
const claude = await resolveClaude();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
const fakePids = new Set();

function killPid(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // already gone
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

after(async () => {
  for (const s of toStop.reverse()) await s.stop().catch(() => {});
  for (const pid of fakePids) if (alive(pid)) killPid(pid);
});

async function waitFor(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(30);
  }
}

// ---- A runner of our own ----

async function startRunner({ dataDir, port, env = {} }) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'runner', 'index.js')], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // MC_DISCOVERY_ROOTS: the folders the runner starts processes in; the data folder is the test's own project area.
    env: { ...process.env, PATH: FAKE_PATH, MC_DATA_DIR: dataDir, MC_RUNNER_PORT: String(port), MC_DISCOVERY_ROOTS: dataDir, ...env },
  });
  const out = { text: '' };
  child.stdout.on('data', (d) => (out.text += d));
  child.stderr.on('data', (d) => (out.text += d));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const t0 = Date.now();
  while (!/Mission Control runner on/.test(out.text)) {
    if (child.exitCode !== null) return { child, pid: child.pid, port, out, exited, dataDir, secretFile: path.join(dataDir, 'runner', 'secret'), failed: true, stop: async () => {} };
    if (Date.now() - t0 > 15000) {
      child.kill();
      throw new Error('runner did not start:\n' + out.text);
    }
    await sleep(40);
  }
  const r = {
    child,
    pid: child.pid,
    port,
    out,
    exited,
    dataDir,
    secretFile: path.join(dataDir, 'runner', 'secret'),
    secret: () => fs.readFileSync(path.join(dataDir, 'runner', 'secret'), 'utf8').trim(),
    // Ends the runner and the processes it holds (by the runner's own shutdown request), then by its pid if needed.
    async stop() {
      if (child.exitCode === null) {
        try {
          const c = await rawClient(port);
          await handshake(c, r.secret());
          await c.next((m) => m.op === 'hello', 3000);
          c.send({ op: 'shutdown', kill: true });
          await Promise.race([exited, sleep(3000)]);
          c.close();
        } catch {
          // fall through to the pid
        }
      }
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
  toStop.push(r);
  return r;
}

// ---- A raw client for the protocol ----

function rawClient(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setEncoding('utf8');
    const msgs = [];
    const waiters = [];
    let buf = '';
    let closed = false;
    const closedP = new Promise((res) => sock.once('close', () => ((closed = true), res())));
    sock.on('error', () => {});
    sock.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        msgs.push(m);
        for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.res(m));
      }
    });
    sock.once('connect', () =>
      resolve({
        msgs,
        send: (o) => sock.write(JSON.stringify(o) + '\n'),
        sendRaw: (t) => sock.write(t),
        next: (pred, ms = 5000) =>
          new Promise((res, rej) => {
            const hit = msgs.find(pred);
            if (hit) return res(hit);
            const w = { pred, res };
            waiters.push(w);
            setTimeout(() => {
              if (waiters.includes(w)) (waiters.splice(waiters.indexOf(w), 1), rej(new Error('no matching message in time')));
            }, ms);
          }),
        closed: () => closed,
        whenClosed: (ms = 5000) => Promise.race([closedP.then(() => true), sleep(ms).then(() => false)]),
        close: () => sock.destroy(),
      }),
    );
    sock.once('error', reject);
  });
}

// The client side of the handshake: waits for the runner's nonce, answers with a nonce of its own and the keyed proof. Returns
// what was sent, so a test can replay it. opts.proto and opts.role change what is sent (for the refusal tests).
async function handshake(c, secret, { proto = 2, role = 'client' } = {}) {
  const challenge = await c.next((m) => m.op === 'challenge');
  const nonce = makeNonce();
  const hello = { op: 'hello', proto, nonce, proof: handshakeProof(secret, role, challenge.nonce, nonce) };
  c.send(hello);
  return { challenge, nonce, hello };
}

async function login(runner) {
  const c = await rawClient(runner.port);
  const h = await handshake(c, runner.secret());
  const hello = await c.next((m) => m.op === 'hello');
  // The runner proves itself with its own role in the hash, over the nonces the other way round.
  assert.equal(hello.proof, handshakeProof(runner.secret(), 'runner', h.nonce, h.challenge.nonce));
  return { c, hello, nonce: h.nonce, challenge: h.challenge };
}

// Everything a socket received except the runner's opening challenge.
const answers = (c) => c.msgs.filter((m) => m.op !== 'challenge');

// A valid start request the way runs.js builds it.
function spawnReq(dataDir, extra = {}) {
  return {
    op: 'spawn',
    runId: crypto.randomUUID(),
    cmd: claude.cmd,
    args: [...claude.pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--permission-prompt-tool', 'stdio'],
    cwd: dataDir,
    meta: { startedAtMs: Date.now(), note: 'test' },
    ...extra,
  };
}

const userLine = (text) => JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

// ---- The protocol ----

const OPEN_DRIVE = path.parse(ROOT).root.slice(0, 1).toUpperCase();

describe('the runner protocol', () => {
  let dataDir;
  let runner;
  const get = async () => {
    if (!runner) {
      dataDir = makeDataDir('mc-runner');
      // The drive this checkout is on is an open drive (openDrives in .data/config.json), unless it is C:, which the test
      // below needs as a closed drive.
      if (OPEN_DRIVE !== 'C') fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ openDrives: [OPEN_DRIVE + ':'] }));
      const port = await freePort();
      runner = await startRunner({ dataDir, port, env: { MC_RUNNER_AUTH_MS: '700', FAKE_STEP_MS: '40', FAKE_LOG: path.join(dataDir, 'fake.log') } });
    }
    return runner;
  };

  test('it creates its secret (64 hex characters) and listens on the loopback address only', async () => {
    const r = await get();
    assert.match(r.secret(), /^[0-9a-f]{64}$/);
    // Reachable on 127.0.0.1 ...
    const c = await rawClient(r.port);
    c.close();
    // ... and a connection to the same port on another local address is not accepted (it is bound to 127.0.0.1 only).
    const other = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.2', port: r.port });
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
    });
    assert.equal(other, false);
  });

  test('without the right answer to the challenge nothing is answered and the connection is closed', async () => {
    const r = await get();
    const secret = r.secret();
    // a request before hello
    let c = await rawClient(r.port);
    c.send({ op: 'list' });
    assert.equal(await c.whenClosed(), true);
    assert.equal(answers(c).length, 0, 'not a word back');
    // a proof made with a wrong secret
    c = await rawClient(r.port);
    await handshake(c, 'f'.repeat(64));
    assert.equal(await c.whenClosed(), true);
    assert.equal(answers(c).length, 0);
    // the old way, the secret itself in the hello: not accepted (and no longer needed)
    c = await rawClient(r.port);
    c.send({ op: 'hello', secret, proto: 2 });
    assert.equal(await c.whenClosed(), true);
    assert.equal(answers(c).length, 0);
    // the proof of the other role (a runner's proof is not a client's proof)
    c = await rawClient(r.port);
    await handshake(c, secret, { role: 'runner' });
    assert.equal(await c.whenClosed(), true);
    assert.equal(answers(c).length, 0);
    // hello with a missing or malformed nonce or proof
    for (const hello of [
      { op: 'hello', proto: 2 },
      { op: 'hello', proto: 2, nonce: 12345, proof: 'x' },
      { op: 'hello', proto: 2, nonce: 'ab', proof: 'cd' },
      { op: 'hello', proto: 2, nonce: makeNonce(), proof: { a: 1 } },
      { op: 'hello', proto: 2, nonce: makeNonce(), proof: '' },
      { op: 'hello', proto: 2, nonce: makeNonce(), proof: 'z'.repeat(64) },
    ]) {
      c = await rawClient(r.port);
      c.send(hello);
      assert.equal(await c.whenClosed(), true);
      assert.equal(answers(c).length, 0);
    }
    // garbage
    c = await rawClient(r.port);
    c.sendRaw('this is not json\n');
    assert.equal(await c.whenClosed(), true);
    assert.equal(answers(c).length, 0);
    // a line longer than any hello needs
    c = await rawClient(r.port);
    c.sendRaw('x'.repeat(10000));
    assert.equal(await c.whenClosed(), true);
    // a connection that says nothing is closed by the runner after the authentication time
    c = await rawClient(r.port);
    assert.equal(await c.whenClosed(3000), true);
    // and the real secret still works afterwards
    const { c: ok, hello } = await login(r);
    assert.equal(hello.ok, true);
    ok.close();
  });

  test('every connection gets its own nonce first; a valid answer cannot be replayed on another connection', async () => {
    const r = await get();
    const a = await rawClient(r.port);
    const ha = await handshake(a, r.secret());
    const helloA = await a.next((m) => m.op === 'hello');
    assert.equal(helloA.ok, true);
    assert.equal(ha.challenge.proto, 2);
    assert.match(ha.challenge.nonce, /^[0-9a-f]{64}$/);
    // the very same answer on a new connection (another nonce from the runner)
    const b = await rawClient(r.port);
    const challengeB = await b.next((m) => m.op === 'challenge');
    assert.notEqual(challengeB.nonce, ha.challenge.nonce);
    b.send(ha.hello);
    assert.equal(await b.whenClosed(), true);
    assert.equal(answers(b).length, 0, 'a replayed answer gets no word back');
    // an answer made for one of two open connections is no good on the other
    const c1 = await rawClient(r.port);
    const c2 = await rawClient(r.port);
    const ch1 = await c1.next((m) => m.op === 'challenge');
    const ch2 = await c2.next((m) => m.op === 'challenge');
    assert.notEqual(ch1.nonce, ch2.nonce);
    const nonce = makeNonce();
    c2.send({ op: 'hello', proto: 2, nonce, proof: handshakeProof(r.secret(), 'client', ch1.nonce, nonce) });
    assert.equal(await c2.whenClosed(), true);
    assert.equal(answers(c2).length, 0);
    // the connection that answered first is still the server's, and the replay did not take its place
    a.send({ op: 'ping' });
    await a.next((m) => m.op === 'pong');
    a.close();
    c1.close();
  });

  test('hello with the right answer shows the runner and its runs (after proving itself); a wrong protocol number gets no answer', async () => {
    const r = await get();
    const { c, hello } = await login(r); // login() checks the runner proof
    assert.equal(hello.proto, 2);
    assert.equal(hello.pid, r.pid);
    assert.deepEqual(hello.runs, []);
    assert.ok(hello.stamp > 0);
    assert.ok(!JSON.stringify(c.msgs).includes(r.secret()), 'the secret is not in what the runner sent');
    c.close();
    const c2 = await rawClient(r.port);
    await handshake(c2, r.secret(), { proto: 99 });
    assert.equal(await c2.whenClosed(), true);
    assert.equal(answers(c2).length, 0);
  });

  test('sockets that never answer cannot keep the real server out, and are dropped', async () => {
    const r = await get();
    // far more idle sockets than the runner keeps waiting at once
    const idle = await Promise.all(Array.from({ length: 160 }, () => rawClient(r.port)));
    // the real server connects at once and is let in
    const { c, hello } = await login(r);
    assert.equal(hello.ok, true);
    await sleep(150);
    assert.ok(idle.filter((x) => !x.closed()).length <= 64, 'the runner does not keep more than 64 waiting');
    // and the authenticated connection works while the flood goes on
    const more = await Promise.all(Array.from({ length: 100 }, () => rawClient(r.port)));
    c.send({ op: 'ping' });
    await c.next((m) => m.op === 'pong');
    // a second real server can take over from the first although the strangers are still there
    const second = await login(r);
    assert.equal(second.hello.ok, true);
    assert.equal(await c.whenClosed(), true);
    assert.ok(c.msgs.some((m) => m.op === 'bye' && m.reason === 'superseded'));
    // everything that did not answer is gone after the answer time (700 ms here)
    await sleep(1200);
    assert.ok([...idle, ...more].every((x) => x.closed()), 'every idle socket was dropped');
    second.c.send({ op: 'ping' });
    await second.c.next((m) => m.op === 'pong');
    second.c.close();
  });

  test('it starts only the claude program with the arguments the server builds; everything else is refused and nothing starts', async () => {
    const r = await get();
    const { c } = await login(r);
    const base = spawnReq(dataDir);
    const bad = [
      ['another program', { cmd: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'echo hi'] }],
      ['node itself with a script of ours', { cmd: process.execPath, args: ['-e', 'console.log(1)'] }],
      ['the right program with an unknown flag', { args: [...base.args, '--dangerously-skip-permissions'] }],
      ['an unknown flag with a value', { args: [...base.args, '--settings', 'x.json'] }],
      ['a flag value of the wrong kind', { args: [...base.args, '--permission-mode', 'bypassPermissions'] }],
      ['a resume that is not a session id', { args: [...base.args, '--resume', 'not-a-uuid'] }],
      ['a shell piece in a model name', { args: [...base.args, '--model', 'x & calc'] }],
      ['an argument that is not a string', { args: [...base.args.slice(0, -1), 42] }],
      ['args that are not a list', { args: 'echo hi' }],
      ['the fixed arguments changed', { args: [...claude.pre, '-p', '--input-format', 'text'] }],
      ['a folder that does not exist', { cwd: path.join(dataDir, 'nope') }],
      ['a folder that is not absolute', { cwd: '..' }],
      ['a folder on C: that is not a project folder', { cwd: 'C:\\Windows' }],
      ['a file, not a folder', { cwd: path.join(ROOT, 'server', 'config.js') }],
      ['a share on the network', { cwd: '\\\\localhost\\c$\\Windows' }],
      ['a device path', { cwd: '\\\\?\\' + dataDir }],
      ['a device path to a drive', { cwd: '\\\\.\\C:\\' }],
      ['a stream mark', { cwd: dataDir + ':evil' }],
      ['a system prompt file that is not one of the server\'s', { args: [...base.args, '--append-system-prompt-file', path.join(dataDir, 'fake.log')] }],
      ['a system prompt file from the secret folder', { args: [...base.args, '--append-system-prompt-file', path.join(dataDir, 'runner', 'secret')] }],
      ['a system prompt file on a share', { args: [...base.args, '--append-system-prompt-file', '\\\\localhost\\c$\\Windows\\win.ini'] }],
      ['a system prompt file that does not exist', { args: [...base.args, '--append-system-prompt-file', path.join(ROOT, 'server', 'prompts', 'nope.md')] }],
      ['a system prompt file next to the prompts', { args: [...base.args, '--append-system-prompt-file', path.join(ROOT, 'server', 'prompts', '..', 'config.js')] }],
      ['a run id that is not a uuid', { runId: 'abc' }],
      ['meta that is not an object', { meta: 'x' }],
    ];
    for (const [what, patch] of bad) {
      const req = { ...spawnReq(dataDir), ...patch };
      c.send(req);
      const m = await c.next((x) => (x.op === 'refused' || x.op === 'spawned') && (x.runId === req.runId || what === 'a run id that is not a uuid'));
      assert.equal(m.op, 'refused', `${what} must be refused`);
    }
    c.send({ op: 'list' });
    const list = await c.next((x) => x.op === 'runs');
    assert.deepEqual(list.runs, [], 'nothing was started');
    c.close();
  });

  test('a started process: its output is numbered and journaled, what the server did sits after the line it had handled, a checkpoint drops what it covers', async () => {
    const r = await get();
    const { c } = await login(r);
    const req = spawnReq(dataDir, { meta: { startedAtMs: 1, tag: 'one' } });
    c.send(req);
    const sp = await c.next((x) => x.op === 'spawned' && x.runId === req.runId);
    assert.ok(sp.pid > 0);
    fakePids.add(sp.pid);
    c.send({ op: 'sub', runId: req.runId, after: 0, ins: true });
    c.send({ op: 'note', runId: req.runId, e: { k: 'user', after: 0, t: 5, uuid: 'u1', prompt: 'hello' } });
    c.send({ op: 'in', runId: req.runId, line: userLine('hello there') });
    // live entries are pushed in order, numbered from 1
    const live = [];
    await waitFor(async () => {
      for (const m of c.msgs) if (m.op === 'e' && m.runId === req.runId && !live.includes(m.e)) live.push(m.e);
      return live.some((e) => e.d === 'out' && /DONE/.test(e.line)) && live.some((e) => e.d === 'out' && /"type":"result"/.test(e.line));
    }, 'the turn');
    assert.deepEqual(live.map((e) => e.n), live.map((_, i) => i + 1));
    assert.ok(live.every((e) => e.d === 'out' && typeof e.line === 'string' && e.t > 0));
    // a note that says "after line 3" is placed right after line 3 in the journal
    c.send({ op: 'note', runId: req.runId, e: { k: 'close', after: 3, t: 6, why: 'idle' } });
    c.send({ op: 'meta', runId: req.runId, patch: { remote: { state: 'on' } } });
    c.send({ op: 'annot', runId: req.runId, n: 2, a: { mark: 77 } });
    // a second client asks for the whole journal (a restarted server): replay from line 0 with the notes
    const second = await login(r);
    const sum = second.hello.runs.find((x) => x.runId === req.runId);
    assert.equal(sum.alive, true);
    assert.equal(sum.meta.tag, 'one');
    assert.deepEqual(sum.meta.remote, { state: 'on' });
    assert.equal(sum.checkpoint, null);
    second.c.send({ op: 'sub', runId: req.runId, after: 0, ins: true });
    const batch = await second.c.next((m) => m.op === 'batch' && m.runId === req.runId && m.done);
    const kinds = batch.entries.map((e) => (e.d === 'in' ? `in:${e.k}` : `out:${e.n}`));
    assert.deepEqual(kinds.slice(0, 2), ['in:user', 'out:1'], 'the message the server sent before it had handled any line comes first');
    const at = kinds.indexOf('in:close');
    assert.ok(at > 0, 'the note is in the journal');
    assert.equal(kinds[at - 1], 'out:3', 'right after line 3');
    assert.equal(kinds[at + 1], 'out:4');
    assert.deepEqual(batch.entries.find((e) => e.d === 'out' && e.n === 2).a, { mark: 77 });
    assert.ok(batch.upto >= live.length);
    // from a line on: only what comes after, and the notes with "after" at or past it
    second.c.send({ op: 'sub', runId: req.runId, after: 3, ins: true });
    const later = await second.c.next((m) => m.op === 'batch' && m.runId === req.runId && m.done && m !== batch);
    assert.deepEqual(later.entries.map((e) => (e.d === 'in' ? `in:${e.k}` : `out:${e.n}`))[0], 'in:close');
    // a checkpoint at line 3 drops lines 1 to 3 and the notes before it, keeps the rest
    second.c.send({ op: 'checkpoint', runId: req.runId, n: 3, state: { seq: 9 } });
    second.c.send({ op: 'list' });
    const lst = await second.c.next((m) => m.op === 'runs');
    assert.deepEqual(lst.runs.find((x) => x.runId === req.runId).checkpoint, { n: 3, state: { seq: 9 } });
    second.c.send({ op: 'sub', runId: req.runId, after: 3, ins: true });
    const afterCp = await second.c.next((m) => m.op === 'batch' && m.runId === req.runId && m.done && m !== batch && m !== later);
    assert.ok(afterCp.entries.every((e) => (e.d === 'in' ? e.after >= 3 : e.n > 3)));
    assert.equal(afterCp.entries[0].k, 'close');
    // the first client was replaced by the second one (only one server at a time)
    assert.equal(await c.whenClosed(), true);
    assert.ok(c.msgs.some((m) => m.op === 'bye' && m.reason === 'superseded'));
    second.c.close();
  });

  test('stdin can be closed and a process killed on request; an ended run is kept until it is forgotten', async () => {
    const r = await get();
    const { c } = await login(r);
    const req = spawnReq(dataDir);
    c.send(req);
    const sp = await c.next((x) => x.op === 'spawned' && x.runId === req.runId);
    fakePids.add(sp.pid);
    c.send({ op: 'sub', runId: req.runId, after: 0, ins: false });
    c.send({ op: 'in', runId: req.runId, line: userLine('HANG this') });
    await c.next((m) => m.op === 'e' && m.e.d === 'out' && /step 1/.test(m.e.line || ''));
    assert.equal(alive(sp.pid), true);
    c.send({ op: 'kill', runId: req.runId });
    const exit = await c.next((m) => m.op === 'e' && m.runId === req.runId && m.e.d === 'exit');
    assert.ok(exit.e.n > 1);
    assert.equal(alive(sp.pid), false, 'the process is gone');
    c.send({ op: 'list' });
    let lst = await c.next((m) => m.op === 'runs');
    const s = lst.runs.find((x) => x.runId === req.runId);
    assert.equal(s.alive, false);
    assert.ok(s.exit && typeof s.exit.code === 'number');
    // a new server sees the end in the journal
    c.send({ op: 'forget', runId: req.runId });
    c.send({ op: 'list' });
    lst = await c.next((m) => m.op === 'runs' && m !== lst);
    assert.equal(lst.runs.some((x) => x.runId === req.runId), false);
    c.close();
  });

  test('the persona prompt file, a prompt shipped with the server, and a subfolder of a project folder are accepted', async () => {
    const r = await get();
    fs.writeFileSync(path.join(dataDir, 'comlink-system.md'), 'prompt\n');
    fs.mkdirSync(path.join(dataDir, 'sub', 'deeper'), { recursive: true });
    const { c } = await login(r);
    const ok = [
      { args: [...spawnReq(dataDir).args, '--append-system-prompt-file', path.join(dataDir, 'comlink-system.md')] },
      { args: [...spawnReq(dataDir).args, '--append-system-prompt-file', path.join(ROOT, 'server', 'prompts', 'comlink.md')] },
      { cwd: path.join(dataDir, 'sub', 'deeper') },
      { cwd: path.join(dataDir, 'sub').toUpperCase() }, // folder names compare without regard to case
    ];
    for (const patch of ok) {
      const req = { ...spawnReq(dataDir), ...patch };
      c.send(req);
      const m = await c.next((x) => (x.op === 'refused' || x.op === 'spawned') && x.runId === req.runId);
      assert.equal(m.op, 'spawned', JSON.stringify(m));
      fakePids.add(m.pid);
      c.send({ op: 'kill', runId: req.runId });
      await c.next((x) => x.op === 'e' && x.runId === req.runId && x.e.d === 'exit').catch(() => {});
      c.send({ op: 'forget', runId: req.runId });
    }
    c.close();
  });

  test('any existing folder on an open drive may be used; a junction that leads out of it, or a folder on C:, may not', { skip: OPEN_DRIVE === 'C' && 'the checkout is on C:' }, async () => {
    const r = await get();
    const base = OPEN_DRIVE + ':\\tmp\\mc\\r3';
    fs.mkdirSync(base, { recursive: true });
    const inV = fs.mkdtempSync(path.join(base, 'cwd-'));
    const junction = path.join(inV, 'out');
    const toV = path.join(inV, 'inside');
    fs.mkdirSync(path.join(inV, 'real'));
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows'], { stdio: 'ignore', windowsHide: true });
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', toV, path.join(inV, 'real')], { stdio: 'ignore', windowsHide: true });
    try {
      const { c } = await login(r);
      const tries = [
        ['a folder on the open drive that is not a project folder', inV, true],
        ['a folder on the open drive written in capitals', inV.toUpperCase(), true],
        ['a junction on the open drive to another folder on it', toV, true],
        ['a junction on the open drive that leads to C:', junction, false],
        ['a folder below that junction', path.join(junction, 'System32'), false],
        ['a folder on the open drive that does not exist', path.join(inV, 'missing'), false],
        ['a folder on C:', 'C:\\Windows', false],
        ['a folder on C: outside the Windows folder', 'C:\\Users', false],
      ];
      for (const [what, cwd, ok] of tries) {
        const req = { ...spawnReq(dataDir), cwd };
        c.send(req);
        const m = await c.next((x) => (x.op === 'refused' || x.op === 'spawned') && x.runId === req.runId);
        assert.equal(m.op, ok ? 'spawned' : 'refused', `${what}: ${JSON.stringify(m)}`);
        if (ok) {
          fakePids.add(m.pid);
          c.send({ op: 'kill', runId: req.runId });
          await c.next((x) => x.op === 'e' && x.runId === req.runId && x.e.d === 'exit').catch(() => {});
          c.send({ op: 'forget', runId: req.runId });
        }
      }
      c.close();
    } finally {
      for (const j of [junction, toV]) {
        try {
          fs.rmdirSync(j); // removes the junction only, never what it points to
        } catch {
          // already gone
        }
      }
      fs.rmSync(inV, { recursive: true, force: true });
    }
    assert.ok(fs.existsSync('C:\\Windows\\System32'), 'removing the junction left its target alone');
  });

  test('the claude program may be written another way (case, slashes); what runs is the path the runner resolved itself', async () => {
    const r = await get();
    const { c } = await login(r);
    const req = spawnReq(dataDir, { cmd: claude.cmd.toUpperCase().replace(/\\/g, '/') });
    c.send(req);
    const m = await c.next((x) => (x.op === 'refused' || x.op === 'spawned') && x.runId === req.runId);
    assert.equal(m.op, 'spawned', JSON.stringify(m));
    fakePids.add(m.pid);
    c.send({ op: 'kill', runId: req.runId });
    await c.next((x) => x.op === 'e' && x.runId === req.runId && x.e.d === 'exit').catch(() => {});
    c.send({ op: 'forget', runId: req.runId });
    c.close();
  });

  test('a second runner on the same port ends with exit code 73 and leaves the first one working', async () => {
    const r = await get();
    const second = await startRunner({ dataDir, port: r.port });
    assert.equal(await second.exited, 73);
    const { hello } = await login(r);
    assert.equal(hello.ok, true);
  });
});

// ---- A server restart mid-turn ----

const listen = (s) => {
  const events = [];
  const req = http.get({ host: '127.0.0.1', port: s.port, path: '/api/events', headers: { Host: `127.0.0.1:${s.port}` } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!block.startsWith('data: ')) continue;
        try {
          const m = JSON.parse(block.slice(6));
          if (m.type === 'chat') events.push(m.data);
        } catch {
          // not JSON
        }
      }
    });
  });
  req.on('error', () => {});
  return { events, stop: () => req.destroy() };
};

const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
const runOf = async (s, runId) => (await pc(s, 'GET', '/api/runs')).json.find((x) => x.runId === runId);

describe('a restart of the server', () => {
  // A runner and a server on one data folder, the fake CLI first in PATH for both.
  async function world(fakeEnv = {}, { runnerEnv = {}, serverEnv = {} } = {}) {
    const dataDir = makeDataDir('mc-restart');
    seedFixture(dataDir);
    const port = await freePort();
    const log = path.join(dataDir, 'fake.log');
    const projDir = path.join(dataDir, 'claude-home', 'projects', 'proj');
    const common = { FAKE_LOG: log, FAKE_STEP_MS: '350', FAKE_TRANSCRIPT: projDir, ...fakeEnv };
    const runner = await startRunner({ dataDir, port, env: { ...common, ...runnerEnv } });
    assert.ok(!runner.failed, runner.out.text);
    const boot = async () => {
      const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, MC_RUNNER_PORT: String(port), ...common, ...serverEnv } });
      toStop.push(s);
      return s;
    };
    const w = {
      dataDir,
      port,
      runner,
      projDir,
      boot,
      lines: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    };
    w.s1 = await boot();
    return w;
  }

  // A kept piece of a turn (what GET /api/sessions/:id sends under "live") against the event the page got over the event stream
  // under the same number: the same thing, in the shorter form the pieces have.
  const samePiece = (piece, full, what) => {
    for (const k of Object.keys(piece)) {
      if (k === 'event') {
        const texts = (e) => e.message.content.map((b) => (b.type === 'text' ? b.text : `tool:${b.name}`));
        assert.deepEqual(texts(piece.event), texts(full.event), `${what}: the same words`);
      } else assert.deepEqual(piece[k], full[k], `${what}: ${k}`);
    }
  };

  // The events of a run, in the order a page applying "seq" would take them: an event is applied once, by its number.
  const bySeq = (lists, runId) => {
    const m = new Map();
    for (const e of lists.flat()) {
      if (e.runId !== runId) continue;
      if (m.has(e.seq)) assert.deepEqual(e, m.get(e.seq), `seq ${e.seq} must mean the same event before and after the restart`);
      else m.set(e.seq, e);
    }
    return m;
  };

  test('the turn goes on, a pending permission question survives and can be answered, the events keep their numbers', async () => {
    const w = await world();
    const l1 = listen(w.s1);
    await sleep(150);
    const r = await pc(w.s1, 'POST', '/api/chat', { prompt: 'ASK me something' });
    assert.equal(r.status, 200, r.text);
    const runId = r.json.runId;
    const pend1 = await waitFor(async () => {
      const p = await pc(w.s1, 'GET', `/api/runs/${runId}/pending`);
      return p.json && p.json.length && p.json;
    }, 'the permission question');
    await sleep(150); // let the event stream deliver what the server published
    const before = l1.events.filter((e) => e.runId === runId);
    const lastSeq = Math.max(...before.map((e) => e.seq));
    assert.deepEqual(before.map((e) => e.seq), before.map((_, i) => i + 1));
    const spawnPid = w.lines().find((l) => l.ev === 'spawn').pid;
    fakePids.add(spawnPid);

    // restart the way the Restart button does: the server exits (code 75) and the loop would start it again
    await w.s1.stop();
    l1.stop();
    assert.equal(alive(spawnPid), true, 'the conversation outlived the server');

    const s2 = await w.boot();
    assert.match(s2.out.text, /took over run/);
    const runs = (await pc(s2, 'GET', '/api/runs')).json;
    const run = runs.find((x) => x.runId === runId);
    assert.ok(run, 'the run is known again');
    assert.equal(run.state, 'working');
    assert.equal(run.pending, 1);
    const pend2 = (await pc(s2, 'GET', `/api/runs/${runId}/pending`)).json;
    assert.deepEqual(pend2, pend1, 'the same question, with the same id and time');

    // a page that opens the conversation gets the turn as it was, numbered as before
    const sid = run.sessionId;
    assert.ok(sid);
    const sess = (await pc(s2, 'GET', `/api/sessions/${sid}?limit=40`)).json;
    assert.equal(sess.live.runId, runId);
    assert.equal(sess.live.upto, lastSeq, 'nothing was lost and nothing was added while the server was away');
    for (const e of sess.live.events) {
      const was = before.find((b) => b.seq === e.seq);
      assert.ok(was, `seq ${e.seq} existed before`);
      samePiece(e, was, `seq ${e.seq}`);
    }
    assert.ok(sess.live.events.some((e) => e.permission), 'the open question is part of the turn');

    // answer it through the new server: the turn goes on to its end
    const l2 = listen(s2);
    await sleep(150);
    const ans = await pc(s2, 'POST', `/api/runs/${runId}/permission`, { requestId: pend2[0].requestId, behavior: 'allow' });
    assert.equal(ans.status, 200, ans.text);
    await waitFor(async () => (await runOf(s2, runId)).state === 'idle', 'the turn to end');
    await sleep(150);
    const after = l2.events.filter((e) => e.runId === runId);
    // The page is also given a few events it had (the new server hands over everything after what the old one is known to have
    // published, which is up to 400 ms behind); the numbers say which, and the events behind them must be the same ones.
    assert.ok(after.some((e) => e.seq === lastSeq + 1), 'the numbering continues where the old server stopped');
    assert.ok(after.filter((e) => e.seq <= lastSeq).every((e) => before.some((b) => b.seq === e.seq)));
    const all = bySeq([before, after], runId);
    assert.deepEqual([...all.keys()], [...all.keys()].map((_, i) => i + 1), 'every number once, no gap');
    const texts = [...all.values()].flatMap((e) => (e.event && e.event.type === 'assistant' ? e.event.message.content.filter((b) => b.text).map((b) => b.text) : []));
    assert.equal(texts.filter((t) => t.startsWith('PERMISSION allow')).length, 1);
    assert.equal(texts.filter((t) => t.startsWith('DONE')).length, 1);
    assert.equal(texts.filter((t) => t.startsWith('ECHO')).length, 1);
    assert.equal(all.get([...all.keys()].at(-1)).done, undefined);
    assert.ok([...all.values()].some((e) => e.turnDone), 'the end of the turn was seen');
    assert.equal(w.lines().filter((l) => l.ev === 'spawn').length, 1, 'one process the whole time');
    l2.stop();
  });

  test('a turn that goes on while the server is away: the page reads it again from the new server and sees every event once', async () => {
    const w = await world({ FAKE_STEP_MS: '1200' });
    const l1 = listen(w.s1);
    await sleep(150);
    const r = await pc(w.s1, 'POST', '/api/chat', { prompt: 'a long plain turn' });
    const runId = r.json.runId;
    await waitFor(async () => l1.events.filter((e) => e.runId === runId).length >= 5, 'some events');
    fakePids.add(w.lines().find((l) => l.ev === 'spawn').pid);
    await w.s1.stop();
    l1.stop();
    const seen = l1.events.filter((e) => e.runId === runId);
    await sleep(500); // the turn goes on with nobody listening
    const s2 = await w.boot();
    const l2 = listen(s2);
    await sleep(200);
    const run = await runOf(s2, runId);
    assert.ok(run, 'the run is known again');
    const sid = run.sessionId;
    // the new server's account of the turn, as a page that sees a gap reads it
    const sess = (await pc(s2, 'GET', `/api/sessions/${sid}?limit=40`)).json;
    assert.ok(sess.live, 'the turn was still going when the new server came up');
    await waitFor(async () => (await runOf(s2, runId)).state === 'idle', 'the turn to end', 30000);
    await sleep(200);
    const after = l2.events.filter((e) => e.runId === runId);
    assert.ok(sess.live.upto >= Math.max(...seen.map((e) => e.seq)), 'the live account covers what the page already had');
    for (const e of sess.live.events) {
      const was = seen.find((b) => b.seq === e.seq);
      if (was) samePiece(e, was, `seq ${e.seq} is the same event as before`);
    }
    // the turn's own words in that account, before and after the restart, without a repeat
    const said = sess.live.events.flatMap((e) => (e.event ? e.event.message.content.filter((b) => b.type === 'text').map((b) => b.text) : []));
    assert.equal(new Set(said).size, said.length);
    // what the page had plus what the new server gives it when it connects is every number once, with the same events behind the
    // same numbers (the new server hands over what it numbered after what the old one is known to have published)
    assert.ok(after.length > 0);
    const everything = bySeq([seen, after], runId);
    assert.deepEqual([...everything.keys()], [...everything.keys()].map((_, i) => i + 1), 'no number missing');
    assert.ok(Math.max(...after.map((e) => e.seq)) > Math.max(...seen.map((e) => e.seq)), 'it went on after the restart');
    assert.ok([...everything.values()].some((e) => e.turnDone));
    // the saved conversation holds the turn exactly once
    const done = (await pc(s2, 'GET', `/api/sessions/${sid}?limit=40`)).json;
    assert.equal(done.live, undefined);
    const ai = done.messages.filter((m) => m.role === 'assistant').map((m) => m.text);
    assert.equal(ai.filter((t) => t.startsWith('DONE')).length, 1);
    assert.equal(ai.filter((t) => t.startsWith('ECHO')).length, 1);
    // numbers the new server gave are never reused for a different event
    bySeq([seen, after], runId);
    l2.stop();
  });

  test('a turn that ends while the server is away still reaches the page: the new server gives a connecting page what it missed, the end of the turn included', async () => {
    const w = await world({ FAKE_STEP_MS: '120' });
    const l1 = listen(w.s1);
    await sleep(150);
    const r = await pc(w.s1, 'POST', '/api/chat', { prompt: 'a short turn' });
    const runId = r.json.runId;
    await waitFor(async () => l1.events.filter((e) => e.runId === runId).length >= 4, 'some events');
    fakePids.add(w.lines().find((l) => l.ev === 'spawn').pid);
    await w.s1.stop();
    l1.stop();
    const seen = l1.events.filter((e) => e.runId === runId);
    assert.ok(!seen.some((e) => e.turnDone), 'the turn had not ended yet');
    await sleep(2500); // the whole turn ends with nobody listening
    const s2 = await w.boot();
    assert.equal((await runOf(s2, runId)).state, 'idle', 'the turn ended while the server was away');
    const l2 = listen(s2); // a page whose event stream reconnected
    await waitFor(async () => l2.events.some((e) => e.runId === runId && e.turnDone), 'the end of the turn');
    await sleep(200);
    const after = l2.events.filter((e) => e.runId === runId);
    const everything = bySeq([seen, after], runId);
    assert.deepEqual([...everything.keys()], [...everything.keys()].map((_, i) => i + 1), 'every number once, none missing');
    const texts = [...everything.values()].flatMap((e) => (e.event && e.event.type === 'assistant' ? e.event.message.content.filter((b) => b.text).map((b) => b.text) : []));
    assert.equal(texts.filter((t) => t.startsWith('DONE')).length, 1);
    assert.equal(texts.filter((t) => t.startsWith('ECHO')).length, 1);
    assert.equal([...everything.values()].filter((e) => e.turnDone).length, 1);
    l2.stop();
  });

  test('two restarts in a row during a turn: the events the in-between server never gave to a page are still handed over by the next one, no number is missing', async () => {
    const w = await world({ FAKE_STEP_MS: '1500' });
    const l1 = listen(w.s1);
    await sleep(150);
    const r = await pc(w.s1, 'POST', '/api/chat', { prompt: 'a long plain turn' });
    assert.equal(r.status, 200, r.text);
    const runId = r.json.runId;
    await waitFor(async () => l1.events.filter((e) => e.runId === runId).length >= 2, 'the first events');
    fakePids.add(w.lines().find((l) => l.ev === 'spawn').pid);
    await sleep(500); // the old server tells the runner how far the page got
    await w.s1.stop();
    l1.stop();
    const seen = l1.events.filter((e) => e.runId === runId);
    // the second server: no page connects to it, and it numbers more events of the turn
    const s2 = await w.boot();
    const sid = (await runOf(s2, runId)).sessionId;
    const upto = async () => {
      const x = (await pc(s2, 'GET', `/api/sessions/${sid}?limit=10`)).json;
      return x && x.live ? x.live.upto : 0;
    };
    const at = await upto();
    await waitFor(async () => (await upto()) > at, 'a new event numbered by the second server', 20000);
    await sleep(900); // longer than the 400 ms it waits before telling the runner anything
    await s2.stop();
    // the third server, and a page that connects to it
    const s3 = await w.boot();
    const l3 = listen(s3);
    await waitFor(async () => l3.events.some((e) => e.runId === runId && e.turnDone), 'the end of the turn', 40000);
    await sleep(200);
    const after = l3.events.filter((e) => e.runId === runId);
    const all = bySeq([seen, after], runId);
    assert.ok(Math.max(...after.map((e) => e.seq)) > Math.max(...seen.map((e) => e.seq)));
    assert.deepEqual([...all.keys()], [...all.keys()].map((_, i) => i + 1), 'every number once, none missing between the first page and the third server');
    assert.equal([...all.values()].filter((e) => e.turnDone).length, 1);
    l3.stop();
  });

  for (const small of [false, true]) test(`two restarts in a row, the turn ending under the second server: the third one ${small ? 'cannot hand over what no page got (checkpoint too small), so it tells the pages to read the conversation again' : 'hands over what no page got, from the checkpoint, with no number missing'}`, async () => {
    const w = await world({ FAKE_STEP_MS: '600' }, small ? { serverEnv: { MC_CHECKPOINT_STASH_BYTES: '10' } } : {});
    const l1 = listen(w.s1);
    await sleep(150);
    const r = await pc(w.s1, 'POST', '/api/chat', { prompt: 'a short turn' });
    assert.equal(r.status, 200, r.text);
    const runId = r.json.runId;
    await waitFor(async () => l1.events.filter((e) => e.runId === runId).length >= 3, 'the first events');
    fakePids.add(w.lines().find((l) => l.ev === 'spawn').pid);
    await sleep(500); // the old server tells the runner how far the page got
    await w.s1.stop();
    l1.stop();
    const seen = l1.events.filter((e) => e.runId === runId);
    // the second server sees the whole turn end; no page is connected, and it writes a checkpoint at the end of the turn
    const s2 = await w.boot();
    await waitFor(async () => (await runOf(s2, runId)).state === 'idle', 'the turn to end under the second server', 30000);
    await sleep(900);
    await s2.stop();
    // the third server restores from that checkpoint and has nothing to replay
    const s3 = await w.boot();
    const l3 = listen(s3);
    await waitFor(async () => l3.events.some((e) => e.runId === runId), 'events for the page');
    await sleep(500);
    const after = l3.events.filter((e) => e.runId === runId);
    const all = bySeq([seen, after], runId);
    const syncs = after.filter((e) => e.resync);
    if (small) {
      assert.equal(syncs.length, 1, 'one resync event for the run');
      assert.equal(syncs[0].seq, Math.max(...after.map((e) => e.seq)), 'it is the newest event');
      assert.ok(syncs[0].seq > Math.max(...seen.map((e) => e.seq)));
      assert.ok(![...all.keys()].every((k, i) => k === i + 1), 'numbers are missing, which is what the resync is for');
    } else {
      assert.equal(syncs.length, 0, 'nothing to read again');
      assert.deepEqual([...all.keys()], [...all.keys()].map((_, i) => i + 1), 'no number missing between the first page and the third server');
      assert.ok([...all.values()].some((e) => e.turnDone), 'the end of the turn reached the page');
    }
    l3.stop();
  });

  test('a page that connects to a server that numbered events while no page was there is told once to read the conversation again', async () => {
    const w = await world({ FAKE_STEP_MS: '100' });
    const r = await pc(w.s1, 'POST', '/api/chat', { prompt: 'a short turn' });
    const runId = r.json.runId;
    fakePids.add((await waitFor(async () => w.lines().find((l) => l.ev === 'spawn'), 'the process')).pid);
    await waitFor(async () => (await runOf(w.s1, runId)).state === 'idle', 'the turn to end with no page', 30000);
    const first = listen(w.s1);
    await sleep(400);
    first.stop();
    const syncs = first.events.filter((e) => e.runId === runId && e.resync);
    assert.equal(syncs.length, 1);
    const second = listen(w.s1);
    await sleep(400);
    second.stop();
    assert.equal(second.events.filter((e) => e.runId === runId).length, 0, 'once is enough');
  });

  test('only a page that connects soon after the restart is given what it missed', async () => {
    const w = await world({ FAKE_STEP_MS: '100' }, { serverEnv: { MC_RESYNC_MS: '600' } });
    const l1 = listen(w.s1);
    await sleep(150);
    const r = await pc(w.s1, 'POST', '/api/chat', { prompt: 'short again' });
    const runId = r.json.runId;
    await waitFor(async () => l1.events.filter((e) => e.runId === runId).length >= 3, 'some events');
    fakePids.add(w.lines().find((l) => l.ev === 'spawn').pid);
    await w.s1.stop();
    l1.stop();
    await sleep(1500);
    const s2 = await w.boot();
    const soon = listen(s2);
    await sleep(300);
    soon.stop();
    assert.ok(soon.events.filter((e) => e.runId === runId).length > 0, 'a page that connects at once is given the events');
    await sleep(900);
    const late = listen(s2);
    await sleep(500);
    late.stop();
    assert.equal(late.events.filter((e) => e.runId === runId).length, 0, 'nothing after the window');
  });

  test('the Restart button (exit code 75) leaves the conversation running; an idle run keeps its idle time; Stop after the restart ends it', async () => {
    const w = await world({ FAKE_STEP_MS: '60' }, { serverEnv: { MC_SUPERVISED: '1', MC_IDLE_MS: '60000' } });
    const r = await pc(w.s1, 'POST', '/api/chat', { prompt: 'hello' });
    const runId = r.json.runId;
    await waitFor(async () => (await runOf(w.s1, runId)).state === 'idle', 'idle');
    const pid = w.lines().find((l) => l.ev === 'spawn').pid;
    fakePids.add(pid);
    const restart = await pc(w.s1, 'POST', '/api/server/restart', { confirm: true });
    assert.equal(restart.status, 200, restart.text);
    assert.equal(await w.s1.exited, 75);
    assert.equal(alive(pid), true);
    const s2 = await w.boot();
    const run = await runOf(s2, runId);
    assert.equal(run.state, 'idle');
    assert.equal(run.promptPreview, 'hello');
    // a message to the same conversation joins the process that is still there
    const j = await pc(s2, 'POST', '/api/chat', { prompt: 'and more', sessionId: run.sessionId });
    assert.equal(j.status, 200, j.text);
    assert.equal(j.json.runId, runId);
    assert.equal(j.json.joined, true);
    await waitFor(async () => (await runOf(s2, runId)).state === 'idle', 'idle again');
    assert.equal(w.lines().filter((l) => l.ev === 'spawn').length, 1);
    // an explicit Stop does end it
    const stop = await pc(s2, 'POST', `/api/runs/${runId}/stop`);
    assert.equal(stop.status, 200, stop.text);
    assert.equal((await runOf(s2, runId)).state, 'stopped');
    await waitFor(() => !alive(pid), 'the process to end');
    // and the runner let go of it
    const { c, hello } = await login(w.runner);
    await sleep(100);
    c.send({ op: 'list' });
    const lst = await c.next((m) => m.op === 'runs');
    assert.equal(lst.runs.some((x) => x.runId === runId), false);
    assert.equal(hello.ok, true);
    c.close();
  });

  test('background work survives a restart: the run stays open, and when the helper ends the new server sees the turn Claude starts by itself', async () => {
    const w = await world({ FAKE_STEP_MS: '60', FAKE_BG_MS: '3500' }, { serverEnv: { MC_IDLE_MS: '800' } });
    const r = await pc(w.s1, 'POST', '/api/chat', { prompt: 'BGAGENT please' });
    const runId = r.json.runId;
    await waitFor(async () => (await runOf(w.s1, runId)).state === 'idle', 'idle');
    assert.equal((await runOf(w.s1, runId)).background, 1);
    const pid = w.lines().find((l) => l.ev === 'spawn').pid;
    fakePids.add(pid);
    await w.s1.stop();
    const s2 = await w.boot();
    const run = await runOf(s2, runId);
    assert.equal(run.state, 'idle');
    assert.equal(run.background, 1, 'the new server knows about the running helper');
    await sleep(1800); // more than twice the idle time
    assert.equal((await runOf(s2, runId)).state, 'idle');
    assert.equal(alive(pid), true);
    await waitFor(async () => w.lines().some((l) => l.ev === 'bg-end'), 'the helper to end');
    await waitFor(async () => {
      const x = await runOf(s2, runId);
      return x.state === 'idle' && x.background === undefined;
    }, 'the notification turn');
    const end = await waitFor(async () => {
      const x = await runOf(s2, runId);
      return x.state === 'done' && x;
    }, 'the idle close');
    assert.equal(end.state, 'done');
  });

  test('a conversation that ended while the server was away is a finished run afterwards', async () => {
    const w = await world({ FAKE_STEP_MS: '60' });
    const r = await pc(w.s1, 'POST', '/api/chat', { prompt: 'first' });
    const runId = r.json.runId;
    await waitFor(async () => (await runOf(w.s1, runId)).state === 'idle', 'idle');
    const pid = w.lines().find((l) => l.ev === 'spawn').pid;
    fakePids.add(pid);
    await w.s1.stop();
    killPid(pid);
    await waitFor(() => !alive(pid), 'the process to end');
    const s2 = await w.boot();
    const run = await waitFor(async () => {
      const x = await runOf(s2, runId);
      return x && x.state !== 'idle' && x;
    }, 'the ended run');
    assert.ok(['failed', 'done', 'stopped'].includes(run.state));
  });

  test('when the runner is not there the server starts claude directly and says so; a runner with another secret is not used either', async () => {
    const dataDir = makeDataDir('mc-fallback');
    seedFixture(dataDir);
    const log = path.join(dataDir, 'fake.log');
    const common = { FAKE_LOG: log, FAKE_STEP_MS: '60', FAKE_TRANSCRIPT: path.join(dataDir, 'claude-home', 'projects', 'proj') };
    // nothing listens
    const dead = await freePort();
    const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, MC_RUNNER_PORT: String(dead), MC_RUNNER_BOOT_MS: '300', ...common } });
    toStop.push(s);
    const r = await pc(s, 'POST', '/api/chat', { prompt: 'direct please' });
    assert.equal(r.status, 200, r.text);
    await waitFor(async () => (await runOf(s, r.json.runId)).state === 'idle', 'idle');
    assert.match(s.out.text, /\[runner\] not available/);
    assert.match(s.out.text, /start directly/);
    const pid = s.out.text && JSON.parse(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)[0]).pid;
    fakePids.add(pid);
    // a runner that holds another secret (its own data folder): the server's hello is refused, so it also starts directly
    const otherDir = makeDataDir('mc-fallback-runner');
    const port = await freePort();
    const runner = await startRunner({ dataDir: otherDir, port, env: common });
    const dataDir2 = makeDataDir('mc-fallback2');
    seedFixture(dataDir2);
    const s2 = await startServer({ dataDir: dataDir2, bridge: false, env: { PATH: FAKE_PATH, MC_RUNNER_PORT: String(port), MC_RUNNER_BOOT_MS: '300', ...common, FAKE_LOG: path.join(dataDir2, 'fake.log') } });
    toStop.push(s2);
    const r2 = await pc(s2, 'POST', '/api/chat', { prompt: 'direct too' });
    assert.equal(r2.status, 200, r2.text);
    await waitFor(async () => (await runOf(s2, r2.json.runId)).state === 'idle', 'idle');
    assert.match(s2.out.text, /\[runner\] not available/);
    const { hello } = await login(runner);
    assert.deepEqual(hello.runs, [], 'the runner was never given the run');
  });

  test('the server says when the running runner is older than its code', async () => {
    const w = await world({}, { runnerEnv: { MC_RUNNER_STAMP: '1000' } });
    assert.match(w.s1.out.text, /older than its code/);
  });

  test('a chat started through the runner is a normal run: options, remote control and stop work as before', async () => {
    const w = await world({ FAKE_STEP_MS: '40' });
    const r = await pc(w.s1, 'POST', '/api/chat', { prompt: 'check options', effort: 'low', model: 'claude-haiku-5-5' });
    assert.equal(r.status, 200, r.text);
    const run = await waitFor(async () => {
      const x = await runOf(w.s1, r.json.runId);
      return x.state === 'idle' && x.remote === 'on' && x;
    }, 'idle with remote control on');
    assert.match(run.remoteUrl, /^https:\/\/claude\.ai\/code\//);
    const spawn = w.lines().find((l) => l.ev === 'spawn');
    fakePids.add(spawn.pid);
    assert.ok(spawn.args.includes('--effort') && spawn.args.includes('low'));
    assert.ok(spawn.args.includes('claude-haiku-5-5'));
    assert.equal(w.lines().filter((l) => l.ev === 'stdin-control-request').length, 1);
  });
});

// ---- A stranger on the runner port, and the secret on the wire ----

// A listener that pretends to be the runner. It records every byte it is sent. mode: forger (a challenge, then a hello with
// a proof made with another secret and a forged run), noproof (a hello without any proof), reflect (the client's own proof
// handed back), early (a hello with a forged run before any challenge), silent (accepts and says nothing).
async function fakeRunner(mode) {
  const port = await freePort();
  const got = [];
  const forged = {
    runId: crypto.randomUUID(),
    pid: 4242,
    alive: true,
    startedAt: Date.now(),
    meta: { startedAtMs: Date.now(), promptPreview: 'forged run', cwd: 'C:\\Windows', sessionId: crypto.randomUUID() },
    checkpoint: null,
    lastN: 0,
    droppedOut: 0,
    exit: null,
  };
  const hello = (extra) => JSON.stringify({ op: 'hello', ok: true, proto: 2, pid: 1, startedAt: Date.now(), stamp: 1, runs: [forged], ...extra }) + '\n';
  const socks = new Set();
  const server = net.createServer((sock) => {
    socks.add(sock);
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('close', () => socks.delete(sock));
    const nonce = makeNonce();
    let buf = '';
    sock.on('data', (d) => {
      got.push(d);
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.op !== 'hello') continue;
        if (mode === 'forger') sock.write(hello({ proof: handshakeProof(crypto.randomBytes(32).toString('hex'), 'runner', m.nonce, nonce) }));
        else if (mode === 'noproof') sock.write(hello());
        else if (mode === 'reflect') sock.write(hello({ proof: m.proof }));
      }
    });
    if (mode === 'early') sock.write(hello());
    else if (mode !== 'silent') sock.write(JSON.stringify({ op: 'challenge', proto: 2, nonce }) + '\n');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    got,
    forged,
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        for (const x of socks) x.destroy();
      }),
  };
}

describe('a stranger on the runner port', () => {
  for (const mode of ['forger', 'noproof', 'reflect', 'early', 'silent']) {
    test(`a listener that cannot prove it holds the secret (${mode}) gets nothing and is not used; its forged runs are not taken over`, async () => {
      const dataDir = makeDataDir('mc-stranger');
      seedFixture(dataDir);
      const log = path.join(dataDir, 'fake.log');
      const fake = await fakeRunner(mode);
      const s = await startServer({
        dataDir,
        bridge: false,
        env: { PATH: FAKE_PATH, MC_RUNNER_PORT: String(fake.port), MC_RUNNER_BOOT_MS: '300', FAKE_LOG: log, FAKE_STEP_MS: '60', FAKE_TRANSCRIPT: path.join(dataDir, 'claude-home', 'projects', 'proj') },
      });
      toStop.push(s);
      toStop.push({ stop: fake.stop });
      const r = await pc(s, 'POST', '/api/chat', { prompt: 'secret prompt text' });
      assert.equal(r.status, 200, r.text);
      await waitFor(async () => (await runOf(s, r.json.runId)).state === 'idle', 'idle');
      const spawned = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.ev === 'spawn');
      fakePids.add(spawned.pid);
      assert.match(s.out.text, /\[runner\] not available/);
      assert.doesNotMatch(s.out.text, /took over run/);
      assert.doesNotMatch(s.out.text, /connected to the runner/);
      const runs = (await pc(s, 'GET', '/api/runs')).json;
      assert.equal(runs.length, 1, 'only the conversation of this server');
      assert.ok(!runs.some((x) => x.runId === fake.forged.runId || x.promptPreview === 'forged run'));
      // what the stranger was sent: no secret, no request to start or write anything, nothing of the conversation
      const secret = fs.readFileSync(path.join(dataDir, 'runner', 'secret'), 'utf8').trim();
      const traffic = fake.got.join('');
      assert.ok(!traffic.includes(secret), 'the secret never crosses the socket');
      assert.ok(!/"op":"(spawn|in|note|sub|list|meta|checkpoint)"/.test(traffic), 'no request of the runner protocol');
      assert.ok(!traffic.includes('secret prompt text'));
      if (mode !== 'silent' && mode !== 'early') assert.match(traffic, /"op":"hello"/, 'it was only given the answer to its challenge');
      if (mode === 'reflect') assert.match(s.out.text, /could not prove/);
    });
  }

  test('the secret is not in the traffic between a real server and the real runner either, and the conversation runs in the runner', async () => {
    const dataDir = makeDataDir('mc-proxy');
    seedFixture(dataDir);
    const log = path.join(dataDir, 'fake.log');
    const common = { FAKE_LOG: log, FAKE_STEP_MS: '60', FAKE_TRANSCRIPT: path.join(dataDir, 'claude-home', 'projects', 'proj') };
    const runnerPort = await freePort();
    const proxyPort = await freePort();
    const runner = await startRunner({ dataDir, port: runnerPort, env: common });
    // a recording relay between the server and the runner
    const traffic = { up: '', down: '' };
    const sockets = new Set();
    const proxy = net.createServer((a) => {
      const b = net.connect({ host: '127.0.0.1', port: runnerPort });
      sockets.add(a).add(b);
      a.on('data', (d) => ((traffic.up += d), b.write(d)));
      b.on('data', (d) => ((traffic.down += d), a.write(d)));
      for (const x of [a, b]) {
        x.on('error', () => {});
        x.on('close', () => (a.destroy(), b.destroy()));
      }
    });
    await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
    toStop.push({ stop: async () => (sockets.forEach((x) => x.destroy()), proxy.close()) });
    const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, MC_RUNNER_PORT: String(proxyPort), ...common } });
    toStop.push(s);
    const r = await pc(s, 'POST', '/api/chat', { prompt: 'through the relay' });
    assert.equal(r.status, 200, r.text);
    await waitFor(async () => (await runOf(s, r.json.runId)).state === 'idle', 'idle');
    fakePids.add(JSON.parse(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)[0]).pid);
    assert.match(s.out.text, /connected to the runner/);
    const secret = runner.secret();
    assert.ok(!traffic.up.includes(secret) && !traffic.down.includes(secret), 'the secret is in neither direction');
    assert.match(traffic.down, /"op":"challenge"/);
    assert.match(traffic.up, /"op":"hello"/);
    assert.match(traffic.up, /"op":"spawn"/, 'the conversation was started through the runner');
    assert.ok(!/"secret"/.test(traffic.up + traffic.down), 'there is no secret field at all');
  });
});
