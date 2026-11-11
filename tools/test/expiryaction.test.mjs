// Tests for Lock (a conversation stays listed but read only) and At 5 min left (Compact by default, Handoff once, or None,
// sent before the prompt cache runs out). Claude is the FAKE CLI in tools/fakeclaude; FAKE_CACHE=5m makes its answers use
// the cache. MC_EXPIRY_LEAD_MS=299000 makes the action due one second after the cache was written, so the test runs in seconds.
// Run: npm test (2 test files at a time)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
    await sleep(150);
  }
}

// A transcript with one prompt and one answer that wrote a 5 min cache `agoMs` ago, on Haiku 5.5.
function seedConversation(tdir, agoMs, entrypoint = 'sdk-cli', cwd = tdir) {
  const id = crypto.randomUUID();
  const t = (ms) => new Date(Date.now() - ms).toISOString();
  const base = { isSidechain: false, userType: 'external', entrypoint, cwd, sessionId: id, version: '2.1.296' };
  const lines = [
    { ...base, type: 'user', uuid: crypto.randomUUID(), timestamp: t(agoMs + 2000), promptSource: 'sdk', message: { role: 'user', content: 'Hello there' } },
    { ...base, type: 'assistant', uuid: crypto.randomUUID(), timestamp: t(agoMs), message: { id: 'msg_seed', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Hi' }], usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 } } } },
  ];
  fs.writeFileSync(path.join(tdir, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return id;
}

// How many user records in the transcript carry this text (the fake saves what it was sent)
const sentCount = (tdir, id, needle) => fs.readFileSync(path.join(tdir, id + '.jsonl'), 'utf8').split('\n').filter((l) => l.includes(needle) && l.includes('"type":"user"')).length;

async function setup(label, agoMs, entrypoint, { chat = false, env = {} } = {}) {
  const dataDir = makeDataDir(label);
  seedFixture(dataDir);
  const tdir = path.join(dataDir, 'claude-home', 'projects', 'D--Dev');
  fs.mkdirSync(tdir, { recursive: true });
  const id = seedConversation(tdir, agoMs, entrypoint, chat ? path.join(dataDir, 'chats') : tdir);
  const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '20', FAKE_TRANSCRIPT: tdir, FAKE_CACHE: '5m', MC_EXPIRY_LEAD_MS: '299000', MC_IDLE_MS: '600000', MC_COMPACT_MIN_TOKENS: '100', ...env } });
  toStop.push(s);
  return { s, tdir, id };
}

describe('Lock and At 5 min left', () => {
  test('a locked conversation refuses every send, and locking drops the expiry action', async () => {
    const { s, id } = await setup('mc-lock', 3600e3); // cache long gone: nothing is sent to it
    const on = await pc(s, 'POST', `/api/sessions/${id}/expiry-action`, { action: 'handoff' });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.action, 'handoff');
    assert.equal(on.json.note, 'Cache expired', 'an expired cache gets nothing');
    assert.equal((await pc(s, 'POST', `/api/sessions/${id}/expiry-action`, { action: 'ping' })).status, 400);

    assert.equal((await pc(s, 'POST', `/api/sessions/${id}/meta`, { locked: 'yes' })).status, 400);
    assert.equal((await pc(s, 'POST', `/api/sessions/${id}/meta`, { locked: true })).status, 200);
    const row = (await pc(s, 'GET', '/api/sessions')).json.find((x) => x.id === id);
    assert.equal(row.locked, true);
    assert.equal(row.expiryAction, null, 'locking drops the expiry action');
    assert.equal((await pc(s, 'GET', `/api/sessions/${id}?limit=5`)).json.locked, true);

    const chat = await pc(s, 'POST', '/api/chat', { prompt: 'hello again', sessionId: id });
    assert.equal(chat.status, 409, chat.text);
    assert.match(chat.json.error, /locked/);
    const later = await pc(s, 'POST', '/api/delayed', { kind: 'timer', at: new Date(Date.now() + 600e3).toISOString(), req: { prompt: 'later', sessionId: id } });
    assert.equal(later.status, 409, later.text);
    assert.equal((await pc(s, 'POST', `/api/sessions/${id}/expiry-action`, { action: 'compact' })).status, 409);

    assert.equal((await pc(s, 'POST', `/api/sessions/${id}/meta`, { locked: false })).status, 200);
    const ok = await pc(s, 'POST', '/api/chat', { prompt: 'hello again', sessionId: id });
    assert.equal(ok.status, 200, ok.text);
  });

  test('Handoff is asked once before the cache runs out, as a notice line, then it is back to Compact', async () => {
    const { s, tdir, id } = await setup('mc-handoff', 60e3); // a 5 min cache written a minute ago: due at once
    assert.equal((await pc(s, 'POST', `/api/sessions/${id}/expiry-action`, { action: 'handoff' })).status, 200);
    const done = await waitFor(async () => { const w = (await pc(s, 'GET', `/api/sessions/${id}/expiry-action`)).json; return w && w.last === 'sent' && w.lastAction === 'handoff' && w; }, 'the handoff to go out', 30000);
    assert.equal(done.action, 'compact', 'once only: back to the default');
    assert.equal(done.choice, null);
    await waitFor(() => sentCount(tdir, id, '[Mission Control handoff]') === 1, 'the handoff in the transcript');
    await sleep(4000);
    assert.equal(sentCount(tdir, id, '[Mission Control handoff]'), 1, 'never twice');
    assert.equal((await pc(s, 'GET', '/api/sessions')).json.find((x) => x.id === id).expiryAction, 'compact');

    const msgs = (await pc(s, 'GET', `/api/sessions/${id}?limit=40`)).json.messages;
    assert.equal(msgs.filter((m) => m.role === 'notice' && m.noticeType === 'handoff').length, 1);
    assert.ok(!msgs.some((m) => m.role === 'user' && /Mission Control handoff/.test(m.text || '')), 'never shown as my words');
    assert.ok(msgs.some((m) => m.role === 'assistant' && /handoff skill/.test(m.text || '')), "Claude's answer is shown");
  });

  test('Compact sends /compact once per cache time and stays on, and None sends nothing', async () => {
    const { s, tdir, id } = await setup('mc-compact', 60e3);
    const none = await pc(s, 'POST', `/api/sessions/${id}/expiry-action`, { action: 'none' });
    assert.equal(none.json.action, null);
    assert.equal(none.json.choice, 'none');
    await sleep(2500);
    assert.equal(sentCount(tdir, id, '/compact'), 0);
    const on = await pc(s, 'POST', `/api/sessions/${id}/expiry-action`, { action: 'compact' });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.choice, null, 'Compact is the default: no choice is stored for it');
    await waitFor(async () => { const w = (await pc(s, 'GET', `/api/sessions/${id}/expiry-action`)).json; return w && w.last === 'sent' && w.lastAction === 'compact'; }, 'compact to go out', 30000);
    await waitFor(() => sentCount(tdir, id, '/compact') === 1, '/compact in the transcript');
    await sleep(4000);
    assert.equal(sentCount(tdir, id, '/compact'), 1, 'once per cache time');
    assert.equal((await pc(s, 'GET', '/api/sessions')).json.find((x) => x.id === id).expiryAction, 'compact', 'still on');
  });

  test('a /compact the CLI refuses goes out once per cache time, not again every few seconds', async () => {
    const { s, tdir, id } = await setup('mc-compact-refused', 60e3, undefined, { env: { FAKE_COMPACT: 'refuse' } });
    await waitFor(() => sentCount(tdir, id, '/compact') === 1, 'the default /compact', 40000);
    await sleep(8000);
    assert.equal(sentCount(tdir, id, '/compact'), 1, 'once per cache time');
    const w = (await pc(s, 'GET', `/api/sessions/${id}/expiry-action`)).json;
    assert.equal(w.last, 'sent');
  });

  test('a chat gets neither Compact nor Handoff: slash commands and skills are off in a chat', async () => {
    const { s, tdir, id } = await setup('mc-compact-chat', 60e3, undefined, { chat: true });
    const row = (await pc(s, 'GET', '/api/sessions')).json.find((x) => x.id === id);
    assert.equal(row.kind, 'chat');
    assert.equal(row.expiryAction, null);
    assert.equal((await pc(s, 'POST', `/api/sessions/${id}/expiry-action`, { action: 'handoff' })).status, 409);
    assert.equal((await pc(s, 'GET', `/api/sessions/${id}/expiry-action`)).json.action, null);
    await sleep(12000); // the look over recent conversations runs at 9 s
    assert.equal(sentCount(tdir, id, '/compact'), 0);
    assert.ok(!(await pc(s, 'GET', '/api/sessions/cache-ending')).json.some((x) => x.id === id), 'a chat does not pulse: nothing can be picked for it');
  });

  test('a conversation with no choice gets Compact by default', async () => {
    const { s, tdir, id } = await setup('mc-default', 60e3);
    const row = (await pc(s, 'GET', '/api/sessions')).json.find((x) => x.id === id);
    assert.equal(row.expiryAction, 'compact');
    assert.equal(row.expiryChoice, null);
    await waitFor(() => sentCount(tdir, id, '/compact') === 1, 'the default /compact (found by the look over recent conversations)', 40000);
  });

  test('Compact waits for a big cache: under the minimum nothing is sent, and the page says why', async () => {
    const { s, tdir, id } = await setup('mc-compact-small', 60e3, undefined, { env: { MC_COMPACT_MIN_TOKENS: '5000' } }); // the seed holds 910
    await waitFor(async () => { const w = (await pc(s, 'GET', `/api/sessions/${id}/expiry-action`)).json; return w && /^Under 5K tokens/.test(w.note || ''); }, 'the note about the small cache', 40000);
    await sleep(3000);
    assert.equal(sentCount(tdir, id, '/compact'), 0);
  });

  test('None: nothing is sent, and the conversation is named while its cache is about to run out', async () => {
    const { s, tdir, id } = await setup('mc-ending', 60e3);
    assert.equal((await pc(s, 'POST', `/api/sessions/${id}/expiry-action`, { action: 'none' })).status, 200);
    const list = await waitFor(async () => { const r = (await pc(s, 'GET', '/api/sessions/cache-ending')).json; return Array.isArray(r) && r.find((x) => x.id === id); }, 'the cache-ending list to name it', 40000);
    assert.ok(Date.parse(list.expiresAt) > Date.now());
    assert.equal(sentCount(tdir, id, '/compact'), 0);
  });

  test('a conversation last used in a terminal gets no default', async () => {
    const { s, id } = await setup('mc-terminal', 60e3, 'cli');
    const row = (await pc(s, 'GET', '/api/sessions')).json.find((x) => x.id === id);
    assert.equal(row.expiryAction, null);
    assert.equal((await pc(s, 'GET', `/api/sessions/${id}/expiry-action`)).json.action, null);
  });
});
