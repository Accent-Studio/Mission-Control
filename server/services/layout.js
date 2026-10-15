// Project layout: which ring (distance from the sun) and angle each project sits at on Home.
// Stored in .data/layout.json as { rings: [{id, ring, angle}], updatedAt }. The user arranges it by hand and
// nothing changes it by itself.
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, writeJson, busyError } from '../lib/jsonStore.js';
import { loadCatalog } from './catalog.js';

export const MAX_RING = 40;
const MAX_ENTRIES = 500;
const FILE = path.join(DATA_DIR, 'layout.json');
const TAU = Math.PI * 2;
const GOLDEN = 2.399;

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

const normAngle = (a) => (a >= 0 && a < TAU ? a : ((a % TAU) + TAU) % TAU);

let stored = null; // { rings: [{id, ring, angle}], updatedAt: string|null }

function clean(entry) {
  if (!entry || typeof entry.id !== 'string') return null;
  if (!Number.isInteger(entry.ring) || entry.ring < 0 || entry.ring > MAX_RING) return null;
  if (typeof entry.angle !== 'number' || !Number.isFinite(entry.angle)) return null;
  return { id: entry.id, ring: entry.ring, angle: normAngle(entry.angle) };
}

// A file that could not be read right now gives an empty layout that is not kept: the next call reads again, and a save
// refuses meanwhile (jsonStore.js). A file that is not valid JSON is set aside there.
function load() {
  if (stored) return stored;
  const r = readJson(FILE, 'layout');
  const parsed = r.value && typeof r.value === 'object' ? r.value : {};
  const seen = new Set();
  const rings = [];
  for (const e of Array.isArray(parsed.rings) ? parsed.rings : []) {
    const c = clean(e);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      rings.push(c);
    }
  }
  const fresh = { rings, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null };
  if (r.ok) stored = fresh;
  return fresh;
}

// Saved entries for projects that still exist, then every other visible project on a new outer ring, alphabetical.
export function getLayout() {
  const s = load();
  const catalog = loadCatalog();
  const known = new Set(catalog.map((p) => p.id));
  const rings = s.rings.filter((e) => known.has(e.id)).map((e) => ({ ...e }));
  const have = new Set(rings.map((e) => e.id));
  let next = rings.reduce((m, e) => Math.max(m, e.ring), -1) + 1;
  const missing = catalog
    .filter((p) => p.hidden !== true && !have.has(p.id))
    .sort((a, b) => String(a.name || a.id).toLowerCase().localeCompare(String(b.name || b.id).toLowerCase()));
  missing.forEach((p, i) => {
    rings.push({ id: p.id, ring: Math.min(MAX_RING, next++), angle: normAngle(i * GOLDEN + 0.4) });
  });
  return { rings, updatedAt: s.updatedAt };
}

// Entries in the body replace the saved ones with the same id; saved entries for other ids are kept.
export function saveLayout(body) {
  if (!body || !Array.isArray(body.rings)) throw fail(400, 'Body must be {rings: [{id, ring, angle}]}');
  if (body.rings.length > MAX_ENTRIES) throw fail(400, 'Too many entries');
  load();
  if (!stored) throw busyError(FILE);
  const known = new Set(loadCatalog().map((p) => p.id));
  const incoming = new Map();
  for (const e of body.rings) {
    if (!e || typeof e.id !== 'string' || !known.has(e.id)) throw fail(400, `Unknown project: ${e && e.id}`);
    const c = clean(e);
    if (!c) throw fail(400, `Bad ring or angle for ${e.id} (ring is an integer 0..${MAX_RING}, angle is a finite number)`);
    if (incoming.has(c.id)) throw fail(400, `Duplicate project: ${c.id}`);
    incoming.set(c.id, c);
  }
  // Everything shown right now is saved with it, so a project that was only placed by default cannot slide to another ring when a neighbor is moved.
  const rings = getLayout().rings.filter((e) => !incoming.has(e.id));
  rings.push(...incoming.values());
  const next = { rings, updatedAt: new Date().toISOString() };
  writeJson(FILE, next);
  stored = next;
  return getLayout();
}
