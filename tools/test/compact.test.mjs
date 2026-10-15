// Tests for what a conversation shows after /compact: the cache panel says Compacted with the size after it (not the last
// request's size and cache time), and the chat shows the /compact line before its summary (the CLI saves them the other way round).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

describe('after /compact', () => {
  test('stats say compacted, and /compact comes before its summary', async () => {
    const dataDir = makeDataDir('mc-compact-view');
    seedFixture(dataDir);
    const tdir = path.join(dataDir, 'claude-home', 'projects', 'D--Dev');
    fs.mkdirSync(tdir, { recursive: true });
    const id = crypto.randomUUID();
    const t0 = new Date(Date.now() - 50 * 60e3).toISOString();
    const t1 = new Date(Date.now() - 2 * 60e3).toISOString();
    const t2 = new Date(Date.now() - 60e3).toISOString();
    const base = { isSidechain: false, userType: 'external', entrypoint: 'sdk-cli', cwd: tdir, sessionId: id, version: '2.1.296' };
    const u = () => crypto.randomUUID();
    const big = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 524480, cache_creation_input_tokens: 702, cache_creation: { ephemeral_1h_input_tokens: 702, ephemeral_5m_input_tokens: 0 } };
    const lines = [
      { ...base, type: 'user', uuid: u(), timestamp: t0, promptSource: 'sdk', message: { role: 'user', content: 'Build the thing' } },
      { ...base, type: 'assistant', uuid: u(), timestamp: t0, message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: big } },
      { ...base, type: 'system', subtype: 'compact_boundary', uuid: u(), parentUuid: null, timestamp: t2, content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 526140, postTokens: 7634 } },
      { ...base, type: 'user', uuid: u(), timestamp: t2, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.\n\nSummary: built the thing.' } },
      { ...base, type: 'user', uuid: u(), timestamp: t1, isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' } },
      { ...base, type: 'user', uuid: u(), timestamp: t1, message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>' } },
      { ...base, type: 'user', uuid: u(), timestamp: t2, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } },
    ];
    fs.writeFileSync(path.join(tdir, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const s = await startServer({ dataDir, bridge: false });
    toStop.push(s);

    const st = (await localReq(s, { path: `/api/sessions/${id}/stats` })).json;
    assert.equal(st.contextUsed, 7634);
    assert.equal(st.model, 'claude-opus-5-5');
    assert.equal(st.cache.expiresAt, null);
    assert.ok(st.cache.compactedAt);

    const all = (await localReq(s, { path: `/api/sessions/${id}?limit=40` })).json.messages;
    assert.deepEqual(all.map((m) => m.noticeType || m.text), ['Build the thing', 'Done.', '/compact', 'summary']);

    // A page that ends at the summary still takes the /compact with it, and the cursor never skips a message.
    const page = (await localReq(s, { path: `/api/sessions/${id}?limit=1` })).json;
    assert.deepEqual(page.messages.map((m) => m.noticeType || m.text), ['/compact', 'summary']);
    const older = (await localReq(s, { path: `/api/sessions/${id}?limit=40&before=${page.cursor}` })).json.messages;
    assert.deepEqual(older.map((m) => m.text), ['Build the thing', 'Done.']);
  });
});
