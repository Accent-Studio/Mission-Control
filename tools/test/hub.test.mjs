// Tests for the hub (services/hub.js, routes/hub.js) and the PC side (services/hubSync.js): three servers on this PC, a
// hub and two PCs named Home and Work that reach it through the hub's bridge listener as paired devices. A chat written on
// Home shows up on Work; Work takes it over at once while Home's Claude is not thinking, and Home picks up Work's turn;
// while Home's Claude is thinking, Work's message goes into it instead; a chat written without the baton becomes a copy;
// a holder that went silent loses the baton; Home's code conversations are on the hub, and Work reads them, read only;
// the hub runs chats itself (for a phone when every PC is off); a message for a code conversation of a PC that is off
// waits on the hub, and what is typed for it follows to its PC.
// Runs against the FAKE Claude CLI in tools/fakeclaude. Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ROOT, localReq, makeDataDir, request, startServer } from './harness.mjs';

const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
async function waitFor(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}

// a 1 by 1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const HOME_DEV = 'h'.repeat(40);
const WORK_DEV = 'w'.repeat(40);
const chatFolder = (dataDir) => path.join(dataDir, 'claude-home', 'projects', path.join(dataDir, 'chats').replace(/[^A-Za-z0-9]/g, '-'));

async function startHub(env = {}) {
  const dataDir = makeDataDir('mc-hub');
  fs.writeFileSync(path.join(dataDir, 'devices.json'), JSON.stringify([
    { id: HOME_DEV, name: 'Home', pairedAt: '2026-10-23T00:00:00Z', lastSeen: null },
    { id: WORK_DEV, name: 'Work', pairedAt: '2026-10-23T00:00:00Z', lastSeen: null },
  ]));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ machineName: 'Hub' }));
  // the hub runs chats too, with the fake Claude, and keeps them in its own chats folder
  const tdir = chatFolder(dataDir);
  fs.mkdirSync(tdir, { recursive: true });
  const fakeLog = path.join(dataDir, 'fake.log');
  const s = await startServer({ dataDir, bridge: true, env: { MC_ROLE: 'hub', PATH: FAKE_PATH, FAKE_STEP_MS: '20', FAKE_TRANSCRIPT: tdir, FAKE_LOG: fakeLog, MC_IDLE_MS: '60000', MC_HUB_RETRY_MS: '500', MC_HUB_SYNC_MS: '1000', ...env } });
  s.tdir = tdir;
  s.fakeLog = fakeLog;
  toStop.push(s);
  return s;
}

async function startPc(hub, name, device, dataDir = makeDataDir('mc-hub-' + name.toLowerCase()), env = {}) {
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ machineName: name }));
  const secret = fs.readFileSync(hub.secretFile, 'utf8').trim();
  fs.writeFileSync(path.join(dataDir, 'hub.json'), JSON.stringify({ url: `http://127.0.0.1:${hub.bridgePort}`, headers: { 'X-MC-Bridge': secret, 'X-MC-Device': device } }));
  const tdir = chatFolder(dataDir);
  fs.mkdirSync(tdir, { recursive: true });
  const fakeLog = path.join(dataDir, 'fake.log');
  const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '20', FAKE_TRANSCRIPT: tdir, FAKE_LOG: fakeLog, MC_IDLE_MS: '60000', MC_HUB_RETRY_MS: '500', MC_HUB_SYNC_MS: '1000', ...env } });
  s.tdir = tdir;
  s.fakeLog = fakeLog;
  toStop.push(s);
  return s;
}

const hubInfo = async (hub, id) => { const r = await pc(hub, 'GET', `/api/hub/sessions/${id}`); return r.status === 200 ? r.json : null; };
const runOf = async (s, runId) => (await pc(s, 'GET', '/api/runs')).json.find((x) => x.runId === runId);
const textsOf = async (s, id) => { const r = await pc(s, 'GET', `/api/sessions/${id}?limit=40`); return r.status === 200 ? r.json.messages.map((m) => m.text).join('\n') : ''; };
const fileSize = (s, id) => { try { return fs.statSync(path.join(s.tdir, id + '.jsonl')).size; } catch { return 0; } };

