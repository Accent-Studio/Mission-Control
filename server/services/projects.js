// Projects: catalog plus live status from git and file dates. Read only.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getProject, loadCatalog } from './catalog.js';
import * as git from './git.js';
import { clientCount, publish } from '../lib/events.js';

const TTL_MS = 15000;
// File systems that round to two seconds would otherwise make a fresh build look older.
const TOLERANCE_MS = 2000;
// An installed program is compared with the build it came from, never exactly.
const SAME_BUILD_MS = 600000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.data', '.astro', '.venv', '__pycache__',
  'venv', 'python_embeded', 'models', 'output', 'input', 'temp', '.cache', 'custom_nodes']);
// custom_nodes is skipped unless the project itself lives inside one.
const skipDir = (name, parent) => SKIP_DIRS.has(name) && !(name === 'custom_nodes' && /[\\/]custom_nodes([\\/]|$)/i.test(parent));

// Stale-while-revalidate cache. A value younger than TTL_MS is served as is. An older one (up to STALE_MS)
// is served at once while one refresh runs in the background, so the page never waits on git after the
// first load. { fresh: true } skips the stale answer and waits for the new value.
const STALE_MS = 600000;
const store = new Map();
function memo(key, fn, { fresh = false } = {}) {
  let e = store.get(key);
  if (!e) store.set(key, (e = { has: false, value: undefined, at: 0, pending: null }));
  const age = Date.now() - e.at;
  if (e.has && age < TTL_MS) return Promise.resolve(e.value);
  if (!e.pending) {
    const entry = e;
    entry.pending = Promise.resolve()
      .then(fn)
      .then((v) => {
        entry.value = v;
        entry.has = true;
        entry.at = Date.now();
        return v;
      })
      .finally(() => {
        entry.pending = null;
      });
    entry.pending.catch(() => {});
  }
  if (!fresh && e.has && age < STALE_MS) return Promise.resolve(e.value);
  return e.pending;
}

