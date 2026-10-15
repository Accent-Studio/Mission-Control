// Tests for "open in Claude Desktop": the detector (server/services/elsewhere.js) and the 409 guard on POST /api/chat.
// The process list is a JSON file (MC_FAKE_PROCESSES), so nothing here looks at the real processes, and Claude is the
// FAKE CLI in tools/fakeclaude. Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ROOT, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const uuid = () => crypto.randomUUID();

const DESK_DIR = 'C:\\Users\\alex\\AppData\\Roaming\\Claude\\claude-code\\2.1.0\\abc123';
const desk = (pid, args, startedMs = 3600000) => ({
  pid,
  ppid: 100,
  name: 'claude.exe',
  exe: DESK_DIR + '\\claude.exe',
  commandLine: `"${DESK_DIR}\\claude.exe" --output-format stream-json --verbose --input-format stream-json ${args}`,
  startedAt: ago(startedMs),
});
const APP = { pid: 100, ppid: 4, name: 'Claude.exe', exe: 'C:\\Users\\alex\\AppData\\Local\\AnthropicClaude\\Claude.exe', commandLine: '"Claude.exe"', startedAt: ago(86400000) };
const mcChild = (id) => ({
  pid: 300,
  ppid: 200,
  name: 'claude.exe',
  exe: 'C:\\Users\\alex\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
  commandLine: `"C:\\Users\\alex\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" -p --input-format stream-json --output-format stream-json --verbose --resume ${id}`,
  startedAt: ago(5000),
});
const NODE = { pid: 200, ppid: 4, name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe', commandLine: 'node server\\runner\\index.js', startedAt: ago(86400000) };

// ---- The detector, with the process list in a file ----

const tmp = fs.mkdtempSync(path.join(process.env.MC_TEST_TMP || os.tmpdir(), 'mc-elsewhere-unit-'));
const listFile = path.join(tmp, 'procs.json');
process.env.MC_FAKE_PROCESSES = listFile;
process.env.MC_ELSEWHERE_TTL_MS = '1200';
const { desktopInfo, elsewhereOf, summarize, WHERE } = await import('../../server/services/elsewhere.js');
const setList = (l) => fs.writeFileSync(listFile, JSON.stringify(l));
const conv = (id, first, last) => ({ id, firstEp: first, lastEp: last });
const ep = (entrypoint, ms) => ({ entrypoint, at: ago(ms) });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('detector', () => {
  test('a: --resume=<id>, --resume <id> and --session-id <id> on a desktop child', () => {
    const [a, b, c, other] = [uuid(), uuid(), uuid(), uuid()];
    const info = summarize([APP, desk(1, `--resume=${a}`), desk(2, `--resume ${b}`), desk(3, `--session-id ${c}`)]);
    for (const id of [a, b, c]) assert.equal(elsewhereOf(conv(id, null, ep('sdk-cli', 1e9)), info), WHERE);
    assert.equal(elsewhereOf(conv(other, null, ep('sdk-cli', 1e9)), info), null);
    // ids compare without regard to case
    assert.equal(elsewhereOf(conv(a.toUpperCase(), null, null), info), WHERE);
  });

  test('a: a mixed-case, quoted command line', () => {
    const [a, b] = [uuid(), uuid()];
    const p = (pid, cmd) => ({
      pid,
      ppid: 100,
      name: 'CLAUDE.EXE',
      exe: 'C:\\USERS\\ALEX\\APPDATA\\ROAMING\\CLAUDE\\CLAUDE-CODE\\2.1.0\\ABC\\CLAUDE.EXE',
      commandLine: cmd,
      startedAt: ago(1000),
    });
    const info = summarize([
      p(1, `"C:\\Users\\alex\\AppData\\Roaming\\Claude\\claude-code\\2.1.0\\abc\\claude.exe" --Output-Format stream-json --RESUME="${a.toUpperCase()}"`),
      p(2, `claude.exe --output-format stream-json --Resume '${b}' --verbose`),
    ]);
    assert.ok(info.claimed.has(a) && info.claimed.has(b));
    assert.equal(info.loose.length, 0);
  });

  test('a: a child that the app started (parent is Claude.exe) counts even outside the claude-code folder, a helper does not', () => {
    const id = uuid();
    const child = { pid: 9, ppid: 100, name: 'claude.exe', exe: 'D:\\x\\claude.exe', commandLine: `claude.exe --output-format stream-json --resume=${id}`, startedAt: ago(1000) };
    const helper = { pid: 10, ppid: 100, name: 'Claude.exe', exe: APP.exe, commandLine: `"Claude.exe" --type=renderer --resume=${uuid()}`, startedAt: ago(1000) };
    const info = summarize([APP, child, helper]);
    assert.equal(elsewhereOf(conv(id, null, null), info), WHERE);
    assert.equal(info.claimed.size, 1);
    assert.equal(info.loose.length, 0);
  });

  test("b: a child with no id, and a first entry from the desktop app 0 to 180 s after it started", () => {
    const startMs = 600000;
    const info = summarize([APP, desk(1, '--model x', startMs)]);
    const first = (afterStartSec, entrypoint = 'claude-desktop') => ({ entrypoint, at: ago(startMs - afterStartSec * 1000) });
    const old = ep('claude-desktop', 3 * 3600000); // last entry long ago: only (b) can say yes
    assert.equal(elsewhereOf(conv(uuid(), first(2), old), info), WHERE);
    assert.equal(elsewhereOf(conv(uuid(), first(0), old), info), WHERE);
    assert.equal(elsewhereOf(conv(uuid(), first(179), old), info), WHERE);
    assert.equal(elsewhereOf(conv(uuid(), first(181), old), info), null, 'too long after the start');
    assert.equal(elsewhereOf(conv(uuid(), first(-5), old), info), null, 'written before the process existed');
    assert.equal(elsewhereOf(conv(uuid(), first(2, 'sdk-cli'), old), info), null, 'not from the app');
    assert.equal(elsewhereOf(conv(uuid(), first(2), old), summarize([APP])), null, 'no desktop child alive');
    assert.equal(elsewhereOf(conv(uuid(), first(2), old), summarize([APP, desk(1, `--resume=${uuid()}`, startMs)])), null, 'a child that names another conversation is not a loose one');
  });

  test('c: the last entry from the desktop app less than 10 min ago, with no process at all', () => {
    const info = summarize([]);
    assert.equal(elsewhereOf(conv(uuid(), null, ep('claude-desktop', 60000)), info), WHERE);
    assert.equal(elsewhereOf(conv(uuid(), null, ep('claude-desktop', 599000)), info), WHERE);
    assert.equal(elsewhereOf(conv(uuid(), null, ep('claude-desktop', 601000)), info), null);
    assert.equal(elsewhereOf(conv(uuid(), null, ep('sdk-cli', 1000)), info), null);
    assert.equal(elsewhereOf(conv(uuid(), null, ep('cli', 1000)), info), null);
    assert.equal(elsewhereOf(conv(uuid(), null, null), info), null);
  });

  test("Mission Control's own children are never elsewhere", () => {
    const id = uuid();
    const info = summarize([APP, NODE, mcChild(id)]);
    assert.equal(info.claimed.size, 0);
    assert.equal(info.loose.length, 0);
    assert.equal(elsewhereOf(conv(id, ep('sdk-cli', 5000), ep('sdk-cli', 1000)), info), null);
    // not even one that looks fresh: an app-less claude.exe under npm is not a desktop child
    assert.equal(elsewhereOf(conv(uuid(), ep('claude-desktop', 4000), ep('claude-desktop', 3600000)), info), null);
  });

  test('the process list is read at most once per TTL, and again after it', async () => {
    const [a, b] = [uuid(), uuid()];
    setList([desk(1, `--resume=${a}`)]);
    await sleep(1300); // the cache of an earlier test has run out
    const first = await desktopInfo();
    assert.ok(first.claimed.has(a));
    setList([desk(1, `--resume=${b}`)]);
    const cached = await desktopInfo();
    assert.ok(cached.claimed.has(a) && !cached.claimed.has(b), 'still the first answer inside the TTL');
    assert.equal(cached, first);
    await Promise.all([desktopInfo(), desktopInfo(), desktopInfo()]);
    await sleep(1300);
    const fresh = await desktopInfo();
    assert.ok(fresh.claimed.has(b) && !fresh.claimed.has(a));
  });

  test('an unreadable list means nothing is known to be open', async () => {
    await sleep(1300);
    fs.writeFileSync(listFile, '{not json');
    const info = await desktopInfo();
    assert.equal(info.claimed.size, 0);
    assert.equal(info.loose.length, 0);
  });
});

// ---- The server: list field and the 409 guard ----

const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });

