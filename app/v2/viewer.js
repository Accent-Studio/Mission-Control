/* Mission Control 2: local paths in Claude's text (md.js marks them as a.md-path), ported from redline.js.
   A web page (.html) opens in a new browser tab. A text file opens in the viewer, with the Documents reader look; a folder, or any
   other file, opens in Windows Explorer on the PC (the Finder on a Mac). A relative path is taken from the conversation's folder: the nearest [data-cwd],
   else the folder of the project the panel shows. */
(() => {
  const { esc, icon: I } = MC, api = MC.api;
  const isRemote = () => document.documentElement.hasAttribute('data-remote') || MC.remote === true;
  let el = null, cur = null, seq = 0, from = null;
  /* the file manager that shows a path: a path from the root is on a Mac */
  const fm = (p) => (/^\//.test(String(p || '')) ? 'Finder' : 'Explorer');
  const onPc = (p) => (fm(p) === 'Finder' ? 'on the Mac' : 'on the PC');

  const close = () => { if (!el) return; el.remove(); el = null; cur = null; seq++; if (from && from.focus && document.contains(from)) from.focus(); from = null; };
  function show(title, kind, sub) {
    close(); from = document.activeElement;
    el = document.createElement('div'); el.className = 'mdlg';
    el.innerHTML = `<div class="mbox mcv2${kind === 'Path' || kind === 'Pick' ? ' short' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="row mcv2-h">${I(kind === 'Doc' ? 'doc' : kind === 'Path' ? 'folder' : 'note')}<b class="ellip" title="${esc(title)}">${esc(title)}</b><span class="badge">${esc(kind)}</span><span class="grow"></span>`
      + `${isRemote() || kind === 'Path' || kind === 'Pick' ? '' : `<button class="btn sm ghost" data-reveal>${I('folder', 'sm')}Show in ${fm(sub)}</button>`}<button class="ibtn sm" data-x title="Close">${I('x', 'sm')}</button></div>`
      + `${sub ? `<div class="faint mono mcv2-sub ellip">${esc(sub)}</div>` : ''}<div class="mcv2-b dview"><div class="lv-empty">${I('loader', 'sm')}Opening</div></div></div>`;
    document.body.appendChild(el);
    el.onclick = (e) => { if (e.target === el || e.target.closest('[data-x]')) close(); if (e.target.closest('[data-reveal]') && cur) MC.revealPath(cur.path); };
    el.querySelector('[data-x]').focus();
    return ++seq;
  }
  const fill = (my, html) => { if (my !== seq || !el) return; const b = el.querySelector('.mcv2-b'); b.innerHTML = html; b.scrollTop = 0; };
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && el && !e.defaultPrevented) { e.preventDefault(); close(); } });

  async function open(info) {
    const my = show(info.name, info.view === 'markdown' ? 'Doc' : 'File', info.path); cur = info;
    try {
      const r = await api.get('/api/path/text?p=' + encodeURIComponent(info.path));
      let txt = r.text || '', cut = '';
      if (txt.length > 200000) { txt = txt.slice(0, 200000); cut = '<div class="faint">Shown up to the first 200,000 characters.</div>'; }
      fill(my, (info.view === 'markdown' ? `<div class="md">${MC.md(txt)}</div>` : `<pre class="mcv2-raw">${esc(txt)}</pre>`) + cut);
    } catch (e) { fill(my, `<div class="lv-err">Could not open this file: ${esc((e && e.message) || 'error')}</div>`); }
  }
  const note = (title, msg) => fill(show(title, 'Path', ''), `<div class="faint">${esc(msg)}</div>`);
  /* several projects hold the same relative path: each is a link, and a click opens it */
  const pick = (title, msg, choices) => fill(show(title, 'Pick', ''), `<div class="faint">${esc(msg)}</div><div class="mcv2-pick">${choices.map((c) => `<a class="md-path li" href="#" data-path="${esc(c.path)}">${I('folder', 'sm')}<span class="grow">${esc(c.project || c.path)}</span><span class="faint mono">${esc(c.path)}</span></a>`).join('')}</div>`);

  MC.revealPath = MC.revealPath || (async (p) => { try { await api.post('/api/path/reveal', { path: p }); } catch (e) { MC.toast('Could not open ' + fm(p) + ': ' + ((e && e.message) || 'error'), 'warn'); } });
  /* a local file as the server shows it in a browser tab (/local/C/a/b.html for C:\\a\\b.html, /local/Users/a/b.html for
     /Users/a/b.html), so its own relative links load too */
  const localUrl = (p) => '/local/' + String(p).replace(/^([A-Za-z]):[\\/]*/, '$1/').replace(/^\/+/, '').split(/[\\/]+/).map(encodeURIComponent).join('/');
  MC.openPath = async (raw, base) => {
    let info;
    try { info = await api.get('/api/path/info?p=' + encodeURIComponent(raw) + '&base=' + encodeURIComponent(base || '')); }
    catch (e) { note(String(raw), 'This path cannot be opened: ' + ((e && e.message) || 'error')); return; }
    if (info.kind === 'missing') return note(info.name, 'Not found: ' + info.path);
    if (info.kind === 'choice') return pick(info.name, 'Several projects have ' + info.path + '. Which one?', info.choices || []);
    if (info.kind === 'file' && info.readable && /\.html?$/i.test(info.path)) return void window.open(localUrl(info.path), '_blank', 'noopener');
    if (info.kind === 'file' && info.view) return open(info);
    if (isRemote()) return note(info.name, (info.kind === 'folder' ? 'Folders' : 'Files like this one') + ' open in ' + fm(info.path) + ' ' + onPc(info.path) + ': ' + info.path);
    if (info.kind === 'file' && !info.readable && /\.(md|markdown|txt|log|json|js|ts|css|html)$/i.test(info.path)) return note(info.name, 'Mission Control only shows files inside your project folders. It is here: ' + info.path);
    close(); MC.revealPath(info.path);
  };
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a.md-path'); if (!a) return;
    e.preventDefault();
    const c = a.closest('[data-cwd]'), p = MC.projectInfo ? MC.projectInfo(MC.curProject && MC.curProject()) : null;
    MC.openPath(a.dataset.path, (c && c.dataset.cwd) || (p && p.folder) || '');
  });
})();
