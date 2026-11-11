// Tests for Claude's multiple choice questions (its AskUserQuestion tool, a can_use_tool request): the waiting question carries
// the questions and their options, an answer must name the questions asked, and the CLI gets updatedInput.answers.
// Claude is the FAKE CLI in tools/fakeclaude (the word QUIZ in a prompt makes it ask). Run: npm test (2 test files at a time)
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
const pc = (s, method, p, body) => localReq(s, { method, path: p, headers: method === 'GET' ? {} : { 'X-MC': '1' }, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}

describe('Claude asks a multiple choice question', () => {
  test('the card has the questions; only real answers go back, as updatedInput.answers', async () => {
    const dataDir = makeDataDir('mc-askq');
    seedFixture(dataDir);
    const tdir = path.join(dataDir, 'claude-home', 'projects', 'D--Dev');
    fs.mkdirSync(tdir, { recursive: true });
    const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '50', FAKE_TRANSCRIPT: tdir } });
    toStop.push(s);
    const r = await pc(s, 'POST', '/api/chat', { prompt: 'QUIZ me please' });
    assert.equal(r.status, 200, r.text);
    const runId = r.json.runId;
    const pend = await waitFor(async () => { const p = await pc(s, 'GET', `/api/runs/${runId}/pending`); return p.json && p.json.length && p.json; }, 'the question');
    const q = pend[0];
    assert.equal(q.tool, 'AskUserQuestion');
    assert.equal(q.questions.length, 2);
    assert.deepEqual(q.questions[0].options.map((o) => o.label), ['Stacked', 'One row']);
    assert.equal(q.questions[1].multiSelect, true);
    assert.equal(q.summary, 'Which layout should the card use?');

    const ans = (body) => pc(s, 'POST', `/api/runs/${runId}/permission`, { requestId: q.requestId, ...body });
    assert.equal((await ans({ behavior: 'allow' })).status, 400, 'an Allow with no answers is refused');
    assert.equal((await ans({ behavior: 'allow', answers: { 'Not asked?': 'x' } })).status, 400);
    assert.equal((await ans({ behavior: 'allow', answers: { 'Which layout should the card use?': '' } })).status, 400);
    const ok = await ans({ behavior: 'allow', answers: { 'Which layout should the card use?': 'One row', 'Which pages should get it?': 'Home, Talk' } });
    assert.equal(ok.status, 200, ok.text);

    // the fake CLI writes what it got into its next message
    const said = await waitFor(async () => {
      const runs = (await pc(s, 'GET', '/api/runs')).json || [];
      const run = runs.find((x) => x.runId === runId);
      if (!run || !run.sessionId) return null;
      const m = (await pc(s, 'GET', `/api/sessions/${run.sessionId}?limit=40`)).json;
      const all = [...((m && m.messages) || []), ...((m && m.live && m.live.messages) || [])].map((x) => x.text || '').join('\n');
      return /QUIZ answers=/.test(all) && all;
    }, 'the answer reaching the CLI');
    assert.match(said, /QUIZ answers=\{"Which layout should the card use\?":"One row","Which pages should get it\?":"Home, Talk"\} questions=2/);
  });
});

// A question waits far longer than a tool permission, and typing an answer starts its countdown again: an answer written
// over a long time still goes. The words typed so far are kept with the question, so a page opened later shows them.
// MC_QUESTION_MS is cut to 2.5 seconds here, so "a long time" is a few seconds.
describe('a question being answered does not run out', () => {
  const Q1 = 'Which layout should the card use?';
  async function boot() {
    const dataDir = makeDataDir('mc-askq-time');
    seedFixture(dataDir);
    const tdir = path.join(dataDir, 'claude-home', 'projects', 'D--Dev');
    fs.mkdirSync(tdir, { recursive: true });
    const s = await startServer({ dataDir, bridge: false, env: { PATH: FAKE_PATH, FAKE_STEP_MS: '50', FAKE_TRANSCRIPT: tdir, MC_QUESTION_MS: '2500' } });
    toStop.push(s);
    return s;
  }
  async function ask(s) {
    const r = await pc(s, 'POST', '/api/chat', { prompt: 'QUIZ me please' });
    assert.equal(r.status, 200, r.text);
    const runId = r.json.runId;
    const pend = await waitFor(async () => { const p = await pc(s, 'GET', `/api/runs/${runId}/pending`); return p.json && p.json.length && p.json; }, 'the question');
    return { runId, q: pend[0] };
  }
  async function said(s, runId, re) {
    return waitFor(async () => {
      const runs = (await pc(s, 'GET', '/api/runs')).json || [];
      const run = runs.find((x) => x.runId === runId);
      if (!run || !run.sessionId) return null;
      const m = (await pc(s, 'GET', `/api/sessions/${run.sessionId}?limit=40`)).json;
      const all = [...((m && m.messages) || []), ...((m && m.live && m.live.messages) || [])].map((x) => x.text || '').join('\n');
      return re.test(all) && all;
    }, 'the CLI reply');
  }

  test('typing keeps it open past its limit, the words are kept with it, and the answer still goes', async () => {
    const s = await boot();
    const { runId, q } = await ask(s);
    const asked = Date.parse(q.at), dl0 = Date.parse(q.deadline);
    assert.ok(dl0 - asked >= 2400 && dl0 - asked <= 2600, 'a question carries its deadline: asked + MC_QUESTION_MS');

    const typing = (body) => pc(s, 'POST', `/api/runs/${runId}/permission/typing`, { requestId: q.requestId, ...body });
    assert.equal((await typing({ draft: { 'Not asked?': 'x' } })).status, 400, 'a draft names only the questions asked');
    assert.equal((await typing({ draft: { [Q1]: 'x'.repeat(20001) } })).status, 400, 'a draft has a size limit');
    assert.equal((await pc(s, 'POST', `/api/runs/${runId}/permission/typing`, { requestId: 'nope' })).status, 404);

    // type for about twice the limit
    let words = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      words += 'more words ';
      const t = await typing({ draft: { [Q1]: words } });
      assert.equal(t.status, 200, t.text);
      assert.ok(Date.parse(t.json.deadline) > Date.now() + 2000, 'typing moves the deadline');
      await sleep(700);
    }
    const pend = (await pc(s, 'GET', `/api/runs/${runId}/pending`)).json;
    assert.equal(pend.length, 1, 'still open after twice its limit');
    assert.equal(pend[0].draft[Q1], words, 'the words typed so far come with the question (a reload, another device)');

    const long = 'A long answer. '.repeat(400).trim(); // about 6000 characters, past the old 4000 limit
    const ok = await pc(s, 'POST', `/api/runs/${runId}/permission`, { requestId: q.requestId, behavior: 'allow', answers: { [Q1]: long, 'Which pages should get it?': 'Home' } });
    assert.equal(ok.status, 200, ok.text);
    await said(s, runId, /QUIZ answers=\{"Which layout should the card use\?":"A long answer\./);
  });

  test('left alone, it closes after its limit with "No answer in time"', async () => {
    const s = await boot();
    const { runId } = await ask(s);
    await said(s, runId, /QUIZ denied message=No answer in time/);
    assert.deepEqual((await pc(s, 'GET', `/api/runs/${runId}/pending`)).json, []);
  });
});