export function clearCache() {
  store.clear();
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

function expandEnv(s) {
  return String(s || '').replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function mtimeMs(p) {
  try {
    return (await fs.promises.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

// ---- Artifacts (a path, or a path with * and ? wildcards in any segment) ----

function wildcardRegex(seg) {
  const esc = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

async function expandGlob(pattern) {
  const parts = path.normalize(pattern).split(path.sep);
  let bases = [parts[0] + path.sep];
  if (!/^[A-Za-z]:$/.test(parts[0])) bases = [parts[0] === '' ? path.sep : parts[0]];
  for (const seg of parts.slice(1)) {
    const next = [];
    for (const base of bases) {
      if (/[*?]/.test(seg)) {
        let names = [];
        try {
          names = await fs.promises.readdir(base);
        } catch {
          continue;
        }
        const re = wildcardRegex(seg);
        for (const n of names) if (re.test(n)) next.push(path.join(base, n));
      } else {
        next.push(path.join(base, seg));
      }
    }
    bases = next;
  }
  return bases;
}

// First candidate that exists, with its date. A pattern gives its newest file match.
async function findArtifact(folder, candidates) {
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const full = path.resolve(folder, expandEnv(raw));
    if (/[*?]/.test(full)) {
      let best = null;
      for (const p of await expandGlob(full)) {
        try {
          const st = await fs.promises.stat(p);
          if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { path: p, mtimeMs: st.mtimeMs };
        } catch {
          /* missing */
        }
      }
      if (best) return best;
    } else {
      const t = await mtimeMs(full);
      if (t != null) return { path: full, mtimeMs: t };
    }
  }
  return null;
}

// ---- Source dates ----

async function walkFiles(dir, out, budget, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.n <= 0) return;
    if (e.isDirectory()) {
      if (!skipDir(e.name, dir)) await walkFiles(path.join(dir, e.name), out, budget, depth + 1);
    } else {
      budget.n--;
      out.push(path.join(dir, e.name));
    }
  }
}

async function statAll(files) {
  const times = [];
  for (let i = 0; i < files.length; i += 200) {
    const chunk = await Promise.all(files.slice(i, i + 200).map(mtimeMs));
    for (const t of chunk) if (t != null) times.push(t);
  }
  return times;
}

// Source dates for a watch list, sorted newest first. Shared per probe through `ctx`.
function sourceDates(ctx, watch) {
  const key = JSON.stringify(watch);
  if (!ctx.dates.has(key)) {
    ctx.dates.set(
      key,
      (async () => {
        let files = null;
        if (ctx.repo) files = await git.sourceFiles(ctx.folder, watch);
        if (files === null) {
          files = [];
          await walkFiles(ctx.folder, files, { n: 50000 });
        }
        const times = await statAll(files);
        return times.sort((a, b) => b - a);
      })(),
    );
  }
  return ctx.dates.get(key);
}

function commitTime(ctx, watch) {
  const key = JSON.stringify(watch);
  if (!ctx.commits.has(key)) {
    ctx.commits.set(
      key,
      ctx.repo
        ? git.lastCommit(ctx.folder, watch).then((c) => (c ? Date.parse(c.date) : null))
        : Promise.resolve(null),
    );
  }
  return ctx.commits.get(key);
}

// ---- Checks ----

const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

function result(state, detail, artifact, built, newestSource, newer) {
  return {
    state,
    detail,
    artifact: artifact ? artifact.path : null,
    artifactTime: iso(built),
    newestSourceTime: iso(newestSource),
    newerFiles: newer,
  };
}

// state: "fresh" | "stale" | "missing" (not built yet) | "none" (no build step)
async function judgeCheck(ctx, check, found) {
  const artifact = found.get(check.key) || null;
  const candidates = (Array.isArray(check.artifact) ? check.artifact : []).filter((a) => typeof a === 'string' && a.trim());
  if (!candidates.length) return result('none', 'no build step', null, null, null, 0);
  if (!artifact) return result('missing', 'not built', null, null, null, 0);

  const built = artifact.mtimeMs;
  const against = String(check.against || '').trim();
  const watch = [check.watch, ctx.project.watch].find((w) => Array.isArray(w) && w.length) || [];

  if (against.startsWith('check:')) {
    const ref = found.get(against.slice(6));
    if (!ref) return result('fresh', 'no build to compare with', artifact, built, null, 0);
    if (built + SAME_BUILD_MS >= ref.mtimeMs) {
      return result('fresh', 'matches the build it came from', artifact, built, ref.mtimeMs, 0);
    }
    return result('stale', 'a newer build is waiting', artifact, built, ref.mtimeMs, 0);
  }
  if (against.startsWith('path:')) {
    const ref = await findArtifact(ctx.folder, [against.slice(5)]);
    if (!ref) return result('fresh', 'nothing to compare with', artifact, built, null, 0);
    if (built + SAME_BUILD_MS >= ref.mtimeMs) {
      return result('fresh', 'matches the latest build', artifact, built, ref.mtimeMs, 0);
    }
    return result('stale', 'a newer build is waiting', artifact, built, ref.mtimeMs, 0);
  }
  if (against === 'commit') {
    const c = await commitTime(ctx, watch);
    if (c == null) return result('fresh', 'no commit to compare with', artifact, built, null, 0);
    if (built + TOLERANCE_MS >= c) return result('fresh', 'has the last commit', artifact, built, c, 0);
    return result('stale', 'made before the last commit', artifact, built, c, 0);
  }

  const dates = await sourceDates(ctx, watch);
  const newest = dates.length ? dates[0] : null;
  let newer = 0;
  for (const t of dates) {
    if (t > built + TOLERANCE_MS) newer++;
    else break;
  }
  if (newer === 0) return result('fresh', 'newer than every source file', artifact, built, newest, 0);
  return result('stale', `${plural(newer, 'file', 'files')} changed since`, artifact, built, newest, newer);
}

// The main check decides the project's build state: the check with key "exe", else the first check that has
// an artifact. Dev, installer or Mac builds that lag behind are listed in `attention`, not folded into `build`.
function mainCheckOf(checks) {
  return checks.find((c) => c.key === 'exe' && c.state !== 'none') || checks.find((c) => c.state !== 'none') || null;
}

// Custom rule: any check flagged `required` in the catalog decides the build state (stale if any required
// check is stale). With no flags at all, the default rule uses the main check alone.
function summarizeBuild(checks, project) {
  const flagged = (project.checks || []).some((c) => typeof c.required === 'boolean');
  let req;
  if (flagged) {
    const keys = new Set((project.checks || []).filter((c) => c.required === true).map((c) => c.key));
    req = checks.filter((c) => keys.has(c.key) && c.state !== 'none');
  } else {
    const main = mainCheckOf(checks);
    req = main ? [main] : [];
  }
  let build = 'unknown';
  if (req.some((c) => c.state === 'stale')) build = 'stale';
  else if (req.length && req.every((c) => c.state === 'fresh')) build = 'fresh';
  const attention = checks
    .filter((c) => !req.includes(c) && c.state === 'stale')
    .map((c) => ({ key: c.key, label: c.label, state: c.state }));
  return {
    build,
    mainCheck: req.length ? req[0].key : null,
    required: req.map((c) => c.key),
    requiredSource: flagged ? 'custom' : 'default',
    attention,
  };
}

// ---- Probe: quick status plus checks, cached per project ----

function failedProbe(project, err) {
  return {
    id: project.id,
    name: project.name,
    folder: project.folder,
    about: project.about || '',
    exists: isDir(project.folder),
    isRepo: false,
    branch: null,
    dirty: null,
    ahead: null,
    behind: null,
    remote: null,
    lastCommit: null,
    build: 'unknown',
    mainCheck: null,
    required: [],
    requiredSource: 'default',
    attention: [],
    checks: [],
    error: String((err && err.message) || err),
  };
}

async function probeUncached(project) {
  const folder = project.folder;
  const base = {
    id: project.id,
    name: project.name,
    folder,
    about: project.about || '',
    exists: isDir(folder),
    isRepo: false,
    branch: null,
    dirty: null,
    ahead: null,
    behind: null,
    remote: null,
    lastCommit: null,
    build: 'unknown',
    mainCheck: null,
    required: [],
    requiredSource: 'default',
    attention: [],
    checks: [],
  };
  const emptyChecks = (project.checks || []).map((c) => ({
    key: c.key,
    label: c.label,
    required: c.required === true,
    state: 'missing',
    detail: 'folder missing',
    artifact: null,
    artifactTime: null,
    newestSourceTime: null,
    newerFiles: 0,
  }));
  if (!base.exists) return { ...base, checks: emptyChecks };

  const repo = git.isRepo(folder);
  base.isRepo = repo;
  const ctx = { project, folder, repo, dates: new Map(), commits: new Map() };

  const gitPart = repo
    ? (async () => {
        const [st, last] = await Promise.all([git.status(folder), git.lastCommit(folder)]);
        const ab = await git.aheadBehind(folder, project.remote, st);
        return { st, last, ab };
      })()
    : Promise.resolve(null);

  const checksPart = (async () => {
    const list = project.checks || [];
    const entries = await Promise.all(list.map(async (c) => [c.key, await findArtifact(folder, c.artifact)]));
    const found = new Map(entries);
    return Promise.all(
      list.map(async (c) => ({ key: c.key, label: c.label, required: c.required === true, ...(await judgeCheck(ctx, c, found)) })),
    );
  })();

  const [g, checks] = await Promise.all([gitPart, checksPart]);
  if (g) {
    base.branch = g.st ? g.st.branch : null;
    base.dirty = g.st ? g.st.dirty : null;
    if (g.ab) {
      base.ahead = g.ab.ahead;
      base.behind = g.ab.behind;
      base.remote = g.ab.remote;
    }
    if (g.last) base.lastCommit = { hash: g.last.hash, subject: g.last.subject, date: g.last.date };
  }
  base.checks = inheritStale(checks, project);
  Object.assign(base, summarizeBuild(base.checks, project));
  return base;
}

// A check judged against another check ("check:exe") only says it matches that build. If that build is itself
// behind the source, so is this one: an app installed from an old build is old too.
function inheritStale(checks, project) {
  const byKey = new Map(checks.map((c) => [c.key, c]));
  return checks.map((c) => {
    const def = (project.checks || []).find((d) => d.key === c.key);
    const against = String((def && def.against) || '').trim();
    if (!against.startsWith('check:')) return c;
    const ref = byKey.get(against.slice(6));
    if (!ref || (ref.state !== 'stale' && ref.state !== 'missing')) return c;
    // `waitsFor`: rebuilding the other check comes first (installing now would install the old build again).
    return { ...c, state: c.state === 'missing' ? 'missing' : 'stale', detail: c.state === 'missing' ? c.detail : 'from an old build', waitsFor: ref.key };
  });
}

// One broken project (bad catalog entry, odd folder) must not take the whole list down.
function probe(project, opts) {
  return memo(`projects:probe:${project.id}`, async () => {
    try {
      return await probeUncached(project);
    } catch (err) {
      console.error(`[projects] probe failed for ${project.id}:`, err);
      return failedProbe(project, err);
    }
  }, opts);
}

// ---- Background warm-up and refresh ----

const REFRESH_MS = 60000;
let lastSnapshot = null;
let warmup = null;

// Starts the first probe of every project without delaying the caller. Requests that arrive meanwhile share
// the same per-project promises (see memo), so no second warm-up starts.
export function warmProjects() {
  if (!warmup) {
    warmup = listProjects({ all: true })
      .then((list) => {
        lastSnapshot = JSON.stringify(list);
        return list;
      })
      .catch((err) => console.error('[projects] warm-up failed:', err));
  }
  return warmup;
}

async function refreshInBackground() {
  if (clientCount() === 0) return;
  try {
    const list = await Promise.all(loadCatalog().map(async (p) => decorate(await probe(p, { fresh: true }), p)));
    const snap = JSON.stringify(list);
    if (lastSnapshot !== null && snap !== lastSnapshot) publish('projects.changed', {});
    lastSnapshot = snap;
  } catch (err) {
    console.error('[projects] background refresh failed:', err);
  }
}

export function startProjectsBackground() {
  warmProjects();
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await refreshInBackground();
    } finally {
      running = false;
    }
  }, REFRESH_MS).unref();
}

