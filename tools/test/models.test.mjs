// Tests for the chat model list (/api/chat/options): the pages take the FIRST model of a family, so the newest
// version of each family must come first, whatever order the CLI's catalog lists them in.
// Run: node --test "tools/test/*.test.mjs"        (no npm packages; every server uses free ports and its own data folder)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ROOT, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;

// Boots a server whose fake Claude home holds the given files in cache/model-catalog.
async function boot(files) {
  const dataDir = makeDataDir('mc-models');
  seedFixture(dataDir);
  const dir = path.join(dataDir, 'claude-home', 'cache', 'model-catalog');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, doc] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(doc));
  const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH } });
  toStop.push(s);
  return s;
}

const model = (id, name, section = 'main') => ({ id, name, section, quick_select: section === 'main' });
const ids = async (s) => {
  const r = await localReq(s, { path: '/api/chat/options' });
  assert.equal(r.status, 200);
  return r.json.models.map((m) => m.id);
};
const firstOf = (list, family) => list.find((id) => id.includes(`-${family}-`));

describe('chat model options', () => {
  test('newest version first within a family (current CLI catalog format, oldest listed first)', async () => {
    const s = await boot({
      'a21a8ca8-8a86-49a1-a7fb-41fe307b652c-d1f345758f8a-cc.json': {
        version: 2,
        fetchedAt: 2000,
        catalog: {
          surface: 'cc',
          config: {
            id: 'cc',
            models: [
              model('claude-haiku-4-5-20251001', 'Haiku 4.5'),
              model('claude-opus-5', 'Opus 5'),
              model('claude-sonnet-5', 'Sonnet 5'),
              model('claude-haiku-5-5', 'Haiku 5.5'),
              model('claude-opus-5-5', 'Opus 5.5'),
              model('claude-sonnet-5-5', 'Sonnet 5.5'),
            ],
          },
        },
      },
    });
    const list = await ids(s);
    assert.equal(firstOf(list, 'haiku'), 'claude-haiku-5-5');
    assert.equal(firstOf(list, 'opus'), 'claude-opus-5-5');
    assert.equal(firstOf(list, 'sonnet'), 'claude-sonnet-5-5');
    assert.ok(list.indexOf('claude-haiku-5-5') < list.indexOf('claude-haiku-4-5-20251001'));
    // Families keep their order: opus, then sonnet, then haiku.
    assert.ok(list.indexOf('claude-opus-5-5') < list.indexOf('claude-sonnet-5-5'));
    assert.ok(list.indexOf('claude-sonnet-5') < list.indexOf('claude-haiku-5-5'));
  });

  test('newest version first in the older published catalog format too', async () => {
    const wrap = (models) => ({ document: { surfaces: { cc: { model_selector_config: [{ models }] } } }, fetchedAt: 1000 });
    const withFamily = (id, name, family) => ({ ...model(id, name), runtime: { family, max_input_tokens: 200000 } });
    const s = await boot({
      'published-test.json': wrap([
        withFamily('claude-haiku-4-5-20251001', 'Haiku 4.5', 'haiku'),
        withFamily('claude-haiku-5-5', 'Haiku 5.5', 'haiku'),
      ]),
    });
    assert.equal(firstOf(await ids(s), 'haiku'), 'claude-haiku-5-5');
  });

  test('the built-in fallback table lists Haiku 5.5 when there is no catalog', async () => {
    const s = await boot({});
    const r = await localReq(s, { path: '/api/chat/options' });
    const haiku = r.json.models.filter((m) => m.id.includes('haiku'));
    assert.deepEqual(haiku, [{ id: 'claude-haiku-5-5', label: 'Haiku 5.5' }]);
  });
});
