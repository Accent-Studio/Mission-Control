// Tests for the conversation gallery: GET /api/sessions/:id/images lists every picture the two people shared, oldest
// first (my pasted pictures, pictures I sent while Claude worked, files Claude sent with SendUserFile), and leaves out
// pictures Claude only looked at with a tool and anything from a helper (sidechain). A picture I sent while Claude
// worked also shows on its message in the thread.
// Run: node --test "tools/test/*.test.mjs"        (no npm packages; the server uses a free port and its own data folder)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

const SID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_C = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const img = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const stamp = (n) => new Date(Date.UTC(2026, 9, 14, 10, n)).toISOString();
let seq = 0;
const record = (o, n) => JSON.stringify({ parentUuid: null, isSidechain: false, uuid: `u-${++seq}`, timestamp: stamp(n), sessionId: SID, entrypoint: 'sdk-cli', cwd: 'D:\\Dev', ...o });

describe('conversation gallery', () => {
  test('lists the shared pictures in order, with who shared each, and nothing Claude only looked at', async () => {
    const dataDir = makeDataDir('mc-gallery');
    seedFixture(dataDir);
    const dir = path.join(dataDir, 'claude-home', 'projects', 'D--Dev');
    fs.mkdirSync(dir, { recursive: true });
    const sent = path.join(dataDir, 'shot.png');
    fs.writeFileSync(sent, Buffer.from(PNG_B, 'base64'));
    const asst = (content, n) => record({ type: 'assistant', message: { id: `m${n}`, role: 'assistant', model: 'claude-sonnet-5-5', content, usage: { input_tokens: 1, output_tokens: 1 } } }, n);
    const lines = [
      record({ type: 'user', promptSource: 'sdk', message: { role: 'user', content: [img(PNG_A), { type: 'text', text: 'Look at this.' }] } }, 1),
      asst([{ type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: 'D:\\x.png' } }], 2),
      record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-read', content: [img(PNG_C)] }] } }, 3),
      asst([{ type: 'tool_use', id: 'tu-send', name: 'SendUserFile', input: { files: [sent] } }], 4),
      record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-send', content: 'sent' }] }, toolUseResult: { attachments: [{ path: sent, isImage: true }], caption: 'Before and after' } }, 5),
      asst([{ type: 'text', text: 'Here it is.' }], 6),
      // sent while Claude worked: a queued_command attachment whose prompt holds the picture
      record({ type: 'attachment', attachment: { type: 'queued_command', prompt: [img(PNG_C), { type: 'text', text: 'And this one.' }], source_uuid: 's-1', delivery_id: 'd-1', commandMode: 'prompt' } }, 7),
      // a helper's picture (sidechain) is not part of the conversation
      record({ type: 'user', isSidechain: true, message: { role: 'user', content: [img(PNG_B), { type: 'text', text: 'helper' }] } }, 8),
      asst([{ type: 'text', text: 'Got both.' }], 9),
    ];
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), lines.join('\n') + '\n');
    const s = await startServer({ dataDir, bridge: false });
    toStop.push(s);

    const r = await localReq(s, { path: `/api/sessions/${SID}/images` });
    assert.equal(r.status, 200);
    const list = r.json.images;
    assert.deepEqual(list.map((i) => i.from), ['you', 'claude', 'you']);
    assert.equal(list[1].name, 'shot.png');
    assert.equal(list[1].caption, 'Before and after');
    assert.ok(list.every((i) => /^\/api\//.test(i.src)));
    assert.ok(list.every((i) => i.at));
    // listing writes no picture files: each one is written the first time it is shown
    const cacheDir = path.join(dataDir, 'imgcache');
    const files = () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).length : 0);
    assert.equal(files(), 0);
    // every listed picture can be fetched
    for (const i of list) assert.equal((await localReq(s, { path: i.src })).status, 200, i.src);
    assert.equal(files(), 2, 'the two pictures of mine are cached now');
    // a cached picture that was removed comes back from the transcript
    for (const f of fs.readdirSync(cacheDir)) fs.unlinkSync(path.join(cacheDir, f));
    assert.equal((await localReq(s, { path: list[0].src })).status, 200);

    // the picture sent while Claude worked also shows on its message
    const m = await localReq(s, { path: `/api/sessions/${SID}?limit=40` });
    const queued = m.json.messages.find((x) => x.text === 'And this one.');
    assert.ok(queued);
    assert.equal(queued.images.length, 1);
    assert.equal(queued.images[0].from, 'you');
    assert.equal(queued.queued, true, 'marked as sent mid-turn, not a new question');
    assert.equal(m.json.messages[0].queued, undefined);

    // a second call reads only what was added: a new pasted picture joins the end
    fs.appendFileSync(path.join(dir, `${SID}.jsonl`), record({ type: 'user', promptSource: 'sdk', message: { role: 'user', content: [img(PNG_B), { type: 'text', text: 'One more.' }] } }, 10) + '\n');
    const r2 = await localReq(s, { path: `/api/sessions/${SID}/images` });
    assert.deepEqual(r2.json.images.map((i) => i.from), ['you', 'claude', 'you', 'you']);

    // with tools=1 the picture Claude only looked at is listed too, and the count matches that list
    const r3 = await localReq(s, { path: `/api/sessions/${SID}/images?tools=1` });
    assert.deepEqual(r3.json.images.map((i) => i.from), ['you', 'tool', 'claude', 'you', 'you']);
    const c1 = await localReq(s, { path: `/api/sessions/image-counts?ids=${SID},not-a-uuid,00000000-0000-4000-8000-000000000000` });
    assert.deepEqual(c1.json.counts, { [SID]: 5 });
    fs.appendFileSync(path.join(dir, `${SID}.jsonl`), record({ type: 'user', promptSource: 'sdk', message: { role: 'user', content: [img(PNG_A), { type: 'text', text: 'Last.' }] } }, 11) + '\n');
    const c2 = await localReq(s, { path: `/api/sessions/image-counts?ids=${SID}` });
    assert.equal(c2.json.counts[SID], 6, 'only the new line is read, and counted');
    // two counts at once read the new lines once
    fs.appendFileSync(path.join(dir, `${SID}.jsonl`), record({ type: 'user', promptSource: 'sdk', message: { role: 'user', content: [img(PNG_A), img(PNG_B), { type: 'text', text: 'Two more.' }] } }, 12) + '\n');
    const both = await Promise.all([1, 2].map(() => localReq(s, { path: `/api/sessions/image-counts?ids=${SID}` })));
    assert.deepEqual(both.map((x) => x.json.counts[SID]), [8, 8]);

    assert.equal((await localReq(s, { path: '/api/sessions/not-a-uuid/images' })).status, 400);
    assert.equal((await localReq(s, { path: '/api/sessions/00000000-0000-4000-8000-000000000000/images' })).status, 404);
  });
});
