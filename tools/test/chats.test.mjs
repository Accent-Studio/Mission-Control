// Tests for plain chats (server/lib/chats.js): a chat runs in the chats folder with web search only, its own system prompt,
// the user's own settings, no MCP servers and no skills; a resumed chat stays a chat; the list sorts chats and code
// conversations apart (kind=chat, kind=code); and the runner accepts exactly these flags and nothing looser.
// Runs against the FAKE Claude CLI in tools/fakeclaude. Run: npm test (2 test files at a time)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ROOT, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

async function boot(dataDir, env = {}, logName = 'fake.log') {
  const log = path.join(dataDir, logName);
  const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_LOG: log, FAKE_STEP_MS: '20', FAKE_TRANSCRIPT: path.join(dataDir, 'claude-home', 'projects', 'proj'), ...env } });
  s.spawns = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((l) => l.ev === 'spawn');
  toStop.push(s);
  return s;
}
function fresh(label) {
  const dataDir = makeDataDir(label);
  seedFixture(dataDir);
  return dataDir;
}

const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
const runOf = async (s, runId) => (await pc(s, 'GET', '/api/runs')).json.find((x) => x.runId === runId);
const flagOf = (args, f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function waitFor(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(50);
  }
}

describe('plain chats', () => {
  test('a new chat runs in the chats folder with web search only, its own prompt, no MCP servers and no permission mode to pick', async () => {
    const dataDir = fresh('mc-chat-new');
    const s = await boot(dataDir, { MC_IDLE_MS: '60000' });
    const a = await pc(s, 'POST', '/api/chat', { prompt: 'hello chat', chat: true, mode: 'plan', projectId: 'fixture' });
    assert.equal(a.status, 200, a.text);
    const sp = await waitFor(() => s.spawns()[0], 'the chat process');
    assert.ok(same(sp.cwd, path.join(dataDir, 'chats')), sp.cwd);
    assert.equal(flagOf(sp.args, '--tools'), 'WebSearch,WebFetch');
    assert.equal(flagOf(sp.args, '--allowedTools'), 'WebSearch,WebFetch');
    assert.equal(flagOf(sp.args, '--setting-sources'), 'user');
    assert.ok(sp.args.includes('--strict-mcp-config'));
    assert.ok(sp.args.includes('--disable-slash-commands'));
    assert.ok(same(flagOf(sp.args, '--system-prompt-file'), path.join(ROOT, 'server', 'prompts', 'chat.md')));
    assert.equal(flagOf(sp.args, '--permission-mode'), 'default', 'a chat never runs in plan mode');

    const run = await waitFor(async () => { const r = await runOf(s, a.json.runId); return r && r.state === 'idle' && r.sessionId && r; }, 'idle');
    assert.equal(run.chat, true);
    // a chat shows on claude.ai like a code conversation (Remote Control, "Show on claude.ai")
    const shown = await waitFor(async () => { const r = await runOf(s, a.json.runId); return r && r.remote === 'on' && r; }, 'Remote Control');
    assert.match(shown.remoteUrl, /^https:\/\/claude\.ai\/code\//);

    // the list puts it under Chats, with no project
    const chats = await waitFor(async () => { const l = (await pc(s, 'GET', '/api/sessions?kind=chat')).json; return l.length && l; }, 'the chat in the list');
    assert.equal(chats[0].id, run.sessionId);
    assert.equal(chats[0].kind, 'chat');
    assert.equal(chats[0].project, null);
    assert.ok(!(await pc(s, 'GET', '/api/sessions?kind=code')).json.some((x) => x.id === run.sessionId));
    assert.equal((await pc(s, 'GET', '/api/sessions/' + run.sessionId + '?limit=1')).json.kind, 'chat');
    assert.equal((await pc(s, 'GET', '/api/sessions/archived-count?kind=chat')).json.count, 0);
  });

  test('a code conversation gets none of the chat flags, and a resumed chat stays a chat after a restart', async () => {
    const dataDir = fresh('mc-chat-resume');
    const s1 = await boot(dataDir, { MC_IDLE_MS: '60000' });
    const code = await pc(s1, 'POST', '/api/chat', { prompt: 'code work' });
    assert.equal(code.status, 200, code.text);
    const c = await pc(s1, 'POST', '/api/chat', { prompt: 'a chat', chat: true });
    assert.equal(c.status, 200, c.text);
    await waitFor(() => s1.spawns().length === 2, 'two processes');
    const codeSpawn = s1.spawns().find((x) => !same(x.cwd, path.join(dataDir, 'chats')));
    assert.ok(codeSpawn, 'the code conversation is not in the chats folder');
    for (const f of ['--tools', '--setting-sources', '--strict-mcp-config', '--disable-slash-commands', '--system-prompt-file']) assert.ok(!codeSpawn.args.includes(f), f);
    // a code conversation gets Mission Control's own tools instead (runs.js writeMcpConfig)
    assert.equal(flagOf(codeSpawn.args, '--allowedTools'), 'mcp__mc');
    assert.ok(flagOf(codeSpawn.args, '--mcp-config'));
    const run = await waitFor(async () => { const r = await runOf(s1, c.json.runId); return r && r.state === 'idle' && r.sessionId && r; }, 'idle');
    await s1.stop();

    const s2 = await boot(dataDir, {}, 'fake2.log');
    const b = await pc(s2, 'POST', '/api/chat', { prompt: 'and again', sessionId: run.sessionId, mode: 'acceptEdits' });
    assert.equal(b.status, 200, b.text);
    const sp = await waitFor(() => s2.spawns()[0], 'the resumed chat');
    assert.equal(flagOf(sp.args, '--resume'), run.sessionId);
    assert.ok(same(sp.cwd, path.join(dataDir, 'chats')), sp.cwd);
    assert.equal(flagOf(sp.args, '--tools'), 'WebSearch,WebFetch');
    assert.equal(flagOf(sp.args, '--permission-mode'), 'default');
  });

  test('a chat cannot be the Com Link, and chat must be true or false', async () => {
    const s = await boot(fresh('mc-chat-bad'));
    assert.equal((await pc(s, 'POST', '/api/chat', { prompt: 'x', chat: true, persona: 'comlink' })).status, 400);
    assert.equal((await pc(s, 'POST', '/api/chat', { prompt: 'x', chat: 'yes' })).status, 400);
  });

  test('a new chat waits as a c- draft and is listed with the new drafts', async () => {
    const s = await boot(fresh('mc-chat-draft'));
    const key = 'c-0e5a1d7c-1111-4222-8333-944455556666';
    const put = await localReq(s, { method: 'PUT', path: '/api/drafts', body: { key, text: 'half a chat' }, headers: { 'X-MC': '1' } });
    assert.equal(put.status, 200, put.text);
    const d = (await pc(s, 'GET', '/api/drafts/new')).json.drafts;
    assert.ok(d.some((x) => x.key === key));
  });
});

describe('runner flags for chats', async () => {
  const { checkSpawnArgs, FIXED_ARGS } = await import('../../server/runner/shared.js');
  const { CHAT_FLAGS } = await import('../../server/lib/chats.js');
  test('the chat flags pass', () => {
    assert.equal(checkSpawnArgs([...FIXED_ARGS, '--model', 'claude-opus-5-5', ...CHAT_FLAGS]), null);
    assert.equal(checkSpawnArgs([...FIXED_ARGS, ...CHAT_FLAGS, '--effort', 'high']), null);
  });
  test('anything looser is refused', () => {
    assert.match(checkSpawnArgs([...FIXED_ARGS, '--tools', 'Bash']), /--tools/);
    assert.match(checkSpawnArgs([...FIXED_ARGS, '--allowedTools', 'WebSearch,WebFetch,Bash']), /--allowedTools/);
    assert.match(checkSpawnArgs([...FIXED_ARGS, '--setting-sources', 'user,project']), /--setting-sources/);
    assert.match(checkSpawnArgs([...FIXED_ARGS, '--system-prompt-file', 'C:\\Windows\\win.ini']), /--system-prompt-file/);
    assert.match(checkSpawnArgs([...FIXED_ARGS, '--mcp-config', 'x.json']), /--mcp-config/);
  });
});
