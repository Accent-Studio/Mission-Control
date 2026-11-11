// Web search for local models (Claude's own web search runs on Anthropic's side, so a local model cannot use it).
// DuckDuckGo's plain HTML page: no key, no account. Returns up to 8 results as "title / address / snippet" text.
const ENDPOINT = 'https://html.duckduckgo.com/html/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", nbsp: ' ' };
function clean(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()];
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (/^#\d/.test(e)) return String.fromCodePoint(Number(e.slice(1)));
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// DuckDuckGo wraps each address in its own redirect: //duckduckgo.com/l/?uddg=<the real address>&rut=...
function realUrl(href) {
  const h = clean(href);
  const m = /[?&]uddg=([^&]+)/.exec(h);
  try {
    return m ? decodeURIComponent(m[1]) : h.startsWith('//') ? 'https:' + h : h;
  } catch {
    return h;
  }
}

export async function webSearch(query) {
  const q = String(query || '').trim().slice(0, 400);
  if (!q) return 'Give a query.';
  const res = await fetch(ENDPOINT + '?q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.8' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return `The search failed (HTTP ${res.status}). Try again later or reword the query.`;
  const html = await res.text();
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div class="result__body)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    const url = realUrl(m[1]);
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // an ad
    out.push(`${out.length + 1}. ${clean(m[2])}\n   ${url}\n   ${clean(m[3] || '')}`);
  }
  if (!out.length) return 'No results. Try other words.';
  return out.join('\n') + '\n\nTo read a page, load the WebFetch tool (group web) and fetch its address.';
}
