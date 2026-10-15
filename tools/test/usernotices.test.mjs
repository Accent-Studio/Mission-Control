// Tests for sorting the user-side records of a Claude Code transcript: the human's words, notices (task
// notifications, helper reports) and hidden meta records. The unit part feeds the classifier the exact shapes found
// in real transcripts (with made-up text); the server part runs them through /api/sessions.
// Run: node --test "tools/test/*.test.mjs"        (no npm packages; the server uses a free port and its own data folder)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { classifyUserEntry, NOTICE_TEXT_MAX } from '../../server/services/userKinds.js';
import { localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

const TASK_TEXT =
  '<task-notification>\n<task-id>ab56a2ee489c19d13</task-id>\n<tool-use-id>toolu_01Q6Zy9dYdsvWsG1aTWbRw7z</tool-use-id>\n' +
  '<output-file>X:\\tasks\\ab56a2ee489c19d13.output</output-file>\n<status>completed</status>\n' +
  '<summary>Agent "Scout project page layout" finished</summary>\n<note>A task-notification fires each time.</note>\n' +
  '<result>Done.</result>\n</task-notification>';
const PEER_TEXT = 'Another Claude session sent a message:\n<agent-message from="ad594ee64b1ca1eca">\n[Subagent hand-back] The report follows:\n  All paths are under app.\n</agent-message>';
const PEER_BODY = '[Subagent hand-back] The report follows:\n  All paths are under app.';

const user = (content, extra = {}) => ({ type: 'user', isSidechain: false, message: { role: 'user', content }, ...extra });

describe('classifyUserEntry', () => {
  test('a human prompt (origin human, sdk) is the user', () => {
    const c = classifyUserEntry(user('Please fix the footer.', { origin: { kind: 'human' }, promptSource: 'sdk', turnOrigin: 'human' }));
    assert.deepEqual(c, { kind: 'user', text: 'Please fix the footer.' });
  });

  test('a message sent from Mission Control (no origin, promptSource sdk) stays the user', () => {
    assert.equal(classifyUserEntry(user('Hello there', { promptSource: 'sdk', turnOrigin: 'sdk' })).kind, 'user');
  });

  test('a task notification (origin task-notification) is a notice with a short label', () => {
    for (const extra of [
      { origin: { kind: 'task-notification', producer: 'session-task', runId: 'r1' }, promptSource: 'system' },
      { origin: { kind: 'task-notification', producer: 'session-task', runId: 'r1' }, promptSource: 'system', turnOrigin: 'task_notification' },
      { origin: { kind: 'task-notification' }, promptSource: 'sdk' },
    ]) {
      const c = classifyUserEntry(user(TASK_TEXT, extra));
      assert.equal(c.kind, 'notice');
      assert.equal(c.type, 'task');
      assert.equal(c.label, 'Helper finished: Scout project page layout');
      assert.equal(c.status, 'finished');
      assert.equal(c.toolUseId, 'toolu_01Q6Zy9dYdsvWsG1aTWbRw7z');
      assert.ok(c.text.startsWith('<task-notification>'));
    }
  });

  test('a failed or stopped helper says so in words', () => {
    const failed = TASK_TEXT.replace('<status>completed</status>', '<status>failed</status>');
    assert.equal(classifyUserEntry(user(failed, { origin: { kind: 'task-notification' } })).label, 'Helper failed: Scout project page layout');
    const killed = TASK_TEXT.replace('<status>completed</status>', '<status>killed</status>');
    assert.equal(classifyUserEntry(user(killed, { origin: { kind: 'task-notification' } })).label, 'Helper killed: Scout project page layout');
  });

  test('a background command notice keeps its own summary, and a failure is added in words', () => {
    const t = '<task-notification>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>';
    assert.equal(classifyUserEntry(user(t, { origin: { kind: 'task-notification' } })).label, 'Background command "npm test" completed (exit code 0)');
    const f = '<task-notification>\n<status>failed</status>\n<summary>Monitor event: "build"</summary>\n</task-notification>';
    assert.equal(classifyUserEntry(user(f, { origin: { kind: 'task-notification' } })).label, 'Monitor event: "build" (failed)');
  });

  test('a helper report (isMeta, origin peer) is a notice whose text is origin.body', () => {
    const c = classifyUserEntry(user(PEER_TEXT, { isMeta: true, origin: { kind: 'peer', from: 'ad594', name: 'general-purpose', body: PEER_BODY }, promptSource: 'system', turnOrigin: 'peer' }));
    assert.equal(c.kind, 'notice');
    assert.equal(c.type, 'peer');
    assert.equal(c.label, 'Report from general-purpose');
    assert.equal(c.text, PEER_BODY);
    const noName = classifyUserEntry(user(PEER_TEXT, { isMeta: true, origin: { kind: 'peer', body: PEER_BODY } }));
    assert.equal(noName.label, 'Report from a helper');
  });

  test('skill text and image notes (isMeta) are hidden', () => {
    assert.equal(classifyUserEntry(user([{ type: 'text', text: 'Base directory for this skill: C:\\x\\delegate\n\n# Delegate' }], { isMeta: true })).kind, 'hidden');
    assert.equal(classifyUserEntry(user([{ type: 'text', text: '[Image: source: C:\\x\\a.png]' }], { isMeta: true })).kind, 'hidden');
  });

  test('tool results stay tool rows', () => {
    assert.equal(classifyUserEntry(user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }])).kind, 'tool');
  });

  test('a prompt that is only an image is still the user, a system one is not', () => {
    const img = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }];
    assert.deepEqual(classifyUserEntry(user(img, { promptSource: 'sdk' })), { kind: 'user', text: '' });
    assert.equal(classifyUserEntry(user(img, { origin: { kind: 'task-notification' }, promptSource: 'system' })).kind, 'hidden');
  });

  test('old transcripts without markers fall back to the text shape', () => {
    assert.equal(classifyUserEntry(user(TASK_TEXT)).kind, 'notice');
    assert.equal(classifyUserEntry(user(TASK_TEXT)).label, 'Helper finished: Scout project page layout');
    const peer = classifyUserEntry(user(PEER_TEXT));
    assert.equal(peer.kind, 'notice');
    assert.equal(peer.type, 'peer');
    assert.equal(peer.text, PEER_TEXT);
    assert.equal(classifyUserEntry(user('<system-reminder>Be careful.</system-reminder>')).kind, 'hidden');
    assert.deepEqual(classifyUserEntry(user('<system-reminder>x</system-reminder>\nReal words')), { kind: 'user', text: 'Real words' });
    assert.equal(classifyUserEntry(user([{ type: 'text', text: TASK_TEXT }])).kind, 'notice');
  });

  test('a real message that mentions task-notification in the middle stays the user', () => {
    const t = 'Why does the page show a raw <task-notification> block when a helper finishes?';
    assert.deepEqual(classifyUserEntry(user(t)), { kind: 'user', text: t });
    assert.equal(classifyUserEntry(user(t, { origin: { kind: 'human' }, promptSource: 'sdk' })).kind, 'user');
    const t2 = 'Another Claude session sent a message, I think. What is that?';
    assert.equal(classifyUserEntry(user(t2, { promptSource: 'sdk' })).kind, 'user');
  });

  test('a human message that starts with the notification words but has origin human or sdk stays the user', () => {
    assert.equal(classifyUserEntry(user(TASK_TEXT, { origin: { kind: 'human' }, promptSource: 'sdk' })).kind, 'user');
    assert.equal(classifyUserEntry(user(TASK_TEXT, { promptSource: 'sdk', turnOrigin: 'sdk' })).kind, 'user');
  });

  test('legacyText: false needs a marker (live replays of the human own messages)', () => {
    assert.equal(classifyUserEntry(user(TASK_TEXT), { legacyText: false }).kind, 'user');
    assert.equal(classifyUserEntry(user(TASK_TEXT, { origin: { kind: 'task-notification' } }), { legacyText: false }).kind, 'notice');
  });

  test('a compact summary and an unknown system origin are notices', () => {
    assert.equal(classifyUserEntry(user('This session is being continued from a previous conversation.', { isCompactSummary: true })).label, 'Earlier conversation summarized');
    assert.equal(classifyUserEntry(user('Something automatic', { origin: { kind: 'channel' }, promptSource: 'system' })).label, 'System message');
  });

  test('a queued_command attachment: the human is the user, a notification and a report stay notices', () => {
    const att = (a) => ({ type: 'attachment', isSidechain: false, attachment: { type: 'queued_command', source_uuid: 's1', delivery_id: 'd1', ...a } });
    const human = classifyUserEntry(att({ prompt: 'Also, please check the footer.', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true }));
    assert.deepEqual(human, { kind: 'user', text: 'Also, please check the footer.', queued: true });
    const task = classifyUserEntry(att({ prompt: TASK_TEXT, commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' } }));
    assert.equal(task.kind, 'notice');
    assert.equal(task.type, 'task');
    assert.equal(task.label, 'Helper finished: Scout project page layout');
    assert.equal(task.queued, true);
    const peer = classifyUserEntry(att({ prompt: '<agent-message from="ad594">\nbody\n</agent-message>', commandMode: 'prompt', origin: { kind: 'peer', name: 'general-purpose', body: PEER_BODY } }));
    assert.equal(peer.kind, 'notice');
    assert.equal(peer.type, 'peer');
    assert.equal(peer.text, PEER_BODY);
    // No origin at all (older CLI): the text shape decides, as for a normal record.
    assert.equal(classifyUserEntry(att({ prompt: TASK_TEXT, commandMode: 'task-notification' })).kind, 'notice');
    assert.equal(classifyUserEntry(att({ prompt: 'Plain words', commandMode: 'prompt' })).kind, 'user');
    // Other attachments and empty prompts show nothing.
    assert.equal(classifyUserEntry({ type: 'attachment', attachment: { type: 'output_style', style: 'ELI5' } }).kind, 'hidden');
    assert.equal(classifyUserEntry(att({ prompt: '', commandMode: 'prompt', origin: { kind: 'human' } })).kind, 'hidden');
  });

  test('a very long notice is cut at the cap', () => {
    const big = TASK_TEXT.replace('<result>Done.</result>', '<result>' + 'x'.repeat(NOTICE_TEXT_MAX * 2) + '</result>');
    const c = classifyUserEntry(user(big, { origin: { kind: 'task-notification' } }));
    assert.ok(c.text.length <= NOTICE_TEXT_MAX + 3);
    assert.ok(c.text.endsWith('...'));
  });
});

// ---- through the server ----

const SID = '3f1c8b52-0d6a-4f3e-9a41-5b7e2c9d1a60';
const stamp = (n) => new Date(Date.UTC(2026, 9, 12, 12, n, 0)).toISOString();

function record(o, n) {
  return JSON.stringify({ parentUuid: null, isSidechain: false, uuid: `u-${n}`, timestamp: stamp(n), sessionId: SID, cwd: 'D:\\Dev', ...o });
}

function transcript() {
  return [
    // the skill text comes first and must not become the title
    record({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: C:\\x\\delegate\n\n# Delegate skill' }] } }, 1),
    record({ type: 'user', origin: { kind: 'task-notification', producer: 'session-task', runId: 'r0' }, promptSource: 'system', message: { role: 'user', content: TASK_TEXT.replace('Scout project page layout', 'Early scout') } }, 2),
    record({ type: 'user', origin: { kind: 'human' }, promptSource: 'sdk', turnOrigin: 'human', message: { role: 'user', content: 'Please fix the footer spacing.' } }, 3),
    record({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'On it, I started a helper.' }], usage: { input_tokens: 10, output_tokens: 20 } } }, 4),
    record({ type: 'user', origin: { kind: 'task-notification', producer: 'session-task', runId: 'r1' }, promptSource: 'system', message: { role: 'user', content: TASK_TEXT } }, 5),
    record({ type: 'user', isMeta: true, origin: { kind: 'peer', from: 'ad594', name: 'general-purpose', body: PEER_BODY }, promptSource: 'system', turnOrigin: 'peer', message: { role: 'user', content: PEER_TEXT } }, 6),
    record({ type: 'assistant', message: { id: 'm2', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'The helper is done.' }], usage: { input_tokens: 10, output_tokens: 30 } } }, 7),
  ].join('\n') + '\n';
}

