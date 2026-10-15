// Project catalog: .data/projects.json, plus the project folders found in the discovery roots.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DISCOVERY_ROOTS, EXTRA_PROJECTS, JOBS_SEED_FILE, PROJECT_ABOUT, PROJECT_ALIASES, ROOT } from '../config.js';

const FILE = path.join(DATA_DIR, 'projects.json');

const SELF = {
  id: 'mission-control',
  name: 'Mission Control',
  folder: ROOT,
  about: 'Dev dashboard.',
  watch: ['.', ':!*.md'],
  remote: '',
  track_push: false,
  checks: [],
};

const NAME_MAX = 60;
const ABOUT_MAX = 160;

const BOM = new RegExp('^\uFEFF');

// A new catalog starts with Mission Control itself. Discovered folders are merged in on every read, and the file is
// written the first time a project's settings change.
function seed() {
  return [SELF];
}


// ---- Job definitions ----

export const JOB_KINDS = [
  'build-dev', 'build-release', 'export-game', 'install-local', 'make-installer', 'push-github',
  'publish-website', 'release', 'deploy', 'sync', 'test', 'run-dev', 'clean', 'other',
];
export const SCRIPT_EXTS = ['.bat', '.cmd', '.ps1'];
// Jobs the server runs itself instead of a script file.
export const BUILTINS = ['git-push'];
export const MAX_JOBS = 60;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// Characters that may not appear in a script path relative to the project (also Windows wildcards and stream marks).
const BAD_REL_CHARS = /["%^&|<>*?:\u0000-\u001f]/;
// Characters that make a full path unsafe to put inside a cmd.exe command line.
const BAD_ABS_CHARS = /["%^&|<>\u0000-\u001f]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

// Ids that are safe to use in a file or folder name.
export function isSafeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
}

// Lenient clean-up of a stored or seeded job. Returns null for an entry that cannot be used.
function cleanJob(j, index) {
  if (!j || typeof j !== 'object') return null;
  if (typeof j.id !== 'string' || !ID_RE.test(j.id)) return null;
  const builtin = BUILTINS.includes(j.builtin) ? j.builtin : null;
  if (!builtin && (typeof j.file !== 'string' || !j.file.trim())) return null;
  const label = typeof j.label === 'string' && j.label.trim() ? j.label.trim().slice(0, 40) : j.id;
  return {
    id: j.id,
    label,
    file: builtin ? null : j.file.trim().replace(/\//g, '\\'),
    builtin,
    kind: JOB_KINDS.includes(j.kind) ? j.kind : 'other',
    // A built-in push always sends something off the PC and never waits for input.
    outward: builtin ? true : j.outward === true,
    interactive: builtin ? false : j.interactive === true,
    order: Number.isFinite(j.order) ? j.order : index,
    visible: j.visible !== false,
  };
}

function cleanJobs(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  list.forEach((raw, i) => {
    const j = cleanJob(raw, i);
    if (!j || seen.has(j.id)) return;
    seen.add(j.id);
    out.push(j);
  });
  return out.map((j, i) => ({ j, i })).sort((a, b) => a.j.order - b.j.order || a.i - b.i).map((x) => x.j);
}

// ---- Seed (server/data/jobs-seed.json): { "<projectId>": { jobs: [...], hidden: bool } } ----

let seedCache = { key: '', data: {} };
let seedWarned = false;

function loadSeed() {
  let st;
  try {
    st = fs.statSync(JOBS_SEED_FILE);
  } catch {
    return {}; // no seed file yet
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (seedCache.key === key) return seedCache.data;
  const data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(JOBS_SEED_FILE, 'utf8').replace(BOM, ''));
    if (parsed && typeof parsed === 'object') {
      for (const [id, v] of Object.entries(parsed)) {
        if (!v || typeof v !== 'object' || !Array.isArray(v.jobs)) continue;
        data[id] = { jobs: cleanJobs(v.jobs), hidden: v.hidden === true };
      }
    }
  } catch (err) {
    if (!seedWarned) console.warn('[catalog] could not read the jobs seed:', err.message);
    seedWarned = true;
  }
  seedCache = { key, data };
  return data;
}

// ---- Discovered folders (never written to disk) ----

const DISCOVER_TTL_MS = 60 * 1000;
let discovered = { at: 0, dirs: [] };

function normFolder(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

// Direct subfolders of the discovery roots that hold a .git folder, plus folders without one that have a
// seeded job. Cached so a busy dashboard does not rescan.
function scanRoots() {
  if (Date.now() - discovered.at < DISCOVER_TTL_MS) return discovered.dirs;
  const seed = loadSeed();
  const dirs = [];
  for (const root of DISCOVERY_ROOTS) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root missing: nothing to discover there
    }
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const n = d.name;
      if (n.startsWith('.') || /(-backup|Backups|-push)$/.test(n)) continue;
      const full = path.join(root, n);
      let hasGit = false;
      try {
        hasGit = fs.statSync(path.join(full, '.git')).isDirectory();
      } catch {
        // no .git folder
      }
      const seeded = seed[slug(n)];
      if (hasGit) dirs.push({ name: n, folder: full });
      else if (seeded && seeded.jobs.length > 0) dirs.push({ name: n, folder: full, seedOnly: true });
    }
  }
  discovered = { at: Date.now(), dirs };
  return dirs;
}

