// Tests for the short names Mission Control gives the conversations it starts (server/services/autoTitle.js): the
// project short forms, the cleanup of the model's answer, and a whole run against the FAKE Claude CLI in tools/fakeclaude
// (its naming mode answers "Fake" plus the first four words of the message).
// Run: npm test (2 test files at a time)        (no npm packages; the server uses a free port and its own data folder)
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
    assert.equal(acronym('Photo Sorter Pro'), 'PSP');
    assert.equal(acronym('Rock-N-Roll'), 'RNR');
    assert.equal(acronym('BlitzRaw website'), 'BRW');
    assert.equal(acronym('TimeTracker'), 'TT');
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

  // Claude renames its own conversation with Mission Control's conversation_title tool when the subject moves for good
  test('Claude renames the conversation when it moved; the old name is kept; a name of mine stays', async () => {
    const s = await boot();
    const r = await pc(s, 'POST', '/api/chat', { prompt: 'Please make the gallery arrows bigger on phones', projectId: 'fixture' });
    const run = await waitFor(async () => { const x = await runOf(s, r.json.runId); return x && x.sessionId && x.state === 'idle' && x; }, 'the run');
    await waitFor(async () => { const x = await rowOf(s, run.sessionId); return x && x.titleSource === 'auto'; }, 'the first name');
    let id = 0;
    const rpc = async (method, params) => (await localReq(s, { method: 'POST', path: '/api/mcp', headers: { 'X-MC': '1', 'X-MC-Run': run.runId }, body: { jsonrpc: '2.0', id: ++id, method, params } })).json;
    const tool = async (args) => (await rpc('tools/call', { name: 'conversation_title', arguments: args })).result.content[0].text;

    // the rules and the name come with initialize; the tool is listed
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.match(init.result.instructions, /Conversation name:/);
    assert.match(init.result.instructions, /aside/);
    assert.match(init.result.instructions, /called "Fake Please make the gallery"/);
    assert.ok((await rpc('tools/list', {})).result.tools.some((t) => t.name === 'conversation_title'));

    assert.equal(await tool({}), 'This conversation is called "Fake Please make the gallery".');
    assert.match(await tool({ title: '"Notes drag and drop."' }), /^Renamed from "Fake Please make the gallery" to "Notes drag and drop"\.$/);
    let row = await rowOf(s, run.sessionId);
    assert.equal(row.title, 'Notes drag and drop');
    assert.deepEqual(row.pastTitles, ['Fake Please make the gallery']);
    assert.match(await tool({ title: 'Notes drag and drop' }), /already called/);
    assert.match(await tool({ title: '...' }), /cannot be used/);

    // my own name is never replaced
    assert.equal((await pc(s, 'POST', `/api/sessions/${run.sessionId}/meta`, { title: 'Mine' })).status, 200);
    assert.match(await tool({ title: 'Something else' }), /named this conversation "Mine" themselves/);
    row = await rowOf(s, run.sessionId);
    assert.equal(row.title, 'Mine');
    assert.deepEqual(row.pastTitles, ['Fake Please make the gallery']);
  });
});
