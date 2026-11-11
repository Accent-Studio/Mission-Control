// Tests for the Sync button (services/sync.js): a project's branch brought in step with its remote in whichever direction
// it needs (a fast-forward, a push, a rebase then a push), a conflict that leaves the folder exactly as it was, a public
// repository that is never pushed, and the commit step: Claude in a conversation the lists never show, until it needs you.
// The remote is a bare repository in the test's own folder; Claude is the FAKE CLI in tools/fakeclaude.
// Run: npm test (2 test files at a time)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ROOT, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;
const pc = (s, method, p, body) => localReq(s, { method, path: p, headers: method === 'GET' ? {} : { 'X-MC': '1' }, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}

// The fixture project as a repository with a bare remote, and a second clone of it: the other PC.
function setup(label) {
  const dataDir = makeDataDir(label);
  seedFixture(dataDir);
  const repo = path.join(dataDir, 'fixture-project');
  const bare = path.join(dataDir, 'remote.git');
  const other = path.join(dataDir, 'other-pc');
  const git = (dir) => (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
  const g = git(repo);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'first');
  g('remote', 'add', 'origin', bare);
  g('push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', bare, other], { windowsHide: true, stdio: 'ignore' });
  const o = git(other);
  o('config', 'user.email', 'other@example.com');
  o('config', 'user.name', 'Other');
  const remoteHead = () => git(bare)('rev-parse', 'main');
  return { dataDir, repo, g, o, remoteHead, write: (dir, f, t) => fs.writeFileSync(path.join(dir, f), t) };
}

