// Tests for the shared markdown renderer app/md.js (MC.md). It is loaded into a minimal fake window, no browser needed.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, test } from 'node:test';
import { ROOT } from './harness.mjs';

const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'md.js'), 'utf8'), sandbox, { filename: 'md.js' });
const md = sandbox.MC.md;

describe('md: safety', () => {
  test('a script tag and other markup are shown as text', () => {
    const h = md('Hello <script>alert(1)</script> and <img src=x onerror=alert(1)>');
    assert.ok(!/<script/i.test(h));
    assert.ok(!/<img/i.test(h));
    assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
  test('on* attributes in the source never become attributes', () => {
    const h = md('<div onclick="evil()">x</div>\n\n[click](https://a.example/x" onmouseover="evil()) and `<b onload=1>`');
    assert.ok(!/<div/i.test(h));
    assert.ok(!/ onclick=/i.test(h.replace(/&quot;/g, '')) || h.includes('&lt;div onclick='));
    assert.ok(!/<[^>]* on\w+=/i.test(h), h);
  });
  test('quotes in a link address cannot break out of the attribute', () => {
    const h = md('[x](https://a.example/"onmouseover="alert(1))');
    // the quote arrives as &quot; inside href, so the tag still has exactly its three attributes
    assert.match(h, /<a href="[^"]*&quot;onmouseover=&quot;[^"]*" target="_blank" rel="noopener noreferrer">x<\/a>/, h);
  });
  test('javascript: and data: links stay text', () => {
    for (const bad of ['[a](javascript:alert(1))', '[a](JaVaScRiPt:alert(1))', '[a](data:text/html;base64,AAAA)', '[a](vbscript:x)', '[a](//evil.example/x)', '[a](/relative)']) {
      const h = md(bad);
      assert.ok(!/<a /.test(h), bad + ' -> ' + h);
    }
  });
  test('http, https and mailto links open safely in a new tab', () => {
    for (const good of ['https://example.com/a?b=1&c=2', 'http://example.com', 'mailto:me@example.com']) {
      const h = md(`[go](${good})`);
      assert.match(h, /<a href="[^"]+" target="_blank" rel="noopener noreferrer">go<\/a>/, h);
    }
    assert.ok(md('[go](https://example.com/a?b=1&c=2)').includes('href="https://example.com/a?b=1&amp;c=2"'));
  });
  test('images are never loaded: the alt text becomes a link', () => {
    const h = md('![a cat](https://example.com/cat.png)');
    assert.ok(!/<img/i.test(h));
    assert.match(h, /<a href="https:\/\/example.com\/cat.png"[^>]*>a cat<\/a>/);
    const bad = md('![a cat](javascript:alert(1))');
    assert.ok(!/<a |<img/i.test(bad));
    assert.ok(bad.includes('a cat'));
  });
  test('a code span or escape inside a link address cannot reach the href', () => {
    for (const bad of ['[a](https://x/`b`)', '[a](https://x/`" onmouseover="alert(1)`)', '[a](https://x/`<img src=x onerror=alert(1)>`)', '![a](https://x/`b`)', '[a](mailto:`q`)', '[a](https://x/\\")']) {
      // the link itself is refused (a bare address before the code span may still link, with a clean address)
      const h = md(bad), anchors = h.match(/<a /g) || [], clean = h.match(/<a href="(?:https?:\/\/|mailto:)[^"<>`]*" target="_blank" rel="noopener noreferrer">/g) || [];
      assert.equal(clean.length, anchors.length, bad + ' -> ' + h);
      assert.ok(!/\u0000/.test(h) && !/<img|<[^>]* on\w+=/i.test(h), bad + ' -> ' + h);
    }
    // a code span in the link text is fine
    assert.match(md('[`x`](https://a.example)'), /<a href="https:\/\/a.example"[^>]*><code class="md-ic">x<\/code><\/a>/);
  });
  test('a badge (image inside a link) becomes a link with the alt text', () => {
    const h = md('[![build status](https://img.shields.io/x.svg)](https://ci.example/run)');
    assert.equal(h, '<p class="md-p"><a href="https://ci.example/run" target="_blank" rel="noopener noreferrer">build status</a></p>');
    assert.ok(!h.includes('[') && !h.includes('<img'));
    assert.ok(md('[![](https://img.example/a.svg)](https://ci.example/run)').includes('>https://ci.example/run</a>'));
    const unsafe = md('[![alt](https://img.example/a.svg)](javascript:alert(1))');
    assert.ok(!unsafe.includes('<a ') && unsafe.includes('alt'), unsafe);
  });
  test('bare addresses become links, trailing punctuation stays outside', () => {
    const h = md('See https://example.com/path, and (https://example.com/x). Also https://example.com/a_b_c.');
    assert.match(h, /<a href="https:\/\/example.com\/path"[^>]*>https:\/\/example.com\/path<\/a>,/);
    assert.match(h, /<a href="https:\/\/example.com\/x"[^>]*>[^<]*<\/a>\)\./);
    assert.ok(h.includes('href="https://example.com/a_b_c"'));
    assert.ok(!h.includes('<em>'));
  });
  test('code is escaped and nothing inside it is formatted', () => {
    const h = md('`<b>*x*</b>` and\n\n```html\n<script>alert(1)</script> **no**\n```');
    assert.ok(!/<script/i.test(h));
    assert.ok(h.includes('<code class="md-ic">&lt;b&gt;*x*&lt;/b&gt;</code>'));
    assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt; **no**'));
  });
});

describe('md: inline', () => {
  test('bold, italic, strike', () => {
    assert.equal(md('**b** __b__ *i* _i_ ~~s~~'), '<p class="md-p"><strong>b</strong> <strong>b</strong> <em>i</em> <em>i</em> <del>s</del></p>');
  });
  test('snake_case_names and file_paths are not italicized', () => {
    const h = md('Use snake_case_names in my_file_paths/and_more.txt and _real italic_ here');
    assert.ok(!h.includes('<em>snake') && h.includes('snake_case_names') && h.includes('my_file_paths/and_more.txt'));
    assert.equal((h.match(/<em>/g) || []).length, 1);
    assert.ok(h.includes('<em>real italic</em>'));
  });
  test('stars with spaces around them stay stars', () => {
    const h = md('2 * 3 * 4 = 24');
    assert.ok(!h.includes('<em>'));
  });
  test('backslash escapes keep the marker as text', () => {
    assert.equal(md('\\*not italic\\*'), '<p class="md-p">*not italic*</p>');
  });
  test('soft line breaks are kept as <br>', () => {
    assert.equal(md('one\ntwo\nthree'), '<p class="md-p">one<br>two<br>three</p>');
  });
  test('indentation and runs of spaces inside a paragraph are kept', () => {
    assert.equal(md('x\n    indented\na    b'), '<p class="md-p">x<br>    indented<br>a    b</p>');
    assert.ok(md('col1    col2\nrow1    row2').includes('col1    col2<br>row1    row2'));
  });
  test('closing hashes and spaces are cut from a heading', () => {
    assert.ok(md('## Title ##  ').includes('>Title</h2>'));
    assert.ok(md('# #').includes('<h1 class="md-h md-h1"></h1>'));
    assert.ok(md('# C#').includes('>C#</h1>'));
    assert.ok(md('#   spaced   text   ').includes('>spaced   text</h1>'));
    assert.ok(!md('# x').includes('<h1'));
  });
  test('headings h1 to h6', () => {
    for (let n = 1; n <= 6; n++) assert.ok(md('#'.repeat(n) + ' Title').includes(`<h${n} class="md-h md-h${n}">Title</h${n}>`));
    assert.ok(!md('#hashtag').includes('<h1'));
    assert.ok(!md('####### seven').includes('<h7'));
  });
  test('rules and quotes (nested)', () => {
    assert.ok(md('---').includes('<hr'));
    assert.ok(md('* * *').includes('<hr'));
    const h = md('> one\n> > two\n> back');
    assert.equal((h.match(/<blockquote/g) || []).length, 2);
  });
});

describe('md: lists', () => {
  test('nested bullet lists', () => {
    const h = md('- a\n  - b\n    - c\n- d');
    assert.equal((h.match(/<ul/g) || []).length, 3);
    assert.equal((h.match(/<li/g) || []).length, 4);
    assert.ok(h.indexOf('>a<') < h.indexOf('>b<') && h.indexOf('>c<') < h.indexOf('>d<'));
    assert.match(h, /<li><span class="md-t">d<\/span><\/li>/);
  });
  test('all three bullet marks work, and two-space nesting under a number works', () => {
    assert.equal((md('* a\n* b').match(/<li/g) || []).length, 2);
    assert.equal((md('+ a\n+ b').match(/<li/g) || []).length, 2);
    const h = md('1. one\n  - sub\n2. two');
    assert.equal((h.match(/<ol/g) || []).length, 1);
    assert.equal((h.match(/<ul/g) || []).length, 1);
    assert.equal((h.match(/<li/g) || []).length, 3);
  });
  test('numbered lists keep their start number, with . and )', () => {
    assert.ok(md('3. c\n4. d').includes('<ol class="md-ol" start="3">'));
    assert.ok(md('1) a\n2) b').includes('<ol class="md-ol">'));
    assert.ok(md('7) a\n8) b').includes('start="7"'));
  });
  test('a list can follow a paragraph line directly, and a code fence can sit inside an item', () => {
    const h = md('Steps:\n- one\n- two\n\n1. run\n   ```sh\n   npm test\n   ```\n2. done');
    assert.equal((h.match(/<ul/g) || []).length, 1);
    assert.equal((h.match(/<ol/g) || []).length, 1);
    assert.ok(h.includes('npm test'));
    assert.equal((h.match(/<li/g) || []).length, 4);
  });
  test('task list items show a box, not a clickable input', () => {
    const h = md('- [ ] todo\n- [x] done\n- [X] done too');
    assert.ok(!/<input/i.test(h));
    assert.equal((h.match(/class="md-box"/g) || []).length, 1);
    assert.equal((h.match(/class="md-box on"/g) || []).length, 2);
    assert.ok(h.includes('todo') && h.includes('done too'));
  });
  test('a loose list gets paragraphs', () => {
    assert.ok(md('- a\n\n- b').includes('<p class="md-p">a</p>'));
  });
});

describe('md: code fences', () => {
  test('a fence keeps its language label and exact text', () => {
    const h = md('```js\nlet a = 1;\n  let b = "<2>";\n```');
    assert.ok(h.includes('<span class="md-lang">js</span>'));
    assert.ok(h.includes('let a = 1;\n  let b = &quot;&lt;2&gt;&quot;;'));
  });
  test('tilde fences and longer fences work, inner shorter fences are text', () => {
    assert.ok(md('~~~\nx\n~~~').includes('<pre><code>x</code></pre>'));
    const h = md('````\n```\ninner\n```\n````\n\nafter');
    assert.ok(h.includes('```\ninner\n```'));
    assert.ok(h.includes('<p class="md-p">after</p>'));
  });
  test('an unclosed fence runs to the end and never throws', () => {
    const h = md('text\n\n```python\nprint(1)\n**not bold**\n- not a list');
    assert.ok(h.includes('<pre><code>print(1)\n**not bold**\n- not a list</code></pre>'));
    assert.ok(!h.includes('<strong>') && !h.includes('<li'));
  });
  test('a fence cut mid-way (as the Sessions tab does) leaves balanced code', () => {
    const cut = ('```\n' + 'line\n'.repeat(1000)).slice(0, 2000) + '...';
    const h = md(cut);
    assert.equal((h.match(/<pre>/g) || []).length, 1);
    assert.equal((h.match(/<\/pre>/g) || []).length, 1);
  });
});

describe('md: tables', () => {
  test('a table with alignment', () => {
    const h = md('| Name | Qty | Price |\n|:-----|:---:|------:|\n| apple | 3 | 1.50 |\n| pear | 10 | 2 |');
    assert.ok(h.includes('<div class="md-tablewrap"><table'));
    assert.equal((h.match(/<th[ >]/g) || []).length, 3);
    assert.equal((h.match(/<td/g) || []).length, 6);
    assert.ok(h.includes('<th class="md-l">Name</th>') && h.includes('<th class="md-c">Qty</th>') && h.includes('<th class="md-r">Price</th>'));
  });
  test('rows without outer pipes, short rows and pipes in code or escaped', () => {
    const h = md('a | b\n--- | ---\n`x|y` | z\nonly |');
    assert.equal((h.match(/<td/g) || []).length, 4);
    assert.ok(h.includes('<code class="md-ic">x|y</code>'));
    assert.ok(md('| a | b |\n|---|---|\n| 1 \\| 2 | 3 |').includes('1 | 2'));
  });
  test('half-written tables while streaming stay readable text', () => {
    for (const part of ['| a | b |', '| a | b |\n|--', '| a | b |\n|---|', '| a | b |\n|---|---|', '| a | b |\n|---|---|\n| 1', '| a | b |\n|---|---|\n| 1 |']) {
      const h = md(part);
      assert.equal(typeof h, 'string');
      assert.ok(!/<script/i.test(h));
    }
    assert.ok(!md('| a | b |\n|---|').includes('<table'));
    assert.ok(md('| a | b |\n|---|---|').includes('<table'));
  });
  test('inline formatting works inside cells', () => {
    assert.ok(md('| a |\n|---|\n| **b** [l](https://x.example) |').includes('<strong>b</strong>'));
  });
});

describe('md: robustness and speed', () => {
  test('odd and broken input never throws', () => {
    const odd = ['', null, undefined, 42, '\u0000\u0000', '`', '``', '```', '[', '](', '![', '[]()', '[a](', '**', '__', '~~', '_', '*', '> ', '>>>>>>>>>>>>>>>>>>>>>>>>>> deep', '- '.repeat(500), '1.', '-', '|', '|||\n|||', '\t\t- tab', '\r\n\r\n- a\r\n- b', '&amp; &lt;b&gt;', '[a]: b', '<<<<>>>>', '\\', 'a\\', '`a\nb`'];
    for (const s of odd) assert.equal(typeof md(s), 'string');
    let deep = ''; for (let i = 0; i < 300; i++) deep += ' '.repeat(i * 2) + '- x\n';
    assert.equal(typeof md(deep), 'string');
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const bits = ['*', '_', '`', '~', '[', ']', '(', ')', '|', '-', '#', '>', '\n', ' ', 'a', '1.', '\n- ', '```', 'https://x.y', '**', '!['];
    for (let r = 0; r < 300; r++) {
      let s = ''; for (let i = 0, n = 5 + Math.floor(rnd() * 80); i < n; i++) s += bits[Math.floor(rnd() * bits.length)];
      const h = md(s);
      assert.equal(typeof h, 'string');
      assert.ok(!/<script|<img|<iframe| on\w+=/i.test(h), s);
    }
  });
  test('200KB of mixed markdown renders in under 200ms', () => {
    const block = '# Heading\n\nSome **bold** and _italic_ text with `code`, a [link](https://example.com) and snake_case_names.\nSecond line.\n\n- one\n  - nested *two*\n- three\n\n1. a\n2. b\n\n> quote\n\n```js\nconst x = 1 < 2;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n';
    let src = ''; while (src.length < 200000) src += block;
    md(src); // warm up the engine
    const t0 = process.hrtime.bigint();
    const h = md(src);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(h.length > 200000);
    assert.ok(ms < 200, `took ${ms.toFixed(0)} ms`);
  });
  test('long lines with stray markers stay fast', () => {
    for (const unit of ['*a ', '_a ', '**a ', '`a ', '[a](b ', '~~a ', '| a ']) assertFast(JSON.stringify(unit), unit.repeat(Math.ceil(100000 / unit.length)));
  });
  test('pathological 100KB inputs render in under 100ms each', () => {
    const N = 100000, rep = (u) => u.repeat(Math.ceil(N / u.length)).slice(0, N), sp = ' '.repeat(N);
    const cases = {
      'heading, spaces, U+2028': '# ' + sp + ' x', 'heading, spaces then text': '# a' + sp + 'x', 'heading, tabs': '# a' + '\t'.repeat(N) + 'x',
      'heading, closing hashes': '# a' + sp + '#' + sp + 'x', 'heading in a list': '- # a' + sp + 'x', 'heading in a quote': '> # a' + sp + 'x', 'many hashes': rep('#'),
      'bare address, many )': 'https://x' + rep(')'), 'bare address, mixed parens': 'https://x' + rep(')('), 'bare address, many dots': 'https://x' + rep('.'),
      'many bare addresses': rep('https://x.y). '),
      'link, spaces after (': '[a](' + sp + 'x', 'link, spaces inside': '[a](x' + sp + 'x', 'link, no spaces': rep('[a](b'), 'link, nested parens': rep('[a](x(x('),
      'link, quote titles': rep('[a](x &quot; '), 'link, quoted titles': rep('[a](x "t" '), 'link, badges': rep('[![a](b)](c'), 'link, many codes': '[a](x' + rep('`a`') + ')',
      'list, spaces, U+2028': '- ' + sp + ' x', 'list, spaces': '- ' + sp + ' x', 'list, deep': rep('  - a\n'), 'list, many items': rep('- a\n'), 'numbers': rep('9. a\n'),
      'table delimiter, spaces': 'a|b\n-' + sp + 'x', 'table delimiter, many cells': 'a|b\n' + rep('--|'), 'table, backticks': 'a|b\n-|-\n' + rep('`a|`'),
      'fence, long info then tick': '```' + 'a'.repeat(N) + '`', 'tilde fence, long run then tick': '~'.repeat(N) + '`', 'tilde fence, spaces then tick': '~~~' + sp + '`',
      'many fences': rep('```\na\n'), 'fences in list': rep('- ```\n  a\n'),
      'deep quotes': rep('> ') + 'x', 'rules': rep('- '), 'emphasis': rep('*a**b'), 'escapes': rep('\\*'), 'plain words': rep('word '), 'blank lines': rep('\n'),
      'trailing spaces in a paragraph': 'a' + sp + ' x\nb',
    };
    for (const [name, src] of Object.entries(cases)) assertFast(name, src);
  });
});

// Best of three runs, so a busy machine does not fail a test over one slow run.
function assertFast(name, src, limit = 100) {
  md(src.slice(0, 200)); // warm up
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = process.hrtime.bigint();
    assert.equal(typeof md(src), 'string');
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  assert.ok(best < limit, `${name} took ${best.toFixed(0)} ms`);
}
