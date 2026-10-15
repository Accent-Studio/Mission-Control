// The Usage page's numbers: the hourly totals of usageIndex.js summed over a time range, priced (pricing.js), and split by
// model, conversation and project. Hours are kept as UTC hour numbers; the page turns them into local days and weeks.
// A tuple is [requests, input, output, cacheRead, cacheWrite5m, cacheWrite1h, activeMs of that model].
import { usageSessions, usageIndexStatus } from './usageIndex.js';
import { allSessionRows } from './sessions.js';
import { getProject } from './catalog.js';
import { costOf, savedOf, familyOf, priceFor } from './pricing.js';
import { planHistory } from './usage.js';

const HOUR_MS = 3600e3;
const HEATMAP_MS = 371 * 24 * HOUR_MS; // the activity grid always shows the last 53 weeks
const MAX_SESSIONS = 5000; // all of them in practice: the page sorts them by any measure

const zero = () => [0, 0, 0, 0, 0, 0, 0];
function add(a, b) {
  for (let i = 0; i < 7; i++) a[i] += b[i] || 0;
  return a;
}
const tokensOf = (t) => t[1] + t[2] + t[3] + t[4] + t[5];

// The page's names for the conversations and their projects. Conversations deleted since keep their numbers, with no title.
async function rowsById() {
  const map = new Map();
  try {
    for (const r of await allSessionRows()) map.set(r.id.toLowerCase(), r);
  } catch {
    // the names are a nicety: the numbers stand without them
  }
  return map;
}

// The projects a conversation counts for, with their shares (adding up to 1). Manual tags share equally.
function projectsOf(row) {
  const tags = row && Array.isArray(row.tags) ? row.tags.filter((t) => t && t.projectId) : [];
  if (tags.length) {
    const w = tags.map((t) => (Number.isFinite(t.share) && t.share > 0 ? t.share : 1));
    const sum = w.reduce((a, b) => a + b, 0);
    return tags.map((t, i) => ({ id: t.projectId, share: w[i] / sum }));
  }
  if (row && row.project) return [{ id: row.project, share: 1 }];
  return [{ id: null, share: 1 }];
}

