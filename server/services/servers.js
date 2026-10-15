// Listening TCP ports joined to process info and catalog projects.
import { run } from '../lib/run.js';
import { cached } from '../lib/cache.js';
import { loadCatalog } from './catalog.js';
import { getProcesses } from './system.js';

const HIDDEN_NAMES = new Set(['svchost', 'system', 'lsass', 'wininit', 'services', 'spoolsv']);
const HIDDEN_PORTS = new Set([135, 139, 445, 5040, 7680]);
const DEV_PORTS = new Set([1420, 3000, 3001, 4000, 4173, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000, 11434]);

const base = (n) => String(n || '').toLowerCase().replace(/\.exe$/, '');

function parseNetstat(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    // The state word is localized (ECOUTE on French Windows), so a listener is recognized by its
    // foreign address ending in :0 instead.
    if (parts.length < 5 || parts[0] !== 'TCP' || !/:0$/.test(parts[2])) continue;
    const local = parts[1];
    const i = local.lastIndexOf(':');
    const port = Number(local.slice(i + 1));
    const pid = Number(parts[4]);
    if (!Number.isInteger(port) || !Number.isInteger(pid)) continue;
    out.push({ port, address: local.slice(0, i).replace(/^\[|\]$/g, ''), pid });
  }
  return out;
}

export function listening() {
  return cached('listening', 5000, async () => {
    const [v4, v6] = await Promise.all([
      run('netstat', ['-ano', '-p', 'tcp'], { timeoutMs: 10000 }),
      run('netstat', ['-ano', '-p', 'tcpv6'], { timeoutMs: 10000 }),
    ]);
    const seen = new Set();
    const rows = [];
    for (const r of [...parseNetstat(v4.stdout), ...parseNetstat(v6.stdout)]) {
      const key = `${r.port}:${r.pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
    return rows;
  });
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\//g, '\\');
}

function findProject(projects, text) {
  const hay = norm(text);
  let best = null;
  for (const p of projects) {
    if (!p.folder) continue;
    const f = norm(p.folder).replace(/\\+$/, '');
    if (!f) continue;
    if (hay.includes(f + '\\') || hay.endsWith(f) || hay.includes(f + '"') || hay.includes(f + ' ')) {
      if (!best || f.length > norm(best.folder).length) best = p;
    }
  }
  return best ? best.id : null;
}

function kindOf(name, cmd, exe) {
  const n = base(name);
  const c = norm(cmd);
  const e = norm(exe);
  if (n === 'ollama' || n === 'ollama app' || n.startsWith('ollama')) return 'ollama';
  if (/\bvite\b/.test(c)) return 'vite';
  if (n === 'node' || n === 'nodejs' || n === 'npm' || n === 'bun' || n === 'deno') return 'node';
  if (n === 'python' || n === 'pythonw' || n === 'py' || n.startsWith('python')) return 'python';
  if (e.includes('\\target\\debug\\') || e.includes('\\target\\release\\') || n === 'cargo' || /(^|\\)cargo(\.exe)?\b/.test(c)) {
    return 'rust';
  }
  return 'other';
}

export async function getServers({ all = false } = {}) {
  const [rows, procs] = await Promise.all([listening(), getProcesses()]);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const projects = loadCatalog();
  const out = [];
  for (const r of rows) {
    const p = byPid.get(r.pid);
    const name = p ? p.name : r.pid === 4 ? 'System' : '';
    const hidden = HIDDEN_NAMES.has(base(name)) || HIDDEN_PORTS.has(r.port) || r.pid === 0;
    if (hidden && !all) continue;
    const isSelf = r.pid === process.pid;
    const kind = kindOf(name, p && p.commandLine, p && p.exe);
    let project = p ? findProject(projects, `${p.commandLine || ''} ${p.exe || ''}`) : null;
    if (isSelf) project = 'mission-control';
    out.push({
      port: r.port,
      address: r.address,
      pid: r.pid,
      name,
      commandLine: p ? p.commandLine : null,
      startedAt: p ? p.startedAt : null,
      project,
      kind,
      isDev: !hidden && (kind !== 'other' || project !== null || DEV_PORTS.has(r.port)),
      isSelf,
    });
  }
  return out.sort((a, b) => a.port - b.port);
}