// Docs and screenshots are listed by library.js (the Docs and Screenshots tabs ask for them when they open).

// ---- Open the installed app ----

// An "installed" check whose launch is "@artifact" describes an installed program. Its exe comes only from
// that check's own artifact list (never from request text). Returns null when the check is not an
// installed-app check, { exe: null } when it is not installed, else { exe }.
function installedExe(check) {
  const l = check && check.launch;
  if (!check || check.key !== 'installed' || !l || String(l.run || '').trim() !== '@artifact') return null;
  for (const raw of Array.isArray(check.artifact) ? check.artifact : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const full = expandEnv(raw.trim());
    if (full.includes('%') || /[*?]/.test(full)) continue;
    if (!/^[A-Za-z]:[\\/]/.test(full) || path.extname(full).toLowerCase() !== '.exe') continue;
    try {
      if (fs.statSync(full).isFile()) return { exe: path.normalize(full) };
    } catch {
      /* not there */
    }
  }
  return { exe: null };
}

// Adds launch: { available, installed, label } to installed-app checks. No path is exposed.
function withLaunch(probed, project) {
  const byKey = new Map((project.checks || []).map((c) => [c.key, c]));
  const checks = (probed.checks || []).map((c) => {
    const info = installedExe(byKey.get(c.key));
    if (!info) return c;
    return { ...c, launch: { available: true, installed: info.exe !== null, label: `Open ${project.name}` } };
  });
  return { ...probed, checks };
}