function withDiscovered(list) {
  const folders = new Set(list.map((p) => normFolder(p && p.folder)));
  const ids = new Set(list.map((p) => p && p.id));
  const out = list.slice();
  for (const d of scanRoots()) {
    if (folders.has(normFolder(d.folder))) continue;
    // A folder found only through the seed must take the seed's id. If a catalog entry already owns that id
    // (BlitzVoice is listed by its Handy subfolder), this folder is not a second project.
    if (d.seedOnly && ids.has(slug(d.name))) continue;
    let id = slug(d.name);
    for (let i = 2; ids.has(id); i++) id = `${slug(d.name)}-${i}`;
    ids.add(id);
    out.push({ id, name: d.name, folder: d.folder, about: '', watch: [], checks: [], discovered: true });
  }
  for (const x of EXTRA_PROJECTS) {
    if (folders.has(normFolder(x.folder)) || ids.has(x.id) || !fs.existsSync(x.folder)) continue;
    ids.add(x.id);
    out.push({ id: x.id, name: x.name, folder: x.folder, about: '', watch: [], checks: [], discovered: true });
  }
  return out;
}

// strict: throw when the file exists but cannot be read, so a write never replaces a file we could not parse.
function readStored({ strict = false } = {}) {
  if (!fs.existsSync(FILE)) return seed();
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(BOM, ''));
    // Valid JSON of the wrong shape counts as unreadable too, so a write never replaces it with an empty list.
    if (!parsed || !Array.isArray(parsed.projects)) throw new Error('no "projects" list in the file');
    return parsed.projects;
  } catch (err) {
    console.error('[catalog] projects.json is unreadable:', err.message);
    if (strict) throw Object.assign(new Error('The project catalog is unreadable, nothing was saved'), { status: 500 });
    return [];
  }
}

// Seeded jobs and the hidden flag apply only to a project with no `jobs` key of its own. The seed never overwrites.
function withJobs(list) {
  const seeded = loadSeed();
  return list.map((p) => {
    if (!p || !p.id) return p;
    let jobs = p.jobs;
    let hidden = p.hidden;
    if (!Array.isArray(jobs) && seeded[p.id]) {
      jobs = seeded[p.id].jobs;
      if (typeof hidden !== 'boolean') hidden = seeded[p.id].hidden;
    }
    return { ...p, jobs: cleanJobs(jobs), hidden: hidden === true };
  });
}

function withAliases(list) {
  return list.map((p) => {
    if (!p || !p.id) return p;
    const extra = Array.isArray(p.aliases) ? p.aliases : [];
    const merged = [...new Set([...(PROJECT_ALIASES[p.id] || []), ...extra].filter((a) => typeof a === 'string' && a.trim()))];
    return merged.length ? { ...p, aliases: merged } : p;
  });
}

function withAbout(list) {
  return list.map((p) => (p && p.id && !p.about && !p.aboutSet && PROJECT_ABOUT[p.id] ? { ...p, about: PROJECT_ABOUT[p.id] } : p));
}

export function loadCatalog() {
  return withAbout(withAliases(withJobs(withDiscovered(readStored()))));
}

export function getProject(id) {
  return loadCatalog().find((p) => p.id === id) || null;
}

// ---- Writing ----

function writeStored(stored) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ projects: stored }, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    // The real file is untouched until the rename succeeds; just do not leave the temp file behind.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
}

// Applies `mutate` to the stored entry of a project and saves (temp file, then rename). A project that only
// exists by discovery gets an entry written for it. Fields the code does not know are kept. Returns false
// for an unknown project.
function updateEntry(id, mutate) {
  const stored = readStored({ strict: true }).slice();
  const base = withDiscovered(stored).find((p) => p && p.id === id);
  if (!base) return false;
  let idx = stored.findIndex((p) => p && p.id === id);
  if (idx < 0) {
    const { discovered: _d, ...entry } = base;
    stored.push(JSON.parse(JSON.stringify(entry)));
    idx = stored.length - 1;
  }
  stored[idx] = mutate(stored[idx]) || stored[idx];
  writeStored(stored);
  return true;
}

