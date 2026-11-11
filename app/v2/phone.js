/* Mission Control 2 on a phone: one screen at a time, in place of the tabs, the rail and the panels.
   Projects (the project list), Sessions (the conversations of the open project or of all of them, the last used first), Chat
   (one conversation full screen) and Docs (the project's documents, then one document). The bottom bar moves between them and
   steps aside while the keyboard is open; the top bar goes back. Android's back button goes back too: each screen is a step in
   the page history.
   The menu button at the top right opens a side panel with the other pages (Projects, the screens above) and a button for
   the text size and theme menu.
   A phone (or a window narrower than 700 px) gets this when the page loads; ?phone=1 or ?phone=0 forces it on or off.
   Loads after home.js; the page's own script calls MC.phoneStart() instead of building the desktop. */
(() => {
  const { $, $$, esc, icon: I, state: S } = MC;
  const q = new URLSearchParams(location.search).get('phone');
  MC.phone = q === '1' || (q !== '0' && (document.documentElement.hasAttribute('data-remote') || matchMedia('(max-width: 700px)').matches));
  if (!MC.phone) return;
  document.documentElement.classList.add('phone');

  const KEY = 'mc2-phone';
  let st = { screen: 'chats', project: null, session: null, scope: 'project' };
  try { st = { ...st, ...(JSON.parse(localStorage.getItem(KEY) || '{}') || {}) }; } catch (e) { /* a broken save: start fresh */ }
  const save = () => { st.project = S.project; st.session = /^new/.test(S.session || '') ? null : S.session; try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* storage off */ } };
  let el, convoVps = null, docsVps = null, tasksVps = null;

  /* what the top bar says, and where back goes, for each screen */
  const SCREENS = {
    projects: { title: () => 'Projects', back: null },
    chats: { title: () => 'Sessions', sub: () => (st.scope === 'all' ? 'All projects' : S.project || ''), back: 'projects' },
    convo: { title: () => (S.session ? MC.sessionById(S.session).title : 'Conversation'), sub: () => S.project || '', back: 'chats' },
    docs: { title: () => S.project || 'Documents', sub: () => (docOpen() ? 'Document' : 'Documents'), back: 'projects' },
    tasks: { title: () => 'Tasks', sub: () => (taskOpen() ? 'Task' : S.project || 'All projects'), back: 'projects' },
  };
  /* the screen the Projects page last showed, so the side panel can go back to it */
  let lastProj = 'projects';
  const docOpen = () => !!(docsVps && docsVps.all()[0].state.doc);
  const taskOpen = () => !!(tasksVps && tasksVps.all()[0].state.open);
  const closeTask = () => { delete tasksVps.all()[0].state.open; tasksVps.refresh(['tasks']); paintTop(); };

  function build() {
    el = document.createElement('div'); el.className = 'ph';
    el.innerHTML = `<header class="ph-h"><button class="ibtn ph-back" data-back title="Back">${I('arrowL')}</button><div class="ph-t"><b class="ellip"></b><span class="ellip faint"></span></div><button class="ibtn" data-more title="More">${I('more')}</button><button class="ibtn" data-side title="Pages">${I('menu')}</button></header>
      <main class="ph-b"><section class="ph-s" data-s="projects"><div class="tree ph-tree"></div></section><section class="ph-s" data-s="chats"><div class="ph-sess" data-sesstree></div></section><section class="ph-s ph-vp" data-s="convo"></section><section class="ph-s ph-vp" data-s="docs"></section><section class="ph-s ph-vp" data-s="tasks"></section></main>
      <nav class="ph-n">${[['projects', 'folder', 'Projects'], ['chats', 'list', 'Sessions'], ['convo', 'chat', 'Chat'], ['docs', 'doc', 'Docs'], ['tasks', 'tasks', 'Tasks']].map(([k, ic, l]) => `<button data-nav="${k}">${I(ic)}<span>${l}</span></button>`).join('')}</nav>`;
    document.body.appendChild(el);
    el.querySelector('[data-back]').onclick = () => history.back();
    el.querySelector('[data-side]').onclick = () => openSide(true);
    el.querySelector('[data-more]').onclick = (e) => { if (st.screen === 'convo' && S.session && !/^new/.test(S.session)) MC.sessionMenu(e.currentTarget, S.session); else moreMenu(e.currentTarget); };
    /* pull to refresh at the top of a screen: the conversations are read again; Projects and Docs reload the page, as the
       menu's Reload does. A conversation is pulled up at its end instead (live.js) */
    MC.pull.box($('[data-s="chats"]', el), 'top', () => (st.scope === 'all' ? ((ALL.at = 0), loadAll()) : H().pidOf() && H().loadList(H().pidOf())));
    MC.pull.box($('[data-s="projects"]', el), 'top', () => location.reload());
    MC.pull.box($('[data-s="docs"]', el), 'top', () => location.reload());
    /* a document opened or closed in the Docs screen: the top bar follows */
    el.querySelector('[data-s="docs"]').addEventListener('click', () => setTimeout(paintTop));
    el.querySelector('[data-s="tasks"]').addEventListener('click', () => setTimeout(paintTop));
    el.querySelector('.ph-n').onclick = (e) => {
      const b = e.target.closest('[data-nav]'); if (!b) return;
      const k = b.dataset.nav;
      if (k === 'docs' && st.screen === 'docs' && docOpen()) { docsVps.all()[0].state.doc = null; docsVps.refresh(['docs']); paintTop(); }
      else if (k === 'tasks' && st.screen === 'tasks' && taskOpen()) closeTask();
      else go(k);
    };
  }

  function paintTop() {
    const sc = SCREENS[st.screen];
    $('.ph-t b', el).textContent = sc.title();
    $('.ph-t span', el).textContent = sc.sub ? sc.sub() : '';
    $('.ph-back', el).style.visibility = sc.back || (st.screen === 'docs' && docOpen()) || (st.screen === 'tasks' && taskOpen()) ? '' : 'hidden';
    $$('[data-nav]', el).forEach((b) => b.classList.toggle('on', b.dataset.nav === st.screen));
    el.dataset.screen = st.screen;
  }

  /* ---------- the side panel: the other pages, and the text size and theme menu ---------- */
  let side = null;
  function openSide(on) {
    if (!side) {
      side = document.createElement('div'); side.className = 'ph-side';
      side.innerHTML = `<div class="ph-scrim" data-sx></div><nav class="ph-sp"><div class="ph-sph"><b>Mission Control</b><span class="grow"></span><button class="ibtn" data-sx title="Close">${I('x')}</button></div>
        <div class="ph-spl">${[['projects', 'folder', 'Projects']].map(([k, ic, l]) => `<button class="ph-spi" data-sp="${k}">${I(ic)}<span>${l}</span></button>`).join('')}</div>
        <span class="grow"></span><button class="btn sm ph-look" data-slook>${I('type', 'sm')}Text size and theme</button></nav>`;
      document.body.appendChild(side);
      side.onclick = (e) => {
        if (e.target.closest('[data-sx]')) { openSide(false); return; }
        if (e.target.closest('[data-slook]')) { moreMenu(e.target.closest('[data-slook]')); return; }
        const b = e.target.closest('[data-sp]'); if (!b) return;
        openSide(false);
        go(SCREENS[lastProj] && !SCREENS[lastProj].page ? lastProj : 'projects');
      };
    }
    $$('[data-sp]', side).forEach((b) => b.classList.toggle('on', b.dataset.sp === (SCREENS[st.screen].page ? st.screen : 'projects')));
    side.classList.toggle('on', on);
  }
  /* the screen: its section shows, and it is drawn fresh */
  function show(screen) {
    if (!SCREENS[screen]) screen = 'chats';
    if ((screen === 'chats' || screen === 'convo' || screen === 'docs') && !S.project) screen = 'projects';
    st.screen = screen; save();
    if (!SCREENS[screen].page) lastProj = screen;
    $$('.ph-s', el).forEach((s) => s.classList.toggle('on', s.dataset.s === screen));
    if (screen === 'projects') MC.renderProjectTree($('.ph-tree', el), { onPick: () => {} });
    if (screen === 'chats') paintList();
    if (screen === 'convo') {
      if (!convoVps) convoVps = new MC.Viewports($('[data-s="convo"]', el), [{ w: 1, rows: [{ mod: 'convo', state: { ls: false, lu: false } }] }], { active: () => st.screen === 'convo', noOpen: true });
      else { convoVps.wake(); convoVps.refresh(['convo']); }
    }
    if (screen === 'docs') {
      if (!docsVps) docsVps = new MC.Viewports($('[data-s="docs"]', el), [{ w: 1, rows: [{ mod: 'docs' }] }], { active: () => st.screen === 'docs', noOpen: true });
      else { docsVps.wake(); docsVps.refresh(['docs']); }
    }
    /* every project's tasks, or the picked project's (the panel's own switch), as a list: the board is too wide here */
    if (screen === 'tasks') {
      if (!tasksVps) tasksVps = new MC.Viewports($('[data-s="tasks"]', el), [{ w: 1, rows: [{ mod: 'tasks', tab: 'List' }] }], { active: () => st.screen === 'tasks', noOpen: true });
      else { tasksVps.wake(); tasksVps.refresh(['tasks']); }
    }
    paintTop();
  }
  /* a new step: Android's back button and the top bar's back arrow return from it */
  function go(screen) {
    if (screen === st.screen) { show(screen); return; }
    history.pushState({ ph: screen }, '');
    show(screen);
  }
  /* back first closes what lies on top: a picture, the usage panel, a menu or a small window (the top one only) */
  function closeOverlay() {
    if (side && side.classList.contains('on')) { openSide(false); return true; }
    const o = [...document.querySelectorAll('.lb, .upop, .menu, .mdlg')].pop(); if (!o) return false;
    if (o.classList.contains('menu')) { MC.closeMenus(); return true; }
    o.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    if (o.isConnected) { const x = o.querySelector('[data-x]'); if (x) x.click(); }
    if (o.isConnected) o.remove();
    return true;
  }
  addEventListener('popstate', (e) => {
    if (closeOverlay()) { history.pushState({ ph: st.screen }, ''); return; }
    /* back from an open document: the list of documents */
    if (st.screen === 'docs' && docOpen()) { docsVps.all()[0].state.doc = null; docsVps.refresh(['docs']); paintTop(); history.pushState({ ph: 'docs' }, ''); return; }
    /* back from an open task: the list */
    if (st.screen === 'tasks' && taskOpen()) { closeTask(); history.pushState({ ph: 'tasks' }, ''); return; }
    const to = (e.state && e.state.ph) || SCREENS[st.screen].back;
    if (to) show(to); else history.pushState({ ph: st.screen }, ''); /* the first screen: back stays here */
  });

  /* the server on the PC restarts; the runner keeps the conversations going, and the page reconnects by itself */
  async function restartServer() {
    if (!(await MC.askYes('Restart the server?', 'Running conversations keep going. The phone drops for a few seconds.', 'Restart'))) return;
    try { await MC.api.post('/api/server/restart', { confirm: true }); MC.toast('Restarting. Back in a few seconds.', 'server'); }
    catch (e) { MC.toast('Not restarted: ' + ((e && e.message) || 'no answer'), 'warn'); }
  }
  /* the PIN lock of this PC (server/services/pcLock.js): the other computer is shut out until its PIN is typed there */
  let lockSt = null;
  const readLock = () => MC.api.get('/api/pc-lock').then((l) => (lockSt = l)).catch(() => null);
  readLock();
  MC.events.on('pc-lock', (l) => { lockSt = l; });
  function moreMenu(anchor) {
    readLock();
    const lockItem = !MC.live.hub && lockSt && lockSt.pin && lockSt.unlocked ? [{ id: 'lock', label: 'Lock the other computer', sub: 'open until ' + new Date(lockSt.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), icon: 'lock' }] : [];
    MC.menu(anchor, [{ h: 'Text size' }, ...[['S', 'Small'], ['M', 'Medium'], ['L', 'Large']].map(([z, l]) => ({ id: 'z:' + z, label: l, icon: 'type', on: S.size === z })),
      { h: 'Theme' }, ...[['slate', 'Slate'], ['redline', 'Redline'], ['midnight', 'Midnight']].map(([t, l]) => ({ id: 't:' + t, label: l, icon: 'moon', on: document.documentElement.dataset.theme === t })),
      { sep: 1 }, { id: 'reload', label: 'Reload', icon: 'refresh' }, ...(MC.live.hub ? [] : [{ id: 'restart', label: 'Restart the server', sub: 'conversations keep going', icon: 'server' }]), ...lockItem],
    (id) => {
      if (id.startsWith('z:')) MC.setSize(id.slice(2));
      else if (id.startsWith('t:')) MC.setTheme(id.slice(2));
      else if (id === 'reload') location.reload();
      else if (id === 'restart') restartServer();
      else if (id === 'lock') MC.api.post('/api/pc-lock/lock', {}).then((l) => { lockSt = l; MC.toast('Locked', 'lock'); }, (e) => MC.toast('Not locked: ' + ((e && e.message) || 'no answer'), 'warn'));
    }, { alignRight: true });
  }

  /* ---------- Sessions: this project's conversations, or every project's, the last used first ---------- */
  const H = () => MC.live.helpers, LV = () => MC.live;
  const ALL = { rows: [], limit: 60, more: false, loaded: false, busy: false, at: 0 };
  async function loadAll() {
    if (ALL.busy) return; ALL.busy = true;
    try {
      const r = await MC.api.get(`/api/sessions?limit=${ALL.limit + 1}&archived=hide`);
      let list = Array.isArray(r) ? r : (r && r.sessions) || [];
      /* the other computers' conversations too, as the hub lists them (on a PC, one of the linked PC's opens live through the
         link). The machines are asked for when the tree has not read them yet */
      let others = Object.keys(LV().remote);
      if (!others.length) { const m = await MC.api.get('/api/machines').catch(() => null); others = ((m && m.machines) || []).map((x) => x.id); }
      if (others.length) {
        await Promise.all(others.map((id) => H().loadRemote(id, true)));
        list = list.concat(...Object.values(LV().remote).map((R) => (R.rows || []).filter((x) => !x.archived))).sort((a, b) => (H().toMs(b.lastAt) || 0) - (H().toMs(a.lastAt) || 0)).slice(0, ALL.limit + 1);
      }
      ALL.more = list.length > ALL.limit; ALL.rows = list.slice(0, ALL.limit); ALL.err = null;
      ALL.rows.forEach((x) => { LV().rows[x.id] = { ...(LV().rows[x.id] || {}), ...x }; });
    } catch (e) { ALL.err = H().errText(e); }
    ALL.loaded = true; ALL.busy = false; ALL.at = Date.now(); paintList();
  }
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  /* the project a conversation belongs to, by name: a project, a root folder, or Simple chats */
  const projOf = (r) => {
    if (r.kind === 'chat') return 'Simple chats';
    if (r.machine) { const p = LV().byId['m:' + r.machine.id + ':' + (r.projectName || '')]; return p ? p.name : null; }
    const p = r.project && LV().byId[r.project]; if (p) return p.name;
    const root = LV().roots.find((x) => norm(x.folder) === norm(r.cwd)); return root ? root.name : null;
  };
  function paintList() {
    const box = el && $('.ph-sess', el); if (!box || st.screen !== 'chats') return;
    const all = st.scope === 'all', key = H().pidOf(), L = all ? ALL : LV().lists[key];
    if (all && (!ALL.loaded || Date.now() - ALL.at > 15000)) loadAll(); else if (!all && key && (!L || (!L.loaded && !L.busy))) H().loadList(key);
    /* a row renamed, pinned or archived since the list loaded: what live.js knows now wins */
    const rows = L && L.loaded ? L.rows.filter((r) => !all || LV().rows[r.id]).map((r) => (all ? { ...r, ...LV().rows[r.id] } : r)).sort((a, b) => (H().toMs(b.lastAt) || 0) - (H().toMs(a.lastAt) || 0)) : [];
    const row = (r) => {
      const s = MC.sessionById(r.id), p = all ? projOf(r) : S.project;
      const dot = { run: '<span class="dot run pulse"></span>', wait: '<span class="dot warn"></span>' }[s.state] || '';
      const label = { run: 'running', wait: 'needs you', idle: 'warm' }[s.state] || H().ago(r.lastAt);
      return `<div class="pr ${r.id === S.session ? 'on' : ''}" data-psess="${esc(r.id)}" data-pproj="${esc(p || '')}"><span class="pr-ic">${I(r.readOnly ? 'pc' : r.locked ? 'lock' : r.pinned ? 'pin' : r.kind === 'chat' ? 'chat' : 'chat', 'sm')}</span>`
        + `<div class="pr-m"><b class="ellip">${esc(r.title || 'Untitled conversation')}</b><span class="pr-s">${dot}<span>${esc(label)}</span>${all && p ? `<span class="pr-p">${esc(p)}</span>` : ''}</span></div>`
        + `<button class="ibtn" data-pmenu="${esc(r.id)}" title="Rename, pin, lock, archive">${I('more', 'sm')}</button></div>`;
    };
    box.innerHTML = `<div class="ph-sw"><div class="seg"><button class="${all ? '' : 'on'}" data-scope="project">${esc(S.project || 'This project')}</button><button class="${all ? 'on' : ''}" data-scope="all">All projects</button></div></div>`
      + (S.project && !H().hubKey(key) ? `<button class="pr pr-new" data-pnew><span class="pr-ic">${I('plus', 'sm')}</span><div class="pr-m"><b>New conversation</b><span class="pr-s">in ${esc(S.project)}</span></div></button>` : '')
      + (!L || !L.loaded ? `<div class="lv-empty">${I('loader', 'sm')}Loading conversations</div>` : L.err ? `<div class="lv-err">${esc(L.err)}</div>` : rows.length ? rows.map(row).join('') : '<div class="lv-empty">No conversations yet.</div>')
      + (L && L.more ? `<button class="pr pr-more" data-pmore><span class="pr-ic">${I('chev', 'sm')}</span><div class="pr-m"><b>Show more</b></div></button>` : '');
  }
  function listClick(e) {
    const sc = e.target.closest('[data-scope]'); if (sc) { st.scope = sc.dataset.scope; save(); paintList(); paintTop(); return; }
    const m = e.target.closest('[data-pmenu]'); if (m) { MC.sessionMenu(m, m.dataset.pmenu); return; }
    if (e.target.closest('[data-pmore]')) { if (st.scope === 'all') { ALL.limit += 60; loadAll(); } else { const L = LV().lists[H().pidOf()]; if (L) { L.limit += 40; H().loadList(H().pidOf()); } } return; }
    if (e.target.closest('[data-pnew]')) { MC.setSession(H().newKey(H().isChatId(H().pidOf()))); go('convo'); return; }
    const r = e.target.closest('[data-psess]'); if (!r) return;
    const name = r.dataset.pproj;
    if (name && name !== S.project && LV().byName[name]) { S.project = name; S.draft = ''; S.picked = new Set(); if (docsVps) docsVps.all()[0].state.doc = null; }
    MC.setSession(r.dataset.psess); go('convo');
  }

  /* ---------- the keyboard: while it is open the bottom bar steps aside ----------
     A touch screen: the page shrinks while the keyboard is up, so a page much shorter than the tallest seen at this width means it
     is open (Back closes it but leaves the box focused, and the bar comes back). Without a touch screen the focus decides. */
  const touch = matchMedia('(pointer:coarse)'), tallest = {};
  const kbOpen = () => { const h = window.visualViewport ? visualViewport.height : innerHeight, w = innerWidth; if (!(h <= (tallest[w] || 0))) tallest[w] = h; return h < tallest[w] * 0.8; };
  const typing = () => { const a = document.activeElement; return !!a && !!el && el.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(checkbox|radio|button)$/.test(a.type))); };
  /* a panel opened while the keyboard was up closes with it: Android's back then closes both (the page never sees that back) */
  let wasKb = false;
  const paintKb = () => {
    if (!el) return;
    const kb = touch.matches ? typing() && kbOpen() : typing();
    el.classList.toggle('kb', kb);
    if (wasKb && !kb) { const o = [...document.querySelectorAll('.lb, .upop, .menu, .mdlg')].pop(); if (o && o._kb) closeOverlay(); }
    wasKb = kb;
  };
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1 && n.matches('.lb, .upop, .menu, .mdlg') && el && el.classList.contains('kb')) n._kb = true; }))).observe(document.body, { childList: true });
  function watchKb() {
    kbOpen();
    el.addEventListener('focusin', () => { paintKb(); setTimeout(paintKb, 400); });
    el.addEventListener('focusout', () => setTimeout(paintKb));
    addEventListener('resize', paintKb);
    if (window.visualViewport) visualViewport.addEventListener('resize', paintKb);
    /* the buttons under the message box keep the focus, so the bar does not come back and shove them away mid-tap */
    el.addEventListener('mousedown', (e) => { if (el.classList.contains('kb') && e.target.closest('.cbox button')) e.preventDefault(); });
  }

  /* the page's own script calls this instead of building the desktop */
  MC.phoneStart = () => {
    try { localStorage.setItem('mc2-on-phone', '1'); } catch (e) { /* storage off */ }
    build(); watchKb();
    $('.ph-sess', el).addEventListener('click', listClick);
    /* the lists live.js repaints (a run starts or ends, a list loads) include this one */
    const orig = MC.renderSessionTree; MC.renderSessionTree = (box) => (box.classList.contains('ph-sess') ? paintList() : orig(box));
    /* what live.js and the panels ask of the desktop, answered for the one screen */
    MC.D = { tabs: () => [], cur: () => null, showTab() {}, newTab: (n, o) => { if (n) { S.project = n; S.session = (o && o.session) || null; go(S.session ? 'convo' : 'chats'); } }, drawTabs() {}, drawSbar() {}, drawRail() {}, drawBar() {}, saveTabs: save, setPage() {}, allVps: () => [].concat(convoVps ? convoVps.all() : [], docsVps ? docsVps.all() : []), L: null };
    MC.on('project', (name) => { S.project = name; S.session = null; S.draft = ''; S.picked = new Set(); save(); if (docsVps) docsVps.all()[0].state.doc = null; go('chats'); });
    MC.on('session', () => { save(); if (st.screen === 'convo') paintTop(); });
    MC.on('open', (m) => { if (m === 'convo') go('convo'); if (m === 'docs') go('docs'); });
    MC.on('stats', () => { if (st.screen === 'convo') paintTop(); });
    MC.live.ready.then(() => {
      const known = (n) => !!MC.live.byName[n];
      S.project = known(st.project) ? st.project : null; S.session = S.project ? st.session : null; S.picked = new Set(); S.draft = '';
      history.replaceState({ ph: 'projects' }, '');
      if (st.screen !== 'projects' && S.project) { history.pushState({ ph: 'chats' }, ''); if (st.screen !== 'chats') history.pushState({ ph: st.screen }, ''); }
      show(S.project ? st.screen : 'projects');
    });
  };
})();
