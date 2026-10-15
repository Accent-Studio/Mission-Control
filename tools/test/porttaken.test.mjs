// Tests for a second Mission Control started while the port is taken: it stops with exit code 73 before it loads the server
// (so it never takes the runner or starts a timer), and it waits a moment first, so a restart finds the port again.
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, test } from 'node:test';
import { makeDataDir } from './harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function hold() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function startOn(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, MC_PORT: String(port), MC_BRIDGE_PORT: 'off', MC_RUNNER_PORT: 'off', MC_DATA_DIR: dataDir, MC_SUPERVISED: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, out: () => out };
}

describe('a second Mission Control on a taken port', () => {
  test('stops with code 73 and never loads the server', async () => {
    const taken = await hold();
    const { child, exited, out } = startOn(taken.address().port, makeDataDir('mc-porttaken'));
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
    if (code === 'timeout') child.kill();
    taken.close();
    assert.equal(code, 73, out());
    assert.match(out(), /is taken/);
    assert.doesNotMatch(out(), /Mission Control on http/);
  });

  test('takes the port when it is freed during the wait (a restart)', async () => {
    const taken = await hold();
    const port = taken.address().port;
    const { child, exited, out } = startOn(port, makeDataDir('mc-portfreed'));
    setTimeout(() => taken.close(), 1200);
    const up = await new Promise((resolve) => {
      const t = setInterval(() => {
        if (/Mission Control on http/.test(out())) {
          clearInterval(t);
          resolve(true);
        }
      }, 100);
      exited.then(() => {
        clearInterval(t);
        resolve(false);
      });
    });
    child.kill();
    await exited;
    assert.ok(up, out());
  });
});
