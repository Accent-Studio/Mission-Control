// Tests for the usage index (server/services/usageIndex.js): hourly token totals per session, read incrementally from
// synthetic transcripts in a temporary Claude home. Nothing real is read or written.
// Run: node --test "tools/test/*.test.mjs"        (no npm packages; no server is started)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-usage-'));
const home = path.join(root, 'claude');
const dataDir = path.join(root, 'data');
const projects = path.join(home, 'projects');
const DIR = 'D--Dev';
fs.mkdirSync(path.join(projects, DIR), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.MC_CLAUDE_HOME = home;
process.env.MC_DATA_DIR = dataDir;

let usage;
before(async () => {
  usage = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../server/services/usageIndex.js')).href);
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 8, 1, 10, 0, 0); // an exact hour
const HOUR = Math.floor(T0 / 3600000);
const iso = (ms) => new Date(ms).toISOString();
const key = (h) => String(HOUR + h);
let counter = 0;
const newSid = () => `${String(++counter).padStart(8, '0')}-1111-4222-8333-444444444444`;
const mainFile = (sid) => path.join(projects, DIR, `${sid}.jsonl`);
const subFile = (sid, name) => path.join(projects, DIR, sid, 'subagents', name);

const u = (over = {}) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...over,
});
function asst(sid, id, ms, usageBlock, opts = {}) {
  const content = opts.content || [{ type: 'text', text: 'hello' }];
  return JSON.stringify({
    parentUuid: null,
    isSidechain: !!opts.side,
    message: { model: opts.model || 'claude-opus-5-5', id, type: 'message', role: 'assistant', content, usage: usageBlock },
    requestId: 'req_' + id,
    type: 'assistant',
    uuid: 'u-' + id + ms,
    timestamp: iso(ms),
    sessionId: sid,
    cwd: opts.cwd || 'D:\\Dev\\Demo',
  });
}
const tool = (name) => ({ type: 'tool_use', id: 'toolu_' + name, name, input: { path: 'x' } });
const prompt = (ms, content, extra = {}) =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content }, uuid: 'p' + ms, timestamp: iso(ms), cwd: 'D:\\Dev\\Demo', ...extra });
const other = (ms) => JSON.stringify({ type: 'system', subtype: 'info', timestamp: iso(ms), content: 'note' });
const write = (file, lines, tail = '\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + tail);
};
const append = (file, lines, tail = '\n') => fs.appendFileSync(file, lines.join('\n') + tail);
const totalOf = (s, hour = 0) => s.h[key(hour)];

