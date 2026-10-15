// Tests for a conversation that is read while a process is still answering it, and for the one-off flag that keeps
// a task off claude.ai. Both run against the FAKE Claude CLI in tools/fakeclaude (it writes its conversation to the
// transcript as it goes, like the real CLI, and answers the remote_control request). Nothing here starts a real
// Claude conversation. Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ROOT, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

async function boot(fakeEnv = {}) {
  const dataDir = makeDataDir('mc-live');
  seedFixture(dataDir);
  const log = path.join(dataDir, 'fake.log');
  const projDir = path.join(dataDir, 'claude-home', 'projects', 'proj');
  const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_LOG: log, FAKE_STEP_MS: '350', FAKE_TRANSCRIPT: projDir, ...fakeEnv } });
  s.log = log;
  s.projDir = projDir;
  s.lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  s.controls = () => s.lines().filter((l) => l.ev === 'stdin-control-request');
  toStop.push(s);
  return s;
}

const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });

async function waitFor(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(30);
  }
}

// A saved conversation with one exchange, the way an earlier process left it.
function savedConversation(s) {
  fs.mkdirSync(s.projDir, { recursive: true });
  const id = crypto.randomUUID();
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  const recs = [
    { type: 'user', cwd: s.dataDir, sessionId: id, timestamp: at(60000), uuid: crypto.randomUUID(), promptSource: 'sdk', message: { role: 'user', content: 'Redesign the chat page' } },
    { type: 'assistant', cwd: s.dataDir, sessionId: id, timestamp: at(50000), uuid: crypto.randomUUID(), message: { id: 'msg_old', role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'Here is the plan.' }], usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  fs.writeFileSync(path.join(s.projDir, id + '.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return id;
}

const session = async (s, id) => (await pc(s, 'GET', `/api/sessions/${id}?limit=40`)).json;
const runOf = async (s, runId) => (await pc(s, 'GET', '/api/runs')).json.find((x) => x.runId === runId);
const userTexts = (j) => j.messages.filter((m) => m.role === 'user').map((m) => m.text);
const aiTexts = (j) => j.messages.filter((m) => m.role === 'assistant').map((m) => m.text);

// The chat events of one run as the pages receive them (the event stream).
function listen(s) {
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
}

describe('a conversation read while a process answers it', () => {
  test('the saved part stops where the turn began and the turn comes as events, so nothing is in both', async () => {
    const s = await boot();
    const id = savedConversation(s);
    const text = 'Much better, but make the box bigger';
    const r = await pc(s, 'POST', '/api/chat', { prompt: text, sessionId: id });
    assert.equal(r.status, 200, r.text);

    // wait until the turn has produced something, then read the conversation the way the Talk page does
    const seen = [];
    await waitFor(async () => {
      const j = await session(s, id);
      if (j.live && j.live.events.some((e) => e.event && e.event.type === 'assistant')) seen.push(j);
      return seen.length >= 1;
    }, 'the turn under way');
    const j = seen[0];
    assert.equal(j.live.runId, r.json.runId);
    assert.equal(j.live.cut, true);
    assert.ok(['starting', 'working'].includes(j.live.state));
    // the transcript on disk already holds the turn (that is what used to show twice) ...
    const onDisk = fs.readFileSync(path.join(s.projDir, id + '.jsonl'), 'utf8');
    assert.ok(onDisk.includes(text), 'the CLI saved the message as it went');
    // ... but the saved part sent to the page has none of it
    assert.deepEqual(userTexts(j), ['Redesign the chat page']);
    assert.deepEqual(aiTexts(j), ['Here is the plan.']);
    // the turn's own events: the message first, then the replies, numbered in order and not past "upto"
    assert.equal(j.live.events[0].sent.text, text);
    assert.ok(Number.isFinite(Date.parse(j.live.events[0].at)), 'the message carries the time it was sent');
    const seqs = j.live.events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.ok(seqs.every((n, i) => i === 0 || n > seqs[i - 1]));
    assert.ok(Math.max(...seqs) <= j.live.upto);
    assert.ok(j.live.turn && Date.parse(j.live.turn.startedAt) > 0);

    // read again at several moments of the turn: the message never shows in the saved part while the turn works
    for (let i = 0; i < 4; i++) {
      const k = await session(s, id);
      if (k.live) assert.deepEqual(userTexts(k), ['Redesign the chat page']);
      await sleep(120);
    }

    // when the turn is over, everything is saved and the live part is gone: one of each
    await waitFor(async () => (await runOf(s, r.json.runId)).state === 'idle', 'the turn to end');
    const done = await session(s, id);
    assert.equal(done.live, undefined);
    assert.deepEqual(userTexts(done), ['Redesign the chat page', text]);
    assert.equal(aiTexts(done).filter((t) => t.startsWith('ECHO')).length, 1);
    assert.equal(aiTexts(done).filter((t) => t.startsWith('DONE')).length, 1);
  });

  test('a message sent while Claude works is in the turn once: in its events, and once in the saved conversation after', async () => {
    const s = await boot();
    const id = savedConversation(s);
    const first = 'First question';
    const second = 'And one more thing';
    const r = await pc(s, 'POST', '/api/chat', { prompt: first, sessionId: id });
    await waitFor(async () => (await session(s, id)).live, 'the turn under way');
    assert.equal((await pc(s, 'POST', '/api/chat', { prompt: second, runId: r.json.runId })).status, 200);
    const j = await waitFor(async () => {
      const k = await session(s, id);
      return k.live && k.live.events.filter((e) => e.sent).length === 2 && k;
    }, 'both messages in the turn');
    assert.deepEqual(j.live.events.filter((e) => e.sent).map((e) => e.sent.text), [first, second]);
    assert.deepEqual(userTexts(j), ['Redesign the chat page']);
    await waitFor(async () => (await runOf(s, r.json.runId)).state === 'idle', 'the turn to end');
    const done = await session(s, id);
    assert.deepEqual(userTexts(done), ['Redesign the chat page', first, second]);
  });

  test('every chat event of a run is numbered 1, 2, 3 ... so a page can drop one it already has', async () => {
    const s = await boot({ FAKE_STEP_MS: '60' });
    const l = listen(s);
    try {
      await sleep(200);
      const r = await pc(s, 'POST', '/api/chat', { prompt: 'count me' });
      await waitFor(async () => (await runOf(s, r.json.runId)).state === 'idle', 'the turn to end');
      await sleep(100);
      const mine = l.events.filter((e) => e.runId === r.json.runId);
      assert.ok(mine.length >= 8, 'a whole turn was seen');
      assert.deepEqual(mine.map((e) => e.seq), mine.map((_, i) => i + 1));
      assert.equal(mine[0].sent.text, 'count me');
    } finally {
      l.stop();
    }
  });

  test('a conversation nobody is answering has no live part', async () => {
    const s = await boot();
    const id = savedConversation(s);
    const j = await session(s, id);
    assert.equal(j.live, undefined);
    assert.deepEqual(userTexts(j), ['Redesign the chat page']);
  });
});

describe('one-off tasks stay off claude.ai', () => {
  const idle = async (s, runId) => waitFor(async () => (await runOf(s, runId)).state === 'idle' && (await runOf(s, runId)), 'an idle run');

  test('remote:false never asks for Remote Control; a conversation without the flag still does', async () => {
    const s = await boot({ FAKE_STEP_MS: '20' });
    const one = await pc(s, 'POST', '/api/chat', { prompt: 'Commit the changes', remote: false });
    assert.equal(one.status, 200, one.text);
    const oneRun = await idle(s, one.json.runId);
    await sleep(300);
    assert.equal(s.controls().length, 0, 'the one-off process was not asked');
    assert.equal(oneRun.remote, undefined);
    assert.equal(oneRun.remoteUrl, undefined);

    const talk = await pc(s, 'POST', '/api/chat', { prompt: 'Hello' });
    await idle(s, talk.json.runId);
    await waitFor(async () => (await runOf(s, talk.json.runId)).remote === 'on', 'remote on for the conversation');
    assert.deepEqual(s.controls().map((c) => [c.subtype, c.enabled]), [['remote_control', true]]);
  });

  test('the Settings switch, off and on again, never reaches a one-off process', async () => {
    const s = await boot({ FAKE_STEP_MS: '20' });
    const one = await pc(s, 'POST', '/api/chat', { prompt: 'Review and push', remote: false });
    await idle(s, one.json.runId);
    const talk = await pc(s, 'POST', '/api/chat', { prompt: 'Hello' });
    await idle(s, talk.json.runId);
    await waitFor(async () => (await runOf(s, talk.json.runId)).remote === 'on', 'remote on');
    assert.equal((await pc(s, 'PUT', '/api/voice/prefs', { remoteControl: false })).status, 200);
    await waitFor(() => s.controls().length === 2, 'the disable request');
    assert.equal((await pc(s, 'PUT', '/api/voice/prefs', { remoteControl: true })).status, 200);
    await waitFor(() => s.controls().length === 3, 'the enable request');
    await sleep(300);
    assert.equal(s.controls().length, 3);
    const spawns = s.lines().filter((l) => l.ev === 'spawn').map((l) => l.pid);
    assert.equal(spawns.length, 2);
    const asked = new Set(s.controls().map((c) => c.pid));
    assert.equal(asked.size, 1, 'only the conversation was ever asked');
    assert.ok(!asked.has(spawns[0]), 'not the one-off process (the first one started)');
  });

  test('the flag belongs to the conversation: options change, idle close and a bare resume all stay off', async () => {
    const s = await boot({ FAKE_STEP_MS: '20', MC_IDLE_MS: '400' });
    const one = await pc(s, 'POST', '/api/chat', { prompt: 'Commit the changes', remote: false, effort: 'low' });
    assert.equal(one.status, 200, one.text);
    const first = await idle(s, one.json.runId);
    assert.ok(first.sessionId, 'the run knows its conversation');
    const sid = first.sessionId;
    // 1. an options change respawns an idle process
    const opt = await pc(s, 'POST', '/api/chat', { prompt: 'again', sessionId: sid, effort: 'high' });
    assert.equal(opt.status, 200, opt.text);
    assert.notEqual(opt.json.runId, one.json.runId, 'a new process');
    await idle(s, opt.json.runId);
    // 2. the idle close, then a resume that sends no remote (the Talk page)
    await waitFor(async () => (await runOf(s, opt.json.runId)).state !== 'idle', 'the idle close');
    const bare = await pc(s, 'POST', '/api/chat', { prompt: 'and again', sessionId: sid });
    assert.equal(bare.status, 200, bare.text);
    assert.notEqual(bare.json.runId, opt.json.runId, 'a new process');
    await idle(s, bare.json.runId);
    await sleep(300);
    assert.equal(s.controls().length, 0, 'no process of the conversation was ever asked for Remote Control');
    assert.equal(s.lines().filter((l) => l.ev === 'spawn').length, 3);
    // 3. the user turning it on explicitly wins, and then it sticks
    await waitFor(async () => (await runOf(s, bare.json.runId)).state !== 'idle', 'the idle close');
    const on = await pc(s, 'POST', '/api/chat', { prompt: 'show it', sessionId: sid, remote: true });
    await idle(s, on.json.runId);
    await waitFor(async () => (await runOf(s, on.json.runId)).remote === 'on', 'remote on when asked for');
    assert.deepEqual(s.controls().map((c) => [c.subtype, c.enabled]), [['remote_control', true]]);
  });

  test('remote must be true or false', async () => {
    const s = await boot();
    const r = await pc(s, 'POST', '/api/chat', { prompt: 'x', remote: 'no' });
    assert.equal(r.status, 400);
    assert.match(r.text, /remote must be true or false/);
  });

  test('the pages: Commit and Review and push and the skill chips send the flag, the Talk page does not', () => {
    const read = (f) => fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
    assert.match(read('project.html'), /silent: true, remote: false/);
    assert.match(read('index.html'), /MC\.comlink\.prefill\('\/' \+ b\.dataset\.n \+ ' ', \{oneOff: true\}\)/);
    assert.match(read('automation.html'), /MC\.comlink\.prefill\('\/' \+ b\.dataset\.sk \+ ' ', \{oneOff: true\}\)/);
    assert.doesNotMatch(read('chat.html'), /remote\s*[:=]\s*false/);
  });

  test('the flag is kept with the conversation on disk: a restart of the server forgets nothing', async () => {
    const s = await boot({ FAKE_STEP_MS: '20' });
    const one = await pc(s, 'POST', '/api/chat', { prompt: 'Commit the changes', remote: false });
    const sid = (await idle(s, one.json.runId)).sessionId;
    const metaFile = path.join(s.dataDir, 'sessions-meta.json');
    assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8'))[sid].oneOff, true);
    await s.stop();

    // a new server process: its memory of the last run is empty, only the notes on disk are left
    const log2 = path.join(s.dataDir, 'fake2.log');
    const s2 = await startServer({ dataDir: s.dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_LOG: log2, FAKE_STEP_MS: '20', FAKE_TRANSCRIPT: s.projDir, MC_IDLE_MS: '400' } });
    toStop.push(s2);
    const controls2 = () => (fs.existsSync(log2) ? fs.readFileSync(log2, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((l) => l.ev === 'stdin-control-request');
    const bare = await pc(s2, 'POST', '/api/chat', { prompt: 'and again', sessionId: sid });
    assert.equal(bare.status, 200, bare.text);
    await waitFor(async () => (await runOf(s2, bare.json.runId)).state === 'idle', 'idle');
    await sleep(300);
    assert.equal(controls2().length, 0, 'the resumed one-off conversation was not put on claude.ai');

    // turning it on (a new process, after the idle close) is remembered the same way
    await waitFor(async () => (await runOf(s2, bare.json.runId)).state !== 'idle', 'the idle close');
    const on =await pc(s2, 'POST', '/api/chat', { prompt: 'show it', sessionId: sid, remote: true });
    await waitFor(async () => (await runOf(s2, on.json.runId)).remote === 'on', 'remote on when asked for');
    assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8'))[sid], undefined, 'no flag left for a conversation that is shown');
  });

  test('the pages: a wake-word follow-up resumes the conversation on screen; the Sessions tab and Running panel use the live part', () => {
    const read = (f) => fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
    assert.match(read('redline.js'), /MC\.comlink\.send\(text, \{ voice:true, sessionId: MC\.comlink\.mini\.sessionId\(\) \|\| undefined \}\)/);
    const project = read('project.html');
    assert.match(project, /MC\.liveTurn\.messages\(s\)/);
    assert.match(project, /MC\.liveTurn\.startedAt\(s\)/);
  });
});

describe('a message sent while Claude writes the end of a turn', () => {
  for (const [label, env] of [
    ['the CLI saves it under the id it was given', {}],
    ['the CLI makes up an id of its own and names it in the replay', { FAKE_UUID: 'ignore' }],
  ]) {
    test(`it shows once from the end of that turn to the end of the next (${label})`, async () => {
      const s = await boot({ FAKE_STEP_MS: '120', FAKE_END_MS: '1800', ...env });
      const id = savedConversation(s);
      const r = await pc(s, 'POST', '/api/chat', { prompt: 'first question', sessionId: id });
      assert.equal(r.status, 200, r.text);
      const done = (e) => e.event && e.event.type === 'assistant' && e.event.message.content.some((b) => b.text && b.text.startsWith('DONE'));
      // Claude has written the end of the turn and has not sent its result line yet
      const t1 = (await waitFor(async () => {
        const j = await session(s, id);
        return j.live && j.live.events.some(done) && j;
      }, 'the end of the first turn')).live.turn.startedAt;
      const late = 'one more thing before you finish';
      assert.equal((await pc(s, 'POST', '/api/chat', { prompt: late, runId: r.json.runId })).status, 200);
      // the next turn has begun (the result line was read)
      const j = await waitFor(async () => {
        const k = await session(s, id);
        const named = !env.FAKE_UUID || (k.live && k.live.events.some((e) => e.sent && e.alias));
        return k.live && k.live.turn.startedAt !== t1 && named && k;
      }, 'the second turn');
      // the CLI had saved the late message before that, so the byte mark falls behind it ...
      assert.ok(fs.readFileSync(path.join(s.projDir, id + '.jsonl'), 'utf8').includes(late));
      // ... and still the message is in the live events once and in the saved part not at all
      assert.equal(j.live.cut, true);
      assert.deepEqual(j.live.events.filter((e) => e.sent).map((e) => e.sent.text), [late]);
      assert.deepEqual(userTexts(j), ['Redesign the chat page', 'first question']);
      for (let i = 0; i < 3; i++) {
        const k = await session(s, id);
        if (k.live && k.live.cut) assert.equal(userTexts(k).filter((t) => t === late).length, 0);
        await sleep(100);
      }
      await waitFor(async () => (await runOf(s, r.json.runId)).state === 'idle', 'the second turn to end', 20000);
      const end = await session(s, id);
      assert.equal(end.live, undefined);
      assert.deepEqual(userTexts(end), ['Redesign the chat page', 'first question', late]);
    });
  }
});

describe('what the server keeps of a turn in progress', () => {
  test('events are kept while the turn works and let go when it ends', async () => {
    const s = await boot({ FAKE_STEP_MS: '200' });
    const r = await pc(s, 'POST', '/api/chat', { prompt: 'plain turn' });
    await waitFor(async () => (await runOf(s, r.json.runId)).liveEvents > 3, 'events kept');
    await waitFor(async () => (await runOf(s, r.json.runId)).state === 'idle', 'the turn to end');
    assert.equal((await runOf(s, r.json.runId)).liveEvents, undefined, 'nothing is kept for a turn that is over');
  });

  test('a flood of big blocks goes past the byte cap: the page is told, the response stays small, the memory is let go', async () => {
    const s = await boot({ FAKE_STEP_MS: '100', MC_TURN_BYTES: '200000', FAKE_FLOOD_N: '120', FAKE_FLOOD_B: '5000' });
    const id = savedConversation(s);
    const r = await pc(s, 'POST', '/api/chat', { prompt: 'FLOOD it', sessionId: id });
    const res = await waitFor(async () => {
      const p = await pc(s, 'GET', `/api/sessions/${id}?limit=40`);
      return p.json.live && p.json.live.truncated && p;
    }, 'the cap to be passed');
    assert.equal(res.json.live.cut, false, 'no cut: the saved conversation is the whole account');
    assert.deepEqual(res.json.live.events, []);
    assert.ok(res.text.length < 350000, `response is ${res.text.length} bytes`);
    assert.equal((await runOf(s, r.json.runId)).liveEvents, undefined, 'nothing kept once over the cap');
    await waitFor(async () => (await runOf(s, r.json.runId)).state === 'idle', 'the flood to end', 30000);
    assert.equal((await runOf(s, r.json.runId)).liveEvents, undefined);
    assert.equal((await session(s, id)).live, undefined);
  });

  test('the page reads the saved conversation again when events were skipped, and while a turn is too long to keep', () => {
    const chat = fs.readFileSync(path.join(ROOT, 'app', 'chat.html'), 'utf8');
    assert.match(chat, /d\.seq > r\.seq \+ 1/, 'a gap in the numbers is noticed');
    assert.match(chat, /refreshHistory\(r\.sessionId\)/);
    assert.match(chat, /r\.polled = !!L\.truncated/);
  });
});

describe('MC.liveTurn (the Sessions tab and the Running panel)', () => {
  const load = () => {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'api.js'), 'utf8');
    const MC = {};
    new Function('MC', src.slice(src.indexOf('MC.liveTurn = ')))(MC);
    return MC.liveTurn;
  };
  const text = (t) => ({ event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }, { type: 'text', text: t }] } } });

  test('messages: the saved part, then the turn in progress (your message and what Claude wrote so far)', () => {
    const L = load();
    const saved = [{ role: 'user', text: 'old', at: '2026-10-13T10:00:00Z' }, { role: 'assistant', text: 'old answer' }];
    const s = { messages: saved, live: { cut: true, turn: { startedAt: '2026-10-13T10:05:00Z' }, events: [{ sent: { text: 'now' }, at: '2026-10-13T10:05:00Z' }, text('working on it'), { event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } } }] } };
    assert.deepEqual(L.messages(s).map((m) => [m.role, m.text]), [['user', 'old'], ['assistant', 'old answer'], ['user', 'now'], ['assistant', 'working on it']]);
    assert.equal(L.startedAt(s), Date.parse('2026-10-13T10:05:00Z'));
  });

  test('messages: with no live part, or one that is not cut, only the saved part; startedAt is null without a turn', () => {
    const L = load();
    const saved = [{ role: 'user', text: 'a' }];
    assert.deepEqual(L.messages({ messages: saved }), saved);
    assert.deepEqual(L.messages({ messages: saved, live: { cut: false, events: [{ sent: { text: 'x' } }] } }), saved);
    assert.equal(L.startedAt({ messages: saved }), null);
  });
});
