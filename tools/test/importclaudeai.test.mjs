// Tests for tools/import-claude-ai.mjs: chats from a claude.ai data export land in the Chats tab with their titles and
// dates, an edited chat keeps the branch written last, claude.ai's artifacts and attached text files become text, an
// empty chat is left out, a second import skips what is already there, and an imported chat resumes as a chat.
// Runs against the FAKE Claude CLI in tools/fakeclaude. Run: npm test (2 test files at a time)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, describe, test } from 'node:test';
import { ROOT, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;
const TOOL = path.join(ROOT, 'tools', 'import-claude-ai.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const pc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });
async function waitFor(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(50);
  }
}

// A zip with one deflated file, laid out the way claude.ai writes its export.
function zipOf(name, data) {
  const packed = zlib.deflateRawSync(data);
  const nm = Buffer.from(name);
  const crc = zlib.crc32 ? zlib.crc32(data) : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nm.length, 28);
  const dirAt = local.length + nm.length + packed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + nm.length, 12); end.writeUInt32LE(dirAt, 16);
  return Buffer.concat([local, nm, packed, central, nm, end]);
}

const ROOT_ID = '00000000-0000-4000-8000-000000000000';
const msg = (uuid, parent, sender, at, content, extra = {}) => ({ uuid, parent_message_uuid: parent, sender, created_at: at, updated_at: at, text: '', content, attachments: [], files: [], ...extra });
const txt = (text) => ({ type: 'text', text });
const CHAT_A = '11111111-1111-4111-8111-111111111111';
const CHAT_B = '22222222-2222-4222-8222-222222222222';
const CHAT_EMPTY = '33333333-3333-4333-8333-333333333333';
const EXPORT = [
  {
    uuid: CHAT_A, name: 'Miso soup', created_at: '2026-10-06T22:30:00Z', updated_at: '2026-10-06T22:40:00Z',
    chat_messages: [
      msg('a0000000-0000-4000-8000-000000000001', ROOT_ID, 'human', '2026-10-06T22:30:00Z', [txt('Is leftover miso soup safe?')], { attachments: [{ file_name: 'notes.txt', extracted_content: 'made on Monday' }], files: [{ file_name: 'notes.txt' }, { file_name: 'photo.jpg' }] }),
      msg('a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'assistant', '2026-10-06T22:30:10Z', [{ type: 'thinking', thinking: 'private' }, { type: 'tool_use', name: 'web_search', input: { query: 'miso soup fridge days' } }, { type: 'tool_result', name: 'web_search', content: [] }, txt('Yes, for 3 days in the fridge.')]),
      // an edit on claude.ai: two answers to the same question, the later branch is kept
      msg('a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000002', 'human', '2026-10-06T22:31:00Z', [txt('First wording')]),
      msg('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000003', 'assistant', '2026-10-06T22:31:10Z', [txt('Old answer')]),
      msg('a0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000002', 'human', '2026-10-06T22:35:00Z', [txt('Second wording')]),
      msg('a0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000005', 'assistant', '2026-10-06T22:35:10Z', [{ type: 'tool_use', name: 'artifacts', input: { title: 'Fridge table', type: 'application/vnd.ant.code', language: 'python', command: 'create', content: 'days = 3' } }, { type: 'tool_result', name: 'artifacts', content: [txt('OK')] }, txt('New answer')]),
    ],
  },
  {
    uuid: CHAT_B, name: '', created_at: '2025-01-14T03:31:00Z', updated_at: '2025-01-14T03:40:00Z',
    chat_messages: [
      msg('b0000000-0000-4000-8000-000000000001', ROOT_ID, 'human', '2025-01-14T03:31:00Z', [txt('Make a markdown page')]),
      msg('b0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'assistant', '2025-01-14T03:31:10Z', [txt('Here it is.\n\n<antThinking>worth an artifact</antThinking>\n\n<antArtifact identifier="md" type="text/html" title="Markdown page">\n<p>hi</p>\n</antArtifact>\n\nSave it as page.html.')]),
    ],
  },
  { uuid: CHAT_EMPTY, name: '', created_at: '2025-06-21T02:00:00Z', updated_at: '2025-06-21T02:00:00Z', chat_messages: [msg('c0000000-0000-4000-8000-000000000001', ROOT_ID, 'human', '2025-06-21T02:00:00Z', []), msg('c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 'assistant', '2025-06-21T02:00:10Z', [])] },
];

const runTool = (dataDir, args) => execFileSync(process.execPath, [TOOL, ...args], { env: { ...process.env, MC_DATA_DIR: dataDir, MC_CLAUDE_HOME: path.join(dataDir, 'claude-home') }, encoding: 'utf8' });

describe('import from claude.ai', () => {
  test('chats from the export are listed under Chats, read as text, and resume as chats', async () => {
    const dataDir = makeDataDir('mc-import-claudeai');
    seedFixture(dataDir);
    const zip = path.join(dataDir, 'conversations-000.zip');
    fs.writeFileSync(zip, zipOf('conversations.json', Buffer.from(JSON.stringify(EXPORT))));

    assert.match(runTool(dataDir, [zip, '--dry-run']), /2 added, 0 already here, 1 empty/);
    assert.match(runTool(dataDir, [zip]), /2 added, 0 already here, 1 empty/);
    assert.match(runTool(dataDir, [zip]), /0 added, 2 already here, 1 empty/, 'a second import skips them');

    const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '20', FAKE_TRANSCRIPT: path.join(dataDir, 'claude-home', 'projects', 'resumed'), MC_IDLE_MS: '60000' } });
    toStop.push(s);
    const chats = await waitFor(async () => { const l = (await pc(s, 'GET', '/api/sessions?kind=chat')).json; return l.length === 2 && l; }, 'the imported chats');
    assert.deepEqual(chats.map((c) => c.id), [CHAT_A, CHAT_B], 'newest first, by the claude.ai dates');
    assert.equal(chats[0].title, 'Miso soup');
    assert.equal(chats[1].title, 'Make a markdown page', 'no title on claude.ai: the first words');
    assert.ok(chats.every((c) => c.kind === 'chat' && c.project === null && c.expiryAction === null));

    const a = (await pc(s, 'GET', `/api/sessions/${CHAT_A}?limit=40`)).json;
    const said = a.messages.map((m) => [m.role, m.text]);
    assert.equal(said.length, 4, JSON.stringify(said));
    assert.match(said[0][1], /Is leftover miso soup safe\?[\s\S]*Attached: notes\.txt[\s\S]*made on Monday[\s\S]*photo\.jpg, not kept/);
    assert.match(said[1][1], /Web search: miso soup fridge days[\s\S]*Yes, for 3 days/);
    assert.ok(!said[1][1].includes('private'), 'claude.ai thinking is left out');
    assert.equal(said[2][1], 'Second wording', 'the branch written last');
    assert.match(said[3][1], /\*\*Fridge table\*\*\s+```python\ndays = 3\n```\s+New answer/);

    const b = (await pc(s, 'GET', `/api/sessions/${CHAT_B}?limit=40`)).json;
    const answer = b.messages.find((m) => m.role === 'assistant').text;
    assert.match(answer, /Here it is\.\s+\*\*Markdown page\*\*\s+```html\n<p>hi<\/p>\n```\s+Save it as page\.html\./);
    assert.ok(!/antThinking|antArtifact|worth an artifact/.test(answer));

    // continuing it runs as a chat, in the chats folder, on the --resume of its claude.ai id
    const go = await pc(s, 'POST', '/api/chat', { prompt: 'and on day 4?', sessionId: CHAT_A });
    assert.equal(go.status, 200, go.text);
    const run = await waitFor(async () => (await pc(s, 'GET', '/api/runs')).json.find((x) => x.runId === go.json.runId), 'the run');
    assert.equal(run.chat, true);
  });
});
