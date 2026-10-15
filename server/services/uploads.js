// Chat attachments (files the user adds to a message) and the cache of images pulled out of transcripts.
//   .data/uploads/<uuid>/<name>   one upload, plus .meta.json (a dot name can never collide with a real file name)
//   .data/imgcache/<sha1>.<ext>   an image taken out of a transcript, named after its bytes
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const IMG_DIR = path.join(DATA_DIR, 'imgcache');

export const UPLOAD_BODY_LIMIT = 40 * 1024 * 1024; // JSON body of POST /api/uploads (base64 of up to 20 MB)
const MAX_IMAGE = 5 * 1024 * 1024; // raw bytes
const MAX_PDF = 20 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_MESSAGE_B64 = 30 * 1024 * 1024; // images and PDFs of one message together, as base64
const MAX_ATTACHMENTS = 10;
const MAX_NAME = 120;
const MAX_AGE_MS = Number(process.env.MC_UPLOAD_MAX_AGE_MS) || 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX = Number(process.env.MC_IMGCACHE_MAX) || 500 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const EXT_OF_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
// Windows device names, also with superscript digits; the part before the first dot decides, and trailing spaces there count too.
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

// What a file's first bytes say it is: "image/png" and so on, "application/pdf", or null.
export function sniff(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

// Letters, digits, space, dot, dash and underscore only; any folder part is cut off; at most 120 characters.
export function sanitizeName(raw) {
  if (typeof raw !== 'string') throw fail(400, 'name must be a string');
  let n = raw.normalize('NFC').split(/[\\/]/).pop();
  n = n.replace(/[^\p{L}\p{N} ._-]/gu, '_');
  n = n.replace(/^[ .]+/, '').replace(/[ .]+$/, '');
  if (!n) throw fail(400, 'That file name cannot be used');
  if (RESERVED.test(n.split('.')[0].replace(/[ ]+$/, ''))) n = '_' + n;
  if (n.length > MAX_NAME) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 20 ? n.slice(dot) : '';
    n = n.slice(0, MAX_NAME - ext.length).replace(/[\ud800-\udbff]$/, '').replace(/[ .]+$/, '') + ext; // never cut a surrogate pair in half
  }
  return n;
}

function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// ---- Uploads ----

// body: { name, type, data } with data as base64. Returns { id, name, kind, size, media_type }.
export function saveUpload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Body must be a JSON object');
  const name = sanitizeName(body.name);
  if (body.type !== undefined && body.type !== null && typeof body.type !== 'string') throw fail(400, 'type must be a string');
  let data = body.data;
  if (typeof data !== 'string' || !data) throw fail(400, 'data must be a base64 string');
  const prefix = /^data:[^,]{0,100};base64,/i.exec(data);
  if (prefix) data = data.slice(prefix[0].length);
  if (data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fail(400, 'data is not valid base64');

  const given = String(body.type || '').split(';')[0].trim().toLowerCase();
  const ext = extOf(name);
  let mediaType = given;
  if (given === 'image/jpg') mediaType = 'image/jpeg';
  if (!mediaType || mediaType === 'application/octet-stream') mediaType = IMAGE_EXT[ext] || (ext === 'pdf' ? 'application/pdf' : given || 'application/octet-stream');
  const kind = IMAGE_TYPES.has(mediaType) ? 'image' : mediaType === 'application/pdf' ? 'pdf' : 'file';
  const limit = kind === 'image' ? MAX_IMAGE : kind === 'pdf' ? MAX_PDF : MAX_FILE;
  const guess = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (guess > limit) {
    const what = kind === 'image' ? 'An image' : kind === 'pdf' ? 'A PDF' : 'A file';
    throw fail(413, `${what} can be at most ${limit / (1024 * 1024)} MB`);
  }
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw fail(400, 'The file is empty');
  if (kind !== 'file') {
    const real = sniff(buf);
    if (real !== mediaType) throw fail(400, kind === 'pdf' ? 'That does not look like a real PDF' : 'That does not look like a real image of the type it says');
  }

  const id = crypto.randomUUID();
  const dir = path.join(UPLOAD_DIR, id);
  const meta = { id, name, kind, size: buf.length, media_type: mediaType, createdAt: new Date().toISOString() };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf);
    fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify(meta));
  } catch (err) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // nothing left to clean
    }
    throw fail(500, 'Could not save the upload: ' + err.message);
  }
  return { id, name, kind, size: meta.size, media_type: mediaType };
}