const lastLaunch = new Map();
const LAUNCH_GUARD_MS = 3000;

// Returns { status, body }. 404 unknown project or not launchable, 409 not installed.
export function launchInstalled(id, key) {
  const project = getProject(id);
  const check = project && (project.checks || []).find((c) => c.key === key);
  const info = installedExe(check);
  if (!info) return { status: 404, body: { error: 'Unknown project or check' } };
  if (!info.exe) return { status: 409, body: { error: 'Not installed: build and install it first' } };
  const guard = `${id}:${key}`;
  const now = Date.now();
  if (now - (lastLaunch.get(guard) || 0) < LAUNCH_GUARD_MS) return { status: 200, body: { ok: true, ignored: true } };
  lastLaunch.set(guard, now);
  try {
    const child = spawn(info.exe, [], { cwd: path.dirname(info.exe), detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    child.once('error', () => {});
    child.unref();
    return { status: 200, body: { ok: true, pid: child.pid } };
  } catch {
    lastLaunch.delete(guard);
    return { status: 500, body: { error: 'Could not open the app' } };
  }
}

// ---- Public API ----

// Jobs and the hidden flag come from the catalog on every call (not from the cached probe), so a saved
// settings change shows at once.
function decorate(probed, project) {
  const launched = withLaunch(probed, project);
  const checks = (launched.checks || []).map((c) => ({ ...c, line: shortLine(c), fix: fixOf(project, c.key) }));
  return { ...launched, checks, jobs: project.jobs || [], hidden: project.hidden === true, ...needsOf(probed) };
}

// One short line per check for the Status panel. The state word itself is shown by the page, so this only says why.
function shortLine(c) {
  if (c.state === 'fresh') return 'up to date';
  if (c.state === 'missing') return 'not built yet';
  if (c.state === 'none') return 'no build step';
  const d = String(c.detail || '');
  let m = d.match(/^(\d+) files? changed since$/);
  if (m) return `${m[1]} file${m[1] === '1' ? '' : 's'} newer`;
  if (d === 'made before the last commit') return 'before the last commit';
  if (d === 'a newer build is waiting') return 'not the latest build';
  if (d === 'from an old build') return 'old build';
  return d || 'out of date';
}

// The button that brings a check up to date: the check's own build step from the catalog. Label, window and
// outward flags come from a tracked job that runs the same script (when there is one), so both agree.
const FIX_LABELS = { dev: 'Run dev', exe: 'Build', installed: 'Install', installer: 'Build installer', mac: 'Build Mac' };
export function fixOf(project, key) {
  const def = (project.checks || []).find((d) => d.key === key);
  const run = def && def.build && typeof def.build.run === 'string' ? def.build.run.trim() : '';
  if (!run) return null;
  const args = def.build && typeof def.build.args === 'string' ? def.build.args.trim() : '';
  // Match the job that runs the very same script, in this project or in the project that owns the script.
  const want = path.resolve(/^[A-Za-z]:[\\/]/.test(run) ? run : path.join(project.folder, run)).toLowerCase();
  const owners = [project, ...loadCatalog().filter((p) => p.id !== project.id)];
  let job = null;
  let own = false;
  for (const p of owners) {
    job = (p.jobs || []).find((j) => j.file && path.resolve(p.folder, j.file).toLowerCase() === want) || null;
    if (job) { own = p.id === project.id; break; }
  }
  // Another project's label (its own "Build release") would be vague here, so it only borrows the flags.
  const label = (!args && own && job.label) || FIX_LABELS[key] || path.basename(run).replace(/\.(bat|cmd|ps1)$/i, '');
  // jobId names this project's own job for the same script, so the page does not list it a second time.
  return { label, outward: !!(job && job.outward), interactive: job ? !!job.interactive : null, jobId: own ? job.id : null };
}

// Why a project needs you: uncommitted changes, commits not pushed, or a required build check that is stale.
// Only the main build counts; other stale checks (installer, Mac, dev) stay in `attention`.
function needsOf(p) {
  const why = [];
  if (p.dirty > 0) why.push(`${p.dirty} uncommitted change${p.dirty > 1 ? 's' : ''}`);
  if (p.ahead > 0) why.push(`${p.ahead} commit${p.ahead > 1 ? 's' : ''} not pushed`);
  if (p.build === 'stale') {
    const req = p.required || [];
    const st = (p.checks || []).filter((c) => req.includes(c.key) && c.state === 'stale').map((c) => c.label);
    why.push('build stale' + (st.length ? ` (${st.join(', ')})` : ''));
  }
  return { needsYou: why.length > 0, needsReasons: why };
}

// Hidden projects are left out unless { all: true }.
export function listProjects({ all = false } = {}) {
  // Not cached as a whole: each project keeps its own entry, so one slow repository never holds the others.
  const catalog = loadCatalog().filter((p) => all || p.hidden !== true);
  return Promise.all(catalog.map(async (p) => decorate(await probe(p), p)));
}

export async function getProjectDetail(id) {
  const project = getProject(id);
  if (!project) return null;
  const detail = await memo(`projects:detail:${id}`, async () => {
    const quick = await probe(project, { fresh: true });
    if (!quick.exists) return { ...quick, commits: [] };
    const commits = quick.isRepo ? await git.log(project.folder, 15) : [];
    return { ...quick, commits };
  });
  return decorate(detail, project);
}

const FILE_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Folders and files that are never served, whatever their extension. Matched per path segment.
const BLOCKED_SEGMENT = /^(\.git|\.svn|\.hg|\.ssh|\.aws|\.gnupg|node_modules)$|^\.env/i;
// Characters Windows treats as a stream marker, wildcard or control code. None belong in a project path.
const BAD_PATH_CHARS = /[\u0000-\u001f:<>"|?*]/;

// Resolves a request path to a servable file inside the project, or { error }.
// error is 'forbidden' (outside the folder, wrong type, blocked name) or 'missing'.
// Checked twice: on the text the caller sent, then on the real path after links and 8.3 short names are resolved.
// folder: the root the path is inside, the project folder unless a library root (a notes folder) is named.
export function resolveProjectFile(project, rel, folder = project.folder) {
  if (!folder) return { error: 'missing' };
  if (typeof rel !== 'string' || !rel || rel.length > 1024 || BAD_PATH_CHARS.test(rel)) return { error: 'forbidden' };
  if (/^[\\/]/.test(rel)) return { error: 'forbidden' };
  const type = FILE_TYPES[path.extname(rel).toLowerCase()];
  if (!type) return { error: 'forbidden' };

  const segments = [];
  for (const seg of rel.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    // Windows silently drops trailing dots and spaces, so "name.md." and ".git." would reach real files.
    if (seg === '..' || /[. ]$/.test(seg) || BLOCKED_SEGMENT.test(seg)) return { error: 'forbidden' };
    segments.push(seg);
  }
  if (!segments.length) return { error: 'forbidden' };

  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync.native(path.resolve(folder));
    real = fs.realpathSync.native(path.join(realRoot, ...segments));
  } catch {
    return { error: 'missing' };
  }
  const inside = path.relative(realRoot, real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { error: 'forbidden' };
  const realSegments = inside.split(path.sep);
  if (realSegments.some((s) => BLOCKED_SEGMENT.test(s))) return { error: 'forbidden' };
  // A link inside the project may point at a file of another type.
  const realType = FILE_TYPES[path.extname(real).toLowerCase()];
  if (!realType) return { error: 'forbidden' };

  let st;
  try {
    st = fs.statSync(real);
  } catch {
    return { error: 'missing' };
  }
  if (!st.isFile()) return { error: 'missing' };
  return { file: real, size: st.size, type: realType };
}
