// Brings chats from a claude.ai data export into Mission Control's Chats tab, where they can be read and continued.
//
//   node tools/import-claude-ai.mjs <conversations-000.zip | conversations.json> [--dry-run] [--force]
//
// Get the export on claude.ai: Settings, Privacy, Export data. Download the "conversations" file from the mail or the
// manifest it gives. Each chat becomes a transcript in the chats folder, with its claude.ai id, title and dates, so a
// second import of the same chat is skipped (--force writes it again, and loses what was added to it in Mission Control).
//
// The export holds the text only. A chat keeps its words, the text files attached to it, its artifacts and the code it
// wrote; pictures and other files are named but not kept. Web searches and the pages read show as one line each. When a
// chat was edited on claude.ai, the branch written last is the one kept.
//
// MC_DATA_DIR and MC_CLAUDE_HOME point it somewhere else, as for the server (tests).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { CHATS_DIR } from '../server/config.js';
import { CHATS_TRANSCRIPT_DIR } from '../server/lib/chats.js';

const HOME = process.env.MC_CLAUDE_HOME ? path.resolve(process.env.MC_CLAUDE_HOME) : path.join(os.homedir(), '.claude');
const OUT_DIR = path.join(HOME, 'projects', CHATS_TRANSCRIPT_DIR);
const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = 'claude-opus-5-5'; // the export does not say which model answered; a continued chat runs on this one
const RESULT_MAX = 4000;

// ---- Reading the export ----

// The one file a zip holds under this name. Stored and deflated entries only, which is what claude.ai writes.
function fromZip(buf, name) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  let at = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const skip = nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const entry = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + skip;
    if (path.posix.basename(entry) !== name) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error(`${name} is packed in a way this tool cannot read (method ${method})`);
  }
  throw new Error(`no ${name} in the zip`);
}

export function readExport(file) {
  const buf = fs.readFileSync(file);
  const text = (buf[0] === 0x50 && buf[1] === 0x4b ? fromZip(buf, 'conversations.json') : buf).toString('utf8').replace(/^\uFEFF/, '');
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('conversations.json is not a list of chats');
  return list;
}

// ---- One claude.ai chat as text ----

// The messages of the branch written last: from the newest answer with nothing under it (or the newest message, when no
// branch ends on an answer), back up to the first one.
function mainBranch(messages) {
  const byId = new Map(messages.map((m) => [m.uuid, m]));
  const parents = new Set(messages.map((m) => m.parent_message_uuid));
  const leaves = messages.filter((m) => !parents.has(m.uuid));
  if (!leaves.length) return messages;
  leaves.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const answered = leaves.filter((m) => m.sender !== 'human');
  const leaf = (answered.length ? answered : leaves).pop();
  const out = [];
  const seen = new Set();
  for (let m = leaf; m && !seen.has(m.uuid); m = byId.get(m.parent_message_uuid)) {
    seen.add(m.uuid);
    out.unshift(m);
  }
  return out[0] && out[0].parent_message_uuid !== ROOT_PARENT && byId.has(out[0].parent_message_uuid) ? messages : out;
}

const fence = (body, lang = '') => {
  const ticks = /```/.test(body) ? '````' : '```';
  return `${ticks}${lang}\n${String(body).replace(/\n$/, '')}\n${ticks}`;
};
const LANGS = { 'text/markdown': 'markdown', 'text/html': 'html', 'application/vnd.ant.react': 'jsx', 'image/svg+xml': 'svg', 'application/vnd.ant.mermaid': 'mermaid' };
const clip = (s) => (s.length > RESULT_MAX ? s.slice(0, RESULT_MAX) + '\n[...]' : s);

