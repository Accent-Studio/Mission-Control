// Mission Control keeps every conversation: at start it raises Claude Code's cleanupPeriodDays (30 days by default) in the
// user's Claude settings, keeps the other settings, and leaves a higher value or an unreadable file alone.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { makeDataDir, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
async function bootWith(settings) {
  const dataDir = makeDataDir('mc-keep');
  const home = path.join(dataDir, 'claude-home');
  fs.mkdirSync(home, { recursive: true });
  if (settings !== undefined) fs.writeFileSync(path.join(home, 'settings.json'), settings);
  const s = await startServer({ dataDir, bridge: false });
  toStop.push(s);
  return path.join(home, 'settings.json');
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('Claude Code keeps every conversation', () => {
  test('no settings file: one is made with cleanupPeriodDays 36500', async () => {
    assert.equal(read(await bootWith(undefined)).cleanupPeriodDays, 36500);
  });
  test('a lower value is raised, and the other settings stay', async () => {
    const v = read(await bootWith(JSON.stringify({ theme: 'dark', cleanupPeriodDays: 30 })));
    assert.deepEqual(v, { theme: 'dark', cleanupPeriodDays: 36500 });
  });
  test('a higher value and an unreadable file are left alone', async () => {
    assert.equal(read(await bootWith(JSON.stringify({ cleanupPeriodDays: 99999 }))).cleanupPeriodDays, 99999);
    const f = await bootWith('{ not json');
    assert.equal(fs.readFileSync(f, 'utf8'), '{ not json');
  });
});
