// Tests for the notes vaults' sync (services/notesSync.js, services/notesHub.js): a hub and two PCs, Home and Work, that
// reach it as paired devices. Home's vault goes up to the hub with git, an edit made on the hub's copy comes back down, the
// same line changed on both sides keeps both versions, and Work's vault of the same name is a repo of its own.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, describe, test } from 'node:test';
import { bridgeHeaders, KNOWN_DEVICE, localReq, makeDataDir, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const call = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
const HOME_DEV = 'h'.repeat(40);
const WORK_DEV = 'w'.repeat(40);
const ENV = { MC_HUB_RETRY_MS: '500', MC_HUB_SYNC_MS: '60000', MC_NOTES_IDLE_MS: '300', MC_NOTES_PULL_MS: '600000', MC_RUNNER_PORT: 'off' };
const g = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

function makeVault(label, files) {
  const dir = makeDataDir(label);
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'config', 'user.name', 'T');
  g(dir, 'config', 'user.email', 't@t');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

async function startHub() {
  const dataDir = makeDataDir('mc-nsync-hub');
  fs.writeFileSync(path.join(dataDir, 'devices.json'), JSON.stringify([
    { id: HOME_DEV, name: 'Home', pairedAt: '2026-11-04T00:00:00Z', lastSeen: null },
    { id: WORK_DEV, name: 'Work', pairedAt: '2026-11-04T00:00:00Z', lastSeen: null },
  ]));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ machineName: 'Hub' }));
  const s = await startServer({ dataDir, bridge: true, env: { MC_ROLE: 'hub', ...ENV } });
  s.dataDir = dataDir;
  toStop.push(s);
  return s;
}
async function startPc(hub, name, device, vault, { config = {}, projects = [] } = {}) {
  const dataDir = makeDataDir('mc-nsync-' + name.toLowerCase());
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ machineName: name, ...config }));
  for (const p of projects) {
    fs.mkdirSync(path.join(dataDir, 'no-projects-here', p), { recursive: true }); // the harness's discovery root
    fs.writeFileSync(path.join(dataDir, 'no-projects-here', p, 'README.md'), '# ' + p + '\n');
    g(path.join(dataDir, 'no-projects-here', p), 'init', '-q'); // a project is a folder with a .git
  }
  const secret = fs.readFileSync(hub.secretFile, 'utf8').trim();
  fs.writeFileSync(path.join(dataDir, 'hub.json'), JSON.stringify({ url: `http://127.0.0.1:${hub.bridgePort}`, headers: { 'X-MC-Bridge': secret, 'X-MC-Device': device } }));
  const s = await startServer({ dataDir, bridge: false, env: { ...ENV, MC_NOTES_REPOS: JSON.stringify([{ id: 'notes', dir: vault }]) } });
  toStop.push(s);
  return s;
}
const syncNow = async (s) => (await call(s, 'POST', '/api/notes/sync', {})).json.repos[0];

