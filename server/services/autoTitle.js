// Gives a conversation started in Mission Control a short name from its first message, the way the Claude desktop app
// names its own. One small `claude -p` call per new conversation: the newest Haiku, its own two-line system prompt, no
// tools, no MCP servers, no settings, nothing saved to the history, so it costs a few hundred tokens and never shows up as
// a conversation itself. The project name is left out (the list shows it as a tag); when the name needs it to make
// sense, the project's short form is used (Mission Control is MC, MetaHuman Optimizer is MHO).
// The name is stored as autoTitle in .data/sessions-meta.json, once; a rename of my own always wins over it.
// Off when MC_AUTO_TITLE=off (the tests turn it off unless they test it).
import { spawn, execFile } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { resolveClaude } from '../lib/claudeExe.js';
import { publish } from '../lib/events.js';
import { loadCatalog, getProject } from './catalog.js';
import { getMeta, setAutoTitle } from './sessionMeta.js';

const TIMEOUT_MS = 60000;
const MAX_QUEUE = 8;
const PROMPT_MAX = 1500;
const queue = [];
let busy = false;
const asked = new Set(); // session ids already queued in this server's life

// "Mission Control" -> "MC", "MetaHuman Optimizer" -> "MHO", "Comfy-N-Chill" -> "CNC"
export function acronym(name) {
  const parts = String(name || '').split(/[\s\-_.]+/).filter(Boolean);
  let out = '';
  for (const p of parts) {
    const caps = p.match(/[A-Z0-9]/g);
    out += caps && /^[A-Z0-9]/.test(p) && caps.length > 1 && caps.length < p.length ? caps.join('') : p[0].toUpperCase();
  }
  return out.slice(0, 6);
}

function systemPrompt() {
  const known = (loadCatalog().projects || []).map((p) => `${p.name} = ${acronym(p.name)}`).slice(0, 60).join(', ');
  return (
    'You name a conversation for a list of conversations. Answer with the name only: 2 to 6 words that say what the first ' +
    'message asks for, sentence case, American English, no quotes, no period, no emoji. Leave the project name out, the ' +
    'list already shows it. Only if the name would be unclear without it, use the short form of a project instead: ' +
    (known || 'none known') +
    '.'
  );
}

// The model's answer as one clean name, or '' when it is not usable.
export function cleanTitle(text) {
  let t = String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  t = t.replace(/^(title|name)\s*:\s*/i, '').replace(/^["'`*]+|["'`*]+$/g, '').replace(/[.!?:;,]+$/, '').replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z]/.test(t) || t.length > 80) return '';
  return t.slice(0, 60);
}

function killTree(child) {
  if (!child || !child.pid) return;
  execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => {});
}

function haiku() {
  return import('./sessions.js')
    .then((m) => {
      const h = (m.catalogModels() || []).find((x) => x.family === 'haiku');
      return h ? h.id : 'haiku';
    })
    .catch(() => 'haiku');
}

async function nameOne({ sessionId, prompt, projectId }) {
  const entry = await resolveClaude();
  const model = await haiku();
  const p = projectId ? getProject(projectId) : null;
  const input = (p ? `Project: ${p.name} (${acronym(p.name)})\n\n` : '') + 'First message:\n' + prompt.slice(0, PROMPT_MAX);
  const args = [...entry.pre, '-p', '--model', model, '--output-format', 'text', '--no-session-persistence', '--tools=', '--strict-mcp-config', '--setting-sources=', '--disable-slash-commands', '--system-prompt', systemPrompt()];
  const text = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(entry.cmd, args, { cwd: DATA_DIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      return reject(err);
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error('no answer within 60s'));
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      if (out.length < 4000) out += c;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      err = (err + c).slice(-300);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}${err.trim() ? ': ' + err.trim().slice(-120) : ''}`));
    });
    child.stdin.end(input);
  });
  const t = cleanTitle(text);
  if (t && setAutoTitle(sessionId, t)) publish('sessions.changed', { id: sessionId });
}

async function drain() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        await nameOne(job);
      } catch (err) {
        console.error('[autotitle] could not name', job.sessionId + ':', String(err.message).slice(0, 160));
      }
    }
  } finally {
    busy = false;
  }
}

// Called once a new conversation has its id. Skips anything already named or renamed, and an empty first message.
export function nameConversation(sessionId, prompt, projectId) {
  if (process.env.MC_AUTO_TITLE === 'off') return;
  const id = String(sessionId || '').toLowerCase();
  const text = String(prompt || '').trim();
  if (!id || !text || asked.has(id) || queue.length >= MAX_QUEUE) return;
  const m = getMeta(id);
  if (m && (m.title || m.autoTitle)) return;
  asked.add(id);
  if (asked.size > 500) asked.delete(asked.values().next().value);
  queue.push({ sessionId: id, prompt: text, projectId: projectId || null });
  drain();
}
