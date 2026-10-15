// Tests for the short names Mission Control gives the conversations it starts (server/services/autoTitle.js): the
// project short forms, the cleanup of the model's answer, and a whole run against the FAKE Claude CLI in tools/fakeclaude
// (its naming mode answers "Fake" plus the first four words of the message).
// Run: node --test "tools/test/*.test.mjs"        (no npm packages; the server uses a free port and its own data folder)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { acronym, cleanTitle } from '../../server/services/autoTitle.js';
import { localReq, makeDataDir, ROOT, seedFixture, startServer } from './harness.mjs';

const FAKE_PATH = path.join(ROOT, 'tools', 'fakeclaude') + path.delimiter + process.env.PATH;
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

describe('autoTitle helpers', () => {
  test('project short forms', () => {
    assert.equal(acronym('Mission Control'), 'MC');
    assert.equal(acronym('MetaHuman Optimizer'), 'MHO');
    assert.equal(acronym('Comfy-N-Chill'), 'CNC');
    assert.equal(acronym('BlitzRaw website'), 'BRW');
    assert.equal(acronym('DevTracker'), 'DT');
  });
  test('the answer becomes one clean name', () => {
    assert.equal(cleanTitle('"Fix the footer spacing."\n'), 'Fix the footer spacing');
    assert.equal(cleanTitle('Title: Gallery for chat pictures'), 'Gallery for chat pictures');
    assert.equal(cleanTitle('\n\n  **Phone tab bar** \nmore'), 'Phone tab bar');
    assert.equal(cleanTitle('...'), '');
    assert.equal(cleanTitle('x'.repeat(200)), '');
  });
});

describe('a new conversation gets a short name', () => {
  async function boot() {
    const dataDir = makeDataDir('mc-autotitle');
    seedFixture(dataDir);
    const projDir = path.join(dataDir, 'claude-home', 'projects', 'proj');
    const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '40', FAKE_TRANSCRIPT: projDir, MC_AUTO_TITLE: '' } });
    toStop.push(s);
    return s;
  }
  const runOf = async (s, runId) => (await pc(s, 'GET', '/api/runs')).json.find((x) => x.runId === runId);
  const rowOf = async (s, id) => (((j) => (Array.isArray(j) ? j : j.sessions || []))((await pc(s, 'GET', '/api/sessions?limit=50')).json)).find((x) => x.id === id);

  test('named once from the first message; a rename wins; one-off tasks and resumes are not named', async () => {
    const s = await boot();
    const r = await pc(s, 'POST', '/api/chat', { prompt: 'Please make the gallery arrows bigger on phones' });
    assert.equal(r.status, 200, r.text);
    const run = await waitFor(async () => { const x = await runOf(s, r.json.runId); return x && x.sessionId && x.state === 'idle' && x; }, 'the run');
    const row = await waitFor(async () => { const x = await rowOf(s, run.sessionId); return x && x.titleSource === 'auto' && x; }, 'the name');
    assert.equal(row.title, 'Fake Please make the gallery');

    // my own rename wins, and clearing it brings the automatic name back
    assert.equal((await pc(s, 'POST', `/api/sessions/${run.sessionId}/meta`, { title: 'Mine' })).status, 200);
    assert.equal((await rowOf(s, run.sessionId)).title, 'Mine');
    assert.equal((await pc(s, 'POST', `/api/sessions/${run.sessionId}/meta`, { title: null })).status, 200);
    assert.equal((await rowOf(s, run.sessionId)).title, 'Fake Please make the gallery');

    // a one-off task keeps its own title
    const one = await pc(s, 'POST', '/api/chat', { prompt: 'Commit the changes', remote: false });
    const oneRun = await waitFor(async () => { const x = await runOf(s, one.json.runId); return x && x.sessionId && x.state === 'idle' && x; }, 'the one-off run');
    await sleep(1500);

    // stored once in the notes file
    const meta = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'sessions-meta.json'), 'utf8'));
    assert.equal(meta[run.sessionId.toLowerCase()].autoTitle, 'Fake Please make the gallery');
    assert.equal(meta[oneRun.sessionId.toLowerCase()] && meta[oneRun.sessionId.toLowerCase()].autoTitle, undefined);
  });
});