describe('sessions API', () => {
  test('notices are not the user: messages, title and turns', async () => {
    const dataDir = makeDataDir('mc-notices');
    seedFixture(dataDir);
    const dir = path.join(dataDir, 'claude-home', 'projects', 'D--Dev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), transcript());
    const s = await startServer({ dataDir, bridge: false });
    toStop.push(s);

    const r = await localReq(s, { path: `/api/sessions/${SID}?limit=40` });
    assert.equal(r.status, 200);
    assert.equal(r.json.title, 'Please fix the footer spacing.');
    const roles = r.json.messages.map((m) => m.role);
    assert.deepEqual(roles, ['notice', 'user', 'assistant', 'notice', 'notice', 'assistant']);
    assert.equal(r.json.messages.filter((m) => m.role === 'user').length, 1);
    const [early, , , done, report] = r.json.messages;
    assert.equal(early.label, 'Helper finished: Early scout');
    assert.equal(done.label, 'Helper finished: Scout project page layout');
    assert.equal(done.status, 'finished');
    assert.ok(done.text.startsWith('<task-notification>'));
    assert.equal(report.label, 'Report from general-purpose');
    assert.equal(report.text, PEER_BODY);
    assert.ok(!r.json.messages.some((m) => /Base directory for this skill/.test(m.text)));

    // The first answer ran from the prompt (minute 3) to its last record (minute 4); the helper's wait is not charged to it.
    const first = r.json.messages[2];
    assert.equal(first.turn.durationMs, 60 * 1000);

    const list = await localReq(s, { path: '/api/sessions' });
    assert.equal(list.status, 200);
    const row = list.json.find((x) => x.id === SID);
    assert.ok(row);
    assert.equal(row.title, 'Please fix the footer spacing.');
  });

  test('a message sent while Claude answers shows once as the user, queued notifications stay notices', async () => {
    const dataDir = makeDataDir('mc-queued');
    seedFixture(dataDir);
    const dir = path.join(dataDir, 'claude-home', 'projects', 'D--Dev');
    fs.mkdirSync(dir, { recursive: true });
    const MID = 'Also, please make the header smaller.';
    const IDLE = 'Thanks, that works.';
    const att = (a, n) => record({ type: 'attachment', attachment: { type: 'queued_command', source_uuid: `s-${n}`, delivery_id: `d-${n}`, ...a } }, n);
    const op = (operation, content, n, extra = {}) => JSON.stringify({ type: 'queue-operation', operation, timestamp: stamp(n), sessionId: SID, ...(content === undefined ? {} : { content }), ...extra });
    const asst = (id, text, n) => record({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 20 } } }, n);
    const lines = [
      record({ type: 'user', origin: { kind: 'human' }, promptSource: 'sdk', message: { role: 'user', content: 'Please fix the footer spacing.' } }, 1),
      asst('m1', 'Working on the footer.', 2),
      // sent mid-answer: enqueue, then the delivery attachment, then remove. No normal user record exists for it.
      op('enqueue', MID, 3),
      op('enqueue', TASK_TEXT, 3),
      att({ prompt: TASK_TEXT, commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' } }, 4),
      att({ prompt: MID, commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true }, 4),
      op('remove', TASK_TEXT, 4, { reason: 'absorbed_mid_turn' }),
      op('remove', MID, 4, { reason: 'absorbed_mid_turn' }),
      asst('m2', 'Done with the footer, and the header is smaller too.', 5),
      // sent while idle: enqueue, dequeue, then a normal user record carrying the same text
      op('enqueue', IDLE, 6),
      op('dequeue', undefined, 6),
      record({ type: 'user', origin: { kind: 'human' }, promptSource: 'sdk', message: { role: 'user', content: IDLE } }, 7),
      asst('m3', 'Glad to hear it.', 8),
    ];
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), lines.join('\n') + '\n');
    const s = await startServer({ dataDir, bridge: false });
    toStop.push(s);

    const r = await localReq(s, { path: `/api/sessions/${SID}?limit=40` });
    assert.equal(r.status, 200);
    const msgs = r.json.messages;
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'notice', 'user', 'assistant', 'user', 'assistant']);
    assert.equal(msgs.filter((m) => m.text === MID).length, 1);
    assert.equal(msgs.filter((m) => m.text === IDLE).length, 1);
    assert.equal(msgs[2].label, 'Helper finished: Scout project page layout');
    assert.equal(msgs[2].noticeType, 'task');
    assert.ok(msgs[2].text.startsWith('<task-notification>'));
    assert.equal(msgs[3].text, MID);
    assert.equal(msgs[3].noticeType, undefined);
    // The mid-turn message does not split the turn: one turn runs from the prompt (minute 1) to the answer at minute 5,
    // and it is stamped on that last answer only.
    assert.equal(msgs[1].turn, undefined);
    assert.equal(msgs[4].turn.durationMs, 4 * 60 * 1000);
    // The title is still the first prompt.
    assert.equal(r.json.title, 'Please fix the footer spacing.');
  });
});
