// The server's own output (what it prints in its window), kept in memory for the Console module's Server log tab.
// It is imported first by index.js, so every line from the start is caught. Nothing changes for the window itself: each
// write still goes to stdout or stderr as before, and is copied here line by line.
const MAX_LINES = 2000;
const MAX_LINE = 4000; // characters; a longer line (a dumped object) is cut

const lines = []; // { seq, t, err, text }
let seq = 0;
const partial = { out: '', err: '' };
const listeners = new Set();

function add(stream, text) {
  const line = { seq: ++seq, t: Date.now(), err: stream === 'err', text: text.length > MAX_LINE ? text.slice(0, MAX_LINE) + ' [...]' : text };
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  for (const fn of listeners) {
    try {
      fn(line);
    } catch {
      // a listener must never break the server's own output
    }
  }
}

function take(stream, chunk) {
  let s = partial[stream] + (typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  let i;
  while ((i = s.indexOf('\n')) >= 0) {
    add(stream, s.slice(0, i).replace(/\r$/, ''));
    s = s.slice(i + 1);
  }
  partial[stream] = s.length > MAX_LINE ? (add(stream, s), '') : s;
}

let installed = false;
export function installServerLog() {
  if (installed) return;
  installed = true;
  for (const [name, stream] of [['out', process.stdout], ['err', process.stderr]]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      try {
        take(name, chunk);
      } catch {
        // keep writing even if the copy failed
      }
      return write(chunk, ...rest);
    };
  }
}

// Lines after `since` (a seq), at most `max`, oldest first.
export function serverLogLines(since = 0, max = MAX_LINES) {
  const out = since ? lines.filter((l) => l.seq > since) : lines.slice();
  return out.length > max ? out.slice(-max) : out;
}

// fn(line) for every new line. Returns a function that stops it.
export function onServerLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

installServerLog();
