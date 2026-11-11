// Local models: what the server (services/localModels.js) and the gate (llmgate/index.js) agree on.
//
// A model comes from "localModels" in .data/config.json:
//   { "id": "qwen3.8-27b", "label": "Qwen 3.8 27B", "server": "<llama-server.exe>", "model": "<file.gguf>",
//     "port": 8080, "ctx": 131072, "args": ["-ngl", "99", "-fa", "on"], "idleSec": 600, "vramTargetMB": 15360 }
// "ctx" is the most context it gets: it starts with as much as fits under vramTargetMB on the card (lib/vramFit.js).
// Only the entries that pass these checks are offered.
import fs from 'node:fs';
import path from 'node:path';
import { ELECTRICITY, LOCAL_MODELS, LOCAL_MODELS_DIR } from '../config.js';

// The efforts a local model offers, and what each one asks of the model's thinking. budget: tokens of thinking before
// it must answer (-1 = no limit, 0 = no thinking at all). Highest first, as the menus show them.
export const LOCAL_EFFORTS = [
  { id: 'xhigh', label: 'Extra high', budget: -1 },
  { id: 'medium', label: 'Medium', budget: 4096 },
  { id: 'low', label: 'Low', budget: 1024 },
  { id: 'none', label: 'No reasoning', budget: 0 },
];
export const LOCAL_DEFAULT_EFFORT = 'medium';

// A Claude effort (an older page, a saved Com Link choice) read as the nearest local one.
export function localEffort(effort) {
  if (LOCAL_EFFORTS.some((e) => e.id === effort)) return effort;
  if (effort === 'high' || effort === 'max') return 'xhigh';
  return LOCAL_DEFAULT_EFFORT;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,60}$/i;
const int = (v, d, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : d);
const absFile = (p) => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0');

function normalize(m) {
  if (!ID.test(m.id || '') || /^claude-/i.test(m.id) || !absFile(m.server) || !absFile(m.model)) return null;
  return {
    id: m.id,
    label: typeof m.label === 'string' && m.label.trim() ? m.label.trim().slice(0, 40) : m.id,
    server: m.server,
    model: m.model,
    port: int(m.port, 8080, 1, 65535),
    ctx: int(m.ctx, 32768, 2048, 1048576),
    args: Array.isArray(m.args) ? m.args.filter((a) => typeof a === 'string' && !a.includes('\0')).slice(0, 64) : [],
    idleSec: int(m.idleSec, 600, 0, 86400),
    vramTargetMB: int(m.vramTargetMB, 15360, 2048, 1048576),
    sampling: m.sampling && typeof m.sampling === 'object' && !Array.isArray(m.sampling) ? m.sampling : null,
  };
}

const MODELS = LOCAL_MODELS.map(normalize).filter(Boolean).filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);

export const localModels = () => MODELS;
export const localModel = (id) => MODELS.find((m) => m.id === id) || null;
export const isLocalModel = (id) => typeof id === 'string' && !!localModel(id);

// ---- Tools on demand ----
// A local model starts with the core tools only. Every other tool (the rest of Claude Code's, and every MCP server's) is
// listed by group in its system prompt; it reads a group with Mission Control's tools_list and adds tools with tools_load.
// The gate sees which tools a conversation loaded in its own history (the tools_load calls), so nothing is stored.
export const CORE_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
export const LOAD_TOOLS = ['mcp__mc__tools_list', 'mcp__mc__tools_load'];
export const NEVER_TOOLS = ['WebSearch']; // runs on Anthropic's side: a local model cannot use it
export const BIG_GROUP = 12; // a group this size or smaller loads whole by its name; a bigger one tool by tool

// "mcp__blender__render" is in group "blender"; a built-in tool such as "Agent" in group "extra".
const WEB = ['WebFetch', 'mcp__mc__web_search'];
export const groupOf = (name) => { if (WEB.includes(name)) return 'web'; const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name); return m ? m[1] : 'extra'; };

// The first sentence of a description, at most 110 characters.
export function summaryOf(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const cut = /^(.{20,110}?[.!?])(\s|$)/.exec(s);
  return cut ? cut[1] : s.length > 110 ? s.slice(0, 107) + '...' : s;
}

// The tool names that a list of names and group names asks for. catalog: { name: summary }. Returns { names, refused }.
export function expandLoad(asked, catalog) {
  const names = new Set();
  const refused = [];
  const all = Object.keys(catalog);
  for (const a of Array.isArray(asked) ? asked : []) {
    if (typeof a !== 'string') continue;
    if (catalog[a] !== undefined) names.add(a);
    else {
      const members = all.filter((n) => groupOf(n) === a);
      if (members.length && members.length <= BIG_GROUP) members.forEach((n) => names.add(n));
      else refused.push(a);
    }
  }
  return { names: [...names], refused };
}

// ---- Electricity ----
// The gate measures the energy of each answer (the graphics card's draw, sampled, plus ELECTRICITY.otherWatts for the rest
// of the PC), split into reading the prompt and writing the answer, and adds it up per model in ENERGY_FILE:
//   { "<model id>": { "promptTok", "promptJ", "outTok", "outJ", "requests" } }
// The Usage page prices a local model's tokens with these averages, as an API price would.
export const ENERGY_FILE = path.join(LOCAL_MODELS_DIR, 'energy.json');
// Before anything is measured: about 100Wh per million tokens read and 4kWh per million written (a 27B model on one card).
const GUESS = { promptJPerTok: 0.36, outJPerTok: 14.4 };

let energyCache = { mtime: -1, data: {} };
export function energyTotals() {
  try {
    const st = fs.statSync(ENERGY_FILE);
    if (st.mtimeMs !== energyCache.mtime) energyCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(ENERGY_FILE, 'utf8')) || {} };
  } catch {
    energyCache = { mtime: -1, data: {} };
  }
  return energyCache.data;
}

// Dollars per million tokens for a local model, from its measured energy: { in, out, cacheRead, cacheWrite5m, cacheWrite1h }.
// Tokens read from llama.cpp's cache cost nothing; nothing is written to a cache that costs extra.
export function localPrice(id) {
  const e = energyTotals()[id] || {};
  const inJ = e.promptTok > 1000 ? e.promptJ / e.promptTok : GUESS.promptJPerTok;
  const outJ = e.outTok > 100 ? e.outJ / e.outTok : GUESS.outJPerTok;
  const dollarsPerJ = ELECTRICITY.pricePerKWh / ELECTRICITY.perDollar / 3.6e6;
  const inP = inJ * 1e6 * dollarsPerJ;
  return { in: inP, out: outJ * 1e6 * dollarsPerJ, cacheRead: 0, cacheWrite5m: inP, cacheWrite1h: inP };
}