// Sets the `required` flag on checks. Leaving the default rule writes it out first (main check on, others off),
// so the first click on one check does not silently switch the implicit main check off.
function applyRequired(entry, changes) {
  const checks = Array.isArray(entry.checks) ? entry.checks : [];
  if (!checks.some((c) => typeof c.required === 'boolean')) {
    const hasStep = (c) => Array.isArray(c.artifact) && c.artifact.some((a) => typeof a === 'string' && a.trim());
    const main = checks.find((c) => c.key === 'exe' && hasStep(c)) || checks.find(hasStep) || null;
    for (const c of checks) c.required = c === main;
  }
  entry.checks = checks.map((c) => (changes.has(c.key) ? { ...c, required: changes.get(c.key) } : c));
  return entry;
}

// Saves a check's `required` flag. Returns false for an unknown project or check.
export function setCheckRequired(id, key, required) {
  const project = getProject(id);
  if (!project || !(project.checks || []).some((c) => c.key === key)) return false;
  return updateEntry(id, (entry) => applyRequired(entry, new Map([[key, !!required]])));
}

// ---- Script paths ----

// Resolves a script path relative to the project folder. Returns { abs, rel } or { error }.
// The file must exist, be a .bat/.cmd/.ps1 and stay inside the folder (links are resolved first).
export function resolveScript(folder, file) {
  if (typeof file !== 'string' || !file.trim() || file.length > 260) return { error: 'must be a path' };
  if (BAD_REL_CHARS.test(file)) return { error: 'contains a character that is not allowed' };
  if (/^[\\/]/.test(file)) return { error: 'must be relative to the project folder' };
  const segs = [];
  for (const seg of file.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' || /[. ]$/.test(seg)) return { error: 'must stay inside the project folder' };
    segs.push(seg);
  }
  if (!segs.length) return { error: 'must be a path' };
  if (!SCRIPT_EXTS.includes(path.extname(segs[segs.length - 1]).toLowerCase())) return { error: 'must be a .bat, .cmd or .ps1 script' };
  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync.native(path.resolve(folder));
    real = fs.realpathSync.native(path.join(realRoot, ...segs));
  } catch {
    return { error: `not found in the project folder (${segs.join('\\')})` };
  }
  const inside = path.relative(realRoot, real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { error: 'must stay inside the project folder' };
  if (!SCRIPT_EXTS.includes(path.extname(real).toLowerCase())) return { error: 'must be a .bat, .cmd or .ps1 script' };
  try {
    if (!fs.statSync(real).isFile()) return { error: 'is not a file' };
  } catch {
    return { error: 'not found in the project folder' };
  }
  if (BAD_ABS_CHARS.test(real)) return { error: 'has a full path with a character that is not safe to run' };
  return { abs: real, rel: segs.join('\\') };
}

// ---- Settings (PUT /api/projects/:id/settings) ----

const bad = (error) => ({ error });
const JOB_FIELDS = ['id', 'label', 'file', 'builtin', 'kind', 'outward', 'interactive', 'order', 'visible'];

