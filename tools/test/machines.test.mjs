// Tests for the Sync panel (services/machines.js): two computers that share a repository, Work (this one) and Home (the
// other, reached as a paired device on its bridge listener the way the PC link reaches it). Sync all asks Home to push
// its commits first, then syncs here, then has Home pull. Home never commits for it and never touches an uncommitted
// file, and it does nothing at all until Home allows Work as a linked computer.
// Run: npm test (2 test files at a time)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { restartDue } from '../../server/lib/codeAge.js';
import { KNOWN_DEVICE, ROOT, bridgeHeaders, bridgeReq, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH; // never the real Claude
const toStop = [];
after(async () => {
  for (const s of toStop.reverse()) await s.stop().catch(() => {});
});
const pc = (s, method, p, body) => localReq(s, { method, path: p, headers: method === 'GET' ? {} : { 'X-MC': '1' }, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}
const gitIn = (dir) => (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function syncAll(s, remote) {
  const r = await pc(s, 'POST', '/api/sync/machines/sync', { remote });
  assert.equal(r.status, 200, r.text);
  return waitFor(async () => {
    const v = (await pc(s, 'GET', '/api/sync/machines')).json.view;
    const sh = v && v.shared.find((x) => x.remote === r.json.state.remote);
    return sh && sh.sync && !sh.sync.busy && !v.crossing && sh.sync;
  }, 'Sync all to end');
}

describe('the Sync panel', () => {
  test('Home pushes first, Work syncs, Home pulls; only committed work, and only once Home allows it', async () => {
    const work = makeDataDir('mc-machines-work');
    const home = makeDataDir('mc-machines-home');
    const bare = path.join(work, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
    const wRepo = seedFixture(work);
    const w = gitIn(wRepo);
    w('init', '-q', '-b', 'main');
    w('config', 'user.email', 'work@example.com');
    w('config', 'user.name', 'Work');
    fs.writeFileSync(path.join(wRepo, 'a.txt'), 'one\n');
    w('add', '-A');
    w('commit', '-q', '-m', 'first');
    w('remote', 'add', 'origin', bare);
    w('push', '-q', '-u', 'origin', 'main');
    const hRepo = seedFixture(home);
    fs.rmSync(hRepo, { recursive: true, force: true });
    execFileSync('git', ['clone', '-q', bare, hRepo], { windowsHide: true, stdio: 'ignore' });
    const h = gitIn(hRepo);
    h('config', 'user.email', 'home@example.com');
    h('config', 'user.name', 'Home');
    const remoteHead = () => gitIn(bare)('rev-parse', 'main');
    for (const d of [work, home]) fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ machineName: path.basename(d).includes('work') ? 'Work' : 'Home' }));

    const common = { PATH: FAKE_PATH, MC_SYNC_VISIBILITY: 'private', MC_MACHINES_POLL_MS: '100' };
    const tdir = path.join(home, 'claude-home', 'projects', 'fixture');
    fs.mkdirSync(tdir, { recursive: true });
    const H = await startServer({ dataDir: home, bridge: true, env: { ...common, FAKE_STEP_MS: '30', FAKE_TRANSCRIPT: tdir, MC_SYNC_SELF_DIR: path.join(home, 'no-mc'), MC_DUE_TEST: 'bridge' } });
    toStop.push(H);
    const link = { name: 'Home', url: `http://127.0.0.1:${H.bridgePort}`, headers: bridgeHeaders(H) };
    const W = await startServer({ dataDir: work, bridge: false, env: { ...common, MC_SYNC_SELF_DIR: path.join(work, 'no-mc'), MC_PC_LINK_TEST: JSON.stringify(link) } });
    toStop.push(W);

    // what each computer has, matched by the remote
    const r0 = await pc(W, 'POST', '/api/sync/machines/refresh', {});
    assert.equal(r0.status, 200, r0.text);
    const v0 = r0.json.view;
    assert.deepEqual(v0.machines.map((m) => [m.which, m.name, m.online]), [['here', 'Work', true], ['pc', 'Home', true]]);
    // Home's bridge has a new build waiting: only Restart all three helps there
    assert.deepEqual(v0.machines.map((m) => [m.restart, m.restartAll, m.runnerOld, m.bridgeOld]), [[false, false, false, false], [true, true, false, true]]);
    assert.equal(v0.shared.length, 1);
    const remote = v0.shared[0].remote;
    assert.deepEqual(v0.shared[0].rows.map((r) => [r.name, r.words]), [['Work', 'In step'], ['Home', 'In step']]);

    // Home has a commit and an uncommitted change; Work has a commit of its own
    fs.writeFileSync(path.join(hRepo, 'b.txt'), 'bee\n');
    h('add', 'b.txt');
    h('commit', '-q', '-m', 'b at home');
    fs.writeFileSync(path.join(hRepo, 'a.txt'), 'one, edited at home\n');
    fs.writeFileSync(path.join(hRepo, 'scratch.txt'), 'mine\n');
    fs.writeFileSync(path.join(wRepo, 'e.txt'), 'ee\n');
    w('add', 'e.txt');
    w('commit', '-q', '-m', 'e at work');

    const v1 = (await pc(W, 'POST', '/api/sync/machines/refresh', {})).json.view;
    assert.deepEqual(v1.shared[0].rows.map((r) => r.words), ['1 commit to push', '1 commit to push, 1 uncommitted file']);

    // a device that is not a linked computer may not ask
    const phone = await bridgeReq(H, { method: 'POST', path: '/api/sync/remote', body: { remote }, hdr: { post: true } });
    assert.equal(phone.status, 403);
    // nor restart Home's runner and bridge: a phone restarts the server alone
    const phoneAll = await bridgeReq(H, { method: 'POST', path: '/api/server/restart', body: { confirm: true, all: true }, hdr: { post: true } });
    assert.equal(phoneAll.status, 403, phoneAll.text);
    assert.equal(phoneAll.json.error, 'pc_only');
    const farAll = await pc(W, 'POST', '/api/sync/machines/restart', { which: 'pc', all: true, confirm: true });
    assert.equal(farAll.status, 403, farAll.text);
    assert.match(farAll.json.error, /has not allowed Work to restart all three/);
    let st = await syncAll(W, remote);
    assert.equal(st.phase, 'needs', st.detail);
    assert.equal(st.kind, 'left', st.detail);
    assert.match(st.notes.join(' '), /Home has not allowed Work to sync it.*Linked computer/);
    assert.equal(remoteHead(), w('rev-parse', 'HEAD'), 'Work still synced itself');
    assert.equal(h('log', '-1', '--format=%s'), 'b at home', 'nothing changed at Home');

    // Home allows it (at Home). Its commit now has to go on top of Work's, around an uncommitted file: not tried
    const allow = await pc(H, 'POST', `/api/devices/${KNOWN_DEVICE}/computer`, { on: true });
    assert.equal(allow.status, 200, allow.text);
    assert.equal(allow.json.computer, true);
    const workHead = w('rev-parse', 'HEAD');
    st = await syncAll(W, remote);
    assert.equal(st.phase, 'needs');
    assert.equal(st.where, 'pc');
    assert.equal(st.kind, 'dirty');
    assert.match(st.detail, /^Home: .*uncommitted file/);
    assert.equal(w('rev-parse', 'HEAD'), workHead, 'nothing changed at Work');
    assert.equal(fs.readFileSync(path.join(hRepo, 'a.txt'), 'utf8'), 'one, edited at home\n');
    // Ask Sonnet: the conversation starts at Home, where it stopped, and is told whose changes those are
    const ask = await pc(W, 'POST', '/api/sync/machines/ask', { remote, model: 'sonnet' });
    assert.equal(ask.status, 200, ask.text);
    assert.equal(ask.json.where, 'pc');
    assert.ok(ask.json.sessionId, 'Home answered with its conversation');
    const homeRuns = await waitFor(async () => { const r = (await pc(H, 'GET', '/api/runs')).json || []; return r.find((x) => x.sessionId === ask.json.sessionId) && r; }, 'the conversation at Home');
    assert.ok(homeRuns.length >= 1);

    // with the edit put away (the new file stays): Home rebases and pushes, Work pulls, Home is in step
    h('checkout', '--', 'a.txt');
    st = await syncAll(W, remote);
    assert.equal(st.phase, 'done', `${st.detail} ${JSON.stringify(st.notes)}`);
    assert.equal(remoteHead(), w('rev-parse', 'HEAD'));
    assert.equal(remoteHead(), h('rev-parse', 'HEAD'));
    assert.deepEqual(w('log', '--format=%s', '-3').split('\n'), ['b at home', 'e at work', 'first']);
    assert.equal(w('rev-list', '--merges', '--count', 'HEAD'), '0');
    assert.equal(fs.readFileSync(path.join(hRepo, 'scratch.txt'), 'utf8'), 'mine\n');
    assert.equal(h('status', '--porcelain'), '?? scratch.txt', 'Home never committed for it');
    const v2 = (await pc(W, 'GET', '/api/sync/machines')).json.view;
    assert.deepEqual(v2.shared[0].rows.map((r) => r.words), ['In step', 'In step']);
    const homeSaw = (await pc(H, 'GET', '/api/projects/fixture/sync')).json.state;
    assert.equal(homeSaw.by, 'Test Phone', 'Home knows who asked');

    // a restart of Home goes through the link (a test server is not supervised, so it says no)
    const rs = await pc(W, 'POST', '/api/sync/machines/restart', { which: 'pc', confirm: true });
    assert.equal(rs.status, 409, rs.text);
    assert.match(rs.json.error, /Restart only works/);
    assert.equal((await pc(W, 'POST', '/api/sync/machines/restart', { which: 'pc' })).status, 400);
    // a linked computer may restart all three there (past the device check: a test server is not supervised)
    const rsAll = await pc(W, 'POST', '/api/sync/machines/restart', { which: 'pc', all: true, confirm: true });
    assert.equal(rsAll.status, 409, rsAll.text);
    assert.match(rsAll.json.error, /Restart only works/);
  });

  test('what needs a restart: the server alone, or all three; an older Mission Control only says code.restart', () => {
    assert.deepEqual(restartDue({ restart: true }), { server: true, runner: false, bridge: false, all: false });
    assert.deepEqual(restartDue({ restart: false, runner: true, bridge: false }), { server: false, runner: true, bridge: false, all: true });
    assert.deepEqual(restartDue({ restart: false, bridge: true }).all, true);
    assert.deepEqual(restartDue(null), { server: false, runner: false, bridge: false, all: false });
  });

  test('a view kept from before a restart is marked stale, and a restart that was due is not kept as a note', async () => {
    const dir = makeDataDir('mc-machines-stale');
    const remote = 'github.com/example/mc';
    const sync = { remote, phase: 'done', label: 'Synced', detail: 'Every computer that is on is in step', busy: false, at: '2026-11-05T04:44:00.000Z',
      notes: ['Home: Restart Mission Control to run the new code', 'Home and Hub run older code: restart them to use the new one', 'Home: package.json changed: run npm install'] };
    fs.writeFileSync(path.join(dir, 'machines.json'), JSON.stringify({
      at: '2026-11-05T04:44:00.000Z',
      machines: [{ which: 'here', name: 'Work', online: true, startedAt: '2026-11-05T04:00:00.000Z', restart: true, role: 'pc' }],
      shared: [{ remote, name: 'Mission Control', self: true, id: null, rows: [], todo: false, sync }],
    }));
    const S = await startServer({ dataDir: dir, bridge: false, env: { MC_SYNC_SELF_DIR: path.join(dir, 'no-mc') } });
    toStop.push(S);
    const v = (await pc(S, 'GET', '/api/sync/machines')).json.view;
    assert.equal(v.stale, true, 'read by an earlier run of the server');
    assert.deepEqual(v.shared[0].sync.notes, ['Home: package.json changed: run npm install']);
    const fresh = (await pc(S, 'POST', '/api/sync/machines/refresh', {})).json.view;
    assert.equal(fresh.stale, false);
    assert.equal(fresh.machines[0].restart, false);
  });
});
