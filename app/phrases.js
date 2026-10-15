// Spoken command phrases for the voice assistant, said at the END of live dictation text: "send it", "cancel that",
// "start over" (drop the words, keep listening) and "end conversation".
// No dependencies. Works in the browser (window.MCPhrases) and in node (import it, then read globalThis.MCPhrases).
(function (g) {
  const TRAIL = new RegExp('[\\s,;:' + String.fromCharCode(0x2013, 0x2014) + '-]+$', 'u'); // a dangling comma or dash left by the phrase
  const WORD = /[\p{L}\p{N}'’]+/gu;

  // lowercase, punctuation gone, apostrophes dropped, single spaces: "Send it!" -> "send it"
  function normalize(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Small words dictation adds or drops ("send a message" for "send message"): ignored on both sides when matching.
  const FILLER = new Set(['a', 'an', 'the']);
  const MAX_VARIANTS = 8;

  // A setting may hold several variations separated by commas: "send message, send a message". Returns them squashed.
  function variants(value) {
    return String(value == null ? '' : value)
      .split(',')
      .map((v) => v.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  // A phrase setting the owner may set: 1 to 8 variations separated by commas, each 2 to 30 characters of letters and
  // spaces. Returns { ok, phrase } (the variations joined by ", ", repeats dropped) or { ok:false, error }.
  function checkPhrase(value) {
    if (typeof value !== 'string') return { ok: false, error: 'must be text' };
    const list = variants(value);
    if (!list.length) return { ok: false, error: 'must be 2 to 30 characters' };
    if (list.length > MAX_VARIANTS) return { ok: false, error: `can hold at most ${MAX_VARIANTS} variations` };
    const seen = new Set();
    const out = [];
    for (const phrase of list) {
      if (phrase.length < 2 || phrase.length > 30) return { ok: false, error: 'must be 2 to 30 characters for each variation' };
      if (!/^[\p{L}]+(?: [\p{L}]+)*$/u.test(phrase)) return { ok: false, error: 'can only hold letters and spaces (commas between variations)' };
      const n = normalize(phrase);
      if (!seen.has(n)) {
        seen.add(n);
        out.push(phrase);
      }
    }
    return { ok: true, phrase: out.join(', ') };
  }

  // Does the text end with the phrase (whole words, trailing punctuation allowed)? Returns { rest } (the original text
  // without the phrase and without a dangling comma or dash) or null.
  function endMatch(text, phrase) {
    const all = normalize(phrase).split(' ').filter(Boolean);
    const skip = all.some((w) => !FILLER.has(w)); // a phrase made only of small words keeps them
    const want = skip ? all.filter((w) => !FILLER.has(w)) : all;
    if (!want.length) return null;
    const src = String(text == null ? '' : text);
    const toks = [];
    let m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(src))) toks.push({ w: normalize(m[0]), at: m.index });
    const real = toks.filter((t) => t.w && !(skip && FILLER.has(t.w)));
    if (real.length < want.length) return null;
    const tail = real.slice(real.length - want.length);
    if (tail.some((t, i) => t.w !== want[i])) return null;
    const rest = src.slice(0, tail[0].at).replace(TRAIL, '').trim();
    return { rest, words: want.length };
  }

  // What the text ends with: { kind:'send'|'cancel'|'rewrite'|'end', rest, empty? } or null. phrases holds any of
  // send, cancel, rewrite and end, each one phrase or several separated by commas. A send phrase with nothing before it
  // counts as a cancel (empty: true).
  // The longest phrase wins when several end the text; on a tie the first in KINDS wins (send loses to the others).
  const KINDS = ['end', 'cancel', 'rewrite', 'send'];
  function detect(text, phrases) {
    const p = phrases || {};
    let best = null;
    for (const kind of KINDS) {
      for (const v of variants(p[kind])) {
        const m = endMatch(text, v);
        if (m && (!best || m.words > best.m.words)) best = { kind, m };
      }
    }
    if (!best) return null;
    if (best.kind === 'send' && !best.m.rest) return { kind: 'cancel', rest: '', empty: true };
    return { kind: best.kind, rest: best.m.rest };
  }

  // Watches live text (each push is the latest full text). When the text ends with a phrase it waits to be sure the
  // model has stopped revising that word: the text must stay exactly the same for 400ms (a new partial that changes
  // anything restarts the wait; a repeat of the same text does not). Then onAct(kind, rest, empty) fires once; reset() starts over for the next dictation.
  class PhraseWatch {
    constructor(opt) {
      this.phrases = opt.phrases; // () => { send, cancel }
      this.onAct = opt.onAct;
      this.ms = opt.stableMs == null ? 400 : opt.stableMs;
      this.setTimer = opt.setTimer || ((f, ms) => setTimeout(f, ms));
      this.clearTimer = opt.clearTimer || ((t) => clearTimeout(t));
      this.reset();
    }
    reset() {
      if (this.timer != null) this.clearTimer(this.timer);
      this.timer = null;
      this.cand = null; // { kind, rest }
      this.acted = false;
      this.last = '';
    }
    push(text) {
      if (this.acted) return;
      this.last = String(text == null ? '' : text);
      const d = detect(this.last, this.phrases());
      if (!d) {
        this._drop();
        return;
      }
      if (this.cand && this.cand.text === this.last) return; // unchanged: the running wait goes on
      this._drop();
      this.cand = { kind: d.kind, rest: d.rest, empty: d.empty, text: this.last };
      this.timer = this.setTimer(() => {
        this.timer = null;
        this._fire();
      }, this.ms);
    }
    _drop() {
      if (this.timer != null) this.clearTimer(this.timer);
      this.timer = null;
      this.cand = null;
    }
    _fire() {
      if (!this.cand || this.acted) return;
      const d = this.cand;
      this._drop();
      this.acted = true;
      this.onAct(d.kind, d.rest, !!d.empty);
    }
  }

  g.MCPhrases = { normalize, variants, checkPhrase, endMatch, detect, PhraseWatch, DEFAULTS: { send: 'send it', cancel: 'cancel that', rewrite: 'start over', end: 'end conversation' } };
})(typeof window !== 'undefined' ? window : globalThis);