function validateJob(folder, raw, i) {
  const at = `jobs[${i}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`${at} must be an object`);
  // A misspelled flag such as "outwards" must not be dropped quietly (it would turn a confirm off).
  const extra = Object.keys(raw).find((k) => !JOB_FIELDS.includes(k));
  if (extra) return bad(`${at} has an unknown field: ${extra}`);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return bad(`${at}.id must be a slug (a-z, 0-9, - or _, 1 to 40 characters)`);
  if (typeof raw.label !== 'string') return bad(`${at}.label must be text`);
  const label = raw.label.trim();
  if (label.length < 1 || label.length > 40) return bad(`${at}.label must be 1 to 40 characters`);
  if (CONTROL.test(label)) return bad(`${at}.label must not contain control characters`);
  if (!JOB_KINDS.includes(raw.kind)) return bad(`${at}.kind must be one of: ${JOB_KINDS.join(', ')}`);
  for (const k of ['outward', 'interactive', 'visible']) {
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean') return bad(`${at}.${k} must be true or false`);
  }
  if (raw.order !== undefined && !Number.isFinite(raw.order)) return bad(`${at}.order must be a number`);
  const builtin = raw.builtin === undefined || raw.builtin === null ? null : raw.builtin;
  if (builtin !== null && !BUILTINS.includes(builtin)) return bad(`${at}.builtin must be one of: ${BUILTINS.join(', ')}`);
  let rel = null;
  if (builtin && raw.outward === false) return bad(`${at}.outward cannot be turned off for the built-in ${builtin} job`);
  if (builtin && raw.interactive === true) return bad(`${at}.interactive cannot be turned on for the built-in ${builtin} job`);
  if (builtin) {
    if (raw.file !== undefined && raw.file !== null && raw.file !== '') return bad(`${at}.file must be empty for a built-in job`);
    if (!fs.existsSync(path.join(folder, '.git'))) return bad(`${at}.builtin ${builtin} needs a git repository`);
  } else {
    const script = resolveScript(folder, raw.file);
    if (script.error) return bad(`${at}.file ${script.error}`);
    rel = script.rel;
  }
  return {
    value: {
      id: raw.id,
      label,
      file: rel,
      builtin,
      kind: raw.kind,
      outward: builtin ? true : raw.outward === true,
      interactive: builtin ? false : raw.interactive === true,
      order: raw.order === undefined ? i : raw.order,
      visible: raw.visible !== false,
    },
  };
}

// Returns { value: { hidden?, jobs?, checks? } } or { error }. Nothing is written here.
export function validateSettings(project, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Body must be an object');
  const unknown = Object.keys(body).filter((k) => !['hidden', 'jobs', 'checks', 'name', 'about'].includes(k));
  if (unknown.length) return bad(`Unknown field: ${unknown[0]}`);
  const value = {};
  // The display name and the subtitle: plain one line text. The folder keeps its own name.
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return bad('name must be text');
    const n = body.name.replace(/\s+/g, ' ').trim();
    if (!n) return bad('name cannot be empty');
    if (n.length > NAME_MAX || /[\u0000-\u001f<>]/.test(n)) return bad(`name must be one line of at most ${NAME_MAX} characters, without < or >`);
    value.name = n;
  }
  if (body.about !== undefined) {
    if (typeof body.about !== 'string') return bad('about must be text');
    const a = body.about.replace(/\s+/g, ' ').trim();
    if (a.length > ABOUT_MAX || /[\u0000-\u001f<>]/.test(a)) return bad(`about must be one line of at most ${ABOUT_MAX} characters, without < or >`);
    value.about = a;
  }
  if (body.hidden !== undefined) {
    if (typeof body.hidden !== 'boolean') return bad('hidden must be true or false');
    value.hidden = body.hidden;
  }
  if (body.jobs !== undefined) {
    if (!Array.isArray(body.jobs)) return bad('jobs must be a list');
    if (body.jobs.length > MAX_JOBS) return bad(`jobs can hold at most ${MAX_JOBS} entries`);
    const jobs = [];
    const ids = new Set();
    for (let i = 0; i < body.jobs.length; i++) {
      const r = validateJob(project.folder, body.jobs[i], i);
      if (r.error) return r;
      if (ids.has(r.value.id)) return bad(`jobs[${i}].id is used twice: ${r.value.id}`);
      ids.add(r.value.id);
      jobs.push(r.value);
    }
    jobs.sort((a, b) => a.order - b.order); // stable: ties keep list position
    value.jobs = jobs.map((j, i) => ({ ...j, order: i }));
  }
  if (body.checks !== undefined) {
    const c = body.checks;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return bad('checks must be an object');
    const known = new Set((project.checks || []).map((x) => x.key));
    const changes = new Map();
    for (const [key, v] of Object.entries(c)) {
      if (!known.has(key)) return bad(`Unknown check: ${key}`);
      if (!v || typeof v !== 'object' || typeof v.required !== 'boolean') return bad(`checks.${key} must be {required: true or false}`);
      changes.set(key, v.required);
    }
    value.checks = changes;
  }
  if (value.hidden === undefined && value.jobs === undefined && value.checks === undefined && value.name === undefined && value.about === undefined) return bad('Nothing to change');
  return { value };
}

// Saves validated settings in one atomic write. Returns false for an unknown project.
export function saveSettings(id, value) {
  return updateEntry(id, (entry) => {
    if (value.hidden !== undefined) entry.hidden = value.hidden;
    if (value.name !== undefined) entry.name = value.name;
    if (value.about !== undefined) { entry.about = value.about; entry.aboutSet = true; } /* an emptied subtitle stays empty */
    if (value.jobs !== undefined) entry.jobs = value.jobs;
    if (value.checks !== undefined && value.checks.size) applyRequired(entry, value.checks);
    return entry;
  });
}