// from, to: ms (to is exclusive). Returns everything the page draws.
export async function usageStats({ from = 0, to = Date.now() + HOUR_MS } = {}) {
  const sessions = usageSessions();
  const rows = await rowsById();
  const h0 = Math.floor(from / HOUR_MS);
  const h1 = Math.ceil(to / HOUR_MS);
  const hoursFrom = Math.floor(Math.min(from, Date.now() - HEATMAP_MS) / HOUR_MS);

  const hours = new Map(); // hourKey -> { a, u, t, m: { model: tuple+cost } }
  const byModel = {}; // model -> { family, t: tuple, cost, saved }
  const total = { t: zero(), cost: 0, saved: 0, activeMs: 0, prompts: 0, tools: 0, sessions: 0, sub: zero(), subCost: 0, unpriced: 0, parts: { read: 0, write: 0, input: 0, output: 0 } };
  const convs = [];
  const projects = new Map(); // id|null -> { cost, tokens, activeMs, req, sessions }

  for (const [sid, s] of Object.entries(sessions)) {
    const c = { t: zero(), cost: 0, subCost: 0, activeMs: 0, prompts: 0, tools: 0, sub: zero(), first: Infinity, last: 0, models: {} };
    for (const [hk, b] of Object.entries(s.h || {})) {
      const hn = Number(hk);
      if (!(hn >= hoursFrom && hn < h1)) continue;
      const inRange = hn >= h0;
      let hr = hours.get(hn);
      if (!hr) hours.set(hn, (hr = { a: 0, u: 0, t: 0, m: {} }));
      hr.a += b.a || 0;
      hr.u += b.u || 0;
      hr.t += b.t || 0;
      for (const [part, list] of [['m', b.m], ['sm', b.sm]]) {
        for (const [model, tu] of Object.entries(list || {})) {
          const cost = costOf(model, tu);
          const x = hr.m[model] || (hr.m[model] = [0, 0, 0, 0, 0, 0, 0, 0]);
          add(x, tu);
          x[7] += cost || 0;
          if (!inRange) continue;
          const bm = byModel[model] || (byModel[model] = { family: familyOf(model), t: zero(), cost: 0, saved: 0, priced: cost !== null });
          add(bm.t, tu);
          bm.cost += cost || 0;
          bm.saved += savedOf(model, tu);
          const p = priceFor(model);
          if (p) {
            total.parts.read += (tu[3] * p.cacheRead) / 1e6;
            total.parts.write += (tu[4] * p.cacheWrite5m + tu[5] * p.cacheWrite1h) / 1e6;
            total.parts.input += (tu[1] * p.in) / 1e6;
            total.parts.output += (tu[2] * p.out) / 1e6;
          }
          add(c.t, tu);
          c.cost += cost || 0;
          c.models[model] = (c.models[model] || 0) + (cost || 0);
          if (part === 'sm') {
            add(c.sub, tu);
            c.subCost += cost || 0;
            total.subCost += cost || 0;
          }
          if (cost === null) total.unpriced += tu[0];
        }
      }
      if (!inRange) continue;
      c.activeMs += b.a || 0;
      c.prompts += b.u || 0;
      c.tools += b.t || 0;
      const ms = hn * HOUR_MS;
      if (ms < c.first) c.first = ms;
      if (ms > c.last) c.last = ms;
    }
    if (!c.t[0] && !c.activeMs) continue;
    add(total.t, c.t);
    add(total.sub, c.sub);
    total.cost += c.cost;
    total.activeMs += c.activeMs;
    total.prompts += c.prompts;
    total.tools += c.tools;
    total.sessions++;
    const row = rows.get(sid.toLowerCase()) || null;
    const top = Object.entries(c.models).sort((a, b) => b[1] - a[1])[0];
    const shares = projectsOf(row);
    convs.push({
      id: sid,
      title: row ? row.title || 'Untitled' : null,
      projects: shares.map((p) => p.id).filter(Boolean),
      archived: !!(row && row.archived),
      gone: !row,
      first: new Date(c.first).toISOString(),
      last: new Date(c.last).toISOString(), // the start of its last active hour
      activeMs: c.activeMs,
      prompts: c.prompts,
      tools: c.tools,
      req: c.t[0],
      tokens: tokensOf(c.t),
      cacheRead: c.t[3],
      subCost: c.subCost,
      cost: c.cost,
      model: top ? top[0] : null,
    });
    for (const p of shares) {
      const pr = projects.get(p.id) || { cost: 0, tokens: 0, activeMs: 0, req: 0, sessions: 0 };
      pr.cost += c.cost * p.share;
      pr.tokens += tokensOf(c.t) * p.share;
      pr.activeMs += c.activeMs * p.share;
      pr.req += c.t[0] * p.share;
      pr.sessions += 1;
      projects.set(p.id, pr);
    }
  }
  for (const m of Object.values(byModel)) total.saved += m.saved;

  convs.sort((a, b) => b.cost - a.cost || b.activeMs - a.activeMs);
  const st = usageIndexStatus();
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    index: { ready: !!st.firstPassDone, running: !!st.running, sessions: st.sessions, files: st.files },
    total: { ...total, tokens: tokensOf(total.t), req: total.t[0], subTokens: tokensOf(total.sub) },
    byModel,
    hours: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([h, v]) => ({ h, ...v })),
    conversations: convs.slice(0, MAX_SESSIONS),
    conversationCount: convs.length,
    projects: [...projects.entries()]
      .map(([id, p]) => ({ id, name: id ? (getProject(id) || {}).name || id : null, ...p }))
      .sort((a, b) => b.cost - a.cost),
    plan: planHistory(from, to),
  };
}
