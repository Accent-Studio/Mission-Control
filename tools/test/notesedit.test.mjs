// Tests for editing notes from the Documents panel (design/notes-spec.md, "Editing from another device"): a hub, Home
// (owns the vault) and Work (linked to Home). Home edits its own note on disk; Work edits Home's note over the link while
// Home is on, and in the hub's copy while it is off (the hub commits it, Home takes it at its next sync). A note changed
// since the editor opened it is never overwritten, the line ends of a note stay, and a Home only folder stays off Work.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, describe, test } from 'node:test';
import { bridgeHeaders, bridgeReq, KNOWN_DEVICE, localReq, makeDataDir, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const call = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
const HOME_DEV = 'h'.repeat(40);
const WORK_DEV = 'w'.repeat(40);
const ENV = { MC_HUB_RETRY_MS: '500', MC_HUB_SYNC_MS: '60000', MC_NOTES_IDLE_MS: '300', MC_NOTES_PULL_MS: '600000', MC_RUNNER_PORT: 'off' };
const g = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
async function until(what, ok, ms = 20000) {
  const t0 = Date.now();
  while (!(await ok())) {
    if (Date.now() - t0 > ms) throw new Error(what);
    await new Promise((res) => setTimeout(res, 100));
  }
}

function makeVault(label, files) {
  const dir = makeDataDir(label);
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'core.autocrlf', 'false');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

describe('editing notes', () => {
  test("Home edits its own notes on disk; Work edits Home's over the link, and on the hub while Home is off", async () => {
    // the hub, with Home and Work paired as devices
    const hubDir = makeDataDir('mc-nedit-hub');
    fs.writeFileSync(path.join(hubDir, 'devices.json'), JSON.stringify([
      { id: HOME_DEV, name: 'Home', pairedAt: '2026-11-08T00:00:00Z', lastSeen: null },
      { id: WORK_DEV, name: 'Work', pairedAt: '2026-11-08T00:00:00Z', lastSeen: null },
    ]));
    fs.writeFileSync(path.join(hubDir, 'config.json'), JSON.stringify({ machineName: 'Hub' }));
    const hub = await startServer({ dataDir: hubDir, bridge: true, env: { MC_ROLE: 'hub', ...ENV } });
    toStop.push(hub);
    const secret = fs.readFileSync(hub.secretFile, 'utf8').trim();
    const hubJson = (device) => JSON.stringify({ url: `http://127.0.0.1:${hub.bridgePort}`, headers: { 'X-MC-Bridge': secret, 'X-MC-Device': device } });

    // Home: owns the vault; its project acme has the notes folder 01-Acme, other has Personal (Home only); Work is one of
    // its computers, paired with its bridge
    const vault = makeVault('mc-nedit-vault', {
      '.mc-notes.json': JSON.stringify({ homeOnly: ['Personal'] }),
      '01-Acme/Pitch.md': 'the pitch\n',
      '01-Acme/Windows.md': '﻿line one\r\nline two\r\n',
      'Personal/Private.md': 'secret\n',
    });
    const homeDir = makeDataDir('mc-nedit-home');
    fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({ machineName: 'Home', notesFolders: { acme: ['01-Acme'], other: ['Personal'] } }));
    fs.writeFileSync(path.join(homeDir, 'devices.json'), JSON.stringify([{ id: KNOWN_DEVICE, name: 'Work', pairedAt: '2026-11-08T00:00:00Z', lastSeen: null, computer: true }]));
    for (const name of ['acme', 'other']) {
      const proj = path.join(homeDir, 'no-projects-here', name);
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'README.md'), '# ' + name + '\n');
      g(proj, 'init', '-q');
    }
    fs.writeFileSync(path.join(homeDir, 'hub.json'), hubJson(HOME_DEV));
    const homeEnv = { ...ENV, MC_RECYCLE: 'move', MC_NOTES_ROOT: vault, MC_NOTES_REPOS: JSON.stringify([{ id: 'notes', dir: vault }]) };
    let home = await startServer({ dataDir: homeDir, bridge: true, env: homeEnv });
    toStop.push(home);
    assert.equal((await call(home, 'POST', '/api/notes/sync', {})).json.repos[0].state, 'in step');
    const mirror = path.join(hubDir, 'hub', 'notes', HOME_DEV, 'notes');

    // ---- Home, its own note: on disk, with the hash it opened with ----
    let f = await call(home, 'GET', '/api/projects/acme/file?root=n0&path=Pitch.md');
    assert.equal(f.text, 'the pitch\n');
    const h0 = f.headers['x-mc-hash'];
    assert.match(h0, /^[0-9a-f]{40}$/);
    let r = await call(home, 'PUT', '/api/projects/acme/file?root=n0&path=Pitch.md', { text: 'the pitch, edited at home\n', base: h0 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.saved, 'disk');
    assert.equal(read(vault, '01-Acme', 'Pitch.md'), 'the pitch, edited at home\n');
    // the old hash is stale now: the note is not overwritten, the editor gets what it holds
    r = await call(home, 'PUT', '/api/projects/acme/file?root=n0&path=Pitch.md', { text: 'an old tab\n', base: h0 });
    assert.equal(r.status, 409);
    assert.equal(r.json.text, 'the pitch, edited at home\n');
    assert.equal(read(vault, '01-Acme', 'Pitch.md'), 'the pitch, edited at home\n');
    // a textarea gives "\n": the note keeps its byte order mark and "\r\n"
    f = await call(home, 'GET', '/api/projects/acme/file?root=n0&path=Windows.md');
    r = await call(home, 'PUT', '/api/projects/acme/file?root=n0&path=Windows.md', { text: 'line one\nline 2\n', base: f.headers['x-mc-hash'] });
    assert.equal(r.status, 200);
    assert.equal(read(vault, '01-Acme', 'Windows.md'), '﻿line one\r\nline 2\r\n');
    // the project folder itself is read only, and nothing outside the notes folder is reached
    assert.equal((await call(home, 'PUT', '/api/projects/acme/file?root=p&path=README.md', { text: 'x' })).status, 403);
    assert.equal((await call(home, 'PUT', '/api/projects/acme/file?root=n0&path=../Personal/Private.md', { text: 'x' })).status, 403);
    assert.equal((await call(home, 'PUT', '/api/projects/acme/file?root=n0&path=Missing.md', { text: 'x' })).status, 404);
    // the notes sync takes the edits up to the hub
    await until('the edit never reached the hub', () => fs.existsSync(mirror) && read(mirror, '01-Acme', 'Pitch.md') === 'the pitch, edited at home\n' && read(mirror, '01-Acme', 'Windows.md') === '﻿line one\r\nline 2\r\n');

    // ---- Work, linked to Home ----
    const workDir = makeDataDir('mc-nedit-work');
    fs.writeFileSync(path.join(workDir, 'config.json'), JSON.stringify({ machineName: 'Work' }));
    fs.writeFileSync(path.join(workDir, 'hub.json'), hubJson(WORK_DEV));
    const work = await startServer({ dataDir: workDir, bridge: false, env: { ...ENV, MC_NOTES_REPOS: '[]', MC_PC_LINK_TEST: JSON.stringify({ name: 'Home', url: `http://127.0.0.1:${home.bridgePort}`, headers: bridgeHeaders(home) }) } });
    toStop.push(work);
    await call(work, 'POST', '/api/pc-link/refresh', {});

    // Home is on: Work reads Home's own copy and saves there, on disk
    f = await call(work, 'GET', '/api/pc/projects/acme/file?root=r0&path=Pitch.md');
    assert.equal(f.text, 'the pitch, edited at home\n');
    r = await call(work, 'PUT', '/api/pc/projects/acme/file?root=r0&path=Pitch.md', { text: 'the pitch, from work\n', base: f.headers['x-mc-hash'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.saved, 'pc');
    assert.equal(r.json.owner, 'Home');
    assert.equal(read(vault, '01-Acme', 'Pitch.md'), 'the pitch, from work\n');
    // a stale hash from Work comes back as a conflict too
    r = await call(work, 'PUT', '/api/pc/projects/acme/file?root=r0&path=Pitch.md', { text: 'stale\n', base: f.headers['x-mc-hash'] });
    assert.equal(r.status, 409);
    assert.equal(r.json.text, 'the pitch, from work\n');
    // a Home only folder stays off Work over the link too
    const viaLink = (method, p, body) => bridgeReq(home, { method, path: p, body, hdr: { post: method !== 'GET' } });
    assert.equal((await viaLink('PUT', '/api/notes/notes/file?path=' + encodeURIComponent('Personal/Private.md'), { text: 'x' })).status, 403);
    assert.equal((await viaLink('GET', '/api/notes/notes/file?path=' + encodeURIComponent('Personal/Private.md'))).status, 403);
    assert.equal((await viaLink('GET', '/api/notes/notes/file?path=' + encodeURIComponent('.git/config'))).status, 403);
    assert.equal(read(vault, 'Personal', 'Private.md'), 'secret\n');
    await until('the edit from Work never reached the hub', () => read(mirror, '01-Acme', 'Pitch.md') === 'the pitch, from work\n');

    // file actions from Work happen on Home, inside the notes folder (lib/noteOps.js), paths as Work sees them
    const opW = (body) => call(work, 'POST', '/api/pc/projects/acme/notes-op', { root: 'r0', ...body });
    r = await opW({ op: 'note', dir: '', name: 'From work' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.path, 'From work.md');
    assert.ok(fs.existsSync(path.join(vault, '01-Acme', 'From work.md')));
    r = await opW({ op: 'folder', dir: '', name: 'Ideas' });
    r = await opW({ op: 'move', paths: ['From work.md'], to: 'Ideas' });
    assert.deepEqual(r.json.paths, ['Ideas/From work.md']);
    r = await opW({ op: 'rename', path: 'Ideas/From work.md', name: 'Renamed' });
    assert.equal(r.json.path, 'Ideas/Renamed.md');
    assert.ok(fs.existsSync(path.join(vault, '01-Acme', 'Ideas', 'Renamed.md')));
    assert.equal((await opW({ op: 'move', paths: ['Ideas/Renamed.md'], to: '..' })).status, 400); // never above its notes folder
    assert.equal((await viaLink('POST', '/api/notes/notes/op', { op: 'delete', paths: ['Personal/Private.md'] })).status, 403);
    assert.equal((await viaLink('POST', '/api/notes/notes/op', { op: 'rename', path: 'Personal', name: 'Open' })).status, 403);
    assert.equal(read(vault, 'Personal', 'Private.md'), 'secret\n');
    r = await opW({ op: 'delete', paths: ['Ideas'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(!fs.existsSync(path.join(vault, '01-Acme', 'Ideas')));

    // ---- Home is off: Work edits the hub's copy, and the hub commits it ----
    await home.stop();
    // making, moving and deleting files waits for Home to be on
    r = await call(work, 'POST', '/api/pc/projects/acme/notes-op', { root: 'r0', op: 'note', dir: '', name: 'Offline' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Home is off/);
    f = await call(work, 'GET', '/api/pc/projects/acme/file?root=r0&path=Pitch.md');
    assert.equal(f.status, 200);
    assert.equal(f.text, 'the pitch, from work\n');
    r = await call(work, 'PUT', '/api/pc/projects/acme/file?root=r0&path=Pitch.md', { text: 'the pitch, while home was off\n', base: f.headers['x-mc-hash'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.saved, 'hub');
    assert.equal(read(mirror, '01-Acme', 'Pitch.md'), 'the pitch, while home was off\n');
    assert.equal(g(mirror, 'status', '--porcelain'), '');
    assert.match(g(mirror, 'log', '-1', '--format=%s').trim(), /^Edited on Work \(the hub's copy\): 01-Acme\/Pitch\.md$/);
    // the hub keeps the same rule: a stale hash never overwrites
    r = await call(work, 'PUT', '/api/pc/projects/acme/file?root=r0&path=Pitch.md', { text: 'stale\n', base: f.headers['x-mc-hash'] });
    assert.equal(r.status, 409);
    assert.equal(read(mirror, '01-Acme', 'Pitch.md'), 'the pitch, while home was off\n');

    // ---- Home is back: its next sync takes the edit ----
    home = await startServer({ dataDir: homeDir, bridge: false, env: homeEnv });
    toStop.push(home);
    assert.equal((await call(home, 'POST', '/api/notes/sync', {})).json.repos[0].state, 'in step');
    assert.equal(read(vault, '01-Acme', 'Pitch.md'), 'the pitch, while home was off\n');
  });
});
