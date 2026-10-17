// Connections: MCP servers (names only, never secrets) and API services (key stored flag only).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR, CLAUDE_HOME, MCP_STARTER_FILE } from '../config.js';
import { run } from '../lib/run.js';
import { cached } from '../lib/cache.js';
import { getServers } from './servers.js';
import { readJson, writeJson } from '../lib/jsonStore.js';

const DEFAULT_SERVICES = [
  { id: 'fal', name: 'fal.ai', docsUrl: 'https://fal.ai/docs' },
  { id: 'wavespeed', name: 'Wavespeed', docsUrl: 'https://wavespeed.ai/docs' },
  { id: 'higgsfield', name: 'Higgsfield', docsUrl: 'https://higgsfield.ai' },
  { id: 'anthropic', name: 'Anthropic API', docsUrl: 'https://docs.anthropic.com' },
  { id: 'openai', name: 'OpenAI', docsUrl: 'https://platform.openai.com/docs' },
].map((s) => ({ ...s, credentialTarget: `MissionControl:${s.id}` }));

const SERVICES_FILE = path.join(DATA_DIR, 'services.json');

// The defaults are written only when there is no file (or a bad one was set aside, see jsonStore.js). A file that could
// not be read right now is left alone: the defaults are shown this once, and the next call reads it again.
export function loadServices() {
  const r = readJson(SERVICES_FILE, 'connections');
  const data = r.value;
  if (data && Array.isArray(data.services)) {
    return data.services.filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && s.id);
  }
  if (r.ok && data === undefined) {
    try {
      writeJson(SERVICES_FILE, { services: DEFAULT_SERVICES });
    } catch {
      // read-only is fine, defaults still work
    }
  }
  return DEFAULT_SERVICES;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    // Never surface the parse error: its message can quote part of the file.
    return null;
  }
}

// Anything that looks like a token (a long run of key characters with a digit in it) is masked.
// Applied to every free-form string that is copied into the output.
export function scrub(value, max = 120) {
  if (typeof value !== 'string') return null;
  const s = value
    .replace(/[A-Za-z][A-Za-z0-9+_-]*:\/\/[^\s/@]*@/g, '') // userinfo in URLs
    .replace(/[A-Za-z0-9_\-+=]{20,}/g, (m) => (/\d/.test(m) ? '[hidden]' : m))
    .replace(/\b(sk|pk|rk|ghp|gho|xox[a-z]|AIza|key|token|secret)[-_][A-Za-z0-9_-]{6,}/gi, '[hidden]');
  return s.length > max ? s.slice(0, max) : s;
}

// Only the program name of a command. Anything with spaces, quotes or "=" after the basename could be
// an embedded argument (for example "npx foo --api-key=sk-123"), so fall back to the first word.
function commandName(command) {
  const safe = /^[A-Za-z0-9._+@-]{1,64}$/;
  const base = path.basename(command.replace(/\\/g, '/'));
  if (safe.test(base)) return base;
  const first = command.trim().split(/\s+/)[0] || '';
  const firstBase = path.basename(first.replace(/\\/g, '/'));
  return safe.test(firstBase) ? firstBase : null;
}

// Reduce one MCP server definition to safe fields only. Never copies env, headers, args, URL paths,
// query strings or userinfo. The output has only: name, type, scope, project, host, command, varCount.
function describe(name, def, scope, project) {
  if (!def || typeof def !== 'object') return null;
  const url = typeof def.url === 'string' ? def.url : null;
  let type = typeof def.type === 'string' ? def.type : url ? 'http' : 'stdio';
  if (!['stdio', 'http', 'sse'].includes(type)) type = url ? 'http' : 'stdio';
  const out = { name: scrub(name, 80) || '(unnamed)', type, scope };
  if (project) out.project = project.slice(0, 200);
  if (url) {
    try {
      // URL.host never includes userinfo, path or query.
      out.host = new URL(url).host.slice(0, 100);
    } catch {
      out.host = null;
    }
  } else if (typeof def.command === 'string') {
    out.command = commandName(def.command);
  }
  out.varCount = def.env && typeof def.env === 'object' ? Object.keys(def.env).length : 0;
  return out;
}

function collect(list, servers, scope, project) {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
  for (const [name, def] of Object.entries(servers)) {
    const d = describe(name, def, scope, project);
    if (d) list.push(d);
  }
}

export function listMcp() {
  const list = [];
  const claudeJson = readJsonFile(path.join(os.homedir(), '.claude.json'));
  if (claudeJson && typeof claudeJson === 'object') {
    collect(list, claudeJson.mcpServers, 'user');
    const projects = claudeJson.projects && typeof claudeJson.projects === 'object' ? claudeJson.projects : {};
    for (const [p, v] of Object.entries(projects)) {
      if (v && typeof v === 'object') collect(list, v.mcpServers, 'project', p);
    }
  }
  const settings = readJsonFile(path.join(CLAUDE_HOME, 'settings.json'));
  if (settings && typeof settings === 'object') collect(list, settings.mcpServers, 'settings');
  addStarterServers(list, claudeJson);
  return list;
}