// The stored upload for an id: { id, name, kind, size, media_type, file }, or null.
export function getUpload(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const dir = path.join(UPLOAD_DIR, id.toLowerCase());
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.meta.json'), 'utf8'));
    if (!meta || typeof meta.name !== 'string' || path.basename(meta.name) !== meta.name || meta.name.startsWith('.')) return null;
    const file = path.join(dir, meta.name);
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return { id: id.toLowerCase(), name: meta.name, kind: meta.kind, size: st.size, media_type: meta.media_type, file };
  } catch {
    return null;
  }
}

// Content blocks for one message: images and PDFs inline as base64, every other file as a text line with its
// absolute path (Claude reads it with its Read tool), then the text of the message last.
// ids: upload ids. Returns { blocks, sent: [{id, name, kind}] }.
export async function buildContent(prompt, ids) {
  const list = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = raw && typeof raw === 'object' ? raw.id : raw;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail(400, 'attachments must be upload ids');
    if (!list.includes(id.toLowerCase())) list.push(id.toLowerCase());
  }
  if (list.length > MAX_ATTACHMENTS) throw fail(400, `At most ${MAX_ATTACHMENTS} attachments per message`);
  const ups = list.map((id) => {
    const u = getUpload(id);
    if (!u) throw fail(404, 'An attachment is unknown or has expired, add it again');
    return u;
  });
  let total = 0;
  for (const u of ups) if (u.kind !== 'file') total += Math.ceil((u.size * 4) / 3);
  if (total > MAX_MESSAGE_B64) throw fail(413, 'The attachments of one message can be at most 30 MB together');

  const blocks = [];
  const sent = [];
  for (const u of ups) {
    if (u.kind === 'image') {
      const buf = await fs.promises.readFile(u.file);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: u.media_type, data: buf.toString('base64') } });
    } else if (u.kind === 'pdf') {
      const buf = await fs.promises.readFile(u.file);
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });
    } else {
      blocks.push({ type: 'text', text: `Attached file: ${u.file}` });
    }
    sent.push({ id: u.id, name: u.name, kind: u.kind });
  }
  if (typeof prompt === 'string' && prompt.trim()) blocks.push({ type: 'text', text: prompt });
  return { blocks, sent };
}

