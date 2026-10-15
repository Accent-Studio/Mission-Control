// The Com Link persona: its prompt plus its own memory, appended to the system prompt of every Com Link run. The prompt is
// .data/comlink-prompt.md when that file exists, else server/prompts/comlink.md, with {{name}} replaced by the assistant's
// name from the voice settings. It keeps the memory itself by writing <remember>...</remember> or <forget>...</forget> in a reply: the
// server applies the tags to the memory file and strips them before the reply reaches the browser, so they are never read aloud.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PERSONA_SYSTEM_FILE, ROOT } from '../config.js';
import { readText, writeAtomic, busyError } from '../lib/jsonStore.js';

const DEFAULT_PROMPT_FILE = path.join(ROOT, 'server', 'prompts', 'comlink.md');
export const OWN_PROMPT_FILE = path.join(DATA_DIR, 'comlink-prompt.md');
const MEMORY_FILE = process.env.MC_PERSONA_MEMORY || path.join(DATA_DIR, 'comlink-memory.md');
const SYSTEM_FILE = PERSONA_SYSTEM_FILE; // the runner accepts exactly this file as a system prompt (runner/shared.js)
const MEMORY_MAX = 8000; // characters; past this the oldest lines go first
const ENTRY_MAX = 300;

export const PERSONAS = ['comlink'];

const TAG_RE = /<(remember|forget)>([\s\S]*?)<\/\1>/gi;

// The memory text ('' when there is none yet), or null when the file is there but could not be read right now. A null
// must never lead to a write: that would replace her whole memory (jsonStore.js).
function readMemory() {
  const r = readText(MEMORY_FILE, 'persona');
  return r.ok ? r.text || '' : null;
}

// Writes prompt + memory to one file and returns its path, for --append-system-prompt-file. Read fresh on every run, so
// an edit to the prompt or the memory reaches the next process without a restart.
export function personaPromptFile(name, displayName = 'Com Link') {
  if (name !== 'comlink') return null;
  const file = fs.existsSync(OWN_PROMPT_FILE) ? OWN_PROMPT_FILE : DEFAULT_PROMPT_FILE;
  const prompt = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim().replaceAll('{{name}}', displayName);
  const mem = (readMemory() || '').trim();
  const text = `${prompt}\n\n# Your memory\n\nWhat you wrote down in earlier conversations, oldest first:\n\n${mem || 'Nothing yet.'}\n`;
  writeAtomic(SYSTEM_FILE, text);
  return SYSTEM_FILE;
}

const today = () => new Date().toISOString().slice(0, 10);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, ENTRY_MAX);

// Applies every tag in the text to the memory file. Returns how many changed it.
export function applyMemoryTags(text) {
  if (typeof text !== 'string' || !/<(remember|forget)>/i.test(text)) return 0;
  const now = readMemory();
  if (now === null) return 0; // the tags are lost this once, the memory is not
  let lines = now.split(/\r?\n/).filter((l) => l.trim());
  let n = 0;
  for (const m of text.matchAll(TAG_RE)) {
    const body = oneLine(m[2]);
    if (!body) continue;
    if (m[1].toLowerCase() === 'remember') {
      if (lines.some((l) => l.toLowerCase().includes(body.toLowerCase()))) continue; // already known
      lines.push(`- ${today()}: ${body}`);
      n++;
    } else {
      const before = lines.length;
      lines = lines.filter((l) => !l.toLowerCase().includes(body.toLowerCase()));
      n += before - lines.length;
    }
  }
  if (!n) return 0;
  while (lines.length > 1 && lines.join('\n').length > MEMORY_MAX) lines.shift();
  try {
    writeAtomic(MEMORY_FILE, lines.join('\n') + '\n');
  } catch (err) {
    console.error('[persona] could not save the memory:', err.message);
    return 0;
  }
  return n;
}

// The text without its memory tags (and without the blank lines they leave).
export function stripMemoryTags(text) {
  if (typeof text !== 'string' || !/<(remember|forget)>/i.test(text)) return text;
  return text.replace(TAG_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// A stream event with the tags applied and stripped. Each text block is applied once (an event is handled once).
// save: false only strips the tags (used when the server replays what it already handled, so nothing is written twice).
export function personaEvent(event, { save = true } = {}) {
  if (!event || event.type !== 'assistant' || !event.message || !Array.isArray(event.message.content)) return event;
  if (!event.message.content.some((b) => b && b.type === 'text' && /<(remember|forget)>/i.test(b.text || ''))) return event;
  const content = event.message.content.map((b) => {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') return b;
    if (save) applyMemoryTags(b.text);
    return { ...b, text: stripMemoryTags(b.text) };
  });
  return { ...event, message: { ...event.message, content } };
}

// Her memory as plain text, for the Settings page.
// Refuses while the file cannot be read: an empty box saved back from the page would wipe her memory.
export function getMemory() {
  const text = readMemory();
  if (text === null) throw busyError(MEMORY_FILE);
  return { text, max: MEMORY_MAX };
}

// Replaces her memory with what the owner typed on the Settings page.
export function setMemory(body) {
  const text = body && typeof body.text === 'string' ? body.text.replace(/\r\n/g, '\n') : null;
  if (text === null) throw Object.assign(new Error('Send {"text": "..."}'), { status: 400 });
  if (text.length > MEMORY_MAX * 2) throw Object.assign(new Error(`The memory is longer than ${MEMORY_MAX * 2} characters`), { status: 400 });
  writeAtomic(MEMORY_FILE, text.trim() ? text.trim() + '\n' : '');
  return getMemory();
}