async function sync(s) {
  const r = await pc(s, 'POST', '/api/projects/fixture/sync', {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.state.busy, true);
  return waitFor(async () => {
    const st = (await pc(s, 'GET', '/api/projects/fixture/sync')).json.state;
    return st && !st.busy && st;
  }, 'the sync to end');
}

describe('the Sync button', () => {
  test('pull, push, rebase then push, and a conflict that changes nothing', async () => {
    const t = setup('mc-sync');
    const s = await startServer({ dataDir: t.dataDir, bridge: false, env: { MC_SYNC_VISIBILITY: 'private' } });
    toStop.push(s);

    assert.equal((await pc(s, 'GET', '/api/projects/fixture/sync')).json.state, null);

    // in step: nothing to do
    let st = await sync(s);
    assert.equal(st.phase, 'done', st.detail);
    assert.equal(st.detail, 'Already in step');

    // only the other PC has new commits: a fast-forward
    t.write(path.join(t.dataDir, 'other-pc'), 'b.txt', 'bee\n');
    t.o('add', 'b.txt');
    t.o('commit', '-q', '-m', 'b from the other PC');
    t.o('push', '-q');
    st = await sync(s);
    assert.equal(st.phase, 'done', st.detail);
    assert.equal(st.done.pulled, 1);
    assert.equal(t.g('rev-parse', 'HEAD'), t.remoteHead());

    // only this side: pushed
    t.write(t.repo, 'c.txt', 'sea\n');
    t.g('add', 'c.txt');
    t.g('commit', '-q', '-m', 'c here');
    st = await sync(s);
    assert.equal(st.phase, 'done', st.detail);
    assert.equal(st.done.pushed, 1);
    assert.equal(t.remoteHead(), t.g('rev-parse', 'HEAD'));

    // both sides, different files: this side's commit goes on top, then out; the history stays a line
    t.o('pull', '-q');
    t.write(path.join(t.dataDir, 'other-pc'), 'd.txt', 'dee\n');
    t.o('add', 'd.txt');
    t.o('commit', '-q', '-m', 'd from the other PC');
    t.o('push', '-q');
    t.write(t.repo, 'e.txt', 'ee\n');
    t.g('add', 'e.txt');
    t.g('commit', '-q', '-m', 'e here');
    st = await sync(s);
    assert.equal(st.phase, 'done', st.detail);
    assert.equal(st.done.pulled, 1);
    assert.equal(st.done.pushed, 1);
    assert.equal(t.remoteHead(), t.g('rev-parse', 'HEAD'));
    assert.equal(t.g('rev-list', '--merges', '--count', 'HEAD'), '0');
    assert.deepEqual(t.g('log', '--format=%s', '-2').split('\n'), ['e here', 'd from the other PC']);

    // both sides change the same line: Sync stops, and the folder is as it was
    t.o('pull', '-q');
    t.write(path.join(t.dataDir, 'other-pc'), 'a.txt', 'one\nTWO there\nthree\n');
    t.o('commit', '-q', '-am', 'a there');
    t.o('push', '-q');
    t.write(t.repo, 'a.txt', 'one\nTWO here\nthree\n');
    t.g('commit', '-q', '-am', 'a here');
    const before = t.g('rev-parse', 'HEAD');
    const remoteBefore = t.remoteHead();
    st = await sync(s);
    assert.equal(st.phase, 'needs');
    assert.equal(st.kind, 'conflict');
    assert.deepEqual(st.files, ['a.txt']);
    assert.match(st.detail, /Nothing was changed/);
    assert.equal(t.g('rev-parse', 'HEAD'), before);
    assert.equal(t.remoteHead(), remoteBefore);
    assert.equal(t.g('status', '--porcelain'), '');
    assert.equal(fs.existsSync(path.join(t.repo, '.git', 'rebase-merge')), false);

    // a second sync while one runs is refused, and an unknown project is a 404
    const a = await pc(s, 'POST', '/api/projects/fixture/sync', {});
    const b = await pc(s, 'POST', '/api/projects/fixture/sync', {});
    assert.equal(a.status, 200);
    assert.equal(b.status, 409);
    await waitFor(async () => !(await pc(s, 'GET', '/api/projects/fixture/sync')).json.state.busy, 'the last sync');
    assert.equal((await pc(s, 'POST', '/api/projects/nope/sync', {})).status, 404);
  });

  test('a public repository is not pushed from here', async () => {
    const t = setup('mc-sync-public');
    const s = await startServer({ dataDir: t.dataDir, bridge: false, env: { MC_SYNC_VISIBILITY: 'public' } });
    toStop.push(s);
    t.write(t.repo, 'c.txt', 'sea\n');
    t.g('add', 'c.txt');
    t.g('commit', '-q', '-m', 'c here');
    const remoteBefore = t.remoteHead();
    const st = await sync(s);
    assert.equal(st.phase, 'needs');
    assert.equal(st.kind, 'public');
    assert.match(st.detail, /Review and push/);
    assert.equal(t.remoteHead(), remoteBefore);
  });

  test('the commit step stays out of the lists until it needs you', async () => {
    const t = setup('mc-sync-commit');
    const tdir = path.join(t.dataDir, 'claude-home', 'projects', 'fixture');
    fs.mkdirSync(tdir, { recursive: true });
    // the fake echoes its prompt back, so a prompt whose last line is the verdict reads as Claude's own answer
    const donePrompt = path.join(t.dataDir, 'sync-done.md');
    fs.writeFileSync(donePrompt, 'Commit the changes in {{project}} on {{branch}}:\n{{files}}\nSYNC: done - nothing worth keeping');
    const s = await startServer({ dataDir: t.dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '30', FAKE_TRANSCRIPT: tdir, MC_SYNC_VISIBILITY: 'private', MC_SYNC_PROMPT_FILE: donePrompt } });
    toStop.push(s);
    const listed = async (sid) => ((await pc(s, 'GET', '/api/sessions?project=fixture&limit=50')).json || []).some((r) => r.id === sid);

    // a new file only: the commit step runs hidden, says done, and the file is left out of git
    t.write(t.repo, 'notes.txt', 'scratch\n');
    let st = await sync(s);
    assert.equal(st.phase, 'done', st.detail);
    assert.ok(st.sessionId, 'the commit step had a conversation');
    assert.match(st.notes.join(' '), /notes\.txt/);
    const hiddenSid = st.sessionId;
    await sleep(300);
    assert.equal(await listed(hiddenSid), false, 'a finished commit step is not listed');
    assert.ok(!((await pc(s, 'GET', '/api/runs')).json || []).some((r) => r.sessionId === hiddenSid && r.running));

    // the same new file again: no new commit step for it
    st = await sync(s);
    assert.equal(st.phase, 'done', st.detail);
    assert.equal(st.sessionId, null);
  });

  test('a commit step that gives no verdict is shown, and Sync stops before pulling', async () => {
    const t = setup('mc-sync-verdict');
    const tdir = path.join(t.dataDir, 'claude-home', 'projects', 'fixture');
    fs.mkdirSync(tdir, { recursive: true });
    const s = await startServer({ dataDir: t.dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '30', FAKE_TRANSCRIPT: tdir, MC_SYNC_VISIBILITY: 'private' } });
    toStop.push(s);
    t.write(path.join(t.dataDir, 'other-pc'), 'b.txt', 'bee\n');
    t.o('add', 'b.txt');
    t.o('commit', '-q', '-m', 'b there');
    t.o('push', '-q');
    t.write(t.repo, 'a.txt', 'changed here\n');
    const before = t.g('rev-parse', 'HEAD');
    const st = await sync(s);
    assert.equal(st.phase, 'needs');
    assert.equal(st.kind, 'commit');
    assert.ok(st.sessionId);
    assert.equal(t.g('rev-parse', 'HEAD'), before, 'nothing was pulled');
    await waitFor(async () => ((await pc(s, 'GET', '/api/sessions?project=fixture&limit=50')).json || []).some((r) => r.id === st.sessionId), 'the conversation in the list');
    // Ask Claude opens that same conversation
    const ask = await pc(s, 'POST', '/api/projects/fixture/sync/ask', {});
    assert.equal(ask.status, 200, ask.text);
    assert.equal(ask.json.sessionId, st.sessionId);
  });
});