export function cleanupOldUploads() {
  let removed = 0;
  let dirs = [];
  try {
    dirs = fs.readdirSync(UPLOAD_DIR);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const d of dirs) {
    if (!ID_RE.test(d)) continue; // only folders this module made
    const dir = path.join(UPLOAD_DIR, d);
    try {
      const st = fs.lstatSync(dir); // a link is never followed
      if (st.isDirectory() && now - st.mtimeMs > MAX_AGE_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // gone already
    }
  }
  return removed;
}
setImmediate(cleanupOldUploads);
setInterval(cleanupOldUploads, 6 * 60 * 60 * 1000).unref();

// ---- Serving a local file ----

// Sends one file: images and PDFs inline, everything else as a download.
// Always with nosniff and a locked-down CSP (a PDF cannot be shown under a sandbox directive, so only it skips that word).
export function serveFile(req, res, { file, name, type, size, inline }) {
  const safe = String(name || 'file').replace(/[^\w. -]/g, '_');
  const headers = {
    'Content-Type': inline ? type : 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': type === 'application/pdf' && inline ? "default-src 'none'" : "default-src 'none'; sandbox",
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safe}"`,
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

export function uploadFileInfo(id) {
  const u = getUpload(id);
  if (!u) return null;
  const inline = u.kind === 'image' || u.kind === 'pdf';
  return { file: u.file, name: u.name, type: u.media_type, size: u.size, inline };
}

// ---- Image cache ----

let cacheBytes = null; // total size of the cache folder, counted on first use

function countCache() {
  let total = 0;
  try {
    for (const f of fs.readdirSync(IMG_DIR)) {
      try {
        total += fs.statSync(path.join(IMG_DIR, f)).size;
      } catch {
        // gone
      }
    }
  } catch {
    // no folder yet
  }
  return total;
}

function trimCache() {
  let files = [];
  try {
    files = fs.readdirSync(IMG_DIR).map((f) => {
      const full = path.join(IMG_DIR, f);
      const st = fs.statSync(full);
      return { full, size: st.size, at: st.mtimeMs };
    });
  } catch {
    return;
  }
  files.sort((a, b) => a.at - b.at);
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    if (total <= CACHE_MAX) break;
    try {
      fs.unlinkSync(f.full);
      total -= f.size;
    } catch {
      // in use or gone
    }
  }
  cacheBytes = total;
}

// Puts base64 image data into the cache and returns its URL, or null when it is not a usable image.
export function cacheImage(mediaType, b64) {
  if (!EXT_OF_TYPE[mediaType] || typeof b64 !== 'string' || !b64 || b64.length > 40 * 1024 * 1024) return null;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return null;
  // The bytes decide what the file is, not the type the transcript claims: anything that is not a real image is not cached.
  const ext = EXT_OF_TYPE[sniff(buf)];
  if (!ext) return null;
  const name = `${crypto.createHash('sha1').update(buf).digest('hex')}.${ext}`;
  const full = path.join(IMG_DIR, name);
  try {
    if (fs.existsSync(full)) {
      const now = new Date();
      fs.utimesSync(full, now, now); // recently shown stays longest
    } else {
      fs.mkdirSync(IMG_DIR, { recursive: true });
      if (cacheBytes === null) cacheBytes = countCache();
      fs.writeFileSync(full, buf);
      cacheBytes += buf.length;
      if (cacheBytes > CACHE_MAX) trimCache();
    }
  } catch {
    return null;
  }
  return `/api/imgcache/${name}`;
}

// The cache name an image would get, without writing it: the gallery lists every picture of a long conversation, and
// writing them all at once is a burst of new files (antivirus watches for that). The bytes are written the first time
// the picture is asked for: `later` remembers how to read them again (lazyImage below), for the newest LAZY_MAX names.
const LAZY_MAX = 2000;
const lazy = new Map(); // cache name -> () => { mediaType, data } | null
export function lazyImage(mediaType, b64, later) {
  if (!EXT_OF_TYPE[mediaType] || typeof b64 !== 'string' || !b64 || b64.length > 40 * 1024 * 1024) return null;
  const buf = Buffer.from(b64, 'base64');
  const ext = buf.length ? EXT_OF_TYPE[sniff(buf)] : null;
  if (!ext) return null;
  const name = `${crypto.createHash('sha1').update(buf).digest('hex')}.${ext}`;
  lazy.delete(name);
  lazy.set(name, later);
  if (lazy.size > LAZY_MAX) lazy.delete(lazy.keys().next().value);
  return `/api/imgcache/${name}`;
}

// A cached image by file name, or null (only names this module wrote, or will write on demand, are accepted).
export function cachedImageInfo(name) {
  const m = /^([0-9a-f]{40})\.(png|jpg|gif|webp)$/.exec(String(name));
  if (!m) return null;
  const file = path.join(IMG_DIR, name);
  if (!fs.existsSync(file) && lazy.has(name)) {
    try {
      const got = lazy.get(name)();
      if (got) cacheImage(got.mediaType, got.data); // written under the same name: the name is the hash of the bytes
    } catch {
      // the transcript moved or changed: no picture
    }
  }
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return { file, name, type: IMAGE_EXT[m[2]], size: st.size, inline: true };
  } catch {
    return null;
  }
}

export const SERVABLE_EXT = { ...IMAGE_EXT, pdf: 'application/pdf' };