async function chatOn(s, body) {
  const r = await pc(s, 'POST', '/api/chat', body);
  assert.equal(r.status, 200, r.text);
  return waitFor(async () => { const x = await runOf(s, r.json.runId); return x && x.state === 'idle' && x.sessionId && x; }, 'the chat to answer');
}

describe('the hub', () => {
  test('a chat moves between two PCs through the hub, one place at a time', async () => {
    const hub = await startHub();
    const home = await startPc(hub, 'Home', HOME_DEV);
    const work = await startPc(hub, 'Work', WORK_DEV);

    // Home writes a chat: it reaches the hub whole, and Home holds it
    const run = await chatOn(home, { prompt: 'hello from home', chat: true });
    const id = run.sessionId;
    const posted = await waitFor(async () => { const e = await hubInfo(hub, id); return e && e.size === fileSize(home, id) && e; }, 'the chat on the hub');
    assert.equal(posted.kind, 'chat');
    assert.equal(posted.origin.name, 'Home');
    assert.equal(posted.holder.name, 'Home');

    // Work picks it up, as a chat
    await waitFor(async () => (await textsOf(work, id)).includes('hello from home'), 'the chat on Work');
    assert.equal((await pc(work, 'GET', `/api/sessions/${id}?limit=1`)).json.kind, 'chat');

    // the Connections page sees it all: what each PC sent and picked up, the hub's count, the computers
    const homeSync = await waitFor(async () => { const s = (await pc(home, 'GET', '/api/hub-link')).json.sync; return s.lastRound && s.hub && s.recent.some((x) => x.what === 'sent' && x.id === id) && s; }, 'Home\'s sync status');
    assert.equal(homeSync.linked, true);
    assert.ok(homeSync.hub.chats >= 1 && homeSync.hub.bytes >= posted.size, JSON.stringify(homeSync.hub));
    assert.ok(homeSync.lastRing, 'the doorbell answered');
    assert.deepEqual(homeSync.machines.filter((m) => m.me).map((m) => m.name), ['Home']);
    const workSync = (await pc(work, 'GET', '/api/hub-link')).json.sync;
    assert.ok(workSync.recent.some((x) => x.what === 'got' && x.id === id && x.bytes > 0), JSON.stringify(workSync.recent));

    // Home's Claude is open but not thinking: Work takes the chat over at once, and Home closes its own
    const t0 = Date.now();
    const wrun = await chatOn(work, { prompt: 'and now from work', sessionId: id });
    assert.equal(wrun.sessionId, id);
    assert.equal(wrun.chat, true);
    assert.ok(Date.now() - t0 < 10000, `the handover took ${Date.now() - t0} ms`);
    await waitFor(async () => { const x = await runOf(home, run.runId); return x && x.state !== 'idle'; }, 'Home to close its Claude');
    await waitFor(async () => { const e = await hubInfo(hub, id); return e && e.holder && e.holder.name === 'Work' && e.size === fileSize(work, id); }, 'Work to post its turn');
    await waitFor(async () => (await textsOf(home, id)).includes('and now from work'), 'Work\'s turn on Home');
    await waitFor(() => fileSize(home, id) === fileSize(work, id), 'the two copies to be the same size', 10000).catch((err) => {
      throw new Error(`${err.message}: home ${fileSize(home, id)}, work ${fileSize(work, id)}
--- home
${home.out.text.slice(-3000)}
--- work
${work.out.text.slice(-3000)}`);
    });
    assert.ok(fs.readFileSync(path.join(home.tdir, id + '.jsonl')).equals(fs.readFileSync(path.join(work.tdir, id + '.jsonl'))), 'and the same bytes');

    // Home now writes to the chat without the baton (as if it were offline): its version becomes a copy, the original
    // stays the hub's
    const line = JSON.stringify({ type: 'user', uuid: 'f'.repeat(8) + '-0000-4000-8000-000000000000', parentUuid: null, isSidechain: false, sessionId: id, cwd: path.join(home.dataDir, 'chats'), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'written at home without the baton' }] } }) + '\n';
    fs.appendFileSync(path.join(home.tdir, id + '.jsonl'), line);
    const copy = await waitFor(async () => (await pc(home, 'GET', '/api/sessions?kind=chat')).json.find((c) => c.id !== id && /\(copy from Home\)/.test(c.title)), 'the copy on Home');
    assert.match(await textsOf(home, copy.id), /written at home without the baton/);
    await waitFor(async () => !(await textsOf(home, id)).includes('without the baton'), 'the original back to the hub\'s version');
    assert.ok(fs.readFileSync(path.join(home.tdir, id + '.jsonl')).equals(fs.readFileSync(path.join(work.tdir, id + '.jsonl'))));
    // the copy is a chat of its own, posted like any other
    await waitFor(async () => { const e = await hubInfo(hub, copy.id); return e && e.size === fileSize(home, copy.id); }, 'the copy on the hub');
  });

  test('while Claude is thinking on Home, a message from Work goes into it, as a phone would', async () => {
    const hub = await startHub();
    const home = await startPc(hub, 'Home', HOME_DEV);
    const work = await startPc(hub, 'Work', WORK_DEV);
    const run = await chatOn(home, { prompt: 'a chat for two', chat: true });
    const id = run.sessionId;
    await waitFor(async () => (await textsOf(work, id)).includes('a chat for two'), 'the chat on Work');
    assert.equal((await pc(home, 'POST', '/api/chat', { prompt: 'think forever HANG', sessionId: id })).status, 200);
    await waitFor(async () => { const x = await runOf(home, run.runId); return x && x.state === 'working'; }, 'Home to think');
    const r = await pc(work, 'POST', '/api/chat', { prompt: 'a word from work', sessionId: id });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { relayed: true, to: 'Home' });
    assert.ok(!(await pc(work, 'GET', '/api/runs')).json.some((x) => x.sessionId === id), 'nothing runs on Work');
    await waitFor(() => fs.existsSync(home.fakeLog) && fs.readFileSync(home.fakeLog, 'utf8').includes('a word from work'), 'the message in Home Claude');
    // a picture travels too, as a phone's does: it goes up to the hub with the message, and Home saves it as an upload
    const up = await pc(work, 'POST', '/api/uploads', { name: 'dot.png', type: 'image/png', data: PNG });
    assert.equal(up.status, 200, up.text);
    const pic = await pc(work, 'POST', '/api/chat', { prompt: 'look at this picture', sessionId: id, attachments: [up.json.id] });
    assert.equal(pic.status, 200, pic.text);
    assert.equal(pic.json.relayed, true);
    const line = await waitFor(() => fs.readFileSync(home.fakeLog, 'utf8').split('\n').find((l) => l.includes('look at this picture')), 'the picture message in Home Claude');
    const img = JSON.parse(line).blockData.find((x) => x.type === 'image');
    assert.deepEqual(img, { type: 'image', media_type: 'image/png', bytes: Buffer.from(PNG, 'base64').length }, 'the picture itself reached Home Claude');
    const e = await hubInfo(hub, id);
    assert.equal(e.holder.name, 'Home');
  });

  test('a holder that went silent loses the baton', async () => {
    const hub = await startHub({ MC_HUB_STALE_MS: '3000' });
    const home = await startPc(hub, 'Home', HOME_DEV);
    const work = await startPc(hub, 'Work', WORK_DEV);
    const run = await chatOn(work, { prompt: 'work holds this one', chat: true });
    const id = run.sessionId;
    await waitFor(async () => { const e = await hubInfo(hub, id); return e && e.holder && e.holder.name === 'Work'; }, 'Work to hold it');
    await waitFor(async () => (await textsOf(home, id)).includes('work holds this one'), 'the chat on Home');
    await work.stop(); // switched off: it never lets go
    const r = await waitFor(async () => { const x = await pc(home, 'POST', '/api/chat', { prompt: 'home takes over', sessionId: id }); return x.status === 200 && x; }, 'the baton to come free', 20000);
    await waitFor(async () => { const x = await runOf(home, r.json.runId); return x && x.state === 'idle'; }, 'Home to answer');
    const e = await hubInfo(hub, id);
    assert.equal(e.holder.name, 'Home');
  });

  test('Home code conversations are on the hub, and Work reads them, read only, in a tab of their own', async () => {
    const hub = await startHub();
    const home = await startPc(hub, 'Home', HOME_DEV);
    const id = crypto.randomUUID();
    const dir = path.join(home.dataDir, 'claude-home', 'projects', 'D--Dev-Thing');
    fs.mkdirSync(dir, { recursive: true });
    const base = { isSidechain: false, userType: 'external', entrypoint: 'sdk-cli', cwd: 'D:\Dev\Thing', sessionId: id, version: '2.1.296' };
    const t = (ms) => new Date(Date.now() - ms).toISOString();
    const rec = (role, text, ms) => JSON.stringify(role === 'user'
      ? { ...base, type: 'user', uuid: crypto.randomUUID(), timestamp: t(ms), promptSource: 'sdk', message: { role: 'user', content: text } }
      : { ...base, type: 'assistant', uuid: crypto.randomUUID(), timestamp: t(ms), message: { id: 'msg_' + ms, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n';
    const file = path.join(dir, id + '.jsonl');
    fs.writeFileSync(file, rec('user', 'fix the build on home', 60000) + rec('assistant', 'the build is fixed', 59000));
    const posted = await waitFor(async () => { const e = await hubInfo(hub, id); return e && e.size === fs.statSync(file).size && e; }, 'the code conversation on the hub');
    assert.equal(posted.kind, 'code');
    assert.equal(posted.origin.name, 'Home');
    assert.equal(posted.holder, null, 'a code conversation has no baton');

    const work = await startPc(hub, 'Work', WORK_DEV);
    const ms = await waitFor(async () => { const d = (await pc(work, 'GET', '/api/machines')).json; return d.machines.length && d.machines; }, 'Home in the list of other PCs');
    assert.deepEqual(ms.map((m) => [m.id, m.name, m.online, m.count]), [[HOME_DEV, 'Home', true, 1]]);
    assert.deepEqual((await pc(home, 'GET', '/api/machines')).json.machines, [], 'Home does not list itself');
    const rows = (await pc(work, 'GET', `/api/sessions?machine=${HOME_DEV}`)).json;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].readOnly, true);
    assert.equal(rows[0].locked, true);
    assert.equal(rows[0].machine.name, 'Home');
    assert.ok(!(await pc(work, 'GET', '/api/sessions?kind=code')).json.some((x) => x.id === id), 'not in Work\'s own list');
    const read = (await pc(work, 'GET', `/api/sessions/${id}?limit=40`)).json;
    assert.equal(read.readOnly, true);
    assert.equal(read.machine.name, 'Home');
    assert.deepEqual(read.messages.map((m) => m.text), ['fix the build on home', 'the build is fixed']);
    assert.ok(!fs.existsSync(path.join(work.dataDir, 'claude-home', 'projects', 'D--Dev-Thing')), 'never in Claude Code\'s own folders on Work');
    assert.equal((await pc(work, 'POST', '/api/chat', { prompt: 'run it here', sessionId: id })).status, 404, 'Work cannot run it');
    const stats = await pc(work, 'GET', `/api/sessions/${id}/stats`); // the usage panel: read from the copy the hub has
    assert.equal(stats.status, 200, stats.text);
    assert.equal(stats.json.model, 'claude-opus-5-5');
    assert.equal(stats.json.contextUsed, 1);

    // Home goes on: Work reads the new turn
    fs.appendFileSync(file, rec('user', 'and the tests too', 2000) + rec('assistant', 'the tests pass', 1000));
    await waitFor(async () => (await pc(work, 'GET', `/api/sessions/${id}?limit=40`)).json.messages.some((m) => m.text === 'the tests pass'), 'the new turn on Work');

    // a tool sends back a screenshot; Home shrinks the conversation: the hub swaps its copy for the smaller one, Work reads
    // the smaller one whole, and a later turn still reaches Work intact
    const shot = 'A'.repeat(50000);
    fs.appendFileSync(file, JSON.stringify({ ...base, type: 'user', uuid: crypto.randomUUID(), timestamp: t(500), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot } }] }] }, toolUseResult: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot } }] }) + '\n');
    const big = fs.statSync(file).size;
    await waitFor(async () => { const e = await hubInfo(hub, id); return e && e.size === big; }, 'the screenshot on the hub');
    await waitFor(async () => (await pc(work, 'GET', `/api/sessions/${id}?limit=40`)).json.messages.length >= 4, 'Work reads it with the screenshot');
    const old = new Date(Date.now() - 10 * 60e3);
    fs.utimesSync(file, old, old);
    const sh = await pc(home, 'POST', '/api/storage/shrink', { confirm: true, items: [{ type: 'code', id }] });
    assert.equal(sh.status, 200, sh.text);
    assert.equal(sh.json.done, 1, JSON.stringify(sh.json));
    assert.ok(sh.json.bytes > 90000, 'both copies of the picture went');
    const small = fs.statSync(file).size;
    assert.ok(small < big - 90000);
    assert.ok(fs.readFileSync(file, 'utf8').includes('Picture removed by Mission Control'));
    const swapped = await waitFor(async () => { const e = await hubInfo(hub, id); return e && e.size === small && e; }, 'the smaller copy on the hub');
    assert.equal(swapped.gen, 1);
    fs.appendFileSync(file, rec('user', 'after the shrink', 200) + rec('assistant', 'still in one piece', 100));
    await waitFor(async () => { const e = await hubInfo(hub, id); return e && e.size === fs.statSync(file).size; }, 'the next turn on the hub');
    const again = await waitFor(async () => { const r = await pc(work, 'GET', `/api/sessions/${id}?limit=40`); return r.json.messages.some((m) => m.text === 'still in one piece') && r.json; }, 'the next turn on Work');
    assert.deepEqual(again.messages.filter((m) => m.text).map((m) => m.text).slice(0, 4), ['fix the build on home', 'the build is fixed', 'and the tests too', 'the tests pass']);
    assert.equal(fs.readFileSync(path.join(work.dataDir, 'hub-cache', id + '.jsonl'), 'utf8'), fs.readFileSync(file, 'utf8'), 'Work has the same bytes as Home');
  });

  test("Home locked with its PIN: Work shows nothing of it, not even the hub's copies", async () => {
    const hub = await startHub();
    const home = await startPc(hub, 'Home', HOME_DEV);
    const id = crypto.randomUUID();
    const dir = path.join(home.dataDir, 'claude-home', 'projects', 'D--Dev-Thing');
    fs.mkdirSync(dir, { recursive: true });
    const base = { isSidechain: false, userType: 'external', entrypoint: 'sdk-cli', cwd: 'D:\Dev\Thing', sessionId: id, version: '2.1.296' };
    fs.writeFileSync(path.join(dir, id + '.jsonl'), JSON.stringify({ ...base, type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), promptSource: 'sdk', message: { role: 'user', content: 'a secret plan' } }) + '\n');
    await waitFor(async () => !!(await hubInfo(hub, id)), 'the conversation on the hub');
    // Home's link, as a locked Home answers it
    const fake = http.createServer((req, res) => {
      res.writeHead(req.url === '/api/pc-lock' ? 200 : 423, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/pc-lock' ? { pin: true, unlocked: false, until: null } : { error: 'pc_locked' }));
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    after(() => fake.close());
    const work = await startPc(hub, 'Work', WORK_DEV, undefined, { MC_PC_LINK_TEST: JSON.stringify({ name: 'Home', url: `http://127.0.0.1:${fake.address().port}` }) });
    await waitFor(async () => (await pc(work, 'GET', '/api/machines')).json.machines.length, 'Home in the list of other PCs');
    await pc(work, 'POST', '/api/pc-link/refresh', {});
    const ms = await waitFor(async () => { const d = (await pc(work, 'GET', '/api/machines')).json.machines; return d[0].locked && d; }, 'Home locked on Work');
    assert.equal(ms[0].count, 0);
    assert.deepEqual((await pc(work, 'GET', `/api/sessions?machine=${HOME_DEV}`)).json, []);
    const read = await pc(work, 'GET', `/api/sessions/${id}?limit=40`);
    assert.equal(read.status, 423);
    assert.deepEqual(read.json, { error: 'peer_locked', pc: 'Home' });
    assert.ok(!read.text.includes('secret plan'));
    assert.equal((await pc(work, 'POST', `/api/waiting/${id}`, { prompt: 'hello' })).status, 423);
  });

  test('the hub runs chats too, so a phone can write to them with every PC off', async () => {
    const hub = await startHub();
    const home = await startPc(hub, 'Home', HOME_DEV);
    const who = (await pc(hub, 'GET', '/api/whoami')).json;
    assert.equal(who.role, 'hub');
    assert.equal(who.name, 'Hub');
    assert.equal((await pc(home, 'GET', '/api/whoami')).json.role, 'pc');

    // Home writes a chat: it is on the hub's own Talk page too
    const run = await chatOn(home, { prompt: 'hello from home', chat: true });
    const id = run.sessionId;
    await waitFor(async () => (await textsOf(hub, id)).includes('hello from home'), 'the chat on the hub');
    assert.equal((await pc(hub, 'GET', `/api/sessions/${id}?limit=1`)).json.kind, 'chat');

    // the phone writes to it on the hub: Home hands it over, the hub runs it, and Home picks up the hub's turn
    const hrun = await chatOn(hub, { prompt: 'and now from the phone', sessionId: id });
    assert.equal(hrun.sessionId, id);
    await waitFor(async () => { const x = await runOf(home, run.runId); return x && x.state !== 'idle'; }, 'Home to close its Claude');
    await waitFor(async () => { const e = await hubInfo(hub, id); return e && e.holder && e.holder.name === 'Hub' && e.size === fileSize(hub, id); }, 'the hub to post its turn');
    await waitFor(async () => (await textsOf(home, id)).includes('and now from the phone'), 'the hub turn on Home');

    // every PC is off: the hub still answers, and Home picks it all up when it is back
    await home.stop();
    const again = await chatOn(hub, { prompt: 'home is off now', sessionId: id });
    assert.equal(again.sessionId, id);
    const back = await startPc(hub, 'Home', HOME_DEV, home.dataDir);
    await waitFor(async () => (await textsOf(back, id)).includes('home is off now'), 'the hub turn on Home once it is back');
    // a chat the phone starts on the hub reaches Home too
    const fresh = await chatOn(hub, { prompt: 'a new chat from the phone', chat: true });
    await waitFor(async () => (await textsOf(back, fresh.sessionId)).includes('a new chat from the phone'), 'the new chat on Home');
  });

  test('a message for a code conversation of a PC that is off waits on the hub, and its draft follows', async () => {
    const hub = await startHub({ MC_HUB_STALE_MS: '3000' });
    const homeDir = makeDataDir('mc-hub-home');
    const cwd = path.join(homeDir, 'thing');
    fs.mkdirSync(cwd, { recursive: true });
    const noTranscript = { FAKE_TRANSCRIPT: '' }; // the fake Claude only logs what it got
    const home = await startPc(hub, 'Home', HOME_DEV, homeDir, noTranscript);
    const id = crypto.randomUUID();
    const dir = path.join(homeDir, 'claude-home', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const base = { isSidechain: false, userType: 'external', entrypoint: 'sdk-cli', cwd, sessionId: id, version: '2.1.296' };
    const file = path.join(dir, id + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ ...base, type: 'user', uuid: crypto.randomUUID(), timestamp: new Date(Date.now() - 60000).toISOString(), promptSource: 'sdk', message: { role: 'user', content: 'start the work at home' } }) + '\n' +
      JSON.stringify({ ...base, type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date(Date.now() - 59000).toISOString(), message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'started' }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
    await waitFor(async () => { const e = await hubInfo(hub, id); return e && e.size === fs.statSync(file).size; }, 'the code conversation on the hub');
    const work = await startPc(hub, 'Work', WORK_DEV, undefined, { MC_HUB_STALE_MS: '3000' });
    await waitFor(async () => (await pc(work, 'GET', `/api/sessions?machine=${HOME_DEV}`)).json.some((x) => x.id === id), 'Home conversation on Work');

    // what is typed on Work becomes Home's draft, and the other way around
    assert.equal((await pc(work, 'PUT', '/api/drafts', { key: id, text: 'half a thought' })).status, 200);
    await waitFor(async () => (await pc(home, 'GET', `/api/drafts?key=${id}`)).json.text === 'half a thought', 'the draft on Home');
    assert.equal((await pc(home, 'PUT', '/api/drafts', { key: id, text: 'half a thought, finished at home' })).status, 200);
    await waitFor(async () => (await pc(work, 'GET', `/api/drafts?key=${id}`)).json.text === 'half a thought, finished at home', 'the draft back on Work');

    // Home goes off; Work sends two messages and takes one back
    await home.stop();
    await waitFor(async () => { const d = (await pc(work, 'GET', '/api/machines')).json; return d.machines.some((m) => m.id === HOME_DEV && !m.online); }, 'Home to count as off', 15000);
    const a = await pc(work, 'POST', `/api/waiting/${id}`, { prompt: 'run the tests when you are back' });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.json.state, 'waiting');
    assert.equal(a.json.originOnline, false);
    const b = await pc(work, 'POST', `/api/waiting/${id}`, { prompt: 'never mind this one' });
    assert.equal(b.status, 201, b.text);
    const c = await pc(work, 'POST', `/api/waiting/${id}/${b.json.sendId}/cancel`, {});
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.state, 'canceled');
    assert.equal((await pc(work, 'POST', `/api/waiting/${id}/${b.json.sendId}/cancel`, {})).status, 409, 'canceled once');
    const read = (await pc(work, 'GET', `/api/sessions/${id}?limit=40`)).json;
    assert.deepEqual(read.sends.map((x) => [x.text, x.state]), [['run the tests when you are back', 'waiting'], ['never mind this one', 'canceled']]);
    assert.equal((await pc(hub, 'POST', `/api/waiting/${'2'.repeat(8)}-2222-4222-8222-${'2'.repeat(12)}`, { prompt: 'x' })).status, 404, 'only another PC\'s conversation');

    // Home is back: it runs the waiting message once, and not the canceled one
    const back = await startPc(hub, 'Home', HOME_DEV, homeDir, noTranscript);
    await waitFor(() => fs.existsSync(back.fakeLog) && fs.readFileSync(back.fakeLog, 'utf8').includes('run the tests when you are back'), 'the message in Home Claude');
    await waitFor(async () => { const e = await hubInfo(hub, id); const x = e && e.sends.find((y) => y.sendId === a.json.sendId); return x && x.state === 'sent'; }, 'the message marked sent');
    await waitFor(async () => (await pc(work, 'GET', `/api/sessions/${id}?limit=40`)).json.sends.some((x) => x.sendId === a.json.sendId && x.state === 'sent'), 'Work to see it went');
    await sleep(1500);
    const log = fs.readFileSync(back.fakeLog, 'utf8');
    assert.ok(!log.includes('never mind this one'), 'the canceled one never ran');
    assert.equal(log.split('\n').filter((l) => l.includes('"stdin-user"') && l.includes('run the tests when you are back')).length, 1, 'it ran once');
  });

  test('a PC is not a hub, and the hub refuses a stranger and a wrong offset', async () => {
    const hub = await startHub();
    const home = await startPc(hub, 'Home', HOME_DEV);
    assert.equal((await pc(home, 'GET', '/api/hub/changes')).status, 404, 'a PC serves no mailbox');
    const secret = fs.readFileSync(hub.secretFile, 'utf8').trim();
    const put = (device, at, body = 'x\n') => request({ port: hub.bridgePort, host: `127.0.0.1:${hub.bridgePort}`, method: 'PUT', path: `/api/hub/transcripts/${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}?at=${at}&kind=chat`, headers: { 'X-MC-Bridge': secret, 'X-MC-Device': device, 'X-MC': '1' }, body });
    assert.equal((await put('s'.repeat(40), 0)).status, 403, 'an unknown device');
    assert.equal((await put(HOME_DEV, 0)).status, 200);
    const wrong = await put(HOME_DEV, 0);
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.reason, 'size');
    assert.equal(wrong.json.size, 2);
    const taken = await put(WORK_DEV, 2);
    assert.equal(taken.status, 409, 'Home holds it');
    assert.equal(taken.json.reason, 'baton');
  });
});
