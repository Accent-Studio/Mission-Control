// Shared helpers for the node tests: start a throwaway Mission Control server on free 47xxx-style ports with its
// own data folder, talk to it with raw headers, and stop it by its exact process id. No npm packages.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KNOWN_DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

// A free loopback port. With MC_TEST_PORTS=48850-48899 (first-last) the port comes from that range instead of the system's
// choice, so a test run stays clear of the real Mission Control ports.
export async function freePort() {
  const range = /^(\d+)-(\d+)$/.exec(process.env.MC_TEST_PORTS || '');
  const tryPort = (port) =>
    new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => {
        const got = s.address().port;
        s.close(() => resolve(got));
      });
    });
  if (!range) return tryPort(0);
  const first = Number(range[1]);
  const count = Number(range[2]) - first + 1;
  const start = Math.floor(Math.random() * count);
  for (let i = 0; i < count; i++) {
    const port = first + ((start + i) % count);
    if (recentPorts.includes(port)) continue; // a server of this process may not have bound it yet
    try {
      const got = await tryPort(port);
      recentPorts.push(got);
      if (recentPorts.length > 12) recentPorts.shift();
      return got;
    } catch {
      // taken, try the next one
    }
  }
  throw new Error('no free port in ' + process.env.MC_TEST_PORTS);
}
const recentPorts = [];

const madeDirs = [];
export function makeDataDir(label = 'mc-test') {
  const dir = fs.mkdtempSync(path.join(process.env.MC_TEST_TMP || os.tmpdir(), `${label}-`));
  madeDirs.push(dir);
  return dir;
}

// The runner may end a file without running a top-level after() hook, so the exit of the process cleans up too.
process.on('exit', () => removeTempDirs());

// Deletes every folder makeDataDir handed out (call after the servers using them have stopped).
export function removeTempDirs() {
  for (const dir of madeDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.error(`could not remove ${dir}: ${err.message}`);
    }
  }
}

// A catalog with one project that has two jobs: one outward (never runs, it needs a typed confirmation) and one
// harmless whose script does not exist (so a start attempt fails with 400 and nothing is ever executed).
export function seedFixture(dataDir) {
  const folder = path.join(dataDir, 'fixture-project');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'ship.bat'), '@echo off\r\necho this must never run\r\n');
  fs.writeFileSync(
    path.join(dataDir, 'projects.json'),
    JSON.stringify({
      projects: [
        {
          id: 'fixture',
          name: 'Fixture',
          folder,
          about: '',
          watch: [],
          checks: [],
          jobs: [
            { id: 'ship', label: 'Ship', file: 'ship.bat', kind: 'other', outward: true, interactive: false, order: 1, visible: true },
            { id: 'build', label: 'Build', file: 'missing.bat', kind: 'other', outward: false, interactive: false, order: 2, visible: true },
            // Outward by kind alone (the flag is off): a phone must still be refused.
            ...['push-github', 'publish-website', 'release', 'deploy', 'sync'].map((kind, i) => (
              { id: `kind-${kind}`, label: kind, file: 'ship.bat', kind, outward: false, interactive: false, order: 3 + i, visible: true }
            )),
            { id: 'gitpush', label: 'Git push', file: '', builtin: 'git-push', kind: 'other', outward: false, interactive: false, order: 9, visible: true },
          ],
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dataDir, 'devices.json'),
    JSON.stringify([{ id: KNOWN_DEVICE, name: 'Test Phone', pairedAt: '2026-10-12T00:00:00Z', lastSeen: null }]),
  );
  return folder;
}

// Starts `node server/index.js` and waits until the main listener (and the bridge listener, unless off) is up.
export async function startServer({ dataDir, bridge = true, env = {}, wantBridgeLine = bridge } = {}) {
  const port = await freePort();
  const bridgePort = bridge === true ? await freePort() : typeof bridge === 'number' ? bridge : null;
  const emptyRoots = path.join(dataDir, 'no-projects-here');
  fs.mkdirSync(emptyRoots, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MC_PORT: String(port),
      MC_BRIDGE_PORT: bridge === false ? 'off' : String(bridgePort),
      MC_DATA_DIR: dataDir,
      MC_DISCOVERY_ROOTS: emptyRoots,
      MC_VOICE_CONTROL_FILE: path.join(dataDir, 'no-voice-control.json'),
      MC_CLAUDE_HOME: path.join(dataDir, 'claude-home'),
      MC_SUPERVISED: '',
      MC_RUNNER_PORT: 'off', // a test server starts claude directly unless the test brings its own runner (runner.test.mjs)
      MC_AUTO_TITLE: 'off', // no naming call per new conversation, unless the test is about it (autotitle.test.mjs)
      ...env,
    },
  });
  const out = { text: '' };
  child.stdout.on('data', (d) => (out.text += d));
  child.stderr.on('data', (d) => (out.text += d));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const started = Date.now();
  while (!/Mission Control on http/.test(out.text) || (wantBridgeLine && !/Bridge listener on http/.test(out.text))) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${out.text}`);
    if (Date.now() - started > 20000) {
      child.kill();
      throw new Error(`server did not start:\n${out.text}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    child,
    pid: child.pid,
    port,
    bridgePort,
    dataDir,
    out,
    exited,
    secretFile: path.join(dataDir, 'bridge', 'secret'),
    // Stops this exact process (never by name).
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

// One request on a fresh connection. `host` overrides the Host header; `headers` are sent as given.
export function request({ port, method = 'GET', path: p = '/', headers = {}, body, host }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host !== undefined) h.Host = host;
    let payload = body;
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body);
      h['Content-Type'] = h['Content-Type'] || 'application/json';
    }
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Headers a correct bridge sends for a phone request (Host is set by the caller through `host` or the default below).
export function bridgeHeaders(server, { device = KNOWN_DEVICE, secret, post = false, origin } = {}) {
  const s = secret ?? fs.readFileSync(server.secretFile, 'utf8').trim();
  const h = { 'X-MC-Bridge': s };
  if (device !== null) h['X-MC-Device'] = device;
  if (post) h['X-MC'] = '1';
  if (origin !== undefined) h.Origin = origin;
  return h;
}

export const bridgeReq = (server, opts = {}) =>
  request({
    port: server.bridgePort,
    host: opts.host ?? `127.0.0.1:${server.bridgePort}`,
    method: opts.method,
    path: opts.path,
    body: opts.body,
    headers: { ...bridgeHeaders(server, opts.hdr || {}), ...(opts.headers || {}) },
  });

export const localReq = (server, opts = {}) =>
  request({ port: server.port, host: opts.host ?? `127.0.0.1:${server.port}`, method: opts.method, path: opts.path, body: opts.body, headers: opts.headers });

// True when nothing listens on the port any more.
export function portClosed(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => resolve(true));
  });
}
