// Tests for the Usage page's numbers: GET /api/usage/stats sums the transcripts (usageIndex.js) over a range and prices them
// (pricing.js). Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';
import { costOf, priceFor, familyOf } from '../../server/services/pricing.js';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Usage page numbers', () => {
  test('prices: per million tokens, cache writes from the input price', () => {
    assert.deepEqual(priceFor('claude-opus-5-5'), { in: 4, out: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 });
    assert.equal(priceFor('claude-fable-5-1').cacheRead, 0.25);
    assert.equal(priceFor('claude-fable-5').cacheRead, 1);
    assert.equal(priceFor('claude-opus-4-1-20250805').in, 15);
    assert.equal(priceFor('claude-opus-4-5-20251101').in, 5);
    assert.equal(priceFor('fake'), null);
    assert.equal(costOf('fake', [1, 1, 1, 1, 1, 1]), null);
    // 1M input, 1M output, 1M cache read, 1M 5m write, 1M 1h write on Opus 5.5: 4 + 20 + 0.2 + 5 + 8
    assert.equal(Math.round(costOf('claude-opus-5-5', [1, 1e6, 1e6, 1e6, 1e6, 1e6]) * 100) / 100, 37.2);
    assert.equal(familyOf('claude-mythos-5-1'), 'fable');
    assert.equal(familyOf('claude-sonnet-5-5'), 'sonnet');
  });

  test('the route sums one conversation over the range, by model, with its title', async () => {
    const dataDir = makeDataDir('mc-ustats');
    seedFixture(dataDir);
    const tdir = path.join(dataDir, 'claude-home', 'projects', 'D--Dev');
    fs.mkdirSync(tdir, { recursive: true });
    const id = crypto.randomUUID();
    const t = new Date(Date.now() - 2 * 3600e3).toISOString();
    const base = { isSidechain: false, userType: 'external', entrypoint: 'sdk-cli', cwd: tdir, sessionId: id, version: '2.1.296' };
    const lines = [
      { ...base, type: 'user', uuid: crypto.randomUUID(), timestamp: t, promptSource: 'sdk', message: { role: 'user', content: 'Count my tokens' } },
      { ...base, type: 'assistant', uuid: crypto.randomUUID(), timestamp: t, message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ];
    fs.writeFileSync(path.join(tdir, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const s = await startServer({ dataDir, bridge: false });
    toStop.push(s);
    let j = null;
    for (let i = 0; i < 60; i++) {
      j = (await localReq(s, { path: '/api/usage/stats?from=' + (Date.now() - 86400e3) })).json;
      if (j && j.index.ready && j.total.req) break;
      await sleep(250);
    }
    assert.equal(j.total.req, 1);
    assert.equal(j.total.tokens, 2000000);
    assert.equal(Math.round(j.total.cost * 100) / 100, 24);
    assert.equal(j.byModel['claude-opus-5-5'].family, 'opus');
    assert.equal(j.conversations.length, 1);
    assert.equal(j.conversations[0].title, 'Count my tokens');
    assert.ok(j.hours.length >= 1);
    // a range that ends before it holds nothing
    const old = (await localReq(s, { path: '/api/usage/stats?from=0&to=' + (Date.now() - 86400e3) })).json;
    assert.equal(old.total.req, 0);
    assert.equal((await localReq(s, { path: '/api/usage/stats?from=5&to=1' })).status, 400);
  });
});