describe('the notes sync', () => {
  test('a vault goes up, a hub edit comes down, a conflict keeps both, and each machine has its own repo', async () => {
    const hub = await startHub();
    const homeVault = makeVault('mc-nsync-vault-home', { 'BlitzRaw/Spec.md': 'line one\nline two\n', 'Personal/Private.md': 'secret\n' });
    const workVault = makeVault('mc-nsync-vault-work', { 'Work/Only.md': 'work\n' });
    const home = await startPc(hub, 'Home', HOME_DEV, homeVault);
    const work = await startPc(hub, 'Work', WORK_DEV, workVault);

    // Home's vault goes up, checked out on the hub
    let r = await syncNow(home);
    assert.equal(r.state, 'in step', r.lastError);
    const hubHome = path.join(hub.dataDir, 'hub', 'notes', HOME_DEV, 'notes');
    assert.equal(fs.readFileSync(path.join(hubHome, 'BlitzRaw', 'Spec.md'), 'utf8'), 'line one\nline two\n');

    // Work's vault of the same name is a repo of its own: it never sees Home's notes
    r = await syncNow(work);
    assert.equal(r.state, 'in step', r.lastError);
    const hubWork = path.join(hub.dataDir, 'hub', 'notes', WORK_DEV, 'notes');
    assert.ok(fs.existsSync(path.join(hubWork, 'Work', 'Only.md')));
    assert.ok(!fs.existsSync(path.join(hubWork, 'Personal')));
    assert.ok(!fs.existsSync(path.join(workVault, 'Personal')));

    // a change on Home becomes a commit and goes up on its own, after the idle time
    fs.writeFileSync(path.join(homeVault, 'BlitzRaw', 'New.md'), 'new note\n');
    const t0 = Date.now();
    while (!fs.existsSync(path.join(hubHome, 'BlitzRaw', 'New.md'))) {
      if (Date.now() - t0 > 20000) throw new Error('the new note never reached the hub');
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.match(g(homeVault, 'log', '-1', '--format=%s').trim(), /^Saved on Home: BlitzRaw\/New\.md$/);

    // an edit on the hub's copy (the owner was off) comes down at the next sync
    await new Promise((res) => setTimeout(res, 1500)); // let the automatic round settle
    fs.writeFileSync(path.join(hubHome, 'BlitzRaw', 'Spec.md'), 'line one\nline two, from the phone\n');
    r = await syncNow(home);
    assert.equal(r.state, 'in step', r.lastError);
    assert.equal(fs.readFileSync(path.join(homeVault, 'BlitzRaw', 'Spec.md'), 'utf8'), 'line one\nline two, from the phone\n');

    // the same line on both sides: Home's version stays, the hub's goes next to it
    fs.writeFileSync(path.join(hubHome, 'BlitzRaw', 'Spec.md'), 'line one\nline two, hub version\n');
    g(hubHome, 'add', '-A');
    g(hubHome, 'commit', '-q', '-m', 'hub edit');
    fs.writeFileSync(path.join(homeVault, 'BlitzRaw', 'Spec.md'), 'line one\nline two, home version\n');
    r = await syncNow(home);
    assert.equal(r.state, 'in step', r.lastError);
    assert.equal(r.conflicts.length, 1);
    assert.equal(fs.readFileSync(path.join(homeVault, 'BlitzRaw', 'Spec.md'), 'utf8'), 'line one\nline two, home version\n');
    const side = path.join(homeVault, ...r.conflicts[0].copy.split('/'));
    assert.match(r.conflicts[0].copy, /^BlitzRaw\/Spec \(conflict from the hub \d{4}-\d\d-\d\d \d{4}\)\.md$/);
    assert.equal(fs.readFileSync(side, 'utf8'), 'line one\nline two, hub version\n');
    // and the hub has both now
    assert.equal(fs.readFileSync(path.join(hubHome, ...r.conflicts[0].copy.split('/')), 'utf8'), 'line one\nline two, hub version\n');
    assert.equal(g(homeVault, 'status', '--porcelain'), '');
  });

  test("another PC reads a machine's notes from the hub, except its home only folders", async () => {
    const hub = await startHub();
    const homeVault = makeVault('mc-nsync-vault-home2', {
      '.mc-notes.json': JSON.stringify({ homeOnly: ['Personal'] }),
      '01-Acme/Pitch.md': 'the pitch\n',
      '01-Acme/img/shot.png': 'png',
      'Personal/Private.md': 'secret\n',
    });
    const workVault = makeVault('mc-nsync-vault-work2', { 'Work/Only.md': 'work\n' });
    const home = await startPc(hub, 'Home', HOME_DEV, homeVault);
    const work = await startPc(hub, 'Work', WORK_DEV, workVault, { config: { notesFolders: { acme: ['Home:01-Acme'], other: ['Home:Visa'] } }, projects: ['acme', 'other'] });
    assert.equal((await syncNow(home)).state, 'in step');
    assert.equal((await syncNow(work)).state, 'in step');

    // Work's project shows Home's folder as one more root, and opens its notes
    const lib = (await call(work, 'GET', '/api/projects/acme/library?kind=docs&fresh=1')).json;
    const root = lib.roots.find((r) => r.label === 'Notes on Home: 01-Acme');
    assert.ok(root, JSON.stringify(lib.roots));
    assert.deepEqual(lib.files.filter((f) => f.root === root.id).map((f) => f.path), ['Pitch.md']);
    const f = await call(work, 'GET', `/api/projects/acme/file?root=${root.id}&path=Pitch.md`);
    assert.equal(f.status, 200);
    assert.equal(f.text, 'the pitch\n');
    const imgs = (await call(work, 'GET', '/api/projects/acme/library?kind=images&fresh=1')).json;
    assert.deepEqual(imgs.files.filter((x) => x.root === root.id).map((x) => x.path), ['img/shot.png']);

    // a home only folder stays off another PC, listed or asked for by name
    const other = (await call(work, 'GET', '/api/projects/other/library?kind=docs&fresh=1')).json;
    const vroot = other.roots.find((r) => r.label === 'Notes on Home: Visa');
    assert.equal(other.files.filter((x) => x.root === vroot.id).length, 0);
    assert.equal((await call(work, 'GET', `/api/projects/other/file?root=${vroot.id}&path=Private.md`)).status, 403);
    assert.equal((await call(work, 'GET', `/api/projects/acme/file?root=${root.id}&path=../Personal/Private.md`)).status, 404);
  });

  test("a linked PC's project shows its notes from the hub, every text file, and an .html note as a page", async () => {
    const hub = await startHub();
    const homeVault = makeVault('mc-nsync-vault-home3', {
      '01-Acme/Pitch.md': 'the pitch\n',
      '01-Acme/Budget.html': '<!doctype html><html><head><title>b</title></head><body><script>localStorage.getItem("x")</script></body></html>',
      '01-Acme/src/main.cpp': 'int main() {}\n',
      '01-Acme/shot.png': 'png',
      '01-Acme/Deck.pptx': 'pptx',
      'Other/Elsewhere.md': 'not this project\n',
    });
    // Home: owns the vault, names 01-Acme as the notes of its project acme, and lets Work in through its bridge
    const homeDir = makeDataDir('mc-nsync-home3');
    fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({ machineName: 'Home', notesFolders: { acme: ['01-Acme'] } }));
    fs.writeFileSync(path.join(homeDir, 'devices.json'), JSON.stringify([{ id: KNOWN_DEVICE, name: 'Work', pairedAt: '2026-11-08T00:00:00Z', lastSeen: null }]));
    for (const name of ['acme', 'Acme-Shop']) {
      const proj = path.join(homeDir, 'no-projects-here', name);
      fs.mkdirSync(proj, { recursive: true });
      g(proj, 'init', '-q');
    }
    const secret = fs.readFileSync(hub.secretFile, 'utf8').trim();
    const hubJson = (device) => JSON.stringify({ url: `http://127.0.0.1:${hub.bridgePort}`, headers: { 'X-MC-Bridge': secret, 'X-MC-Device': device } });
    fs.writeFileSync(path.join(homeDir, 'hub.json'), hubJson(HOME_DEV));
    const home = await startServer({ dataDir: homeDir, bridge: true, env: { ...ENV, MC_NOTES_ROOT: homeVault, MC_NOTES_REPOS: JSON.stringify([{ id: 'notes', dir: homeVault }]) } });
    toStop.push(home);
    assert.equal((await syncNow(home)).state, 'in step');

    // Home tells a linked PC where the project's notes are in the vault
    const listed = (await call(home, 'GET', '/api/projects')).json.projects.find((p) => p.id === 'acme');
    assert.deepEqual(listed.notes, [{ repo: 'notes', folder: '01-Acme' }]);
    // and its own Docs tab lists every text file of a notes folder, and serves them
    const own = (await call(home, 'GET', '/api/projects/acme/library?kind=docs&fresh=1')).json;
    const n0 = own.roots.find((r) => r.id === 'n0');
    assert.deepEqual(own.files.filter((f) => f.root === n0.id).map((f) => f.path).sort(), ['Budget.html', 'Pitch.md', 'src/main.cpp']);
    assert.equal((await call(home, 'GET', '/api/projects/acme/file?root=n0&path=src/main.cpp')).text, 'int main() {}\n');

    // Work: linked to Home, and its own vault nowhere near
    const workDir = makeDataDir('mc-nsync-work3');
    fs.writeFileSync(path.join(workDir, 'config.json'), JSON.stringify({ machineName: 'Work' }));
    fs.writeFileSync(path.join(workDir, 'hub.json'), hubJson(WORK_DEV));
    const work = await startServer({ dataDir: workDir, bridge: false, env: { ...ENV, MC_NOTES_REPOS: '[]', MC_PC_LINK_TEST: JSON.stringify({ name: 'Home', url: `http://127.0.0.1:${home.bridgePort}`, headers: bridgeHeaders(home) }) } });
    toStop.push(work);
    const link = (await call(work, 'POST', '/api/pc-link/refresh', {})).json;
    assert.deepEqual(link.projects.find((p) => p.id === 'acme').notes, [{ repo: 'notes', folder: '01-Acme' }]);

    // Home's project on Work: its notes, from the hub's list (a file is read on Home while the link is up)
    const lib = (await call(work, 'GET', '/api/pc/projects/acme/library?kind=docs&fresh=1')).json;
    assert.deepEqual(lib.roots, [{ id: 'r0', label: 'Notes on Home: 01-Acme' }]);
    assert.deepEqual(lib.files.map((f) => f.path).sort(), ['Budget.html', 'Pitch.md', 'src/main.cpp']);
    const f = await call(work, 'GET', '/api/pc/projects/acme/file?root=r0&path=src/main.cpp');
    assert.equal(f.status, 200);
    assert.equal(f.text, 'int main() {}\n');
    assert.match(f.headers['content-type'], /^text\/plain/);
    const imgs = (await call(work, 'GET', '/api/pc/projects/acme/library?kind=images&fresh=1')).json;
    assert.deepEqual(imgs.files.map((x) => x.path), ['shot.png']);

    // an .html note: its text, or a page in a sandbox of its own, with storage that works there
    const text = await call(work, 'GET', '/api/pc/projects/acme/file?root=r0&path=Budget.html');
    assert.match(text.headers['content-type'], /^text\/plain/);
    const page = await call(work, 'GET', '/api/pc/projects/acme/file?root=r0&path=Budget.html&view=page');
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.headers['content-security-policy'], /^sandbox allow-scripts[^;]*;\s*default-src 'none'/);
    assert.doesNotMatch(page.headers['content-security-policy'], /allow-same-origin/);
    assert.match(page.text, /^<!doctype html><html><head><script>\(function\(\)\{function mem\(\)/);
    const local = await call(home, 'GET', '/api/projects/acme/file?root=n0&path=Budget.html&view=page');
    assert.equal(local.text, page.text);

    // a project Home names no notes for: the hub's copy has a top folder named like it ("01-Acme" for "Acme-Shop")
    const glId = (await call(home, 'GET', '/api/projects')).json.projects.find((p) => p.name === 'Acme-Shop').id;
    assert.deepEqual(link.projects.find((p) => p.id === glId).notes, []);
    const guessed = (await call(work, 'GET', `/api/pc/projects/${glId}/library?kind=docs&fresh=1`)).json;
    assert.deepEqual(guessed.roots, [{ id: 'r0', label: 'Notes on Home: 01-Acme' }]);
    assert.ok(guessed.files.some((x) => x.path === 'Budget.html'));
    assert.equal((await call(work, 'GET', `/api/pc/projects/${glId}/file?root=r0&path=Pitch.md`)).text, 'the pitch\n');

    // only the project's own folders, and only projects Home listed
    assert.equal((await call(work, 'GET', '/api/pc/projects/acme/file?root=r0&path=../Other/Elsewhere.md')).status, 404);
    assert.equal((await call(work, 'GET', '/api/pc/projects/acme/file?root=r1&path=Pitch.md')).status, 404);
    assert.equal((await call(work, 'GET', '/api/pc/projects/nope/library?kind=docs')).status, 404);
  });
});
