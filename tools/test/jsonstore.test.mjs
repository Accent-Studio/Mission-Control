// Tests for the files in .data while another program holds one for a moment (antivirus, backup, sync): a read that fails
// is not an empty file, nothing is saved over it, and the data is there again once it can be read (server/lib/jsonStore.js).
// A folder in place of the file stands in for the lock: reading it fails with an error that is not "no file".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { makeDataDir } from './harness.mjs';

const dataDir = makeDataDir('mc-jsonstore');
process.env.MC_DATA_DIR = dataDir;
process.env.MC_PERSONA_MEMORY = path.join(dataDir, 'comlink-memory.md');
const lock = (file) => fs.mkdirSync(file, { recursive: true });
const unlock = (file, text) => {
  fs.rmSync(file, { recursive: true, force: true });
  fs.writeFileSync(file, text);
};

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

describe('a .data file that cannot be read for a moment', () => {
  test('conversation settings: refused while locked, kept after', async () => {
    const file = path.join(dataDir, 'sessions-meta.json');
    lock(file);
    const meta = await import('../../server/services/sessionMeta.js');
    assert.deepEqual(meta.getAllMeta(), {});
    assert.throws(() => meta.setMeta(ID_B, { pinned: true }), (e) => e.status === 503);
    assert.ok(fs.statSync(file).isDirectory(), 'nothing was written over it');
    unlock(file, JSON.stringify({ [ID_A]: { title: 'Kept', locked: true } }));
    assert.equal(meta.getMeta(ID_A).title, 'Kept');
    meta.setMeta(ID_B, { pinned: true });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved[ID_A].title, 'Kept');
    assert.equal(saved[ID_B].pinned, true);
  });

  test('drafts: refused while locked, kept after', async () => {
    const file = path.join(dataDir, 'drafts.json');
    lock(file);
    const drafts = await import('../../server/services/drafts.js');
    assert.equal(drafts.getDraft(ID_A).text, '');
    assert.throws(() => drafts.putDraft({ key: ID_B, text: 'new words' }), (e) => e.status === 503);
    unlock(file, JSON.stringify({ rev: 4, drafts: { [ID_A]: { text: 'unsent words', atts: [], at: Date.now(), rev: 4 } } }));
    assert.equal(drafts.getDraft(ID_A).text, 'unsent words');
  });

  test('Com Link memory: never replaced while it cannot be read', async () => {
    const file = process.env.MC_PERSONA_MEMORY;
    lock(file);
    const persona = await import('../../server/services/persona.js');
    assert.throws(() => persona.getMemory(), (e) => e.status === 503);
    assert.equal(persona.applyMemoryTags('<remember>a new fact</remember>'), 0);
    assert.ok(fs.statSync(file).isDirectory(), 'nothing was written over it');
    unlock(file, '- 2026-10-01: an old fact\n');
    assert.equal(persona.applyMemoryTags('<remember>a new fact</remember>'), 1);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /an old fact/);
    assert.match(text, /a new fact/);
  });

  test('a file that is not valid JSON is set aside, not lost', async () => {
    const { readJson } = await import('../../server/lib/jsonStore.js');
    const file = path.join(dataDir, 'broken.json');
    fs.writeFileSync(file, '{ "half": ');
    const r = readJson(file, 'test');
    assert.deepEqual(r, { ok: true, value: undefined });
    assert.ok(!fs.existsSync(file));
    assert.equal(fs.readdirSync(dataDir).filter((f) => f.startsWith('broken.json.bad-')).length, 1);
  });
});