describe('usage index', () => {
  test('a message id is counted once, a bigger repeat adds only the increase, cache writes split into 5m and 1h', async () => {
    const sid = newSid();
    write(mainFile(sid), [
      asst(sid, 'msg_A', T0 + 1000, u({ input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 } })),
      asst(sid, 'msg_A', T0 + 1100, u({ input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 } })),
      asst(sid, 'msg_A', T0 + 1200, u({ input_tokens: 3, output_tokens: 25, cache_read_input_tokens: 500, cache_creation_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 } })),
      asst(sid, 'msg_B', T0 + 2000, u({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 50 })),
      asst(sid, 'msg_S', T0 + 3000, u({ input_tokens: 99, output_tokens: 99 }), { model: '<synthetic>' }),
      JSON.stringify({ type: 'assistant', timestamp: iso(T0 + 4000), message: { model: 'claude-opus-5-5', id: 'msg_N', content: [] } }),
    ]);
    await usage.runUsagePass();
    const s = usage.usageSessions()[sid];
    assert.ok(s, 'session is indexed');
    assert.equal(s.dir, DIR);
    assert.equal(s.cwd, 'D:\\Dev\\Demo');
    const m = totalOf(s).m['claude-opus-5-5'];
    // [requests, in, out, cacheRead, cacheWrite5m, cacheWrite1h, ms]
    assert.deepEqual(m.slice(0, 6), [2, 4, 27, 500, 150, 300]);
    assert.equal(totalOf(s).m['<synthetic>'], undefined);
    assert.deepEqual(totalOf(s).sm, {});
  });

  test('a subagent file counts for the parent session, in sm', async () => {
    const sid = newSid();
    write(mainFile(sid), [prompt(T0, 'go'), asst(sid, 'msg_M', T0 + 1000, u({ input_tokens: 1, output_tokens: 5 }), { content: [tool('Agent')] })]);
    write(subFile(sid, 'agent-aaa.jsonl'), [
      prompt(T0 + 2000, 'task for the agent'),
      asst(sid, 'msg_X', T0 + 3000, u({ input_tokens: 7, output_tokens: 70 }), { model: 'claude-haiku-5', side: true, content: [tool('Read'), tool('Grep')] }),
    ]);
    write(path.join(projects, DIR, sid, 'subagents', 'workflows', 'wf_1', 'agent-bbb.jsonl'), [
      asst(sid, 'msg_Y', T0 + 4000, u({ input_tokens: 2, output_tokens: 20 }), { model: 'claude-haiku-5', side: true }),
    ]);
    await usage.runUsagePass();
    const s = usage.usageSessions()[sid];
    const h = totalOf(s);
    assert.deepEqual(h.m['claude-opus-5-5'].slice(0, 3), [1, 1, 5]);
    assert.deepEqual(h.sm['claude-haiku-5'].slice(0, 3), [2, 9, 90]);
    assert.equal(h.m['claude-haiku-5'], undefined);
    assert.equal(h.t, 3, 'tool calls are summed over both');
    assert.equal(h.u, 1, 'the agent task is not a typed prompt');
    assert.equal(Object.keys(usage.usageSessions()).filter((k) => k === sid).length, 1);
  });

  test('active time counts gaps up to 5 minutes, to the hour of the later line, and the same gap goes to the model', async () => {
    const sid = newSid();
    const t = T0 + 59 * 60000 + 30000; // 10:59:30
    write(mainFile(sid), [
      other(t),
      asst(sid, 'msg_1', t + 60000, u({ output_tokens: 1 })), // 11:00:30, gap 60 s, later line is in hour 1
      other(t + 60000 + 5 * 60000), // gap exactly 5 min counts
      other(t + 60000 + 5 * 60000 + 5 * 60000 + 1), // gap just over 5 min does not
      asst(sid, 'msg_2', t + 60000 + 10 * 60000 + 1 + 20000, u({ output_tokens: 1 })), // gap 20 s
    ]);
    await usage.runUsagePass();
    const s = usage.usageSessions()[sid];
    assert.equal(s.h[key(0)], undefined, 'nothing is active in the first hour');
    assert.equal(totalOf(s, 1).a, 60000 + 300000 + 20000);
    assert.equal(totalOf(s, 1).m['claude-opus-5-5'][6], 60000 + 20000, 'ms only for gaps ending at an assistant line');
    assert.equal(s.first, t);
    assert.equal(s.last, t + 60000 + 10 * 60000 + 1 + 20000);
  });

  test('prompts and tool calls are counted', async () => {
    const sid = newSid();
    write(mainFile(sid), [
      prompt(T0, 'a typed prompt'),
      prompt(T0 + 1000, [{ type: 'text', text: 'with blocks' }, { type: 'image', source: { type: 'base64', data: 'x' } }]),
      prompt(T0 + 2000, 'meta text', { isMeta: true }),
      prompt(T0 + 3000, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      prompt(T0 + 4000, 'a result with text', { toolUseResult: { stdout: 'x' } }),
      prompt(T0 + 5000, [{ type: 'image', source: { type: 'base64', data: 'x' } }]), // only a picture: still a prompt
      // Written as user lines, but not typed: a finished task, a helper's report, a compact summary, an interrupt, command output.
      prompt(T0 + 5100, '<task-notification>\n<task-id>b1</task-id>', { origin: { kind: 'task-notification' } }),
      prompt(T0 + 5200, 'Another Claude session sent a message: done', { origin: { kind: 'peer', name: 'helper' } }),
      prompt(T0 + 5300, 'This session is being continued from a previous conversation.', { isCompactSummary: true }),
      prompt(T0 + 5400, [{ type: 'text', text: '[Request interrupted by user]' }]),
      prompt(T0 + 5500, '<local-command-stdout>Compacted </local-command-stdout>'),
      prompt(T0 + 5600, 'typed, and marked as human', { origin: { kind: 'human' } }),
      // Sent while Claude was answering: the user's own counts, a task notice delivered the same way does not.
      JSON.stringify({ parentUuid: null, isSidechain: false, attachment: { type: 'queued_command', prompt: 'one more thing', origin: { kind: 'human' } }, type: 'attachment', timestamp: iso(T0 + 5700) }),
      JSON.stringify({ parentUuid: null, isSidechain: false, attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>b2</task-id>' }, type: 'attachment', timestamp: iso(T0 + 5800) }),
      asst(sid, 'msg_T', T0 + 6000, u({ output_tokens: 3 }), { content: [{ type: 'thinking', thinking: '' }] }),
      asst(sid, 'msg_T', T0 + 6100, u({ output_tokens: 3 }), { content: [tool('Bash')] }),
      asst(sid, 'msg_T', T0 + 6200, u({ output_tokens: 3 }), { content: [tool('Read')] }),
    ]);
    await usage.runUsagePass();
    const h = totalOf(usage.usageSessions()[sid]);
    assert.equal(h.u, 5);
    assert.equal(h.t, 2);
    assert.equal(h.m['claude-opus-5-5'][0], 1);
  });

  test('a second pass adds only the lines appended, a half-written last line waits until it is complete', async () => {
    const sid = newSid();
    const f = mainFile(sid);
    write(f, [asst(sid, 'msg_1', T0, u({ output_tokens: 10 }))]);
    await usage.runUsagePass();
    const before = fs.statSync(f).size;
    assert.equal(totalOf(usage.usageSessions()[sid]).m['claude-opus-5-5'][2], 10);

    const second = asst(sid, 'msg_2', T0 + 1000, u({ output_tokens: 5 }));
    const third = asst(sid, 'msg_3', T0 + 2000, u({ output_tokens: 7 }));
    append(f, [second, third.slice(0, 120)], ''); // the last line is cut off
    await usage.runUsagePass();
    let h = totalOf(usage.usageSessions()[sid]);
    assert.equal(h.m['claude-opus-5-5'][2], 15, 'the cut-off line is not counted');
    assert.equal(h.m['claude-opus-5-5'][0], 2);
    assert.equal(usage.usageIndexStatus().lastPass.bytes, Buffer.byteLength(second) + 1 + 120, 'only the new bytes were read, not the file again');

    append(f, [third.slice(120)], '\n');
    await usage.runUsagePass();
    h = totalOf(usage.usageSessions()[sid]);
    assert.equal(h.m['claude-opus-5-5'][2], 22);
    assert.equal(h.m['claude-opus-5-5'][0], 3);
    assert.ok(fs.statSync(f).size > before);

    // Nothing new: nothing is read, nothing changes.
    await usage.runUsagePass();
    assert.equal(usage.usageIndexStatus().lastPass.bytes, 0);
    assert.equal(totalOf(usage.usageSessions()[sid]).m['claude-opus-5-5'][2], 22);
  });

  test('a repeat of a message id in a later pass is still counted once', async () => {
    const sid = newSid();
    const f = mainFile(sid);
    write(f, [asst(sid, 'msg_R', T0, u({ output_tokens: 10 }))]);
    await usage.runUsagePass();
    append(f, [asst(sid, 'msg_R', T0 + 500, u({ output_tokens: 18 }))]);
    await usage.runUsagePass();
    const m = totalOf(usage.usageSessions()[sid]).m['claude-opus-5-5'];
    assert.equal(m[0], 1);
    assert.equal(m[2], 18);
  });

  test('a deleted file keeps its data, a shrunk file is read again', async () => {
    const gone = newSid();
    write(mainFile(gone), [prompt(T0, 'hi'), asst(gone, 'msg_G', T0 + 1000, u({ output_tokens: 42 }))]);
    const shrunk = newSid();
    write(mainFile(shrunk), [asst(shrunk, 'msg_1', T0, u({ output_tokens: 100 })), asst(shrunk, 'msg_2', T0 + 1000, u({ output_tokens: 200 }))]);
    await usage.runUsagePass();
    assert.equal(totalOf(usage.usageSessions()[shrunk]).m['claude-opus-5-5'][2], 300);

    fs.rmSync(mainFile(gone));
    write(mainFile(shrunk), [asst(shrunk, 'msg_9', T0 + 7200000, u({ output_tokens: 7 }))]);
    await usage.runUsagePass();
    const g = usage.usageSessions()[gone];
    assert.equal(totalOf(g).m['claude-opus-5-5'][2], 42, 'history of a deleted conversation stays');
    assert.equal(totalOf(g).u, 1);
    const s = usage.usageSessions()[shrunk];
    assert.equal(s.h[key(0)], undefined, 'the old data of the replaced file is dropped');
    assert.equal(totalOf(s, 2).m['claude-opus-5-5'][2], 7);
    await usage.runUsagePass();
    assert.equal(totalOf(usage.usageSessions()[gone]).m['claude-opus-5-5'][2], 42);
  });

  test('the state survives a fresh load from usage-index.json', async () => {
    await usage.runUsagePass();
    const live = JSON.parse(JSON.stringify(usage.usageSessions()));
    const filesBefore = usage.usageIndexStatus().files;
    assert.ok(fs.existsSync(path.join(dataDir, 'usage-index.json')));
    assert.equal(fs.readdirSync(dataDir).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp file is left');
    usage._resetForTests();
    assert.deepEqual(usage.usageSessions(), live);
    assert.equal(usage.usageIndexStatus().files, filesBefore);
    assert.equal(usage.usageIndexStatus().firstPassDone, false);
    // And a pass on the loaded state reads nothing again.
    await usage.runUsagePass();
    assert.equal(usage.usageIndexStatus().lastPass.bytes, 0);
    assert.equal(usage.usageIndexStatus().firstPassDone, true);
    assert.deepEqual(JSON.parse(JSON.stringify(usage.usageSessions())), live);
  });

  test('passes do not overlap', async () => {
    const a = usage.runUsagePass();
    const b = usage.runUsagePass();
    assert.equal(a, b);
    assert.equal(usage.usageIndexStatus().running, true);
    await a;
    assert.equal(usage.usageIndexStatus().running, false);
  });
});
