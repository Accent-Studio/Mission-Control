// One shared, safe markdown renderer: MC.md(src) returns HTML. Used by the Talk page, the project Sessions tab and the Docs tab.
// Safety: every character of the source is HTML-escaped before any tag is added, so injected markup shows as text.
// Only http, https and mailto addresses become links, and images are never loaded (the alt text becomes a link).
// GitHub style: headings, paragraphs (soft line breaks kept), emphasis, inline code, fenced code, nested lists,
// task lists, quotes, rules, tables and bare links. It never throws: any trouble falls back to escaped plain text.
window.MC = window.MC || {};

// Reading styles: a color and font theme plus a text size for every .md block (md.css holds the looks). The choice is kept per
// browser in localStorage (mc-md-theme, mc-md-size) and set on <html> as data-md-theme and data-md-size the moment this file
// runs, which is before any markdown is rendered (pages render it after a fetch), so there is no flash of the default look.
// A theme's Google Font is added as one stylesheet link, only for the theme in use; the Settings page loads all of them for its
// previews. GitHub and the default size need no font download. It never throws: storage may be blocked.
window.MC.mdStyle = (function () {
  var KEY_THEME = 'mc-md-theme', KEY_SIZE = 'mc-md-size';
  var GF = 'https://fonts.googleapis.com/css2?display=swap&family=';
  var THEMES = [
    { id: 'redline', name: 'Redline', font: 'Inter:ital,wght@0,400;0,500;0,600;0,700;1,400' }, // headings use Montserrat, which redline.css loads
    { id: 'github', name: 'GitHub Dark', font: '' },
    { id: 'dracula', name: 'Dracula', font: 'DM+Sans:ital,wght@0,400;0,500;0,700;1,400&family=DM+Mono:ital,wght@0,400;0,500;1,400' },
    { id: 'nord', name: 'Nord', font: 'Inter:ital,wght@0,400;0,500;0,600;0,700;1,400' },
    { id: 'gruvbox', name: 'Gruvbox Dark', font: 'Noto+Sans:ital,wght@0,400;0,500;0,700;1,400' },
    { id: 'solarized', name: 'Solarized Dark', font: 'Source+Sans+3:ital,wght@0,400;0,600;0,700;1,400&family=Fira+Mono:wght@400;500' },
    { id: 'catppuccin', name: 'Catppuccin Mocha', font: 'Inter:ital,wght@0,400;0,500;0,600;0,700;1,400' },
    { id: 'tokyo', name: 'Tokyo Night', font: 'Inter:ital,wght@0,400;0,500;0,600;0,700;1,400' },
  ];
  var SIZES = [{ id: 'small', name: 'Small' }, { id: 'medium', name: 'Medium' }, { id: 'large', name: 'Large' }];
  var DEFAULT_THEME = 'redline', DEFAULT_SIZE = 'medium';
  var root = typeof document !== 'undefined' ? document.documentElement : null;
  var theme = DEFAULT_THEME, size = DEFAULT_SIZE, listeners = [];

  function known(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* storage may be blocked */ } }

  function loadFont(id) {
    var t = known(THEMES, id);
    if (!t || !t.font || !root) return;
    var tag = 'mc-md-font-' + t.id;
    if (document.getElementById(tag)) return;
    var a = document.createElement('link');
    a.id = tag; a.rel = 'stylesheet'; a.href = GF + t.font;
    (document.head || root).appendChild(a);
  }
  function apply() {
    if (!root) return;
    if (theme === DEFAULT_THEME) root.removeAttribute('data-md-theme'); else root.setAttribute('data-md-theme', theme);
    loadFont(theme);
    if (size === DEFAULT_SIZE) root.removeAttribute('data-md-size'); else root.setAttribute('data-md-size', size);
  }
  function load() {
    var t = read(KEY_THEME), s = read(KEY_SIZE);
    theme = known(THEMES, t) ? t : DEFAULT_THEME;
    size = known(SIZES, s) ? s : DEFAULT_SIZE;
  }
  function tell() { listeners.slice().forEach(function (fn) { try { fn(theme, size); } catch (e) { /* a listener must not break the others */ } }); }

  load(); apply();
  // another tab or window of this browser changed the choice: follow it live
  if (typeof window.addEventListener === 'function') window.addEventListener('storage', function (e) {
    if (e.key !== KEY_THEME && e.key !== KEY_SIZE && e.key !== null) return;
    load(); apply(); tell();
  });

  return {
    themes: THEMES, sizes: SIZES,
    get theme() { return theme; },
    get size() { return size; },
    setTheme: function (id) { if (!known(THEMES, id)) return; theme = id; write(KEY_THEME, id); apply(); tell(); },
    setSize: function (id) { if (!known(SIZES, id)) return; size = id; write(KEY_SIZE, id); apply(); tell(); },
    loadFont: loadFont,
    loadAllFonts: function () { THEMES.forEach(function (t) { loadFont(t.id); }); },
    on: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
  };
})();

