// Shrink: a conversation transcript without its heavy parts (services/storage.js rewrites the files with it). Pure: no
// files, no server, so a test can load it on its own.
//
// Most of a big code conversation is screenshots that tools sent back (a browser, Blender, ComfyUI...), and Claude Code
// keeps each one twice: in the tool result, and in its own copy of the result (toolUseResult). Shrink takes out the parts
// picked on the page (SHRINK_PARTS) from the conversation and from its helper agents' conversations, and keeps everything
// else: every message, answer and step stays, in order, so the conversation still opens and can go on. What is taken out
// becomes a short note. The old files go to the Recycle Bin, so a shrink can be undone there.

export const SHRINK_PARTS = {
  toolPictures: 'Pictures tools sent back (screenshots)',
  userPictures: 'Pictures you attached',
  documents: 'Documents you attached (PDFs)',
  thinking: "Claude's thinking",
  toolOutput: 'Long tool results (command output, files read), the first lines stay',
  toolInputs: 'Long tool inputs (files Claude wrote), the first lines stay',
  records: "Claude Code's background records (file snapshots, progress)",
};
const PIC_NOTE = '[Picture removed by Mission Control to save space]';
const DOC_NOTE = '[Document removed by Mission Control to save space]';
const BIG = 1000; // characters of base64: a smaller picture is not worth a note
const LONG = 2000; // characters: a longer text is cut
const KEEP = 400; // characters of a cut text that stay
const B64 = /^[A-Za-z0-9+/=\s]+$/;
const isPicture = (v) => v && typeof v === 'object' && v.type === 'image' && v.source && typeof v.source.data === 'string' && v.source.data.length > BIG;
const isDocument = (v) => v && typeof v === 'object' && v.type === 'document' && v.source && typeof v.source.data === 'string' && v.source.data.length > BIG;
const cutText = (t) => `${t.slice(0, KEEP)}\n[${(t.length - KEEP).toLocaleString('en-US')} more characters removed by Mission Control to save space]`;

// One pass over a line. Every part that could go is counted in `could` (what the page shows before a shrink); only the
// parts in `opts` are taken out, and counted in `saved`.
function shrinkLine(o, opts, could, saved) {
  const take = (part, bytes) => { could[part] = (could[part] || 0) + bytes; if (opts[part]) { saved[part] = (saved[part] || 0) + bytes; return true; } return false; };
  // strings inside a tool input, Claude Code's own copy of a result, or a background record: long ones are cut
  const cutAll = (v, part, pics) => {
    if (typeof v === 'string') return v.length > LONG && take(part, v.length - KEEP) ? cutText(v) : v;
    if (Array.isArray(v)) return v.map((x) => cutAll(x, part, pics));
    if (!v || typeof v !== 'object') return v;
    if (pics && isPicture(v)) return take('toolPictures', v.source.data.length) ? { ...v, source: { ...v.source, data: '' } } : v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (pics && (k === 'base64' || k === 'data') && typeof x === 'string' && x.length > BIG && B64.test(x.slice(0, 200))) out[k] = take('toolPictures', x.length) ? '' : x;
      else out[k] = cutAll(x, part, pics);
    }
    return out;
  };
  const toolResult = (b) => {
    if (typeof b.content === 'string') return b.content.length > LONG && take('toolOutput', b.content.length - KEEP) ? { ...b, content: cutText(b.content) } : b;
    if (!Array.isArray(b.content)) return b;
    return { ...b, content: b.content.map((x) => {
      if (isPicture(x)) return take('toolPictures', x.source.data.length) ? { type: 'text', text: PIC_NOTE } : x;
      if (x && x.type === 'text' && typeof x.text === 'string' && x.text.length > LONG) return take('toolOutput', x.text.length - KEEP) ? { ...x, text: cutText(x.text) } : x;
      return x;
    }) };
  };
  const c = o.message && Array.isArray(o.message.content) ? o.message.content : null;
  if (c) {
    const out = [];
    for (const b of c) {
      if (!b || typeof b !== 'object') { out.push(b); continue; }
      if (b.type === 'tool_result') out.push(toolResult(b));
      else if (isPicture(b)) out.push(take('userPictures', b.source.data.length) ? { type: 'text', text: PIC_NOTE } : b);
      else if (isDocument(b)) out.push(take('documents', b.source.data.length) ? { type: 'text', text: DOC_NOTE } : b);
      else if ((b.type === 'thinking' || b.type === 'redacted_thinking') && take('thinking', JSON.stringify(b).length)) continue;
      else if (b.type === 'tool_use' && b.input) out.push({ ...b, input: cutAll(b.input, 'toolInputs', false) });
      else out.push(b);
    }
    o.message.content = out.length ? out : [{ type: 'text', text: '[Thinking removed by Mission Control to save space]' }];
  }
  if (o.toolUseResult) o.toolUseResult = cutAll(o.toolUseResult, 'toolOutput', true);
  if (!o.message) {
    // a background record: keep its ids and links (the conversation is a chain of them), cut its long texts
    for (const [k, v] of Object.entries(o)) if (!['type', 'uuid', 'parentUuid', 'sessionId', 'timestamp', 'messageId', 'leafUuid'].includes(k)) o[k] = cutAll(v, 'records', false);
  }
  return o;
}

// opts: { part: true } of SHRINK_PARTS. Resolves { text (null with measureOnly), saved: { part: bytes }, could: { part: bytes } }.
export function shrinkText(text, opts = { toolPictures: true }, { measureOnly = false } = {}) {
  const could = {};
  const saved = {};
  const out = [];
  for (const line of text.split('\n')) {
    // a short line has nothing worth taking out, except thinking
    if (!line || (line.length < LONG && !line.includes('"thinking"'))) { if (!measureOnly) out.push(line); continue; }
    let o;
    try { o = JSON.parse(line); } catch { if (!measureOnly) out.push(line); continue; }
    const before = JSON.stringify(saved);
    const n = shrinkLine(o, measureOnly ? {} : opts, could, saved);
    if (!measureOnly) out.push(JSON.stringify(saved) === before ? line : JSON.stringify(n));
  }
  return { text: measureOnly ? null : out.join('\n'), saved, could };
}
