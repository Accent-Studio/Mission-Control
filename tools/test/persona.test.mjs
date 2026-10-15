// Tests for the Com Link persona (its memory tags) and the start over and end conversation phrases.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-persona-'));
process.env.MC_DATA_DIR = dir;
const MEM = path.join(dir, 'comlink-memory.md');
const { applyMemoryTags, stripMemoryTags, personaEvent, personaPromptFile } = await import('../../server/services/persona.js');
await import('../../app/phrases.js');
const PH = globalThis.MCPhrases;
const ALL = { send: 'send it', cancel: 'cancel that', rewrite: 'start over', end: 'end conversation' };

describe('phrases: start over and end conversation', () => {
  test('each phrase is found at the end, with what came before', () => {
    assert.deepEqual(PH.detect('I said it wrong, start over', ALL), { kind: 'rewrite', rest: 'I said it wrong' });
    assert.deepEqual(PH.detect('Thanks Nova. End conversation.', ALL), { kind: 'end', rest: 'Thanks Nova.' });
    assert.deepEqual(PH.detect('What time is it, send it', ALL), { kind: 'send', rest: 'What time is it' });
    assert.equal(PH.detect('never mind, cancel that', ALL).kind, 'cancel');
  });
  test('without the new phrases, detect works as before', () => {
    assert.equal(PH.detect('start over', { send: 'send it', cancel: 'cancel that' }), null);
    assert.deepEqual(PH.detect('send it', { send: 'send it', cancel: 'cancel that' }), { kind: 'cancel', rest: '', empty: true });
  });
  test('variations separated by commas, and small words ignored', () => {
    const ph = { send: 'send message, send it now', cancel: 'stop message', rewrite: 'rewrite message', end: 'end conversation' };
    assert.deepEqual(PH.detect('What time is it, send a message.', ph), { kind: 'send', rest: 'What time is it' });
    assert.deepEqual(PH.detect('fix it send it now', ph), { kind: 'send', rest: 'fix it' });
    assert.deepEqual(PH.detect('bye, end the conversation', ph), { kind: 'end', rest: 'bye' });
    assert.equal(PH.detect('I want to send a messenger', ph), null);
    assert.deepEqual(PH.checkPhrase(' send message ,send it now, Send  Message '), { ok: true, phrase: 'send message, send it now' });
    assert.equal(PH.checkPhrase('send message, x').ok, false);
    assert.equal(PH.checkPhrase('send message, send it!').ok, false);
  });
  test('the longest phrase wins', () => {
    assert.equal(PH.detect('go on, cancel that now', { send: 'now', cancel: 'that now' }).kind, 'cancel');
  });
});

describe('persona memory', () => {
  test('remember adds a dated line, a repeat is skipped, forget removes it', () => {
    fs.rmSync(MEM, { force: true });
    assert.equal(applyMemoryTags('Ha. <remember>They call the old build server Boomer.</remember>'), 1);
    assert.equal(applyMemoryTags('<remember>They call the old build server Boomer.</remember>'), 0);
    assert.match(fs.readFileSync(MEM, 'utf8'), /^- \d{4}-\d{2}-\d{2}: They call the old build server Boomer\.\n$/);
    assert.equal(applyMemoryTags('<forget>build server Boomer</forget>'), 1);
    assert.equal(fs.readFileSync(MEM, 'utf8').trim(), '');
  });
  test('tags are stripped from what is shown and read aloud', () => {
    assert.equal(stripMemoryTags('Copy that.\n<remember>They hate mornings.</remember>\nOn it.'), 'Copy that.\n\nOn it.');
    assert.equal(stripMemoryTags('No tags here.'), 'No tags here.');
  });
  test('an assistant event is cleaned and its tags applied', () => {
    fs.rmSync(MEM, { force: true });
    const ev = { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Sure. <remember>They like green tea.</remember>' }, { type: 'tool_use', id: 't' }] } };
    const out = personaEvent(ev);
    assert.equal(out.message.content[0].text, 'Sure.');
    assert.equal(out.message.content[1].type, 'tool_use');
    assert.match(fs.readFileSync(MEM, 'utf8'), /They like green tea\./);
    assert.equal(ev.message.content[0].text, 'Sure. <remember>They like green tea.</remember>'); // the original is not changed
  });
  test('the system prompt file holds the prompt and the memory', () => {
    const f = personaPromptFile('comlink', 'Nova');
    const t = fs.readFileSync(f, 'utf8');
    assert.match(t, /You are Nova, the voice assistant/);
    assert.doesNotMatch(t, /\{\{name\}\}/);
    assert.match(t, /# Your memory/);
    assert.match(t, /They like green tea\./);
    assert.equal(personaPromptFile('other'), null);
  });
  test('an own prompt in the data folder replaces the default one', () => {
    const own = path.join(dir, 'comlink-prompt.md');
    fs.writeFileSync(own, 'You are {{name}}, my own assistant.');
    try {
      const t = fs.readFileSync(personaPromptFile('comlink', 'Nova'), 'utf8');
      assert.match(t, /^You are Nova, my own assistant\./);
      assert.match(t, /# Your memory/);
    } finally {
      fs.rmSync(own, { force: true });
    }
  });
});
