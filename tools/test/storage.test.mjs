// Conversations and attachments on the System page (services/storage.js, routes/storage.js): what is kept, by type and
// by project, and moving picked items away. MC_RECYCLE=move puts them in .data/trash instead of the real Recycle Bin.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { bridgeReq, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const OLD = new Date(Date.now() - 400 * 864e5);
const CODE = '11111111-1111-4111-8111-111111111111';
const BUSY = '22222222-2222-4222-8222-222222222222';
const UP = '33333333-3333-4333-8333-333333333333';

function transcript(dir, id, cwd, text, when) {
  const at = when.toISOString();
  const lines = [
    { type: 'user', uuid: id.slice(0, 8) + '-0000-4000-8000-000000000001', parentUuid: null, isSidechain: false, sessionId: id, cwd, timestamp: at, message: { role: 'user', content: [{ type: 'text', text }] } },
    { type: 'assistant', uuid: id.slice(0, 8) + '-0000-4000-8000-000000000002', parentUuid: id.slice(0, 8) + '-0000-4000-8000-000000000001', isSidechain: false, sessionId: id, cwd, timestamp: at, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }] } },
  ];
  const f = path.join(dir, id + '.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(f, when, when);
  return f;
}

describe('shrink', () => {
  test('takes the tool pictures out, keeps the text and the user\'s own pictures, and the old file goes away', async () => {
    const { shrinkText } = await import('../../server/lib/shrink.js');
    const pic = (n) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(n) } });
    const lines = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look at this' }, pic(5000)] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'screenshot', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'done' }, pic(8000)] }] }, toolUseResult: { type: 'image', file: { base64: 'C'.repeat(8000), type: 'image/png' } } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [pic(200)] }] } },
    ];
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const m = shrinkText(text, {}, { measureOnly: true });
    assert.equal(m.text, null);
    assert.equal(m.could.toolPictures, 16000, 'both copies of the screenshot');
    assert.equal(m.could.userPictures, 5000);
    assert.ok(m.could.thinking > 0);
    const r = shrinkText(text, { toolPictures: true });
    assert.deepEqual(Object.keys(r.saved), ['toolPictures']);
    const out = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(out[0].message.content[1].source.data.length, 5000, 'the user\'s own picture stays');
    assert.deepEqual(out[1], lines[1], 'the thinking and the tool call stay as they were');
    assert.deepEqual(out[2].message.content[0].content, [{ type: 'text', text: 'done' }, { type: 'text', text: '[Picture removed by Mission Control to save space]' }]);
    assert.equal(out[2].toolUseResult.file.base64, '', 'Claude Code\'s copy keeps its shape, without the data');
    assert.equal(out[3].message.content[0].content[0].source.data.length, 200, 'a tiny picture is not worth it');
    assert.equal(r.text.endsWith('\n'), true);

    // everything ticked: the user's picture and the thinking go too, and every line keeps its place
    const all = shrinkText(text, { toolPictures: true, userPictures: true, thinking: true, toolOutput: true, toolInputs: true, records: true });
    const o2 = all.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(o2.length, lines.length);
    assert.deepEqual(o2[0].message.content[1], { type: 'text', text: '[Picture removed by Mission Control to save space]' });
    assert.deepEqual(o2[1].message.content.map((b) => b.type), ['tool_use'], 'the thinking went, the tool call stayed');
  });
});

describe('conversations and attachments', () => {
  test('lists what is kept, and moves picked items away, never one in use', async () => {
    const dataDir = makeDataDir('mc-storage');
    const folder = seedFixture(dataDir);
    const tdir = path.join(dataDir, 'claude-home', 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(path.join(tdir, CODE, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(tdir, CODE, 'subagents', 'a.jsonl'), 'x'.repeat(5000));
    const codeFile = transcript(tdir, CODE, folder, 'an old code conversation', OLD);
    const busyFile = transcript(tdir, BUSY, folder, 'written just now', new Date());
    fs.mkdirSync(path.join(dataDir, 'uploads', UP), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'uploads', UP, 'photo.png'), Buffer.alloc(2000));
    fs.mkdirSync(path.join(dataDir, 'logs', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'logs', 'fixture', 'build.log'), 'log');
    const s = await startServer({ dataDir, bridge: true, env: { MC_RECYCLE: 'move' } });
    toStop.push(s);

    const st = (await localReq(s, { path: '/api/storage?fresh=1' })).json;
    assert.equal(st.types.code, 'Code conversations');
    const code = st.items.find((x) => x.id === CODE);
    assert.equal(code.type, 'code');
    assert.equal(code.project, 'Fixture');
    assert.ok(code.bytes > 5000, 'the helper agents folder counts too');
    assert.equal(code.lastAt, OLD.toISOString());
    assert.equal(st.items.find((x) => x.id === 'u:' + UP).type, 'pictures');
    assert.ok(st.items.some((x) => x.type === 'logs' && x.id === 'l:fixture/build.log'));

    // a phone may not delete
    const phone = await bridgeReq(s, { method: 'POST', path: '/api/storage/delete', body: { items: [{ type: 'code', id: CODE }], confirm: true }, post: true });
    assert.equal(phone.status, 403);
    assert.equal((await localReq(s, { method: 'POST', path: '/api/storage/delete', body: { items: [{ type: 'code', id: CODE }] }, headers: { 'X-MC': '1' } })).status, 400, 'confirm is needed');

    const r = await localReq(s, { method: 'POST', path: '/api/storage/delete', headers: { 'X-MC': '1' }, body: { confirm: true, items: [
      { type: 'code', id: CODE }, { type: 'code', id: BUSY }, { type: 'pictures', id: 'u:' + UP }, { type: 'logs', id: 'l:fixture/build.log' }, { type: 'logs', id: 'l:../../escape' },
    ] } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.done, 3);
    assert.deepEqual(r.json.failed.map((f) => f.id).sort(), [BUSY, 'l:../../escape'].sort());
    assert.ok(!fs.existsSync(codeFile) && !fs.existsSync(path.join(tdir, CODE)), 'the transcript and its folder are gone');
    assert.ok(fs.existsSync(busyFile), 'a conversation in use stays');
    assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', UP)));
    const trash = fs.readdirSync(path.join(dataDir, 'trash')).flatMap((d) => fs.readdirSync(path.join(dataDir, 'trash', d)));
    assert.ok(trash.includes(CODE + '.jsonl') && trash.includes(UP), 'moved, not deleted');
    const after2 = (await localReq(s, { path: '/api/storage' })).json;
    assert.ok(!after2.items.some((x) => x.id === CODE));
  });
});