window.MC.md = (function () {
  var MAXDEPTH = 12; // quotes and lists nested deeper than this are shown as plain paragraphs

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ---------- inline ---------- */
  var ESCAPABLE = '\\`*_{}[]()#+-.!~|<>&"\'';
  var SAFE_URL = /^(?:https?:\/\/|mailto:)/i;
  var RE_SPECIAL = /[\\`]/g;
  // [text](url "title") and ![alt](url), run on already escaped text, so quotes in a title arrive as &quot;
  // The text may hold one badge image: [![alt](img)](url). Every run is length-bounded so a long line cannot make it slow.
  var RE_LINK = /(!?)\[((?:[^\[\]\n]|!\[[^\[\]\n]{0,300}\]\([^\s()]{0,300}\)){0,500})\]\(\s{0,40}([^\s()]{0,2000}(?:\([^\s()]{0,2000}\)[^\s()]{0,2000}){0,20})(?:\s{1,40}&quot;[^\n]{0,300}?&quot;)?\s{0,40}\)/g;
  var RE_BADGE = /!\[([^\[\]\n]*)\]\([^\s()]*\)/g;
  var RE_ANGLE = /&lt;(https?:\/\/[^\s&\u0000]*(?:&amp;[^\s&\u0000]*)*)&gt;/g;
  var RE_BARE = /(?<![\w\/@=.])https?:\/\/(?:(?!&lt;|&gt;|&quot;|&#39;)[^\s\u0000])+/g;

  function anchor(url, inner) { return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>'; }

  // Strikethrough, bold and italic on escaped text. Spans are length-bounded so a stray marker cannot make this slow.
  function emph(t) {
    // each step is skipped when its marker is absent, which is the common case for a table cell or a short line
    if (t.indexOf('~~') >= 0) t = t.replace(/~~(?=\S)([\s\S]{1,400}?)(?<=\S)~~/g, '<del>$1</del>');
    if (t.indexOf('*') >= 0) {
      t = t.replace(/\*\*\*(?=[^\s*])([\s\S]{1,400}?)(?<=[^\s*])\*\*\*/g, '<strong><em>$1</em></strong>');
      t = t.replace(/\*\*(?=\S)([\s\S]{1,400}?)(?<=\S)\*\*/g, '<strong>$1</strong>');
    }
    if (t.indexOf('__') >= 0) t = t.replace(/(?<![\w])__(?=\S)([\s\S]{1,400}?)(?<=\S)__(?![\w])/g, '<strong>$1</strong>');
    if (t.indexOf('*') >= 0) t = t.replace(/\*(?=[^\s*])([\s\S]{1,300}?)(?<=[^\s*])\*/g, '<em>$1</em>');
    if (t.indexOf('_') >= 0) t = t.replace(/(?<![\w])_(?=[^\s_])([\s\S]{1,300}?)(?<=[^\s_])_(?![\w])/g, '<em>$1</em>');
    return t;
  }

  // Parts that must not be touched by later steps (code, links, escaped characters) are parked as \u0000N\u0000.
  function inline(raw) {
    var store = [];
    function hold(h) { store.push(h); return '\u0000' + (store.length - 1) + '\u0000'; }
    var s = String(raw).replace(/\u0000/g, ''), n = s.length, i = 0, buf = '', m;
    var re = RE_SPECIAL; // shared: lastIndex is set before every use and inline() never calls itself
    while (i < n) {
      re.lastIndex = i; m = re.exec(s);
      if (!m) { buf += s.slice(i); break; }
      buf += s.slice(i, m.index); i = m.index;
      if (s.charAt(i) === '\\') {
        var nx = s.charAt(i + 1);
        if (nx && ESCAPABLE.indexOf(nx) >= 0) { buf += hold(esc(nx)); i += 2; } else { buf += '\\'; i++; }
        continue;
      }
      var k = 1; while (s.charAt(i + k) === '`') k++;
      var ticks = s.slice(i, i + k), p = i + k, found = -1;
      while ((p = s.indexOf(ticks, p)) >= 0) {
        if (s.charAt(p - 1) !== '`' && s.charAt(p + k) !== '`') { found = p; break; }
        p++; while (s.charAt(p) === '`') p++;
      }
      if (found < 0) { buf += ticks; i += k; continue; }
      var code = s.slice(i + k, found).replace(/\n/g, ' ');
      if (code.length > 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ' && code.trim()) code = code.slice(1, -1);
      buf += hold('<code class="md-ic">' + esc(code) + '</code>');
      i = found + k;
    }
    var t = esc(buf);

    if (t.indexOf('](') >= 0) t = t.replace(RE_LINK, function (all, bang, text, url) {
      // a parked piece (code span or escape) inside the address would expand inside the href attribute, so such links stay text
      var ok = SAFE_URL.test(url) && url.indexOf('\u0000') < 0;
      var flat = text.replace(RE_BADGE, '$1'); // a badge [![alt](img)](url) becomes a link whose text is the alt text
      if (bang) return ok ? hold(anchor(url, flat || url)) : flat; // images are never loaded: the alt text stands in
      if (!ok) return flat !== text ? flat : all;
      return hold(anchor(url, emph(flat) || url));
    });
    if (t.indexOf('&lt;http') >= 0) t = t.replace(RE_ANGLE, function (all, url) { return hold(anchor(url, url)); });
    if (t.indexOf('http') >= 0) t = t.replace(RE_BARE, function (u) {
      var k = u.length, tail, open = 0, shut = 0, q;
      for (q = 0; q < k; q++) { var pc = u.charCodeAt(q); if (pc === 40) open++; else if (pc === 41) shut++; } // counted once, not per trimmed character
      for (;;) {
        var c = u.charAt(k - 1);
        if (k > 8 && /[.,;:!?*_~\]]/.test(c)) { k--; continue; }
        if (k > 8 && c === ')' && open < shut) { k--; shut--; continue; }
        break;
      }
      tail = u.slice(k); u = u.slice(0, k);
      if (u.length <= 8) return u + tail;
      return hold(anchor(u, u)) + tail;
    });
    t = emph(t);

    if (t.indexOf('\u0000') < 0) return t;
    for (var pass = 0; pass < 5 && t.indexOf('\u0000') >= 0; pass++) t = t.replace(/\u0000(\d+)\u0000/g, function (all, d) { return store[+d] != null ? store[+d] : ''; });
    return t.replace(/\u0000/g, '');
  }

  /* ---------- blocks ---------- */
  // Block patterns avoid "." (it stops at U+2028, which makes a failed match retry from every position) and keep every
  // run of spaces either bounded or followed by something that cannot match the same characters.
  var RE_FENCE = /^ {0,3}(`{3,}|~{3,}(?!~))([^`]*)$/;
  var RE_HEAD = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
  var RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  var RE_QUOTE = /^ {0,3}>/;
  var RE_LI = /^( *)([-*+]|\d{1,9}[.)])( +|$)([^\n]*)$/;
  var RE_DELIM = /^ {0,3}\|?[ \t]{0,40}:?-+:?[ \t]{0,40}(?:\|[ \t]{0,40}:?-+:?[ \t]{0,40}){0,200}\|?[ \t]{0,40}$/;

  function indentOf(l) { var k = 0; while (l.charCodeAt(k) === 32) k++; return k; }
  function strip(l, k) { var d = Math.min(indentOf(l), k); return d ? l.slice(d) : l; }
  function fenceOpen(l) { var m = RE_FENCE.exec(l); return m ? { ch: m[1].charAt(0), len: m[1].length, lang: /^[ \t]*([^\s`]*)/.exec(m[2])[1] } : null; }
  // ATX heading: returns { lv, text } or null. The closing #s and the spaces around the text are cut by hand, not by a regex that backtracks.
  function headOf(l) {
    var m = RE_HEAD.exec(l); if (!m) return null;
    var t = l.slice(m[0].length), a = 0, b = t.length, c;
    while (a < b && ((c = t.charCodeAt(a)) === 32 || c === 9)) a++;
    while (b > a && ((c = t.charCodeAt(b - 1)) === 32 || c === 9)) b--;
    var e = b; while (e > a && t.charCodeAt(e - 1) === 35) e--;
    if (e < b && (e === a || (c = t.charCodeAt(e - 1)) === 32 || c === 9)) { b = e; while (b > a && ((c = t.charCodeAt(b - 1)) === 32 || c === 9)) b--; }
    return { lv: m[1].length, text: t.slice(a, b) };
  }
  function fenceClose(l, f) { var m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l); return !!m && m[1].charAt(0) === f.ch && m[1].length >= f.len; }
  function isBlockStart(l) { return !!(fenceOpen(l) || RE_HEAD.test(l) || RE_HR.test(l) || RE_QUOTE.test(l)); }

  function codeHtml(lines, lang) {
    lang = String(lang || '').replace(/[^\w+#.\-]/g, '').slice(0, 24);
    return '<div class="md-code">' + (lang ? '<span class="md-lang">' + esc(lang) + '</span>' : '') + '<pre><code>' + esc(lines.join('\n')) + '</code></pre></div>';
  }

  // Splits a table row on pipes that are not escaped and not inside a code span.
  function splitRow(s) {
    s = s.trim(); if (s.charAt(0) === '|') s = s.slice(1);
    var cells = [], cur = '', tick = 0, i = 0, n = s.length;
    while (i < n) {
      var c = s.charAt(i);
      if (c === '\\' && i + 1 < n) { cur += s.charAt(i + 1) === '|' ? '|' : c + s.charAt(i + 1); i += 2; continue; }
      if (c === '`') {
        var k = 1; while (s.charAt(i + k) === '`') k++;
        var run = s.slice(i, i + k);
        if (!tick) { if (s.indexOf(run, i + k) >= 0) tick = k; } else if (k === tick) tick = 0;
        cur += run; i += k; continue;
      }
      if (c === '|' && !tick) { cells.push(cur); cur = ''; i++; continue; }
      cur += c; i++;
    }
    if (cur.trim() || !cells.length) cells.push(cur);
    return cells;
  }

  function tableHtml(head, delim, rows) {
    var al = delim.map(function (d) { d = d.trim(); var l = d.charAt(0) === ':', r = d.charAt(d.length - 1) === ':'; return l && r ? ' class="md-c"' : r ? ' class="md-r"' : l ? ' class="md-l"' : ''; });
    var cols = head.length, h = '<div class="md-tablewrap"><table class="md-table"><thead><tr>';
    for (var c = 0; c < cols; c++) h += '<th' + al[c] + '>' + inline(head[c].trim()) + '</th>';
    h += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr>';
      for (var c = 0; c < cols; c++) h += '<td' + al[c] + '>' + (r[c] != null ? inline(r[c].trim()) : '') + '</td>';
      h += '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  function tableStart(L, i) {
    if (i + 1 >= L.length || L[i].indexOf('|') < 0 || !RE_DELIM.test(L[i + 1])) return null;
    var head = splitRow(L[i]), delim = splitRow(L[i + 1]);
    return head.length === delim.length ? { head: head, delim: delim } : null;
  }

  // Reads one list starting at L[i]; returns { html, next }. Items hold their own blocks, so lists nest by recursion.
  function parseList(L, i, depth) {
    var first = RE_LI.exec(L[i]), ordered = /\d/.test(first[2].charAt(0)), n = L.length, items = [], loose = false, startNo = ordered ? parseInt(first[2], 10) : 1;
    while (i < n) {
      var m = RE_LI.exec(L[i]);
      if (!m || RE_HR.test(L[i]) || /\d/.test(m[2].charAt(0)) !== ordered) break;
      var mi = m[1].length, sp = m[3].length, ci = mi + m[2].length + (sp === 0 || sp > 4 ? 1 : sp);
      var body = [m[4]], fence = fenceOpen(m[4]), j = i + 1, itemLoose = false;
      while (j < n) {
        var ln = L[j];
        if (fence) { var sl = strip(ln, ci); body.push(sl); if (fenceClose(sl, fence)) fence = null; j++; continue; }
        if (!ln.trim()) {
          var k = j + 1; while (k < n && !L[k].trim()) k++;
          if (k >= n) { j = k; break; }
          var nm = RE_LI.exec(L[k]), nind = indentOf(L[k]);
          if (nind >= ci || (nm && nind > mi)) { if (!nm) itemLoose = true; for (; j < k; j++) body.push(''); continue; }
          break;
        }
        var ind = indentOf(ln), lm = RE_LI.exec(ln);
        if (lm && ind <= mi) break;
        if (ind >= ci || (lm && ind > mi)) { var st = strip(ln, ci); body.push(st); fence = fenceOpen(st); j++; continue; }
        if (!isBlockStart(ln)) { body.push(ln.trim()); j++; continue; } // lazy continuation of the item's text
        break;
      }
      // trailing blank lines belong to no item
      while (body.length && !body[body.length - 1].trim()) body.pop();
      if (itemLoose) loose = true;
      items.push(body);
      i = j;
      var k2 = i; while (k2 < n && !L[k2].trim()) k2++;
      if (k2 > i && k2 < n) {
        var sm = RE_LI.exec(L[k2]);
        if (sm && !RE_HR.test(L[k2]) && /\d/.test(sm[2].charAt(0)) === ordered && indentOf(L[k2]) <= mi) { loose = true; i = k2; }
        else break;
      } else if (k2 >= n) { i = k2; break; }
    }
    var h = ordered ? '<ol class="md-ol"' + (startNo !== 1 ? ' start="' + startNo + '"' : '') + '>' : '<ul class="md-ul">';
    items.forEach(function (body) {
      var tm = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(body[0]), cls = '', box = '';
      if (tm) {
        var done = tm[1] !== ' ';
        body = [tm[2] || ''].concat(body.slice(1));
        cls = ' class="md-task"';
        box = '<span class="md-box' + (done ? ' on' : '') + '" role="img" aria-label="' + (done ? 'done' : 'not done') + '"></span>';
      }
      h += '<li' + cls + '>' + box + blocks(body, depth + 1, !loose) + '</li>';
    });
    return { html: h + (ordered ? '</ol>' : '</ul>'), next: i };
  }

  function paragraph(lines, tight) {
    // Indentation and runs of spaces are kept (md.css sets pre-wrap on these), so pasted logs and ASCII tables keep their shape.
    var h = inline(lines.map(function (l) { return l.trimEnd(); }).join('\n')).replace(/\n/g, '<br>');
    return tight ? '<span class="md-t">' + h + '</span>' : '<p class="md-p">' + h + '</p>';
  }

  function blocks(L, depth, tight) {
    var out = [], i = 0, n = L.length, m;
    if (depth > MAXDEPTH) return paragraph(L.filter(function (l) { return l.trim(); }), tight);
    while (i < n) {
      var ln = L[i];
      if (!ln.trim()) { i++; continue; }
      var f = fenceOpen(ln);
      if (f) {
        var code = []; i++;
        while (i < n && !fenceClose(L[i], f)) { code.push(L[i]); i++; }
        i++; // skip the closing fence; an unclosed one runs to the end, which is what a streaming answer needs
        out.push(codeHtml(code, f.lang));
        continue;
      }
      if ((m = headOf(ln))) {
        var lv = m.lv;
        out.push('<h' + lv + ' class="md-h md-h' + lv + '">' + inline(m.text) + '</h' + lv + '>');
        i++; continue;
      }
      if (RE_HR.test(ln)) { out.push('<hr class="md-hr">'); i++; continue; }
      if (RE_QUOTE.test(ln)) {
        var q = [];
        while (i < n && RE_QUOTE.test(L[i])) { q.push(L[i].replace(/^ {0,3}> ?/, '')); i++; }
        out.push('<blockquote class="md-quote">' + blocks(q, depth + 1, false) + '</blockquote>');
        continue;
      }
      if (RE_LI.test(ln)) {
        var r = parseList(L, i, depth);
        out.push(r.html); i = r.next; continue;
      }
      var tb = tableStart(L, i);
      if (tb) {
        var rows = []; i += 2;
        while (i < n && L[i].trim() && L[i].indexOf('|') >= 0 && !isBlockStart(L[i])) { rows.push(splitRow(L[i])); i++; }
        out.push(tableHtml(tb.head, tb.delim, rows));
        continue;
      }
      var para = [ln]; i++;
      while (i < n && L[i].trim()) {
        var nx = L[i], lm = RE_LI.exec(nx);
        if (isBlockStart(nx) || tableStart(L, i)) break;
        if (lm && lm[4] && !RE_HR.test(nx) && (!/\d/.test(lm[2].charAt(0)) || parseInt(lm[2], 10) === 1)) break;
        para.push(nx); i++;
      }
      out.push(paragraph(para, tight));
    }
    return out.join('');
  }

  function md(src) {
    try {
      src = String(src == null ? '' : src).replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
      var L = src.split('\n');
      for (var i = 0; i < L.length; i++) if (L[i].charCodeAt(0) === 9) L[i] = L[i].replace(/^\t+/, function (t) { return '    '.repeat(t.length); });
      return blocks(L, 0, false);
    } catch (e) {
      return '<p class="md-p">' + esc(src).replace(/\n/g, '<br>') + '</p>';
    }
  }
  md.esc = esc;
  return md;
})();
