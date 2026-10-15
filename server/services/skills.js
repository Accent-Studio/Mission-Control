// Skills: global (~/.claude/skills), project (<folder>/.claude/skills) and plugin skills.
// Only the YAML frontmatter name and description are read.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME } from '../config.js';
import { cached } from '../lib/cache.js';

const HEAD_BYTES = 16 * 1024;

function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  return v;
}

// Small frontmatter parser: handles plain, quoted, folded (>) and literal (|) scalars.
export function parseFrontmatter(text) {
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return {};
  const end = t.indexOf('\n---', 4);
  if (end < 0) return {};
  const lines = t.slice(4, end).split('\n');
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    const block = /^([>|])[+-]?$/.exec(val.trim());
    const parts = [];
    let j = i + 1;
    while (j < lines.length && (lines[j].startsWith(' ') || lines[j].startsWith('\t') || lines[j] === '')) {
      parts.push(lines[j].trim());
      j++;
    }
    if (block) {
      val = block[1] === '>' ? parts.join(' ') : parts.join('\n');
    } else if (parts.length) {
      val = unquote([val, ...parts].join(' '));
    } else {
      val = unquote(val);
    }
    out[key] = val.replace(/\s+/g, ' ').trim();
    i = j - 1;
  }
  return out;
}

function readSkillFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      return parseFrontmatter(buf.subarray(0, n).toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function skillsIn(dir, scope, extra = {}) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of names) {
    const fm = readSkillFile(path.join(dir, d.name, 'SKILL.md'));
    if (!fm) continue;
    out.push({ name: fm.name || d.name, description: fm.description || '', scope, ...extra });
  }
  return out;
}

// Plugin skills live at plugins/synced/<id>/<plugin>/skills/<skill>/SKILL.md
function pluginSkills() {
  const out = [];
  const synced = path.join(CLAUDE_HOME, 'plugins', 'synced');
  let ids = [];
  try {
    ids = fs.readdirSync(synced, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  const seen = new Set();
  for (const id of ids) {
    let plugins = [];
    try {
      plugins = fs.readdirSync(path.join(synced, id.name), { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const p of plugins) {
      for (const s of skillsIn(path.join(synced, id.name, p.name, 'skills'), 'plugin', { plugin: p.name })) {
        const key = `${p.name}:${s.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
      }
    }
  }
  return out;
}

const byName = (a, b) => a.name.localeCompare(b.name);

// projectFolder is optional; when given, that project's own skills are included.
export async function listSkills(projectFolder = null) {
  const base = await cached('skills:base', 30000, async () => [
    ...skillsIn(path.join(CLAUDE_HOME, 'skills'), 'global').sort(byName),
    ...pluginSkills().sort(byName),
  ]);
  if (!projectFolder) return base;
  const own = skillsIn(path.join(projectFolder, '.claude', 'skills'), 'project').sort(byName);
  return [...base.filter((s) => s.scope === 'global'), ...own, ...base.filter((s) => s.scope === 'plugin')];
}