// Servers in the starter's servers.json that no Claude Code entry starts are listed with scope "not registered",
// so a server that dropped out of .claude.json shows up instead of quietly vanishing.
function addStarterServers(list, claudeJson) {
  if (!MCP_STARTER_FILE) return;
  const starter = readJsonFile(MCP_STARTER_FILE);
  const servers = starter && typeof starter.servers === 'object' && !Array.isArray(starter.servers) ? starter.servers : null;
  if (!servers) return;
  const started = new Set();
  const scan = (defs) => {
    if (!defs || typeof defs !== 'object') return;
    for (const def of Object.values(defs)) {
      if (!def || typeof def.command !== 'string' || !/mcp-starter(\.exe)?$/i.test(def.command)) continue;
      if (Array.isArray(def.args) && typeof def.args[0] === 'string') started.add(def.args[0]);
    }
  };
  if (claudeJson && typeof claudeJson === 'object') {
    scan(claudeJson.mcpServers);
    for (const v of Object.values(claudeJson.projects || {})) if (v && typeof v === 'object') scan(v.mcpServers);
  }
  for (const name of Object.keys(servers)) {
    if (started.has(name)) continue;
    list.push({ name: scrub(name, 80) || '(unnamed)', type: 'stdio', scope: 'not registered', command: 'mcp-starter.exe', varCount: 0 });
  }
}

// Target names from `cmdkey /list`. Only names are read, never values (cmdkey does not print them).
// The label before the colon is localized ("Target:", "Cible :", "Ziel:"), so the parser keys on the
// stable "<Type>:target=<name>" form and falls back to the English label.
export function parseCmdkey(stdout) {
  const targets = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    let m = /^\s*[^:=\r\n]{1,40}?\s*:\s*[A-Za-z]+:target=(.+?)\s*$/.exec(line);
    if (!m) m = /^\s*Target\s*:\s*(.+?)\s*$/i.exec(line);
    if (m) targets.add(m[1].toLowerCase());
  }
  return targets;
}

async function storedTargets() {
  return cached('cmdkey-list', 30000, async () => {
    const r = await run('cmdkey.exe', ['/list'], { timeoutMs: 8000 });
    // null means "could not check", which is different from "nothing stored".
    if (r.code !== 0) return null;
    return parseCmdkey(r.stdout);
  });
}

// A docs link is shown as origin plus path only (no userinfo, query or fragment).
function safeUrl(u) {
  if (typeof u !== 'string') return null;
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
    return x.origin + (x.pathname === '/' ? '' : scrub(x.pathname, 120));
  } catch {
    return null;
  }
}

export async function getConnections() {
  let targets = null;
  try {
    targets = await storedTargets();
  } catch {
    targets = null;
  }
  const services = loadServices().map((s) => ({
    id: s.id,
    name: scrub(s.name, 80),
    docsUrl: safeUrl(s.docsUrl),
    credentialTarget: scrub(String(s.credentialTarget || ''), 80),
    keyStored: targets ? targets.has(String(s.credentialTarget).toLowerCase()) : false,
  }));
  const out = { mcp: listMcp(), services };
  if (!targets) out.keyCheck = 'unavailable';
  return out;
}

export function findService(id) {
  return loadServices().find((s) => s.id === id) || null;
}

// ---- Local apps: ComfyUI ----
// Desktop app default is 8000, the classic server is 8188. MC_COMFY_PORTS is for tests only.
function comfyPorts() {
  const env = String(process.env.MC_COMFY_PORTS || '');
  const list = env.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return list.length ? list : [8000, 8188];
}

async function fetchJson(url, ms = 1000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const GB = 1024 ** 3;
const gb = (n) => Math.round((n / GB) * 10) / 10;

async function probeComfy() {
  for (const port of comfyPorts()) {
    const stats = await fetchJson(`http://127.0.0.1:${port}/system_stats`);
    // A real ComfyUI answers with a "system" object; other things on port 8000 do not.
    if (!stats || typeof stats !== 'object' || !stats.system || typeof stats.system !== 'object') continue;
    const queue = await fetchJson(`http://127.0.0.1:${port}/queue`);
    const dev = Array.isArray(stats.devices) ? stats.devices.find((d) => d && d.vram_total > 0) || stats.devices[0] : null;
    const total = dev && Number(dev.vram_total) > 0 ? Number(dev.vram_total) : 0;
    const free = dev && Number(dev.vram_free) >= 0 ? Number(dev.vram_free) : 0;
    const count = (a) => (Array.isArray(a) ? a.length : 0);
    let process_ = null;
    try {
      const row = (await getServers({ all: true })).find((x) => x.port === port);
      if (row) process_ = { pid: row.pid, name: row.name || null };
    } catch {
      process_ = null;
    }
    return {
      id: 'comfyui',
      name: 'ComfyUI',
      running: true,
      port,
      version: typeof stats.system.comfyui_version === 'string' ? scrub(stats.system.comfyui_version, 40) : null,
      python: typeof stats.system.python_version === 'string' ? scrub(stats.system.python_version.split(' ')[0], 20) : null,
      vramUsedGB: total ? gb(total - free) : null,
      vramTotalGB: total ? gb(total) : null,
      queue: queue ? { running: count(queue.queue_running), pending: count(queue.queue_pending) } : null,
      process: process_,
    };
  }
  return { id: 'comfyui', name: 'ComfyUI', running: false, port: null, version: null, vramUsedGB: null, vramTotalGB: null, queue: null, process: null };
}

export function getComfy() {
  return cached('comfy-probe', 5000, probeComfy);
}

export async function getLocalApps() {
  return [await getComfy()];
}