async function boot() {
  const dataDir = makeDataDir('mc-elsewhere');
  seedFixture(dataDir);
  const procs = path.join(dataDir, 'procs.json');
  fs.writeFileSync(procs, '[]');
  const projDir = path.join(dataDir, 'claude-home', 'projects', 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, MC_FAKE_PROCESSES: procs, MC_ELSEWHERE_TTL_MS: '1000', FAKE_STEP_MS: '50' } });
  s.setProcs = (l) => fs.writeFileSync(procs, JSON.stringify(l));
  // A saved conversation whose entries come from `entrypoint`, the last one `lastMsAgo` ms ago.
  s.conversation = (entrypoint, lastMsAgo = 3600000) => {
    const id = uuid();
    const recs = [
      { type: 'user', entrypoint, cwd: dataDir, sessionId: id, timestamp: ago(lastMsAgo + 20000), uuid: uuid(), message: { role: 'user', content: 'Hello there' } },
      { type: 'assistant', entrypoint, cwd: dataDir, sessionId: id, timestamp: ago(lastMsAgo), uuid: uuid(), message: { id: 'msg_a', role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'Hi.' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    fs.writeFileSync(path.join(projDir, id + '.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return id;
  };
  toStop.push(s);
  return s;
}

describe('server', () => {
  test('lists and single-session data carry elsewhere; the guard answers 409 and the flag lets it through', async () => {
    const s = await boot();
    const open = s.conversation('claude-desktop', 60000); // (c)
    const mine = s.conversation('sdk-cli', 60000);
    const named = s.conversation('sdk-cli', 3600000); // only a command line names it
    s.setProcs([APP, desk(1, `--resume=${named}`), mcChild(mine)]);

    // the list never waits for the process list: the first answer has only what the transcripts say (c), the refresh follows
    const first = (await pc(s, 'GET', '/api/sessions')).json;
    assert.equal(first.find((x) => x.id === open).elsewhere, 'Claude Desktop');
    assert.equal(first.find((x) => x.id === named).elsewhere, undefined);
    await sleep(400);
    const list = (await pc(s, 'GET', '/api/sessions')).json;
    const el = (id) => list.find((x) => x.id === id).elsewhere;
    assert.equal(el(open), 'Claude Desktop');
    assert.equal(el(named), 'Claude Desktop');
    assert.equal(el(mine), undefined);
    assert.equal((await pc(s, 'GET', `/api/sessions/${open}`)).json.elsewhere, 'Claude Desktop');
    assert.equal((await pc(s, 'GET', `/api/sessions/${mine}`)).json.elsewhere, undefined);

    // a stale page or the phone sends no flag: refused, and no process is started
    const refused = await pc(s, 'POST', '/api/chat', { prompt: 'hi', sessionId: open });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.json, { error: 'elsewhere', where: 'Claude Desktop' });
    assert.equal((await pc(s, 'POST', '/api/chat', { prompt: 'hi', sessionId: named })).status, 409);
    assert.equal((await pc(s, 'GET', '/api/runs')).json.length, 0);

    // a conversation that is not open there is not asked about
    assert.equal((await pc(s, 'POST', '/api/chat', { prompt: 'hi', sessionId: mine })).status, 200);

    // Send anyway
    const ok = await pc(s, 'POST', '/api/chat', { prompt: 'hi', sessionId: open, elsewhereOk: true });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.json.runId);

    // once Mission Control holds a process for it, no question is asked again for that run
    const again = await pc(s, 'POST', '/api/chat', { prompt: 'and again', sessionId: open });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.runId, ok.json.runId);
    assert.equal(again.json.joined, true);
  });

  test('new conversations, the Com Link and one-off tasks never get the check', async () => {
    const s = await boot();
    const open = s.conversation('claude-desktop', 60000);
    const fresh = await pc(s, 'POST', '/api/chat', { prompt: 'a new one' });
    assert.equal(fresh.status, 200, fresh.text);
    const oneOff = await pc(s, 'POST', '/api/chat', { prompt: 'commit', sessionId: open, remote: false });
    assert.equal(oneOff.status, 200, oneOff.text);
    const s2 = await boot();
    const open2 = s2.conversation('claude-desktop', 60000);
    const comlink = await pc(s2, 'POST', '/api/chat', { prompt: 'hello', sessionId: open2, persona: 'comlink' });
    assert.notEqual(comlink.status, 409, comlink.text);
    // the Com Link panel marks its own sends: never held, even with the persona switch off (no persona in the body)
    const s3 = await boot();
    const open3 = s3.conversation('claude-desktop', 60000);
    assert.equal((await pc(s3, 'POST', '/api/chat', { prompt: 'hi', sessionId: open3 })).status, 409, 'the Talk page is held');
    const panel = await pc(s3, 'POST', '/api/chat', { prompt: 'hi', sessionId: open3, source: 'comlink' });
    assert.equal(panel.status, 200, panel.text);
  });

  test('a malformed line in the transcript does not break the list or the guard', async () => {
    const s = await boot();
    const id = s.conversation('claude-desktop', 60000);
    const file = path.join(s.dataDir, 'claude-home', 'projects', 'proj', id + '.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, [lines[0], '{"type":"assistant","entrypoint":"cli","timestamp":', 'not json at all', lines[1], '{"broken":'].join('\n') + '\n');
    const list = (await pc(s, 'GET', '/api/sessions')).json;
    assert.equal(list.find((x) => x.id === id).elsewhere, 'Claude Desktop');
    assert.equal((await pc(s, 'POST', '/api/chat', { prompt: 'hi', sessionId: id })).status, 409);
  });

  test('a process read that is too slow: the list does not wait and the guard fails open within its limit', async () => {
    const dataDir = makeDataDir('mc-elsewhere-slow');
    seedFixture(dataDir);
    const procs = path.join(dataDir, 'procs.json');
    const projDir = path.join(dataDir, 'claude-home', 'projects', 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    const id = uuid();
    fs.writeFileSync(procs, JSON.stringify([desk(1, `--resume=${id}`)]));
    fs.writeFileSync(
      path.join(projDir, id + '.jsonl'),
      JSON.stringify({ type: 'user', entrypoint: 'sdk-cli', cwd: dataDir, sessionId: id, timestamp: ago(3600000), uuid: uuid(), message: { role: 'user', content: 'Old one' } }) + '\n',
    );
    const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, MC_FAKE_PROCESSES: procs, MC_FAKE_PROCESSES_DELAY_MS: '4000', MC_ELSEWHERE_WAIT_MS: '600', FAKE_STEP_MS: '50' } });
    toStop.push(s);
    let t = Date.now();
    const list = await pc(s, 'GET', '/api/sessions');
    assert.equal(list.status, 200);
    assert.ok(Date.now() - t < 1500, 'the list did not wait for the read');
    t = Date.now();
    const sent = await pc(s, 'POST', '/api/chat', { prompt: 'hi', sessionId: id });
    const took = Date.now() - t;
    assert.equal(sent.status, 200, sent.text); // the read is still running: fails open
    assert.ok(took < 3000, `the guard waited ${took} ms`);
  });
});