function toolText(p) {
  const i = p.input || {};
  switch (p.name) {
    case 'artifacts': {
      const title = i.title || i.id || 'Artifact';
      if (i.command === 'update') return `**${title}** (changed)\n\n${fence(i.new_str || '')}`;
      if (typeof i.content !== 'string') return '';
      return i.type === 'text/markdown' ? `**${title}**\n\n${i.content}` : `**${title}**\n\n${fence(i.content, i.language || LANGS[i.type] || '')}`;
    }
    case 'create_file':
      return `**${path.posix.basename(String(i.path || 'file'))}**\n\n${fence(i.file_text || '')}`;
    case 'bash_tool':
      return fence(i.command || '', 'bash');
    case 'web_search':
    case 'WebSearch':
      return i.query ? `_Web search: ${i.query}_` : '';
    case 'web_fetch':
    case 'WebFetch':
      return i.url ? `_Read: ${i.url}_` : '';
    case 'message_compose_v1':
      return (Array.isArray(i.variants) ? i.variants : []).map((v) => `**${v.label || 'Draft'}**\n\n${v.body || ''}`).join('\n\n');
    default:
      return ''; // claude.ai's own housekeeping (showing files, reading its skills, suggesting connectors)
  }
}

function resultText(p) {
  if (p.name !== 'bash_tool') return '';
  const raw = (Array.isArray(p.content) ? p.content : []).map((c) => (c && c.type === 'text' ? c.text : '')).join('');
  let out = raw;
  try {
    const r = JSON.parse(raw);
    out = [r.stdout, r.stderr].filter(Boolean).join('\n');
  } catch {
    // plain text
  }
  return out.trim() ? `Output:\n\n${fence(clip(out.trim()))}` : '';
}

// Answers from early 2025 carry claude.ai's markup in the text itself: its private notes (antThinking, left out) and
// its artifacts (antArtifact, turned into a title and a code block like the later ones).
const attr = (tag, name) => { const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(tag); return m ? m[1] : ''; };
function oldMarkup(text) {
  return String(text)
    .replace(/<antThinking>[\s\S]*?<\/antThinking>\s*/g, '')
    .replace(/<antArtifact(\s[^>]*)?>([\s\S]*?)(?:<\/antArtifact>|$)/g, (_, tag = '', body) => {
      const type = attr(tag, 'type');
      return toolText({ name: 'artifacts', input: { title: attr(tag, 'title') || attr(tag, 'identifier'), type, language: attr(tag, 'language'), content: body.replace(/^\r?\n/, '') } });
    });
}

function assistantText(m) {
  const parts = Array.isArray(m.content) && m.content.length ? m.content : [{ type: 'text', text: m.text || '' }];
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    const t = p.type === 'text' ? oldMarkup(p.text || '') : p.type === 'tool_use' ? toolText(p) : p.type === 'tool_result' ? resultText(p) : '';
    if (t.trim()) out.push(t.trim());
  }
  return out.join('\n\n');
}

function userText(m) {
  const parts = Array.isArray(m.content) && m.content.length ? m.content : [{ type: 'text', text: m.text || '' }];
  const out = [];
  const said = parts.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n\n').trim();
  if (said) out.push(said);
  const named = new Set();
  for (const a of m.attachments || []) {
    named.add(a.file_name);
    out.push(a.extracted_content ? `**Attached: ${a.file_name}**\n\n${fence(a.extracted_content)}` : `_[Attached: ${a.file_name}, not kept in the export]_`);
  }
  for (const f of m.files || []) if (f && f.file_name && !named.has(f.file_name)) out.push(`_[Attached: ${f.file_name}, not kept in the export]_`);
  return out.join('\n\n');
}

// [{ role, text, at }], one per turn, user and assistant in turn (two in a row from one side become one).
export function turnsOf(chat) {
  const out = [];
  for (const m of mainBranch(Array.isArray(chat.chat_messages) ? chat.chat_messages : [])) {
    const role = m.sender === 'human' ? 'user' : 'assistant';
    const text = role === 'user' ? userText(m) : assistantText(m);
    const last = out[out.length - 1];
    if (last && last.role === role) {
      if (text) last.text = last.text ? last.text + '\n\n' + text : text;
      continue;
    }
    out.push({ role, text, at: m.created_at });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.some((t) => t.text)) return []; // claude.ai kept nothing of it
  for (const t of out) if (!t.text) t.text = t.role === 'user' ? '(no text)' : '(no answer)';
  return out;
}

// ---- The transcript ----

