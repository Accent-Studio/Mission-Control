// API-equivalent prices, in dollars per million tokens, to turn the token counts of the transcripts into money.
// On a subscription nothing is billed this way: it says what the same work would cost at pay-as-you-go API prices.
// Cache writes cost 1.25x the input price for the 5 min cache and 2x for the 1h cache. Cache reads have their own price
// (0.1x on most models, less on Fable 5.1 and Opus 5.5). Source: the Claude API pricing table, October 2026.
// Haiku 5.5 costs more above 100K tokens of prompt; the hourly totals do not keep the size of each request, so the base
// price is used and its cost can be a little low.

// [input, output, cache read]; the writes come from the input price
const TABLE = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25]],
  [/(fable|mythos)-5(?![-\d])|(fable|mythos)-5-\d{8}/, [10, 50, 1]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus-5(?![-\d])|opus-5-\d{8}/, [5, 25, 0.5]],
  [/opus-4-[5-9]/, [5, 25, 0.5]],
  [/opus-4-1|opus-4(?![-\d])|opus-4-\d{8}|3-opus/, [15, 75, 1.5]],
  [/sonnet-5/, [2, 10, 0.2]],
  [/sonnet-4|3-7-sonnet|3-5-sonnet|sonnet-3/, [3, 15, 0.3]],
  [/haiku-5/, [0.1, 0.5, 0.01]],
  [/haiku-4/, [1, 5, 0.1]],
  [/3-5-haiku|haiku-3-5/, [0.8, 4, 0.08]],
  [/3-haiku/, [0.25, 1.25, 0.03]],
];

const cache = new Map();

// { in, out, cacheRead, cacheWrite5m, cacheWrite1h } in dollars per million tokens, or null for a model not in the table.
export function priceFor(model) {
  if (typeof model !== 'string' || !model) return null;
  if (cache.has(model)) return cache.get(model);
  let p = null;
  for (const [re, [i, o, r]] of TABLE) {
    if (re.test(model)) {
      p = { in: i, out: o, cacheRead: r, cacheWrite5m: i * 1.25, cacheWrite1h: i * 2 };
      break;
    }
  }
  cache.set(model, p);
  return p;
}

// Dollars for one usage tuple [requests, in, out, cacheRead, cacheWrite5m, cacheWrite1h, ...], or null when not priced.
export function costOf(model, t) {
  const p = priceFor(model);
  if (!p) return null;
  return (t[1] * p.in + t[2] * p.out + t[3] * p.cacheRead + t[4] * p.cacheWrite5m + t[5] * p.cacheWrite1h) / 1e6;
}

// Dollars the cache reads saved: what they would have cost as plain input, minus what they cost.
export function savedOf(model, t) {
  const p = priceFor(model);
  if (!p) return 0;
  return (t[3] * (p.in - p.cacheRead)) / 1e6;
}

// The family a model belongs to, for colors and grouping: fable, opus, sonnet, haiku or other.
export function familyOf(model) {
  const m = /(fable|mythos|opus|sonnet|haiku)/.exec(String(model || ''));
  if (!m) return 'other';
  return m[1] === 'mythos' ? 'fable' : m[1];
}
