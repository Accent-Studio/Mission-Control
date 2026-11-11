// Plain chats: conversations with no project and no file tools, like a chat on claude.ai. They all run in CHATS_DIR, so a
// transcript whose folder is CHATS_DIR is a chat (sessions.js lists it under Chats, runs.js resumes it as one).
import fs from 'node:fs';
import path from 'node:path';
import { CHATS_DIR, ROOT } from '../config.js';
import { CHAT_TOOLS } from '../runner/shared.js';

export { CHATS_DIR };

// The system prompt of a chat. It replaces Claude Code's own prompt; the user's CLAUDE.md still applies.
export const CHAT_PROMPT_FILE = path.join(ROOT, 'server', 'prompts', 'chat.md');

// Web search and web pages, allowed without asking; only the user's own settings (not a project's), no MCP servers, no skills.
export const CHAT_FLAGS = ['--tools', CHAT_TOOLS, '--allowedTools', CHAT_TOOLS, '--setting-sources', 'user', '--strict-mcp-config', '--disable-slash-commands', '--system-prompt-file', CHAT_PROMPT_FILE];

const norm = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const CHATS_NORM = norm(CHATS_DIR);

export const isChatDir = (cwd) => !!cwd && norm(cwd) === CHATS_NORM;

export function ensureChatsDir() {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  return CHATS_DIR;
}

// Claude Code keeps a folder's transcripts in ~/.claude/projects/<the folder's path, every character that is not a letter
// or a digit turned into a dash>. Every chat on this computer is in this one folder, whatever path its records name: a
// chat that came from another computer (the hub) or from claude.ai still says where it was written first.
export const CHATS_TRANSCRIPT_DIR = CHATS_DIR.replace(/[^A-Za-z0-9]/g, '-');
export const isChatFolder = (dirName) => typeof dirName === 'string' && dirName.toLowerCase() === CHATS_TRANSCRIPT_DIR.toLowerCase();