export function transcriptOf(chat) {
  const id = String(chat.uuid).toLowerCase();
  const turns = turnsOf(chat);
  const lines = [];
  let parent = null;
  let n = 0;
  for (const t of turns) {
    const uuid = crypto.randomUUID();
    const base = { parentUuid: parent, isSidechain: false, uuid, timestamp: new Date(t.at || chat.created_at).toISOString(), userType: 'external', entrypoint: 'sdk-cli', cwd: CHATS_DIR, sessionId: id, version: 'claude.ai export' };
    if (t.role === 'user') lines.push({ ...base, type: 'user', promptSource: 'sdk', message: { role: 'user', content: [{ type: 'text', text: t.text }] } });
    else lines.push({ ...base, type: 'assistant', message: { model: MODEL, id: `msg_claudeai_${id.slice(0, 8)}_${++n}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: t.text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    parent = uuid;
  }
  const first = turns[0] ? turns[0].text.replace(/\s+/g, ' ').trim() : '';
  const title = String(chat.name || '').trim() || (first.length > 60 ? first.slice(0, 57) + '...' : first);
  if (title) lines.push({ type: 'custom-title', customTitle: title.slice(0, 120), sessionId: id });
  return { id, title, turns: turns.length, text: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' };
}

// ---- Run ----

// Claude Code deletes a transcript whose file is older than cleanupPeriodDays (30 by default) each time it starts. A chat
// gets its date from claude.ai only when that setting keeps it; otherwise its file keeps today's date. The list sorts by
// the timestamps inside either way.
function keepDays() {
  try {
    const v = Number(JSON.parse(fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8')).cleanupPeriodDays);
    return v >= 1 ? v : 30;
  } catch {
    return 30;
  }
}
function dateIt(file, chat, keep) {
  const when = new Date(chat.updated_at || chat.created_at);
  if (!Number.isFinite(when.getTime()) || Date.now() - when.getTime() > (keep - 2) * 86400e3) return false;
  fs.utimesSync(file, when, when);
  return true;
}

export function importChats(list, { dryRun = false, force = false } = {}) {
  const report = { written: [], skipped: [], empty: [], dated: 0, keepDays: keepDays() };
  if (!dryRun) fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const chat of list) {
    if (!chat || !UUID_RE.test(String(chat.uuid || ''))) continue;
    const t = transcriptOf(chat);
    const row = { id: t.id, title: t.title, turns: t.turns, bytes: Buffer.byteLength(t.text) };
    if (!t.turns) { report.empty.push(row); continue; }
    const file = path.join(OUT_DIR, t.id + '.jsonl');
    if (fs.existsSync(file) && !force) {
      // already here and not continued since the import (the same size: only its line ids differ), it gets its date back
      if (!dryRun && fs.statSync(file).size === Buffer.byteLength(t.text) && dateIt(file, chat, report.keepDays)) report.dated++;
      report.skipped.push(row);
      continue;
    }
    if (!dryRun) {
      fs.writeFileSync(file, t.text);
      if (dateIt(file, chat, report.keepDays)) report.dated++;
    }
    report.written.push(row);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node tools/import-claude-ai.mjs <conversations-000.zip | conversations.json> [--dry-run] [--force]');
    process.exit(2);
  }
  const report = importChats(readExport(file), { dryRun: args.includes('--dry-run'), force: args.includes('--force') });
  const kb = (b) => Math.round(b / 1024) + ' KB';
  for (const r of report.written) console.log(`${args.includes('--dry-run') ? 'would add' : 'added'}  ${r.title}  (${r.turns} messages, ${kb(r.bytes)})`);
  for (const r of report.skipped) console.log(`skipped  ${r.title}  (already here)`);
  for (const r of report.empty) console.log(`empty    ${r.title || r.id}`);
  console.log(`\n${report.written.length} added, ${report.skipped.length} already here, ${report.empty.length} empty. Folder: ${OUT_DIR}`);
  if (!args.includes('--dry-run')) console.log(`${report.dated} with their date from claude.ai. Claude Code keeps conversations ${report.keepDays} days (cleanupPeriodDays)${report.keepDays <= 30 ? ': raise it in ~/.claude/settings.json, then run this again, to give the older chats their dates' : ''}.`);
}
