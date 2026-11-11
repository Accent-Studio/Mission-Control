/* Mission Control 2: the real data behind the new shell.
   Projects, conversations, sending, the live answer, permission questions, drafts, Send later, other PCs and dictation come
   from the server, through the same calls as today's Talk page (chat.html). Modules not ported yet still show sample data.
   Load order: api.js, md.js, data.js, modules.js, this file, then the shell script in index.html. */
(() => {
  const { $$, esc, icon: I, state: S } = MC;
  const D = MC.data, M = MC.modules, api = MC.api;
  const enc = encodeURIComponent;
  const LV = MC.live = {
    projects: [], roots: [], byName: {}, byId: {}, lists: {}, rows: {}, runs: [], opts: null, prefs: {}, usage: null,
    conv: {}, store: {}, view: {}, turns: {}, stats: {}, pick: {}, modePick: {}, held: [], holding: 0, att: {}, open: {}, delayed: [], newDrafts: [], remote: {},
  };
  D.chats = []; /* the sample chats go: the real ones load below */
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  MC.tabId = MC.tabId || uuid(); /* this page, so it can skip the echo of its own draft saves */

  /* ---------- small helpers ---------- */
  const toMs = (iso) => { const t = typeof iso === 'number' ? iso : Date.parse(iso); return isFinite(t) ? t : null; };
  const hhmm = (iso) => { const t = toMs(iso); return t == null ? '' : new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); };
  const ago = (iso) => {
    const t = toMs(iso); if (t == null) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + ' m'; if (s < 86400) return Math.floor(s / 3600) + ' h';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' d';
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const whenText = (iso) => { const t = toMs(iso); if (t == null) return ''; const d = new Date(t), today = new Date(); const day = d.toDateString() === today.toDateString() ? 'today' : d.toDateString() === new Date(Date.now() + 86400000).toDateString() ? 'tomorrow' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); return hhmm(t) + ' ' + day; };
  const dur = (ms) => { if (ms == null || !(ms >= 0)) return ''; const s = Math.round(ms / 1000); if (s < 60) return s + ' s'; const m = Math.floor(s / 60); if (m < 60) return m + ' m ' + (s % 60) + ' s'; return Math.floor(m / 60) + ' h ' + (m % 60) + ' m'; };
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const tok = (n) => (n == null || !isFinite(n)) ? '' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k tokens' : n + ' tokens';
  const cap = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n) + '\n\n[... ' + (t.length - n).toLocaleString('en-US') + ' more characters]' : t; };
  const errText = (e) => (e && ((e.data && e.data.message) || e.message)) || 'unknown error';
  const isNew = (sid) => !sid || /^newc?:/.test(sid);
  const newKey = (chat) => (chat ? 'newc:' : 'new:') + uuid();
  const lsGet = (k, d) => { try { const v = JSON.parse(MC.store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => MC.store.set(k, JSON.stringify(v));

  /* open and closed folders and sections, remembered on this PC (project tree and session lists alike) */
  const CLOSED = lsGet('mc2-closed', {});
  const isClosed = (k, dflt) => (k in CLOSED ? !!CLOSED[k] : !!dflt);
  const toggleClosed = (k, dflt) => { CLOSED[k] = !isClosed(k, dflt); lsSet('mc2-closed', CLOSED); };
  /* pinned projects, remembered on this PC: they go to Pinned at the top of the tree */
  let PINS = lsGet('mc2-pins', []);
  const isPinned = (name) => PINS.includes(name);
  const togglePin = (name) => { PINS = isPinned(name) ? PINS.filter((n) => n !== name) : PINS.concat([name]); lsSet('mc2-pins', PINS); };
  const pinSlot = (attr, on, what) => `<button class="tw tpin ${on ? 'on' : ''}" ${attr} title="${on ? 'Unpin' : 'Pin'} ${what}">${I('pin', 'sm')}</button>`;

  /* ---------- projects and root folders ---------- */
  const TINTS = ['#8fb0ff', '#e8a25a', '#7fd0c8', '#b59cff', '#d58fb8', '#9ccf7a', '#c9b27a', '#7aa7c9', '#c97a7a', '#e0b04a', '#d0705a', '#8fc07a', '#7a9fe0', '#c08fd0', '#a08fd5', '#8fd5a0', '#d5c08f'];
  const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const normPath = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const leaf = (p) => String(p || '').split(/[\\/]+/).filter(Boolean).pop() || String(p);
  const projOfRow = (r) => (r && (r.project || (r.tags && r.tags[0] && r.tags[0].projectId))) || null;
  const rowProj = (r) => { const p = LV.byId[projOfRow(r)]; return p ? p.name : null; };
  const runningIn = (pid) => LV.runs.filter((r) => r.running && (r.state === 'working' || r.state === 'starting') && (r.projectId === pid || projOfRow(LV.rows[r.sessionId]) === pid || (pid === '*chat' && LV.rows[r.sessionId] && LV.rows[r.sessionId].kind === 'chat') || (LV.rows[r.sessionId] && LV.rows[r.sessionId].folder === pid))).length;
  async function loadProjects() {
    const who = await MC.whoami; LV.hub = !!(who && who.role === 'hub');
    if (LV.hub) return loadHubProjects();
    const d = await api.get('/api/projects');
    LV.projects = ((d && d.projects) || []).map((p) => ({ ...p, tint: TINTS[hash(p.id) % TINTS.length] })); /* all of it: Home reads the git state and what needs you */
    /* the root folders: as the server names them; an older server does not, so the folders that hold several projects */
    let roots = Array.isArray(d && d.roots) ? d.roots : null;
    if (!roots) { const n = {}; LV.projects.forEach((p) => { const r = String(p.folder).split(/[\\/]+/).slice(0, 2).join('\\'); n[r] = (n[r] || 0) + 1; }); roots = Object.keys(n).filter((r) => n[r] > 1); }
    LV.roots = roots.map((path) => ({ id: 'root:' + path, name: leaf(path), folder: path, root: true, tint: '#8d97a8' }));
    LV.byName = {}; LV.byId = {};
    LV.projects.concat(LV.roots, [CHATS]).forEach((p) => { LV.byName[p.name] = p; LV.byId[p.id] = p; });
    (LV.hubGroups || []).forEach((h) => h.items.forEach((p) => { if (!LV.byName[p.name]) LV.byName[p.name] = p; LV.byId[p.id] = p; }));
    buildRoots();
    LV.pcGroups = loadPcGroups();
  }
  /* the simple chats are one place too: picking it lists every chat in the conversation list */
  const CHATS = { id: '*chat', name: 'Simple chats', folder: '', chats: true, tint: '#8d97a8' };
  /* The hub has no projects of its own. Its projects are the PCs', named by their conversations, under each PC: a project
     there is m:<PC id>:<project name> (an empty name: that PC's conversations outside a project). They open read only, and
     a message to one waits on the hub until that PC is on. */
  const hubKey = (id) => /^m:/.test(id || '');
  /* a project of the PC this one is linked to (Home): a new conversation in it starts there, through the link */
  const linkProj = (id) => { const p = hubKey(id) && LV.byId[id]; return p && p.link && p.rid ? p : null; };
  async function loadHubProjects() {
    const m = await api.get('/api/machines'), pcs = (m && m.machines) || [];
    await Promise.all(pcs.map((x) => loadRemote(x.id, true)));
    LV.projects = []; LV.roots = []; LV.byName = {}; LV.byId = {};
    LV.byName[CHATS.name] = CHATS; LV.byId[CHATS.id] = CHATS;
    remoteGroups(pcs);
    buildRoots();
  }
  /* On a PC, the other PCs' projects follow this PC's root folders in the tree, one group per PC, the same way (read
     only, a message waits on the hub until that PC runs it). They load after this PC's own projects, so these never wait
     on the hub. A PC this one is paired with (Home, services/pcLink.js) shows its own tree instead: each of its root
     folders with its projects, read through the direct link to it (the last list read, when it is off). */
  let pcGroupsN = 0;
  async function loadPcGroups() {
    const n = ++pcGroupsN;
    let pcs = [], link = null, ok = false;
    try {
      const [m, l] = await Promise.all([api.get('/api/machines').catch(() => null), api.get('/api/pc-link').catch(() => null)]);
      pcs = (m && m.machines) || []; link = l; LV.link = l;
      await Promise.all(pcs.map((x) => loadRemote(x.id, true)));
      ok = !!m && !!l && !l.locked && pcs.every((x) => !(LV.remote[x.id] || {}).err); /* locked: its projects are not known, its tabs wait */
    } catch (e) { pcs = []; }
    if (n !== pcGroupsN || LV.hub) return; /* a newer load runs */
    Object.keys(LV.byId).filter(hubKey).forEach((id) => { const p = LV.byId[id]; if (LV.byName[p.name] === p) delete LV.byName[p.name]; delete LV.byId[id]; });
    remoteGroups(pcs, link);
    buildRoots(); paintTrees();
    /* the other PCs' projects are known now: a tab of one of them, kept back at the start, can open (index.html). ok: every
       list was read, so a project still missing is really gone */
    LV.pcKnown = { ok };
    MC.emit('projects-known', { ok });
    if (link && link.paired && link.online) loadRuns(); /* now its processes can be read too */
  }
  function remoteGroups(pcs, link) {
    LV.hubGroups = [];
    /* a PC locked with its PIN shows nothing: its place in the tree is a lock, with its Unlock button */
    const shut = new Set(pcs.filter((x) => x.locked).map((x) => x.name));
    if (link && link.paired && link.locked) shut.add(link.paired.name);
    pcs = pcs.filter((x) => !shut.has(x.name));
    shut.forEach((nm) => LV.hubGroups.push({ path: nm, locked: nm, items: [] }));
    const L = link && link.paired && Array.isArray(link.projects) && link.projects.length ? link : null;
    if (L && !pcs.some((x) => x.name === L.paired.name)) pcs = pcs.concat([{ id: 'link', name: L.paired.name, online: L.online }]); /* no conversations on the hub yet */
    pcs.forEach((x) => {
      const rows = ((LV.remote[x.id] || {}).rows || []).filter((r) => !r.archived);
      const names = [...new Set(rows.map((r) => r.projectName || ''))].sort((a, b) => (!a) - (!b) || a.localeCompare(b));
      const mk = (n) => {
        let name = n || 'Other conversations';
        if (LV.byName[name]) name += ' on ' + x.name; /* the same project on two PCs */
        const p = { id: 'm:' + x.id + ':' + n, name, folder: '', machine: x.id, pname: n, tint: n ? TINTS[hash(n) % TINTS.length] : '#8d97a8' };
        LV.byName[name] = p; LV.byId[p.id] = p; return p;
      };
      if (L && x.name === L.paired.name) {
        const off = L.online ? '' : ' (off)', byName = (a, b) => a.name.localeCompare(b.name);
        const groups = L.roots.map((r) => ({ path: x.name + ': ' + r + off, folder: r, items: [] }));
        const other = { path: x.name + ': other folders' + off, items: [] };
        L.projects.filter((q) => !q.hidden).forEach((q) => {
          const p = mk(q.name); p.folder = q.folder; p.about = q.about || ''; p.rid = q.id; p.link = true; /* its id on that PC: a new conversation starts there */
          (groups.find((g) => normPath(q.folder).startsWith(normPath(g.folder) + '\\')) || other).items.push(p);
        });
        /* a project named in its conversations but not in its list (renamed, or gone) */
        names.filter((nm) => nm && !L.projects.some((q) => q.name === nm)).forEach((nm) => other.items.push(mk(nm)));
        groups.concat([other]).forEach((g) => g.items.sort(byName));
        /* its conversations outside every project: at the end of its first root folder */
        if (names.includes('')) (groups[0] || other).items.push(mk(''));
        groups.concat([other]).filter((g) => g.items.length || g.folder).forEach((g) => LV.hubGroups.push({ path: g.path, items: g.items }));
        return;
      }
      LV.hubGroups.push({ path: x.name + (x.online ? '' : ' (off)'), items: names.map(mk) });
    });
  }
  const rootFor = (folder) => LV.roots.find((r) => normPath(folder).startsWith(normPath(r.folder) + '\\'));
  function buildRoots() {
    if (LV.hub) { D.roots = (LV.hubGroups || []).map((g) => ({ path: g.path, locked: g.locked, items: g.items.map((p) => ({ name: p.name, id: p.id, tint: p.tint, running: 0 })) })); return; }
    const g = {};
    LV.projects.forEach((p) => { const r = rootFor(p.folder); const k = r ? r.folder : ''; (g[k] = g[k] || []).push(p); });
    const item = (p) => ({ name: p.name, id: p.id, tint: p.tint, running: runningIn(p.id) });
    D.roots = LV.roots.map((r) => ({ path: r.folder, root: r, items: (g[r.folder] || []).sort((a, b) => a.name.localeCompare(b.name)).map(item) }));
    if (g['']) D.roots.push({ path: 'Other folders', items: g[''].sort((a, b) => a.name.localeCompare(b.name)).map(item) });
    (LV.hubGroups || []).forEach((h) => D.roots.push({ path: h.path, locked: h.locked, items: h.items.map((p) => ({ name: p.name, id: p.id, tint: p.tint, running: 0 })) }));
  }
  MC.projectInfo = (name = S.project) => {
    const p = LV.byName[name];
    return p ? { ...p, running: runningIn(p.id) } : { name: name || 'No project', folder: '', tint: '#9db4ff', running: 0 };
  };
  const pidOf = (name = MC.curProject()) => (LV.byName[name] || {}).id || null;
  const curSess = () => MC.curSession();
  const setCurSess = (id) => { if (MC.ctx) MC.ctx.vp.state.session = id; else S.session = id; };
  const isRootId = (id) => /^root:/.test(id || '');
  const isChatId = (id) => id === '*chat';
  const ALL = '*all'; /* the list of every conversation on this PC, code and chats, for the Everything switch */

  /* the project tree (the fly-out and the Projects module): places, each root folder with its own conversations and its
     projects, then the simple chats. Every folder remembers whether it is open. */
  /* the questions and permissions that wait in a project (D.inbox, read by home.js), as a pulsing pill with its count */
  const needPill = (name) => { const n = (D.inbox || []).filter((x) => x.proj === name).length; return n ? `<span class="needpill" title="${n} waiting for your answer">${I('clock', 'sm')}${n}</span>` : ''; };
  MC.renderProjectTree = (el, opts = {}) => {
    const q = (el._q || '').toLowerCase(), match = (n) => !q || n.toLowerCase().includes(q);
    const projRow = (p) => !match(p.name) ? '' : `<div class="tn ${p.name === S.project ? 'on' : ''}" data-proj="${esc(p.name)}">${pinSlot(`data-pinp="${esc(p.name)}"`, isPinned(p.name), 'this project')}<span class="tint" style="width:calc(22px*var(--k));height:calc(22px*var(--k));font-size:calc(12px*var(--k));background:${p.tint}">${esc(p.name[0])}</span><span class="nm">${esc(p.name)}</span><span class="meta">${needPill(p.name)}${p.running ? `<span class="dot run pulse" title="${p.running} running"></span>${p.running}` : ''}</span>${newTabBtn(p.name)}</div>`;
    const rootRow = (r) => !match(r.name) && q ? '' : `<div class="tn ${r.name === S.project ? 'on' : ''}" data-proj="${esc(r.name)}" title="${esc(r.folder)}">${pinSlot(`data-pinp="${esc(r.name)}"`, isPinned(r.name), 'this folder')}${I('folder', 'sm')}<span class="nm">In ${esc(r.folder)} itself</span><span class="meta">${needPill(r.name)}${runningIn(r.id) ? `<span class="dot run pulse"></span>${runningIn(r.id)}` : ''}</span>${newTabBtn(r.name)}</div>`;
    const sec = (key, dflt, head, body) => { const shut = !q && isClosed(key, dflt); return `<div class="tsec tfold" data-fold="${esc(key)}" data-dflt="${dflt ? 1 : 0}">${I(shut ? 'chevR' : 'chev', 'sm')}${head}</div><div class="tkids ${shut ? 'closed' : ''}" style="margin-left:calc(5px*var(--k));border:0;padding-left:0">${body}</div>`; };
    const roots = D.roots.filter((r) => !(S.work && /games/i.test(r.path))).map((r) => ({ ...r, items: r.items.filter((p) => !isPinned(p.name)), root: r.root && !isPinned(r.root.name) ? r.root : null }));
    const nRun = runningIn('*chat'), chatPin = isPinned('Simple chats');
    const W = [62, 48, 70, 55, 40];
    const lockSec = (r) => `<div class="tsec">${I('pc', 'sm')}${esc(r.path)}</div><div class="pclockcov"><div class="fake">${W.map((w, i) => `<div class="tn"><span class="tw"></span><span class="tint" style="width:calc(22px*var(--k));height:calc(22px*var(--k));background:${TINTS[i % TINTS.length]}"></span><span class="nm"><i class="fakebar" style="width:${w}%"></i></span></div>`).join('')}</div>`
      + `<div class="pclockov">${I('lock')}<b>${esc(r.locked)} is locked</b><button class="btn sm primary" data-unlockpc="${esc(r.locked)}">${I('lock', 'sm')}Unlock</button></div></div>`;
    const chatRow = () => match('Simple chats') ? `<div class="tn ${S.project === 'Simple chats' ? 'on' : ''}" data-proj="Simple chats">${pinSlot('data-pinp="Simple chats"', chatPin, 'simple chats')}${I('chat', 'sm')}<span class="nm">Simple chats</span><span class="meta">${nRun ? `<span class="dot run pulse"></span>${nRun}` : esc(String(D.chats.length || ''))}</span>${newTabBtn('Simple chats')}</div>` : '';
    const pinned = PINS.map((n) => (n === 'Simple chats' ? chatRow() : LV.byName[n] && isRootId(LV.byName[n].id) ? rootRow(LV.byName[n]) : LV.byName[n] ? projRow({ ...LV.byName[n], running: runningIn(LV.byName[n].id) }) : '')).join('');
    el.innerHTML = `
      <div class="input" style="margin:calc(5px*var(--k)) calc(5px*var(--k)) 2px">${I('search', 'sm')}<input placeholder="Find a project" value="${esc(el._q || '')}"><span class="kbd">/</span></div>
      <div class="tpad"></div>${chatPin ? '' : chatRow()}
      ${pinned ? `<div class="tsec">${I('pin', 'sm')}Pinned</div>${pinned}` : ''}
      ${roots.map((r) => r.locked ? (q ? '' : lockSec(r)) : sec('tree:' + r.path, /games/i.test(r.path), `${I('folder', 'sm')}${esc(r.path)}<span class="faint" style="margin-left:calc(5px*var(--k))">${r.items.length}</span>${r.root && onPC() ? `<button class="ibtn" data-rootmenu="${esc(r.path)}" title="Root folder options">${I('more', 'sm')}</button>` : ''}`, (r.root ? rootRow(r.root) : '') + r.items.map(projRow).join(''))).join('')}
      ${onPC() && !q ? `<div class="tn" data-addroot style="margin-top:calc(10px*var(--k));color:var(--text-3)"><span class="tw"></span>${I('plus', 'sm')}<span class="nm">Add a root folder</span></div>` : ''}`;
    const inp = el.querySelector('input');
    const inNewTab = (name) => { if (opts.onNewTab) opts.onNewTab(name); else if (MC.D && MC.D.newTab) MC.D.newTab(name); };
    el.onauxclick = (e) => { const p = e.target.closest('[data-proj]'); if (p && e.button === 1) { e.preventDefault(); inNewTab(p.dataset.proj); } };
    el.onmousedown = (e) => { if (e.button === 1 && e.target.closest('[data-proj]')) e.preventDefault(); }; /* no scroll mode on a middle click */
    inp.oninput = () => { el._q = inp.value; MC.renderProjectTree(el, opts); const i2 = el.querySelector('input'); i2.focus(); i2.setSelectionRange(99, 99); };
    el.onclick = (e) => {
      const ul = e.target.closest('[data-unlockpc]'); if (ul) { e.stopPropagation(); MC.unlockPc(ul.dataset.unlockpc); return; }
      const nt = e.target.closest('[data-newtab]'); if (nt) { e.stopPropagation(); inNewTab(nt.dataset.newtab); return; }
      const rm = e.target.closest('[data-rootmenu]'); if (rm) { e.stopPropagation(); rootMenu(rm); return; }
      if (e.target.closest('[data-addroot]')) { addRootFolder(); return; }
      const pp = e.target.closest('[data-pinp]'); if (pp) { e.stopPropagation(); togglePin(pp.dataset.pinp); MC.renderProjectTree(el, opts); return; }
      const f = e.target.closest('[data-fold]'); if (f) { toggleClosed(f.dataset.fold, f.dataset.dflt === '1'); MC.renderProjectTree(el, opts); return; }
      const p = e.target.closest('[data-proj]'); if (p) { if ((e.ctrlKey || opts.newTab) && opts.onNewTab) { opts.onNewTab(p.dataset.proj); return; } MC.setProject(p.dataset.proj); opts.onPick && opts.onPick(p.dataset.proj); MC.renderProjectTree(el, opts); return; }
    };
  };
  MC.setProject = (name) => { S.project = name; MC.emit('project', name); };
  /* root folders: added and removed here, saved in the PC's settings (a phone and the hub cannot). The server then says
     projects.changed, and the trees load again. */
  const onPC = () => !LV.hub && !document.documentElement.hasAttribute('data-remote') && MC.remote !== true;
  async function addRootFolder() {
    const t = await MC.askText('Add a root folder', null, '', 'Add');
    if (t === null || !t.trim()) return;
    try { const r = await api.post('/api/roots', { folder: t }); MC.toast(leaf(r.roots[r.roots.length - 1]) + ' added', 'check'); } catch (e) { MC.toast('Not added: ' + errText(e), 'warn'); }
  }
  function rootMenu(btn) {
    const folder = btn.dataset.rootmenu;
    MC.menu(btn, [{ id: 'open', label: 'Open folder', icon: 'folder' }, { sep: 1 }, { id: 'rm', label: 'Remove from the list', icon: 'xc' }], async (id) => {
      if (id === 'open') api.post('/api/path/reveal', { path: folder }).catch((e) => MC.toast('Could not open it: ' + errText(e), 'warn'));
      if (id === 'rm' && (await MC.askYes(`Remove ${folder} from the list?`, 'The folder and its files stay where they are.', 'Remove'))) {
        try { await api.post('/api/roots/remove', { folder }); MC.toast(leaf(folder) + ' removed', 'check'); } catch (e) { MC.toast('Not removed: ' + errText(e), 'warn'); }
      }
    });
  }
  function newTabBtn(name) { return `<button class="ibtn sm tn-more" data-newtab="${esc(name)}" title="Open in a new tab">${I('ext', 'sm')}</button>`; }
  /* the usage panel, above the message box: opened from the context and cache button */
  function usagePop(btn) {
    const old = document.querySelector('.upop'); if (old) { const same = old._btn === btn; old.remove(); if (same) return; }
    const p = document.createElement('div'); p.className = 'upop'; p._btn = btn; p.innerHTML = MC.usageMini ? MC.usageMini() : '';
    document.body.appendChild(p);
    const r = btn.getBoundingClientRect(), w = p.offsetWidth;
    p.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px'; p.style.bottom = innerHeight - r.top + 8 + 'px';
    const off = (e) => { if (!p.contains(e.target) && !btn.contains(e.target) && !e.target.closest('.menu')) { p.remove(); removeEventListener('mousedown', off, true); } };
    addEventListener('mousedown', off, true);
  }

  /* ---------- runs: every Claude process this PC keeps ---------- */
  async function loadRuns() {
    try { const r = await api.get('/api/runs'); LV.runs = Array.isArray(r) ? r.filter((x) => !x.hidden) : []; } catch (e) { return; } /* hidden: the Sync button's commit step, until it needs you */
    /* the linked PC's processes too (through the link), so its conversations that wait for an answer show here */
    if (LV.link && LV.link.paired && LV.link.online) { try { const r = await api.get('/api/pc/runs'); LV.pcRuns = Array.isArray(r) ? r.filter((x) => !x.hidden).map((x) => ({ ...x, pc: true })) : []; } catch (e) { LV.pcRuns = []; } } else LV.pcRuns = [];
    /* a process another page started (the phone, the Talk page, Send later) for a conversation open here: read its live turn */
    LV.runs.forEach((r) => { if (r.running && r.sessionId && (r.state === 'working' || r.state === 'starting') && LV.view[r.sessionId] !== r.runId && convEls(r.sessionId).length) loadConv(r.sessionId); });
    buildRoots(); buildAgents(); paintAllWaits();
    MC.D && MC.D.drawTabs && MC.D.drawTabs(); MC.D && MC.D.drawSbar && MC.D.drawSbar();
    paintTrees();
  }
  /* the background tasks still running in a conversation's process (a test suite started with run_in_background): their words */
  const bgOf = (sid) => { const r = LV.runs.find((x) => x.sessionId === sid && x.bgTasks && x.bgTasks.length); return r ? r.bgTasks.map((t) => t.description || 'A background task').join(', ') : ''; };
  const pendingIn = (rec) => !!rec && rec.items.some((i) => i.kind === 'perm' && i.state === 'pending');
  const stateOf = (sid) => {
    const r = LV.runs.find((x) => x.sessionId === sid && x.running) || (LV.pcRuns || []).find((x) => x.sessionId === sid && x.running); if (!r) return 'done';
    if (pendingIn(LV.store[r.runId]) || (r.pending && r.pending.length)) return 'wait';
    return r.state === 'working' || r.state === 'starting' ? 'run' : 'idle';
  };
  /* the Running module and the status bar: one line per live process */
  function buildAgents() {
    D.agents = LV.runs.filter((r) => r.running).map((r) => {
      const row = LV.rows[r.sessionId], p = LV.byId[r.projectId || projOfRow(row)];
      const st = stateOf(r.sessionId);
      return { runId: r.runId, name: (row && row.title) || 'New conversation', proj: p ? p.name : 'No project', model: (row && modelLabel(row.model)) || '', job: st === 'wait' ? 'Waiting for your answer' : r.promptPreview || '', state: st, for: ago(r.startedAt), sid: r.sessionId };
    });
    MC.emit('rerender', 'running');
  }

  /* ---------- conversation lists ---------- */
  async function loadList(key) {
    const L = LV.lists[key] || (LV.lists[key] = { limit: 40, rows: [], more: false, loaded: false });
    if (L.busy) return; L.busy = true;
    const q = key === '*chat' ? 'kind=chat' : key === ALL ? 'all=1' : isRootId(key) ? 'kind=code&folder=' + enc(key.slice(5)) : 'kind=code&project=' + enc(key);
    try {
      let list;
      if (hubKey(key)) { /* a PC's project on the hub: that PC's conversations, picked by project name */
        const p = LV.byId[key]; if (!p) throw new Error('This project is no longer on the hub');
        await loadRemote(p.machine, true); const R = LV.remote[p.machine];
        if (R.err) throw new Error(R.err);
        list = R.rows.filter((r) => !r.archived && (r.projectName || '') === p.pname).slice(0, L.limit + 1);
      } else {
        const rows = await api.get(`/api/sessions?limit=${L.limit + 1}&archived=hide&${q}`);
        list = Array.isArray(rows) ? rows : (rows && rows.sessions) || [];
      }
      if (isRootId(key)) list = list.filter((r) => normPath(r.cwd) === normPath(key.slice(5))); /* only the ones started right in that folder */
      L.more = list.length > L.limit; L.rows = list.slice(0, L.limit); L.loaded = true; L.err = null;
      L.rows.forEach((r) => { if (isRootId(key)) r.folder = key; LV.rows[r.id] = { ...(LV.rows[r.id] || {}), ...r }; });
    } catch (e) { L.err = e.status === 404 && isRootId(key) ? 'Restart the server once to list the conversations of a root folder' : errText(e); L.loaded = true; }
    finally { L.busy = false; }
    if (key === '*chat') D.chats = L.rows.map((r) => ({ id: r.id, title: r.title || 'Chat', when: ago(r.lastAt) }));
    if (!isRootId(key) && !hubKey(key)) loadArchived(key);
    buildAgents(); paintTrees(); paintHeads();
  }
  /* archived conversations stay out of the list; "Show archived (n)" at its end lists them */
  LV.arch = {};
  async function loadArchived(key) {
    const A = LV.arch[key] || (LV.arch[key] = { count: 0, show: false, rows: [] });
    const chat = key === '*chat', q = chat ? 'kind=chat' : key === ALL ? 'all=1' : 'kind=code&project=' + enc(key);
    try {
      const c = await api.get('/api/sessions/archived-count?' + q); A.count = c && typeof c.count === 'number' ? c.count : 0;
      A.rows = A.show && A.count ? ((await api.get('/api/sessions?limit=200&archived=only&' + q)) || []) : [];
      A.rows.forEach((r) => { r.archived = true; LV.rows[r.id] = { ...(LV.rows[r.id] || {}), ...r }; });
    } catch (e) { A.count = 0; A.rows = []; }
    if (!A.count) A.show = false;
    paintTrees();
  }
  /* "Cache ending": the cache of a conversation runs out soon and nothing is planned for it */
  LV.cacheEnd = {};
  function markCacheEnding(list) {
    (Array.isArray(list) ? list : []).forEach((x) => {
      if (!x || typeof x.id !== 'string') return;
      const t = Date.parse(x.expiresAt); if (!(t > Date.now())) { delete LV.cacheEnd[x.id]; return; }
      LV.cacheEnd[x.id] = t; setTimeout(paintTrees, t - Date.now() + 500);
    });
    paintTrees();
  }
  const cacheEnding = (id) => { const t = LV.cacheEnd[id]; if (t && t > Date.now()) return true; delete LV.cacheEnd[id]; return false; };
  MC.events.on('cache-ending', (d) => markCacheEnding([d]));
  api.get('/api/sessions/cache-ending').then(markCacheEnding).catch(() => {});
  async function loadNewDrafts() { try { const d = await api.get('/api/drafts/new'); LV.newDrafts = (d && d.drafts) || []; } catch (e) { return; } paintTrees(); }
  /* another PC's conversations, from the hub. wait: a load already under way is waited for rather than skipped */
  async function loadRemote(mid, wait) {
    const R = LV.remote[mid] || (LV.remote[mid] = { rows: [], loaded: false });
    if (R.busy) { if (wait) await R.busy; return; }
    R.busy = (async () => {
      try { const rows = await api.get(`/api/sessions?machine=${enc(mid)}&limit=2000`); R.rows = Array.isArray(rows) ? rows : []; R.err = null; R.rows.forEach((r) => (LV.rows[r.id] = r)); }
      catch (e) { R.err = errText(e); }
    })();
    await R.busy; R.loaded = true; R.busy = null; paintTrees();
  }
  let listT = 0;
  const reloadLists = () => { clearTimeout(listT); listT = setTimeout(() => { Object.keys(LV.lists).forEach(loadList); loadNewDrafts(); }, 400); };
  const paintTrees = () => $$('[data-sesstree]').forEach((el) => MC.renderSessionTree(el));

  MC.allSessions = () => Object.values(LV.rows);
  MC.sessionById = (id) => {
    const r = LV.rows[id], c = LV.conv[id];
    if (r) return { ...r, title: r.title || 'Untitled conversation', state: stateOf(id), when: ago(r.lastAt) };
    return { id, kind: kindOf(id), title: (c && c.meta && c.meta.title) || (isNew(id) ? (/^newc:/.test(id) ? 'New chat' : 'New conversation') : 'Conversation'), state: stateOf(id), when: '' };
  };

  /* the session list of the open project: drafts, pinned, then by day, then the same project on the other PCs.
     data-scope="all" on the element: every conversation instead, each with the name of its project */
  MC.renderSessionTree = (el) => {
    const all = el.dataset.scope === 'all', pid = pidOf(), key = all ? ALL : pid, proj = LV.byId[pid];
    if (!key) { el.innerHTML = '<div class="lv-empty">This project is not in Mission Control\'s list.</div>'; return; }
    const L = LV.lists[key];
    if (!L || !L.loaded) { if (!L || !L.busy) loadList(key); el.innerHTML = `<div class="lv-empty">${I('loader', 'sm')}Loading conversations</div>`; return; }
    const now = new Date(), day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const G = [['Pinned', []], ['Today', []], ['This week', []], ['Earlier', []]];
    L.rows.forEach((r) => { const t = toMs(r.lastAt) || 0; G[r.pinned ? 0 : t >= day0 ? 1 : t >= day0 - 6 * 86400000 ? 2 : 3][1].push(r); });
    const tagChips = (r) => all ? ((n) => (n ? `<span class="tchip">${esc(n)}</span>` : ''))(r.kind === 'chat' ? 'Chat' : rowProj(r) || r.projectName || (r.cwd ? leaf(r.cwd) : ''))
      : (Array.isArray(r.tags) ? r.tags : []).filter((t) => t && t.projectId && t.projectId !== key && LV.byId[t.projectId]).slice(0, 2)
        .map((t) => `<span class="tchip" title="${t.source === 'manual' ? 'Set by you' : 'Found from the files it touched'}">${esc(LV.byId[t.projectId].name)}</span>`).join('') + (r.tagsPending ? '<span class="tchip">Sorting</span>' : '');
    const row = (r) => {
      const st = stateOf(r.id), ending = !r.archived && st !== 'run' && cacheEnding(r.id);
      const dot = st === 'wait' ? '' : ending ? '<span class="dot warn pulse"></span>' : { run: '<span class="dot run pulse"></span>' }[st] || '';
      const label = st === 'wait' ? '' : r.archived ? 'archived' : ending ? 'cache ending' : { run: 'running', idle: 'warm' }[st] || ago(r.lastAt);
      const need = st === 'wait' ? `<span class="needpill" title="Claude is waiting for your answer">${I('clock', 'sm')}Needs you</span>` : st !== 'run' && bgOf(r.id) ? `<span class="bgpill" title="${esc(bgOf(r.id))}">${I('loader', 'sm')}Background</span>` : '';
      const drag = r.pinned && !r.archived && !all ? 'draggable="true" data-pinrow="1"' : '';
      return `<div class="tn ${r.id === curSess() ? 'on' : ''} ${r.archived ? 'arch' : ''}" data-sess="${esc(r.id)}" ${drag} title="${esc((r.title || '') + (Array.isArray(r.pastTitles) && r.pastTitles.length ? '\nEarlier: ' + r.pastTitles.slice().reverse().join(', ') : ''))}">${r.readOnly || r.archived ? '<span class="tw"></span>' : pinSlot(`data-pins="${esc(r.id)}"`, !!r.pinned, 'this conversation')}${I(r.readOnly ? 'pc' : r.archived ? 'box' : r.locked ? 'lock' : 'chat', 'sm')}<span class="nm">${esc(r.title || 'Untitled conversation')}</span>${tagChips(r)}<span class="meta">${need}${dot}${esc(label)}</span><button class="ibtn sm tn-more" data-rowmenu="${esc(r.id)}" title="Rename, pin, lock, archive">${I('more', 'sm')}</button></div>`;
    };
    const A = LV.arch[key];
    const sec = (k, name, n, body, dflt) => `<div class="tsec" data-grp="${esc(k)}" data-dflt="${dflt ? 1 : 0}" style="cursor:pointer">${I(isClosed(k, dflt) ? 'chevR' : 'chev', 'sm')}${esc(name)}<span class="faint" style="margin-left:calc(5px*var(--k))">${n}</span></div><div class="${isClosed(k, dflt) ? 'tkids closed' : ''}">${body}</div>`;
    /* drafts stay with their own project, even in the Everything list: a draft opened here would start in this project */
    const drafts = !pid ? [] : LV.newDrafts.filter((d) => (isChatId(pid) ? /^c-/.test(d.key) : /^n-/.test(d.key) && d.project === pid && !isRootId(pid)));
    const machines = D.places.filter((p) => /^m:/.test(p.id));
    const chats = isChatId(pid);
    el.innerHTML = (!pid || (hubKey(pid) && !linkProj(pid)) ? '' : `<div class="tn ${isNew(curSess()) ? 'on' : ''}" data-newconv><span class="tw"></span>${I('plus', 'sm')}<span class="nm">${chats ? 'New chat' : 'New conversation'}${isRootId(pid) ? ' in ' + esc(proj.folder) : linkProj(pid) ? ' on ' + esc((LV.link && LV.link.paired && LV.link.paired.name) || 'the other PC') : ''}</span></div>`)
      + (L.err ? `<div class="lv-empty">${esc(L.err)}</div>` : '')
      + (drafts.length ? sec('sess:Drafts', 'Drafts', drafts.length, drafts.map((d) => `<div class="tn ${curSess() === (/^c-/.test(d.key) ? 'newc:' : 'new:') + d.key.slice(2) ? 'on' : ''}" data-draft="${esc(d.key)}" title="${esc(d.preview)}"><span class="tw"></span>${I('note', 'sm')}<span class="nm">${esc(d.preview || (d.files ? d.files + ' file(s)' : 'Draft'))}</span><span class="meta">${esc(ago(d.at))}</span></div>`).join(''), false) : '')
      + G.filter((g) => g[1].length).map(([name, rows]) => sec('sess:' + name, name, rows.length, rows.map(row).join(''), name === 'Earlier')).join('')
      + (L.more ? `<div class="tn" data-moresess style="color:var(--text-3)"><span class="tw"></span>${I('chev', 'sm')}<span class="nm">Show more</span></div>` : '')
      + (!L.rows.length && !L.err ? '<div class="lv-empty">No conversations here yet.</div>' : '')
      + (A && A.count ? `<div class="tn archtog" data-archtog><span class="tw"></span>${I('box', 'sm')}<span class="nm">${A.show ? 'Hide archived' : `Show archived (${A.count})`}</span></div>${A.show ? A.rows.map(row).join('') : ''}` : '')
      + (!all && (isRootId(key) || chats || hubKey(key)) ? '' : machines.map((m) => {
        const k = 'sess:' + m.id, R = LV.remote[m.id.slice(2)];
        if (!isClosed(k, true) && !R) loadRemote(m.id.slice(2));
        const rows = !R ? [] : all ? R.rows.filter((r) => !r.archived).slice(0, L.limit) : R.rows.filter((r) => r.projectName === MC.curProject() || (proj && r.projectName === leaf(proj.folder)));
        const body = !R || !R.loaded ? `<div class="lv-empty">${I('loader', 'sm')}Asking the hub</div>` : R.err ? `<div class="lv-empty">${esc(R.err)}</div>` : rows.length ? rows.map(row).join('') : `<div class="lv-empty">Nothing ${all ? '' : 'from this project '}on ${esc(m.name)}</div>`;
        return sec(k, 'On ' + m.name + (m.online ? '' : ' (off)'), R && R.loaded ? rows.length : '', body, true);
      }).join(''));
    el.onclick = (e) => {
      const rm = e.target.closest('[data-rowmenu]'); if (rm) { e.stopPropagation(); rowMenu(rm, rm.dataset.rowmenu); return; }
      const ps = e.target.closest('[data-pins]'); if (ps) { e.stopPropagation(); const r = LV.rows[ps.dataset.pins]; if (r) setMeta(r.id, { pinned: !r.pinned }); return; }
      const g = e.target.closest('[data-grp]'); if (g) { toggleClosed(g.dataset.grp, g.dataset.dflt === '1'); MC.renderSessionTree(el); return; }
      if (e.target.closest('[data-moresess]')) { L.limit += 40; loadList(key); return; }
      if (e.target.closest('[data-archtog]')) { A.show = !A.show; loadArchived(key); return; }
      if (e.target.closest('[data-newconv]')) { const cs = curSess(); MC.setSession(isNew(cs) && /^newc:/.test(cs) === chats ? cs : newKey(chats)); MC.emit('open', 'convo'); return; }
      const d = e.target.closest('[data-draft]'); if (d) { MC.setSession((/^c-/.test(d.dataset.draft) ? 'newc:' : 'new:') + d.dataset.draft.slice(2)); MC.emit('open', 'convo'); return; }
      const s = e.target.closest('[data-sess]'); if (s) { if ((e.ctrlKey || e.metaKey) && MC.D && MC.D.newTab) { MC.D.newTab(tabOf(s.dataset.sess), { session: s.dataset.sess }); return; } MC.setSession(s.dataset.sess); MC.emit('open', 'convo'); }
    };
    /* a new tab opens on the conversation's own project (in the Everything list it can be another one) */
    const tabOf = (sid) => (all && (LV.rows[sid] || {}).kind === 'chat' ? 'Simple chats' : all && rowProj(LV.rows[sid])) || MC.curProject();
    el.onauxclick = (e) => { const s = e.target.closest('[data-sess]'); if (s && e.button === 1 && MC.D && MC.D.newTab) { e.preventDefault(); MC.D.newTab(tabOf(s.dataset.sess), { session: s.dataset.sess }); } };
    el.onmousedown = (e) => { if (e.button === 1 && e.target.closest('[data-sess]')) e.preventDefault(); };
    el.oncontextmenu = (e) => { const s = e.target.closest('[data-sess]'); if (!s) return; e.preventDefault(); rowMenu(s, s.dataset.sess); };
    let dragId = null;
    const clear = () => $$('.tn.dropb, .tn.dropa', el).forEach((x) => x.classList.remove('dropb', 'dropa'));
    el.ondragstart = (e) => { const s = e.target.closest('[data-pinrow]'); if (!s) return; dragId = s.dataset.sess; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); };
    el.ondragover = (e) => { if (!dragId) return; const s = e.target.closest('[data-pinrow]'); clear(); if (!s || s.dataset.sess === dragId) return; e.preventDefault(); const r = s.getBoundingClientRect(); s.classList.add(e.clientY > r.top + r.height / 2 ? 'dropa' : 'dropb'); };
    el.ondrop = (e) => { if (!dragId) return; e.preventDefault(); const s = e.target.closest('[data-pinrow]'); if (s && s.dataset.sess !== dragId) { const r = s.getBoundingClientRect(); placePinned(key, dragId, s.dataset.sess, e.clientY > r.top + r.height / 2); } dragId = null; clear(); };
    el.ondragend = () => { dragId = null; clear(); };
  };
  /* the order of the pinned conversations (the others follow by date); the server keeps it */
  function placePinned(key, id, nextTo, after) {
    const L = LV.lists[key]; if (!L) return;
    const pinned = L.rows.filter((r) => r.pinned), rest = L.rows.filter((r) => !r.pinned), me = pinned.find((r) => r.id === id); if (!me) return;
    pinned.splice(pinned.indexOf(me), 1);
    const at = nextTo === null ? Math.max(0, Math.min(pinned.length, after)) : pinned.findIndex((r) => r.id === nextTo) + (after ? 1 : 0);
    pinned.splice(at, 0, me); L.rows = pinned.concat(rest); paintTrees();
    api.post('/api/sessions/order', { ids: L.rows.map((r) => r.id) }).catch((e) => MC.toast('Could not save the order: ' + errText(e), 'warn')).then(() => loadList(key));
  }
  /* the projects a conversation belongs to: picked by you, or found from the files it touched (Automatic) */
  function editProjects(sid) {
    const r = LV.rows[sid] || {}, pick = new Set((Array.isArray(r.tags) ? r.tags : []).filter((t) => t && t.projectId).map((t) => t.projectId));
    const d = document.createElement('div'); d.className = 'mdlg';
    d.innerHTML = `<div class="mbox" role="dialog" aria-modal="true"><div class="mt2">Projects of this conversation</div><div class="tagpick">${LV.projects.map((p) => `<label class="tagrow"><input type="checkbox" value="${esc(p.id)}" ${pick.has(p.id) ? 'checked' : ''}><span class="tint" style="background:${p.tint}">${esc(p.name[0])}</span>${esc(p.name)}</label>`).join('')}</div>`
      + `<div class="row"><button class="btn sm ghost" data-auto>Automatic</button><span class="grow"></span><button class="btn sm ghost" data-x>Cancel</button><button class="btn sm primary" data-ok>Save</button></div></div>`;
    document.body.appendChild(d);
    const end = () => d.remove();
    d.onkeydown = (e) => { if (e.key === 'Escape') end(); };
    d.onclick = (e) => {
      if (e.target === d || e.target.closest('[data-x]')) return end();
      if (e.target.closest('[data-auto]')) { end(); setMeta(sid, { tags: null }); return; }
      if (e.target.closest('[data-ok]')) { const ids = [...d.querySelectorAll('input:checked')].map((x) => x.value); end(); setMeta(sid, { tags: ids }); }
    };
    d.querySelector('[data-ok]').focus();
  }

  /* rename, pin, lock, archive, throw away: the row menu in the lists and the ... in the conversation header */
  async function setMeta(sid, patch) {
    try { await api.post(`/api/sessions/${enc(sid)}/meta`, patch); } catch (e) { MC.toast('Not changed: ' + errText(e), 'warn'); return false; }
    if (LV.rows[sid]) Object.assign(LV.rows[sid], patch.title !== undefined ? { title: patch.title, titleSource: 'custom' } : patch);
    if (LV.conv[sid] && LV.conv[sid].meta) { if (patch.title !== undefined) LV.conv[sid].meta.title = patch.title; if (patch.locked !== undefined) LV.conv[sid].meta.locked = patch.locked; }
    reloadLists(); paintTrees(); paintHeads(); return true;
  }
  /* another PC's conversation: changed there through the link (routes/pcLink.js), which needs that PC on */
  const theirs = (sid) => { const r = LV.rows[sid] || {}, c = LV.conv[sid], m = r.machine || (c && c.meta && c.meta.machine); return r.readOnly || (c && c.meta && c.meta.readOnly) ? ((m && m.name) || 'the other PC') : null; };
  const linkUp = (name) => !!(LV.link && LV.link.paired && LV.link.online && LV.link.paired.name === name);
  const sessApi = (sid) => (theirs(sid) ? '/api/pc/sessions/' : '/api/sessions/') + enc(sid);
  function remoteMenu(anchor, sid) {
    const r = LV.rows[sid] || {}, name = theirs(sid);
    if (!linkUp(name)) { MC.toast(`${name} is off. Change it when it is on.`, 'pc'); return; }
    MC.menu(anchor, [{ h: (r.title || 'Conversation').slice(0, 40) }, { id: 'ren', label: 'Rename', icon: 'note' }, { sep: 1 }, { id: 'archive', label: 'Archive', sub: 'hidden, searchable', icon: 'box' }, { id: 'trash', label: 'Throw away', sub: 'Recycle Bin', icon: 'trash' }], async (id) => {
      if (id === 'ren') {
        const t = await MC.askText('Rename this conversation', '', r.title || ''); if (t === null || !t.trim()) return;
        try { await api.post(sessApi(sid) + '/meta', { title: t.trim().slice(0, 200) }); } catch (e) { MC.toast('Not renamed: ' + errText(e), 'warn'); return; }
        if (LV.rows[sid]) LV.rows[sid].title = t.trim().slice(0, 200); reloadLists(); paintTrees(); paintHeads();
      }
      if (id === 'archive' || id === 'trash') endAs(sid, id);
    }, { alignRight: true });
  }
  function rowMenu(anchor, sid) {
    const r = LV.rows[sid] || {}, c = LV.conv[sid], locked = r.locked || (c && c.meta && c.meta.locked);
    if (theirs(sid)) { remoteMenu(anchor, sid); return; }
    const key = pidOf(), pinned = ((LV.lists[key] || {}).rows || []).filter((x) => x.pinned), pi = pinned.findIndex((x) => x.id === sid);
    MC.menu(anchor, [{ h: (r.title || 'Conversation').slice(0, 40) }, { id: 'ren', label: 'Rename', icon: 'note' }, ...(r.archived ? [] : [{ id: 'pin', label: r.pinned ? 'Unpin' : 'Pin to the top', icon: 'pin' }]),
      ...(pi > 0 ? [{ id: 'up', label: 'Move up', icon: 'arrowU' }] : []), ...(pi >= 0 && pi < pinned.length - 1 ? [{ id: 'down', label: 'Move down', icon: 'down' }] : []),
      ...(r.kind === 'chat' || isChatId(key) ? [] : [{ id: 'tags', label: 'Projects…', sub: 'which ones it belongs to', icon: 'folder' }]),
      { id: 'lock', label: locked ? 'Unlock' : 'Lock', sub: locked ? '' : 'no sending by mistake', icon: 'lock' },
      { sep: 1 }, r.archived ? { id: 'unarchive', label: 'Unarchive', sub: 'back in the list', icon: 'box' } : { id: 'archive', label: 'Archive', sub: 'hidden, searchable', icon: 'box' }, { id: 'trash', label: 'Throw away', sub: 'Recycle Bin', icon: 'trash' }], async (id) => {
      if (id === 'up' || id === 'down') placePinned(key, sid, null, pi + (id === 'up' ? -1 : 1));
      if (id === 'tags') editProjects(sid);
      if (id === 'unarchive') { try { await api.post(`/api/sessions/${enc(sid)}/archive`, { archived: false }); if (LV.rows[sid]) LV.rows[sid].archived = false; MC.toast('Back in the list', 'check'); reloadLists(); } catch (e) { MC.toast('Not unarchived: ' + errText(e), 'warn'); } }
      if (id === 'ren') { const t = await MC.askText('Rename this conversation', 'Empty gives back the automatic name.', r.title || ''); if (t !== null) setMeta(sid, { title: t.trim() ? t.trim().slice(0, 200) : null }); }
      if (id === 'pin') setMeta(sid, { pinned: !r.pinned });
      if (id === 'lock') { await setMeta(sid, { locked: !locked }); MC.emit('rerender', 'convo'); }
      if (id === 'archive' || id === 'trash') endAs(sid, id);
    }, { alignRight: true });
  }
  MC.sessionMenu = (anchor, sid) => rowMenu(anchor, sid); /* the phone's top bar opens it for the conversation on screen */
  async function endAs(sid, id) {
    const name = theirs(sid);
    if (name && !linkUp(name)) { MC.toast(`${name} is off. End it when it is on.`, 'pc'); return; }
    try {
      if (id === 'archive') await api.post(sessApi(sid) + '/archive', { archived: true });
      if (id === 'trash') { if (!(await MC.askYes('Throw this conversation away?', `It goes to the Recycle Bin${name ? ' on ' + name : ''}.`, 'Throw away'))) return; await api.post(sessApi(sid) + '/delete', { confirm: true }); }
    } catch (e) { MC.toast((id === 'trash' ? 'Not thrown away: ' : 'Not archived: ') + (e.status === 409 ? 'Claude used it in the last 2 minutes, or still runs in it' : errText(e)), 'warn'); return; }
    MC.toast(id === 'trash' ? 'Thrown away. It is in the Recycle Bin.' : 'Archived. Search still finds it.', id === 'trash' ? 'trash' : 'check');
    delete LV.rows[sid]; reloadLists(); if (S.session === sid) MC.setSession(null);
  }

  /* ---------- options: model, mode, effort ---------- */
  const PREFS = 'mc.chat.opts'; /* shared with the Talk page: a new conversation starts with the last choice */
  try { LV.prefs = JSON.parse(localStorage.getItem(PREFS) || '{}') || {}; } catch (e) { LV.prefs = {}; }
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(LV.prefs)); } catch (e) { /* storage blocked */ } };
  const optList = (k) => (LV.opts && Array.isArray(LV.opts[k]) ? LV.opts[k] : []).filter((o) => o && o.id != null);
  const optValue = (key, listKey) => {
    const list = optList(listKey); if (!list.length) return '';
    const has = (v) => v != null && list.some((o) => String(o.id) === String(v));
    const dflt = LV.opts && LV.opts.defaults ? LV.opts.defaults[key] : null;
    return has(LV.prefs[key]) ? String(LV.prefs[key]) : has(dflt) ? String(dflt) : String(list[0].id);
  };
  const modelLabel = (id) => { if (!id) return ''; const o = optList('models').find((x) => x.id === id); return o ? o.label : String(id).replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^\w/, (c) => c.toUpperCase()); };
  const optLabel = (listKey, id) => { const o = optList(listKey).find((x) => String(x.id) === String(id)); return o ? o.label : id; };
  const ownModel = (sid) => { const st = LV.stats[sid], r = LV.rows[sid]; return (st && st.model) || (r && r.model) || ''; };
  const modelOf = (sid) => (isNew(sid) ? optValue('model', 'models') : LV.pick[sid] || ownModel(sid) || optValue('model', 'models'));
  /* the permission mode of a conversation: the one picked in its message box, else the one kept with it on its PC (the server
     says), else Auto, the default of a new conversation and of one that never had a mode picked */
  const modeOfConv = (sid) => {
    const list = optList('modes'), has = (v) => v && list.some((o) => String(o.id) === String(v));
    if (has(LV.modePick[sid])) return LV.modePick[sid];
    const c = LV.conv[sid]; if (!isNew(sid) && c && c.meta && has(c.meta.mode)) return c.meta.mode;
    const d = LV.opts && LV.opts.defaults && LV.opts.defaults.mode;
    return has(d) ? d : has('auto') ? 'auto' : list.length ? String(list[0].id) : '';
  };
  /* a mode picked in a conversation's box: kept with the conversation on its PC, and a Claude running it switches at once */
  async function pickMode(sid, id) {
    LV.modePick[sid] = id;
    if (isNew(sid)) return;
    const c = LV.conv[sid], link = !!(c && c.meta && c.meta.readOnly && c.meta.link);
    if (c && c.meta && c.meta.readOnly && !link) return; /* a PC that is off: the mode cannot reach it now */
    try {
      const r = await api.post((link ? '/api/pc/sessions/' : '/api/sessions/') + enc(sid) + '/mode', { mode: id });
      if (c && c.meta) c.meta.mode = id;
      if (r && r.live) MC.toast('Claude now runs with ' + optLabel('modes', id), 'lock');
    } catch (e) { MC.toast('The mode was not changed: ' + errText(e) + '. It goes with your next message.', 'warn'); }
  }
  const switching = (sid) => !isNew(sid) && LV.pick[sid] && LV.pick[sid] !== ownModel(sid);
  /* a local model (Qwen on llama.cpp) has its own efforts, and its own remembered choice */
  const modelOpt = (id) => optList('models').find((x) => x.id === id) || null;
  const effortsOf = (sid) => { const o = modelOpt(modelOf(sid)); return o && o.local && Array.isArray(o.efforts) ? o.efforts.filter((e) => e && e.id != null) : optList('efforts'); };
  const effortOf = (sid) => {
    const o = modelOpt(modelOf(sid)); if (!(o && o.local)) return optValue('effort', 'efforts');
    const list = effortsOf(sid), v = LV.prefs['effort:' + o.id], has = (x) => list.some((e) => String(e.id) === String(x));
    return has(v) ? String(v) : has('medium') ? 'medium' : list.length ? String(list[0].id) : '';
  };
  const effortLabel = (sid) => { const v = effortOf(sid), o = effortsOf(sid).find((e) => String(e.id) === v); return o ? o.label : v; };
  function kindOf(sid) { if (/^newc:/.test(sid || '')) return 'chat'; if (isNew(sid)) return 'code'; const r = LV.rows[sid], c = LV.conv[sid]; return (r && r.kind) || (c && c.meta && c.meta.kind) || 'code'; }

  /* ---------- context and cache ---------- */
  async function loadStats(sid) {
    if (isNew(sid)) return;
    try { LV.stats[sid] = await api.get(`/api/sessions/${enc(sid)}/stats`); } catch (e) { return; }
    paintStats(sid);
  }
  MC.cacheLeft = () => { const st = LV.stats[S.session], t = st && st.cache && toMs(st.cache.expiresAt); S.cacheTtl = ({ '1h': 3600, '5m': 300 })[st && st.cache && st.cache.ttl] || 300; return t ? Math.max(0, Math.round((t - Date.now()) / 1000)) : 0; };
  const ctxPct = (sid) => { const st = LV.stats[sid]; return st && st.contextPct != null ? Math.round(st.contextPct) : null; };
  function paintStats(sid) {
    convEls(sid).forEach((cv) => { const e = cv.querySelector('[data-ctx]'); if (!e) return; const p = ctxPct(sid); e.querySelector('.uctx').textContent = p == null ? '--' : p + '%'; e.classList.toggle('warn', p != null && p >= 80); });
    if (sid === S.session) MC.emit('stats', sid);
  }

  /* ---------- drafts: what is typed, kept on the server so the phone and the other tabs see it ---------- */
  const DR = { known: {}, unsent: {}, t: {} };
  const draftKey = (sid) => (isNew(sid) ? (/^newc:/.test(sid) ? 'c-' : 'n-') + sid.replace(/^newc?:/, '') : sid);
  const draftOf = (k) => DR.unsent[k] || DR.known[k] || null;
  const readyAtts = (list) => (list || []).filter((a) => a.status === 'ready' && a.id).map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size || 0 }));
  const sameDraft = (a, b) => !!a && !!b && a.text === b.text && JSON.stringify(a.atts || []) === JSON.stringify(b.atts || []);
  function noteDraft(sid, text) {
    const k = draftKey(sid), now = { text, atts: readyAtts(LV.att[k]) };
    const pid = pidOf();
    if (/^n-/.test(k)) now.project = pid && !isRootId(pid) ? pid : '';
    if (!draftOf(k) && !text.trim() && !now.atts.length) return;
    if (sameDraft(now, draftOf(k))) return;
    DR.unsent[k] = now; clearTimeout(DR.t[k]); DR.t[k] = setTimeout(() => pushDraft(k), 600);
  }
  async function pushDraft(k, keep) {
    const d = DR.unsent[k]; if (!d) return;
    let ok = false;
    try { const r = await fetch('/api/drafts', { method: 'PUT', keepalive: !!keep, headers: { 'X-MC': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k, text: d.text, atts: d.atts, project: d.project, tab: MC.tabId }) }); ok = r.ok; } catch (e) { /* the server is away: tried again at the next change */ }
    if (ok) { DR.known[k] = d; if (DR.unsent[k] === d) delete DR.unsent[k]; if (/^n-/.test(k)) loadNewDrafts(); }
  }
  async function pullDraft(k) {
    let d; try { d = await api.get('/api/drafts?key=' + enc(k)); } catch (e) { return; }
    if (!d) return;
    DR.known[k] = { text: String(d.text || ''), atts: Array.isArray(d.atts) ? d.atts : [], project: d.project };
    if (DR.unsent[k]) return; /* typed here and not saved yet: those words win */
    applyDraft(k, DR.known[k]);
  }
  /* puts a draft in every open box for it; a file still uploading here stays */
  function applyDraft(k, d) {
    const up = (LV.att[k] || []).filter((a) => a.status === 'up');
    LV.att[k] = (d.atts || []).map((a) => ({ id: a.id, name: a.name || 'file', kind: a.kind || 'file', size: a.size || 0, status: 'ready', src: a.kind === 'image' ? '/api/uploads/' + enc(a.id) + '/file' : '' })).concat(up);
    /* only painted, never saved back: a box being typed in here keeps its words, and must not send them (or an empty box) back
       over the draft that just came in, which would wipe the words the other device has */
    $$(`.convo[data-dk="${CSS.escape(k)}"]`).forEach((cv) => { const ta = cv.querySelector('textarea'); if (ta && ta.value !== d.text && document.activeElement !== ta) { ta.value = d.text; cv._fit && cv._fit(); } cv._chips && cv._chips(); });
  }
  function moveDraft(from, to) {
    const d = draftOf(from); if (!d || (!d.text.trim() && !(d.atts || []).length)) return;
    DR.unsent[to] = { text: d.text, atts: d.atts }; DR.unsent[from] = { text: '', atts: [], project: d.project };
    LV.att[to] = LV.att[from] || []; LV.att[from] = [];
    pushDraft(to); pushDraft(from);
  }
  addEventListener('pagehide', () => Object.keys(DR.unsent).forEach((k) => pushDraft(k, true)));

  /* ---------- reading a conversation ---------- */
  /* While a conversation is being read, live events wait and are applied after it (the read can rebuild the live turn). */
  function hold() {
    LV.holding++; let done = false; const t = setTimeout(free, 10000);
    function free() { if (done) return; done = true; clearTimeout(t); LV.holding = Math.max(0, LV.holding - 1); if (LV.holding) return; const q = LV.held; LV.held = []; q.forEach(onChat); }
    return free;
  }
  async function loadConv(sid) {
    if (isNew(sid)) return;
    const c = LV.conv[sid] || (LV.conv[sid] = { msgs: [], cursor: null, hasMore: false, state: 'loading' });
    if (c.busy) { c.again = true; return; }
    c.busy = true; const free = hold();
    try {
      const s = await api.get(`/api/sessions/${enc(sid)}?limit=40`);
      c.msgs = Array.isArray(s.messages) ? s.messages : []; c.cursor = s.cursor != null ? s.cursor : null; c.hasMore = !!s.hasMore && c.cursor != null;
      c.meta = { title: s.title, cwd: s.cwd, kind: s.kind, locked: !!s.locked, readOnly: !!s.readOnly, link: !!s.link, archived: !!s.archived, elsewhere: s.elsewhere || null, machine: s.machine || null, mode: typeof s.mode === 'string' ? s.mode : null };
      if (Array.isArray(s.sends)) c.sends = s.sends;
      c.state = 'ok'; c.err = null;
      applyLive(sid, s);
    } catch (e) { c.state = 'err'; c.err = errText(e); }
    finally { c.busy = false; free(); }
    paintHist(sid, !c.seen); c.seen = true; paintLive(sid); paintHeads(); paintWaits(sid);
    if (c.again) { c.again = false; loadConv(sid); }
  }
  async function loadOlder(sid, btn) {
    const c = LV.conv[sid]; if (!c || !c.hasMore || c.olderBusy) return;
    c.olderBusy = true; if (btn) btn.textContent = 'Loading older messages';
    try {
      const s = await api.get(`/api/sessions/${enc(sid)}?limit=40&before=${enc(c.cursor)}`);
      c.msgs = (Array.isArray(s.messages) ? s.messages : []).concat(c.msgs);
      c.cursor = s.cursor != null ? s.cursor : null; c.hasMore = !!s.hasMore && c.cursor != null;
    } catch (e) { if (btn) btn.textContent = 'Could not load older messages. Click to try again'; c.olderBusy = false; return; }
    c.olderBusy = false;
    /* keep the reader where they were: the new messages go above */
    convEls(sid).forEach((cv) => { const sc = cv.querySelector('.convo-scroll'), h0 = sc.scrollHeight, t0 = sc.scrollTop; fillHist(cv, sid); sc.scrollTop = t0 + sc.scrollHeight - h0; });
  }

  /* ---------- turning messages into HTML ---------- */
  const TOOL_RE = /^\[tool: ([^\]]*)\]$/;
  const splitTool = (t) => { const m = /^(\S+)\s*([\s\S]*)$/.exec(String(t || '').trim()); return m ? [m[1], m[2]] : [String(t), '']; };
  const stepsHtml = (tools, open) => {
    if (!tools.length) return '';
    const count = {}; tools.forEach((t) => { const n = splitTool(t)[0]; count[n] = (count[n] || 0) + 1; });
    const sum = Object.entries(count).map(([n, k]) => (k > 1 ? `${n} ${k}` : n)).join(', ');
    return `<div class="msg"><div class="mb"><details class="stepgrp" ${open ? 'open' : ''}><summary>${I('zap', 'sm')}<span>${tools.length === 1 ? '1 step' : tools.length + ' steps'}</span><span class="faint ellip">${esc(sum)}</span></summary><div class="steps">${tools.map((t) => { const [n, d] = splitTool(t); return `<div class="step">${I('check', 'sm')}<b>${esc(n.slice(0, 60))}</b><span class="x ellip" title="${esc(d)}">${esc(d.slice(0, 200))}</span></div>`; }).join('')}</div></details></div></div>`;
  };
  const safeSrc = (s) => (/^(\/api\/|data:image\/|blob:)/.test(String(s || '')) ? String(s) : '');
  const imgsHtml = (list) => {
    const L = (list || []).filter((m) => m && safeSrc(m.src));
    if (!L.length) return '';
    return `<div class="mimgs">${L.map((m) => (m.kind === 'pdf' || /\.pdf$/i.test(m.name || '')
      ? `<a class="mfile" href="${esc(safeSrc(m.src))}" target="_blank" rel="noopener">${I('doc', 'sm')}${esc(m.name || 'PDF')}</a>`
      : `<button class="mimg" data-img="${esc(safeSrc(m.src))}" title="${esc(m.caption || m.name || '')}"><img src="${esc(safeSrc(m.src))}" alt="${esc(m.name || '')}" loading="lazy"></button>`)).join('')}</div>`;
  };
  const turnHtml = (t) => {
    if (!t || typeof t !== 'object') return '';
    const a = toMs(t.startedAt), b = toMs(t.endedAt), ms = t.durationMs != null ? t.durationMs : a != null && b != null ? b - a : null;
    const bits = [];
    if (!t.partial && ms != null) bits.push('Ran for ' + dur(ms));
    if (t.outputTokens) bits.push(tok(t.outputTokens) + ' out');
    return bits.length ? `<span class="turnm">${esc(bits.join(' · '))}</span>` : '';
  };
  /* long messages fold; the answer at the end of a turn starts open. A message opened or closed by hand keeps that. */
  const isLong = (t) => t.length > 700 || t.split('\n').length > 10;
  const bubble = (me, at, text, extra, meta, fid, openDflt) => {
    const long = !!text && isLong(text), open = !long || (fid in LV.open ? LV.open[fid] : !!openDflt);
    return `<div class="msg ${me ? 'me' : ''}"><div class="mb"><div class="mt"><b>${me ? 'You' : 'Claude'}</b>${esc(hhmm(at))}${meta || ''}</div>${text ? `<div class="tx md ${open ? '' : 'fold'}">${MC.md(cap(text, open ? 100000 : 4000))}</div>` : ''}${long ? `<button class="more" data-more="${esc(fid)}" data-open="${open ? 1 : 0}">${open ? 'Show less' : 'Show more'}</button>` : ''}${extra || ''}${text ? `<div class="hov"><button data-h="copy">${I('copy', 'sm')}Copy</button></div>` : ''}</div></div>`;
  };
  const noticeHtml = (label, text, at) => {
    const body = String(text || '').trim(), head = `${I('info', 'sm')}<span>${esc(String(label || 'System message').slice(0, 200))}</span><span class="faint">${esc(hhmm(at))}</span>`;
    return body ? `<details class="nline"><summary>${head}</summary><pre>${esc(cap(body, 20000))}</pre></details>` : `<div class="nline">${head}</div>`;
  };
  const HANDOFF_MARK = '[Mission Control handoff]';
  function histHtml(sid, msgs) {
    const out = []; let tools = [];
    const flush = () => { if (tools.length) { out.push(stepsHtml(tools, false)); tools = []; } };
    msgs.forEach((m, i) => {
      if (m.role === 'notice') { flush(); out.push(noticeHtml(m.label, m.text, m.at)); return; }
      const t = String(m.text || '').trim(), imgs = Array.isArray(m.images) ? m.images : [];
      const tm = TOOL_RE.exec(t);
      if (tm) { tools.push(tm[1]); if (imgs.length) { flush(); out.push(bubble(false, m.at, '', imgsHtml(imgs))); } return; }
      flush();
      const me = m.role === 'user';
      if (!t && !imgs.length) return;
      out.push(bubble(me, m.at, t, imgsHtml(imgs), me ? '' : turnHtml(m.turn), sid + ':' + (m.pos != null ? m.pos : i), !me && !!m.turn));
    });
    flush();
    return out.join('');
  }

  /* ---------- the live turn: one record per Claude process ---------- */
  const rec = (runId) => LV.store[runId] || (LV.store[runId] = { runId, status: 'starting', items: [], startedAt: new Date().toISOString(), sessionId: null, key: null, turnOpen: false, seq: 0 });
  /* the words for a tool call that is running: what Claude said it does (a Bash description), else the command or file */
  const runLine = (b) => { const i = b.input || {}; const what = String(i.description || i.command || i.file_path || i.path || i.pattern || i.url || '').replace(/\s+/g, ' ').slice(0, 120); return (b.name === 'Bash' || !b.name ? '' : b.name + (what ? ': ' : '')) + what || String(b.name || 'a tool'); };
  const openTool = (r) => { if (!r || !r.open || !r.open.size) return null; let o = null; r.open.forEach((v) => { if (!o || v.at < o.at) o = v; }); return o; };
  const toolClock = (r) => { const o = openTool(r); return o ? clock(Date.now() - o.at) : ''; };
  const toolLine = (b) => { const i = b.input || {}; const hint = String(i.file_path || i.path || i.command || i.description || i.pattern || i.url || '').replace(/\s+/g, ' ').slice(0, 90); return String(b.name || 'tool').slice(0, 60) + (hint ? ' ' + hint : ''); };
  const normAtt = (a) => ({ id: a && a.id, name: String((a && a.name) || 'file'), kind: a && a.kind, src: (a && a.src) || (a && a.id ? '/api/uploads/' + enc(a.id) + '/file' : '') });
  function addUser(r, text, atts, src, at) {
    text = String(text == null ? '' : text);
    const same = r.items.filter((i) => i.kind === 'user' && i.text === text);
    if (src === 'local') { const e0 = same.find((i) => i.ev && !i.claimed); if (e0) { e0.claimed = true; e0.local = true; return e0; } }
    else { const l0 = same.find((i) => i.local && !i.confirmed); if (l0) { l0.confirmed = true; return l0; } }
    const during = r.turnOpen || (r.status === 'working' && r.items.some((i) => i.kind === 'text' || i.kind === 'tool'));
    const it = { kind: 'user', text, atts: (atts || []).map(normAtt), at: at || new Date().toISOString(), during };
    if (src === 'local') it.local = true; else it.ev = true;
    r.items.push(it); r.turnOpen = true; if (r.status === 'idle') r.status = 'working';
    return it;
  }
  function addPerm(r, p) {
    const id = String(p.requestId);
    if (r.items.some((i) => i.kind === 'perm' && i.requestId === id)) return;
    const qs = Array.isArray(p.questions) ? p.questions.filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options)) : null;
    r.items.push({ kind: 'perm', requestId: id, tool: String(p.tool || 'a tool').slice(0, 80), summary: String(p.summary || '').replace(/\s+/g, ' ').trim(), input: p.input && typeof p.input === 'object' ? p.input : null, suggestions: Array.isArray(p.suggestions) ? p.suggestions : [], state: 'pending', questions: qs && qs.length ? qs : null, pick: {}, other: {} });
    const it = r.items[r.items.length - 1];
    if (it.questions) { qdRestore(it, p); if (qdAll()[id]) { const k = keyOf(r); if (k) setTimeout(() => paintHist(k), 0); } }
    if (r.status === 'idle') r.status = 'working';
  }
  function resolvePerm(r, id, behavior, msg, expired) {
    const it = r.items.find((i) => i.kind === 'perm' && i.requestId === String(id)); if (!it || (it.state !== 'pending' && it.state !== 'closed')) return;
    it.state = behavior === 'allow' ? (it.always ? 'always' : 'allowed') : behavior === 'deny' && !expired ? 'denied' : 'closed'; it.busy = false; it.err = '';
    if (expired) it.note = 'It closed after waiting a long time with no answer.';
    else if (typeof msg === 'string' && msg && behavior !== 'allow') it.note = msg;
    if (it.questions) { if (it.state === 'allowed' || it.skipped) qdDrop(it.requestId); else if (qdHasText(it)) qdSave(r, it); }
  }
  const closePerms = (r) => r.items.forEach((i) => { if (i.kind === 'perm' && i.state === 'pending') { i.state = 'closed'; i.note = 'The run ended before this was answered.'; if (i.questions && qdHasText(i)) qdSave(r, i); } });
  const keyOf = (r) => r.key || r.sessionId;
  /* a run of the PC this one is linked to is asked there, through the link (routes/pcLink.js) */
  const runApi = (runId) => (LV.store[runId] && LV.store[runId].pc ? '/api/pc/runs/' : '/api/runs/') + enc(runId);
  async function loadPending(runId) {
    let d; try { d = await api.get(`${runApi(runId)}/pending`); } catch (e) { return; }
    const list = Array.isArray(d) ? d : (d && (d.pending || d.items)) || [];
    if (!list.length) return;
    const r = rec(runId); list.forEach((p) => { p = p && p.permission ? p.permission : p; if (p && p.requestId) addPerm(r, p); });
    paintLive(keyOf(r)); buildAgents(); paintTrees();
  }

  function onChat(d) {
    if (!d || !d.runId) return;
    if (LV.holding) { LV.held.push(d); return; }
    const r = rec(d.runId);
    if (d.resync) { if (typeof d.seq === 'number' && d.seq > r.seq) r.seq = d.seq; if (r.sessionId && LV.conv[r.sessionId]) loadConv(r.sessionId); return; }
    if (typeof d.seq === 'number') {
      if (d.seq <= r.seq) return;
      const gap = r.seq > 0 && d.seq > r.seq + 1 && r.sessionId && LV.conv[r.sessionId];
      r.seq = gap ? d.seq - 1 : d.seq;
      if (gap) { loadConv(r.sessionId); LV.held.push(d); return; }
    }
    applyChat(r, d, false);
  }
  function applyChat(r, d, replay) {
    const paint = () => { if (!replay) paintLive(keyOf(r)); };
    if (r.polled && !replay && (d.sent || Array.isArray(d.images) || (d.event && (d.event.type === 'assistant' || d.event.mcNotice)))) { pollTranscript(r); return; }
    if (d.sent && String(d.sent.text || '').indexOf(HANDOFF_MARK) === 0) return;
    if (d.sent) { addUser(r, d.sent.text, d.sent.attachments, 'event', d.at); paint(); return; }
    if (d.permission && d.permission.requestId) { addPerm(r, d.permission); paint(); if (!replay) { buildAgents(); paintTrees(); } return; }
    if (d.permissionDone != null) { resolvePerm(r, d.permissionDone, d.behavior, d.message, !!d.expired); paint(); return; }
    if (Array.isArray(d.images)) { if (d.images.length) r.items.push({ kind: 'img', media: d.images }); paint(); return; }
    if (d.turnDone) {
      r.sessionId = d.sessionId || r.sessionId; r.turnOpen = false; r.open = null;
      if (!replay && d.ok !== false) readAloud(r);
      if (r.status === 'working' || r.status === 'starting' || r.status === 'idle') r.status = 'idle';
      turnEnd(r); return;
    }
    if (d.done) {
      r.sessionId = d.sessionId || r.sessionId; r.turnOpen = false; r.open = null; closePerms(r);
      if (d.state === 'stopped') r.status = 'stopped';
      else if (r.status === 'error') { /* keep the reported error */ }
      else if (d.state === 'done' || d.code === 0) r.status = 'done';
      else { r.status = 'error'; r.error = (typeof d.error === 'string' && d.error) || `The run ended with an error (code ${d.code}).`; }
      runEnded(r); return;
    }
    const ev = d.event || {};
    if (ev.session_id && !r.sessionId) {
      r.sessionId = ev.session_id;
      /* a process started elsewhere for a conversation open here: from now on its answer shows here too */
      if (!replay && !r.key && LV.view[r.sessionId] !== r.runId && convEls(r.sessionId).length) { loadConv(r.sessionId); return; }
    }
    if (r.status === 'starting') r.status = 'working';
    if ((ev.type === 'system' && ev.subtype === 'init') || (ev.type === 'user' && ev.isReplay)) { if (r.status === 'idle') r.status = 'working'; }
    if (ev.type === 'user' && r.open && ev.message && Array.isArray(ev.message.content)) ev.message.content.forEach((b) => { if (b && b.type === 'tool_result') r.open.delete(b.tool_use_id); });
    if (ev.type === 'user' && ev.mcNotice && typeof ev.mcNotice === 'object') r.items.push({ kind: 'notice', label: ev.mcNotice.label, text: ev.mcNotice.text, at: new Date().toISOString() });
    else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      if (r.status === 'idle') r.status = 'working';
      ev.message.content.forEach((b) => { if (b.type === 'text' && b.text) r.items.push({ kind: 'text', text: b.text }); else if (b.type === 'tool_use') { r.items.push({ kind: 'tool', text: toolLine(b) }); if (b.id) (r.open || (r.open = new Map())).set(b.id, { line: runLine(b), at: Date.now() }); } });
    } else if (ev.type === 'result' && ev.is_error) r.items.push({ kind: 'err', text: String(ev.result || 'Claude reported an error.') });
    paint();
  }
  function pollTranscript(r) {
    if (r.pollT) return;
    r.pollT = setTimeout(() => { r.pollT = null; if (r.polled && r.sessionId && (r.status === 'working' || r.status === 'starting')) loadConv(r.sessionId); }, 4000);
  }
  /* the server's account of a turn under way: the saved part stops where it began, and its events come with it */
  function applyLive(sid, s) {
    const L = s && s.live;
    if (L && L.runId) {
      const r = rec(L.runId);
      if (LV.conv[sid] && LV.conv[sid].meta && LV.conv[sid].meta.link) r.pc = true;
      r.sessionId = sid; r.items = []; r.turnOpen = false; r.seq = 0; r.polled = !!L.truncated; r.open = null;
      if (L.cut && Array.isArray(L.events)) L.events.forEach((e) => { r.seq = Math.max(r.seq, e.seq || 0); applyChat(r, e, true); });
      r.seq = Math.max(r.seq, L.upto || 0); r.turnOpen = true;
      (L.tools || []).forEach((t) => { const o = r.open && r.open.get(t.id), at = toMs(t.since); if (o && at != null) o.at = at; }); /* when each began, by the server's clock */
      r.status = L.state === 'starting' ? 'starting' : 'working';
      if (L.turn && toMs(L.turn.startedAt) != null) { r.startedAt = L.turn.startedAt; LV.turns[r.runId] = { startedAt: L.turn.startedAt, out: L.turn.outputTokens }; }
      LV.view[sid] = r.runId;
      loadPending(r.runId);
    } else {
      const c = LV.view[sid] && LV.store[LV.view[sid]];
      if (c) { c.items = c.items.filter((it) => it.kind === 'err'); c.polled = false; }
    }
  }
  /* a new conversation got its id at the end of its first turn: every tab that shows it moves to the id, and so does its draft */
  function adopt(key, sid) {
    if (!key || !sid || key === sid) return;
    LV.view[sid] = LV.view[key]; delete LV.view[key];
    if (LV.conv[key]) { LV.conv[sid] = LV.conv[key]; delete LV.conv[key]; }
    moveDraft(draftKey(key), sid);
    if (LV.modePick[key]) { LV.modePick[sid] = LV.modePick[key]; delete LV.modePick[key]; }
    ((MC.D && MC.D.tabs && MC.D.tabs()) || []).forEach((t) => { if (t.session === key) t.session = sid; });
    if (S.session === key) S.session = sid;
    ((MC.D && MC.D.allVps && MC.D.allVps()) || []).forEach((v) => { if (v.state.session === key) v.state.session = sid; });
    convEls(key).forEach((cv) => { cv.dataset.sid = sid; cv.dataset.dk = sid; });
    MC.D && MC.D.saveTabs && MC.D.saveTabs();
  }
  /* the answer's last words (its text after the last tool call), read aloud by BlitzVoice when "Read replies aloud" is on and
     the conversation is on screen; MC.speakReply skips a reply it already read */
  function readAloud(r) {
    const els = (r.sessionId ? convEls(r.sessionId) : []).concat(r.key ? convEls(r.key) : []);
    if (document.visibilityState !== 'visible' || !els.some((el) => el.offsetParent)) return;
    const parts = [];
    for (let i = r.items.length - 1; i >= 0; i--) { const it = r.items[i]; if (it.kind === 'text') parts.unshift(it.text); else if (it.kind === 'tool' || it.kind === 'user') break; }
    const text = parts.join('\n').trim(); if (!text) return;
    let h = 5381; for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    MC.speakReply(text, r.runId + ':' + h.toString(36), false);
  }
  async function turnEnd(r) {
    const key = r.key, sid = r.sessionId;
    paintLive(keyOf(r));
    if (key && sid) { r.key = null; adopt(key, sid); }
    loadRuns(); reloadLists();
    if (sid) { loadStats(sid).then(() => { delete LV.pick[sid]; paintComposers(sid); }); if (LV.conv[sid] || convEls(sid).length) await loadConv(sid); }
    if (key && sid) MC.emit('session', S.session);
  }
  async function runEnded(r) {
    if (r.key && r.sessionId) { const key = r.key; r.key = null; adopt(key, r.sessionId); }
    paintLive(keyOf(r));
    await loadRuns(); reloadLists();
    if (r.sessionId) { loadStats(r.sessionId); if (LV.conv[r.sessionId]) loadConv(r.sessionId); }
  }

  const askAnswered = (it, qi) => { const picks = (it.pick && it.pick[qi]) || [], other = String((it.other && it.other[qi]) || '').trim(); return picks.concat(other ? [other] : []); };
  const askReady = (it) => it.questions.every((q, qi) => askAnswered(it, qi).length > 0);

  /* ---------- answers being written to Claude's questions ----------
     What is picked and typed is kept in this browser on every keystroke (so a reload keeps it) and sent to the server now and
     then (so the question's countdown starts again, and another device sees the words). An answer that was sent is dropped;
     one whose question closed first stays, with Copy and Send as a message, until it is sent or dismissed. */
  const QD_KEY = 'mc.askDrafts', QD_KEEP = 30 * 864e5;
  const qdAll = () => { let o; try { o = JSON.parse(localStorage.getItem(QD_KEY) || '{}'); } catch (e) { o = {}; } return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; };
  const qdWrite = (o) => { try { localStorage.setItem(QD_KEY, JSON.stringify(o)); } catch (e) { /* full or blocked: the server copy remains */ } };
  const qdHasText = (it) => it.questions && it.questions.some((q, qi) => askAnswered(it, qi).length);
  function qdSave(r, it) {
    const o = qdAll(), now = Date.now();
    for (const k of Object.keys(o)) if (!(now - (o[k].at || 0) < QD_KEEP)) delete o[k];
    if (!qdHasText(it)) delete o[it.requestId];
    else o[it.requestId] = { at: now, runId: r.runId, sid: r.sessionId || r.key || '', questions: it.questions.map((q) => q.question), other: it.other, pick: it.pick, closed: it.state !== 'pending', note: it.note || '' };
    qdWrite(o);
  }
  const qdDrop = (rid) => { const o = qdAll(); if (o[rid]) { delete o[rid]; qdWrite(o); } };
  /* a question the page sees again (a reload, the live turn read again): the words come back, from here or from the server */
  function qdRestore(it, p) {
    const d = qdAll()[it.requestId];
    if (d) { it.other = d.other && typeof d.other === 'object' ? d.other : {}; it.pick = d.pick && typeof d.pick === 'object' ? d.pick : {}; return; }
    if (p.draft && typeof p.draft === 'object') it.questions.forEach((q, qi) => { if (typeof p.draft[q.question] === 'string') it.other[qi] = p.draft[q.question]; });
  }
  /* the server hears of the typing a moment after it stops, and at least every 20 seconds during it */
  const QT = {};
  function typingSoon(r, it) {
    const t = QT[it.requestId] || (QT[it.requestId] = { timer: 0, last: 0 });
    clearTimeout(t.timer);
    t.timer = setTimeout(() => typingNow(r, it), Date.now() - t.last > 20000 ? 300 : 1500);
  }
  function typingNow(r, it) {
    const t = QT[it.requestId] || (QT[it.requestId] = { timer: 0, last: 0 }); t.last = Date.now();
    if (it.state !== 'pending') return;
    const draft = {}; it.questions.forEach((q, qi) => { const v = String((it.other && it.other[qi]) || ''); if (v) draft[q.question] = v.slice(0, 20000); });
    api.post(`${runApi(r.runId)}/permission/typing`, { requestId: it.requestId, draft }).catch(() => { /* answered, closed, or an older server: the kept copy is here */ });
  }
  /* a question open on a page does not run out: every few minutes the page says it is still there */
  setInterval(() => Object.values(LV.store).forEach((r) => r.items.forEach((it) => {
    if (it.kind === 'perm' && it.questions && it.state === 'pending' && convEls(keyOf(r)).length) api.post(`${runApi(r.runId)}/permission/typing`, { requestId: it.requestId }).catch(() => {});
  })), 5 * 60 * 1000);
  /* what was picked and typed, as one message for Claude */
  const keptText = (questions, it) => questions.map((q, qi) => { const a = askAnswered(it, qi); return a.length ? `${q}\n${a.join(', ')}` : ''; }).filter(Boolean).join('\n\n');
  const keptMessage = (questions, it) => 'My answer to your question (it closed before I could send it):\n\n' + keptText(questions, it);
  const keptHtml = (rid, questions, it) => `<div class="qkept" data-qkept="${esc(rid)}"><div class="faint">What you wrote was not sent:</div><pre class="qkt">${esc(keptText(questions, it))}</pre><div class="row"><button class="btn sm primary" data-qk="send">${I('send', 'sm')}Send as a message</button><button class="btn sm" data-qk="copy">${I('copy', 'sm')}Copy</button><button class="btn sm ghost" data-qk="drop">Dismiss</button></div></div>`;
  /* kept answers of this conversation whose question is no longer on the page (the turn ended, or the page was reloaded) */
  function keptHist(sid) {
    const o = qdAll(), live = new Set(); Object.values(LV.store).forEach((r) => r.items.forEach((i) => { if (i.kind === 'perm') live.add(i.requestId); }));
    return Object.entries(o).filter(([rid, d]) => d && (d.sid === sid || (LV.store[d.runId] && LV.store[d.runId].sessionId === sid)) && !live.has(rid) && Array.isArray(d.questions)).map(([rid, d]) => {
      const it = { other: d.other || {}, pick: d.pick || {} };
      return `<div class="ask fin" data-rid="${esc(rid)}"><div class="at">${I('help')}Claude asked ${MC.st('idle', 'Closed')}</div>${d.questions.map((q) => `<div class="qq"><div class="qh"><b>${esc(q)}</b></div></div>`).join('')}${keptHtml(rid, d.questions, it)}</div>`;
    }).join('');
  }
  const fitQ = (root) => root.querySelectorAll('textarea[data-qother]').forEach((t) => { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 420) + 'px'; t.style.overflowY = t.scrollHeight > 420 ? 'auto' : 'hidden'; });
  function permHtml(it, runId) {
    const a = `data-prun="${esc(runId)}" data-rid="${esc(it.requestId)}"`;
    if (it.questions) {
      const qs = it.questions.map((q, qi) => {
        const picks = (it.pick && it.pick[qi]) || [];
        const head = `<div class="qh">${q.header ? `<span class="badge">${esc(q.header)}</span>` : ''}<b>${esc(q.question)}</b>${q.multiSelect ? '<span class="faint">Pick any</span>' : ''}</div>`;
        if (it.state !== 'pending') { const ans = it.answers && it.answers[q.question]; return `<div class="qq">${head}${ans ? `<div class="qans">${esc(ans)}</div>` : ''}</div>`; }
        return `<div class="qq">${head}<div class="qopts">${q.options.map((o, oi) => { const on = picks.includes(o.label); return `<button class="qopt ${on ? 'on' : ''}" data-qopt="${qi}:${oi}" ${it.busy ? 'disabled' : ''}>${I(on ? 'check' : 'circle', 'sm')}<span><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></button>`; }).join('')}</div>
          <textarea class="qother" data-qother="${qi}" rows="1" maxlength="20000" placeholder="Other: write your own answer" ${it.busy ? 'disabled' : ''}>${esc((it.other && it.other[qi]) || '')}</textarea></div>`;
      }).join('');
      if (it.state === 'pending') return `<div class="ask" ${a}><div class="at">${I('help')}Claude asks</div>${qs}<div class="row"><button class="btn primary sm" data-pact="answers" ${it.busy || !askReady(it) ? 'disabled' : ''}>${I('send', 'sm')}Send answers</button><button class="btn sm ghost" data-pact="deny" ${it.busy ? 'disabled' : ''}>Skip</button>${it.busy ? '<span class="faint">Sending</span>' : ''}</div>${it.err ? `<div class="lv-err">${esc(it.err)}</div>` : ''}</div>`;
      /* closed before an answer went: what was picked and typed stays, to copy or send as a message */
      const kept = it.state !== 'allowed' && !it.keptDone && qdHasText(it) ? keptHtml(it.requestId, it.questions.map((q) => q.question), it) : '';
      return `<div class="ask fin" ${a}><div class="at">${I('help')}Claude asked ${MC.st(it.state === 'allowed' ? 'done' : 'idle', it.state === 'allowed' ? 'Answered' : it.state === 'denied' ? 'Skipped' : 'Closed')}</div>${qs}${it.note ? `<div class="faint">${esc(String(it.note).slice(0, 200))}</div>` : ''}${kept}</div>`;
    }
    const lines = it.input ? Object.keys(it.input).slice(0, 12).map((k) => k + ': ' + String(it.input[k])).join('\n') : '';
    const det = lines ? `<details class="pdet"><summary>Details</summary><pre>${esc(cap(lines, 2000))}</pre></details>` : '';
    const head = `<div class="at">${I('warn')}Claude wants to use <b>${esc(it.tool)}</b></div>${it.summary ? `<code>${esc(it.summary.slice(0, 400))}</code>` : ''}`;
    if (it.state === 'pending') return `<div class="ask" ${a}>${head}${det}<div class="row"><button class="btn primary sm" data-pact="allow" ${it.busy ? 'disabled' : ''}>${I('check', 'sm')}Allow</button>${it.suggestions.length ? `<button class="btn sm" data-pact="always" ${it.busy ? 'disabled' : ''} title="Allow this now and do not ask again for the same kind of action">Allow always</button>` : ''}<button class="btn sm ghost" data-pact="deny" ${it.busy ? 'disabled' : ''}>Deny</button>${it.busy ? '<span class="faint">Sending</span>' : ''}</div>${it.err ? `<div class="lv-err">${esc(it.err)}</div>` : ''}</div>`;
    const word = { allowed: ['done', 'Allowed'], always: ['done', 'Always allowed'], denied: ['fail', 'Denied'] }[it.state] || ['idle', 'Closed'];
    return `<div class="ask fin" ${a}>${head}<div class="row">${MC.st(word[0], word[1])}</div>${it.note ? `<div class="faint">${esc(String(it.note).slice(0, 200))}</div>` : ''}${det}</div>`;
  }
  function liveTurnText(r) {
    const t = LV.turns[r.runId]; if (!(r.status === 'working' || r.status === 'starting')) return '';
    const a = toMs((t && t.startedAt) || r.startedAt); return (a != null ? clock(Date.now() - a) : '') + (t && t.out ? ' · ' + tok(t.out) : '');
  }
  function liveHtml(r) {
    if (!r) return '';
    let h = '', tools = [];
    const working = r.status === 'working' || r.status === 'starting';
    let lastText = -1; r.items.forEach((it, i) => { if (it.kind === 'text') lastText = i; });
    const flush = () => { if (tools.length) { h += stepsHtml(tools, working); tools = []; } };
    r.items.forEach((it, i) => {
      if (it.kind === 'tool') { tools.push(it.text); return; }
      flush();
      if (it.kind === 'user') h += bubble(true, it.at, it.text, imgsHtml(it.atts) + (it.during ? '<div class="faint lv-during">Sent during the reply</div>' : ''), '', 'live:' + r.runId + ':' + i, false);
      else if (it.kind === 'text') h += bubble(false, null, it.text, '', '', 'live:' + r.runId + ':' + i, i === lastText);
      else if (it.kind === 'notice') h += noticeHtml(it.label, it.text, it.at);
      else if (it.kind === 'img') h += bubble(false, null, '', imgsHtml(it.media));
      else if (it.kind === 'perm') h += permHtml(it, r.runId);
      else if (it.kind === 'err') h += `<div class="lv-err">${I('xc', 'sm')}${esc(cap(it.text, 2000))}</div>`;
    });
    flush();
    if (r.status === 'stopped') h += `<div class="lv-err">${I('stop', 'sm')}Stopped.</div>`;
    else if (r.status === 'error') h += `<div class="lv-err">${I('xc', 'sm')}${esc(cap(r.error || 'The run failed.', 2000))}</div>`;
    if (r.notice) h += `<div class="lv-err">${I('warn', 'sm')}${esc(r.notice)}${r.elsewhere ? ' <button class="btn sm" data-anyway>Send anyway</button>' : ''}</div>`;
    return h;
  }
  /* the line above the message box while Claude works, with Stop: it stays in view when the conversation is scrolled up.
     Starting, thinking and a running tool share one line, so it does not jump when it changes from one to the other */
  function liveBar(r) {
    if (!r || !(r.status === 'starting' || r.status === 'working')) return '';
    const stop = `<button class="btn sm ghost" data-stop="${esc(r.runId)}">${I('stop', 'sm')}Stop</button>`;
    const line = (label, what, clock) => `<div class="thinking tool">${MC.st('run', label)}<span class="ellip grow">${what}</span>${clock}<span class="faint mono" data-turn-live="${esc(r.runId)}">${esc(liveTurnText(r))}</span>${stop}</div>`;
    if (r.status === 'starting') return line('Starting', '', '');
    const o = openTool(r);
    return pendingIn(r) ? `<div class="thinking wait">${I('clock', 'sm')}Claude is waiting for your answer above${stop}</div>`
      : o ? line('Running', esc(o.line), `<b class="mono" data-tool-live="${esc(r.runId)}">${esc(toolClock(r))}</b>`)
      : line('Thinking', '', '');
  }
  setInterval(() => {
    $$('[data-turn-live]').forEach((e) => { const r = LV.store[e.dataset.turnLive]; const t = r ? liveTurnText(r) : ''; if (e.textContent !== t) e.textContent = t; });
    $$('[data-tool-live]').forEach((e) => { const t = toolClock(LV.store[e.dataset.toolLive]); if (e.textContent !== t) e.textContent = t; });
    $$('[data-bg-since]').forEach((e) => { const t = clock(Date.now() - Number(e.dataset.bgSince)); if (e.textContent !== t) e.textContent = t; });
  }, 1000);

  /* ---------- painting the open conversation panels ---------- */
  const atBottom = (sc) => sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  function convEls(key) { return key ? $$(`.convo[data-sid="${CSS.escape(key)}"]`) : []; }
  function fillHist(cv, sid) {
    const c = LV.conv[sid], h = cv.querySelector('.hist'), top = cv.querySelector('.older');
    if (isNew(sid)) {
      const chat = /^newc:/.test(sid), p = MC.projectInfo();
      h.innerHTML = `<div class="lv-hello">${I('chat', 'lg')}<b>${chat ? 'New simple chat' : 'New conversation in ' + esc(p.root ? p.folder : MC.curProject() || 'no project')}</b><span>${chat ? 'No project and no file tools. Your first message names it.' : 'Claude starts in ' + esc(p.folder || 'the default folder') + '. Your first message names it.'}</span></div>`;
      top.innerHTML = ''; return;
    }
    if (!c || c.state === 'loading') { h.innerHTML = `<div class="lv-empty">${I('loader', 'sm')}Loading the conversation</div>`; top.innerHTML = ''; return; }
    if (c.state === 'err') { h.innerHTML = `<div class="lv-err">${I('xc', 'sm')}Could not load this conversation: ${esc(c.err)} <button class="btn sm" data-reload>Try again</button></div>`; top.innerHTML = ''; return; }
    top.innerHTML = c.hasMore ? `<button class="lv-older" data-older>${I('chev', 'sm')}Load older messages</button>` : c.msgs.length ? '<div class="lv-start">Start of the conversation</div>' : '';
    h.innerHTML = (histHtml(sid, c.msgs) + pendingHtml(sid, c) + keptHist(sid)) || '<div class="lv-empty">No messages yet.</div>';
  }
  /* another PC's conversation: what you sent from here that its transcript does not show yet (it went, or that PC took it
     and is starting it). One that still waits stays in the bar above the message box, where it can be canceled. */
  function pendingHtml(sid, c) {
    if (!c.meta || !c.meta.readOnly) return '';
    const name = esc((c.meta.machine && c.meta.machine.name) || 'the other PC');
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    const users = c.msgs.filter((m) => m.role === 'user').map((m) => ({ at: toMs(m.at) || 0, t: norm(m.text) }));
    return ((c.sends || []).filter((x) => (x.state === 'taken' || x.state === 'sent') && Date.now() - (toMs(x.at) || 0) < 3600e3
      && !users.some((u) => u.at >= (toMs(x.at) || 0) - 600e3 && u.t && u.t.includes(norm(x.text).slice(0, 60))))
      .map((x) => bubble(true, x.at, x.text, `<div class="faint lv-pend">${I('loader', 'sm')}${x.state === 'taken' ? name + ' is starting it' : 'Sent to ' + name}</div>`)).join(''));
  }
  function paintHist(sid, toBottom) {
    convEls(sid).forEach((cv) => { const sc = cv.querySelector('.convo-scroll'), stick = toBottom || atBottom(sc); fillHist(cv, sid); if (stick) sc.scrollTop = sc.scrollHeight; });
  }
  function paintLive(key) {
    if (!key) return;
    const r = LV.view[key] && LV.store[LV.view[key]];
    convEls(key).forEach((cv) => {
      const sc = cv.querySelector('.convo-scroll'), stick = atBottom(sc), live = cv.querySelector('.live');
      /* the Other box being typed in keeps its focus and caret when the live part is drawn again */
      const f = document.activeElement, fq = f && live.contains(f) && f.matches('textarea[data-qother]') ? { rid: f.closest('[data-rid]').dataset.rid, qi: f.dataset.qother, a: f.selectionStart, b: f.selectionEnd } : null;
      live.innerHTML = liveHtml(r); fitQ(live);
      const lb = cv.querySelector('.lbar'), bh = liveBar(r); if (lb && lb.innerHTML !== bh) lb.innerHTML = bh;
      if (fq) { const t = live.querySelector(`[data-rid="${CSS.escape(fq.rid)}"] textarea[data-qother="${CSS.escape(fq.qi)}"]`); if (t && !t.disabled) { t.focus(); try { t.setSelectionRange(fq.a, fq.b); } catch (e) { /* fine */ } } }
      if (stick) sc.scrollTop = sc.scrollHeight;
    });
  }
  const paintHeads = () => $$('.vp').forEach((v) => { const t = v.querySelector('.vp-sub'), cv = v.querySelector('.convo[data-sid]'); if (t && cv) t.textContent = MC.sessionById(cv.dataset.sid).title; });
  const paintComposers = (sid) => convEls(sid).forEach((cv) => { const b = cv.querySelector('[data-c="model"] span'); if (b) b.textContent = modelLabel(modelOf(sid)); });

  /* ---------- Send later ---------- */
  async function loadDelayed() { try { const d = await api.get('/api/delayed'); LV.delayed = (d && d.items) || []; } catch (e) { return; } paintAllWaits(); }
  const delayedFor = (sid) => LV.delayed.filter((x) => (isNew(sid) ? !x.sessionId && x.projectId === (pidOf() || null) && !isRootId(pidOf()) : x.sessionId === sid));
  /* the bar above the message box: messages that wait for a time, and messages that wait for another PC */
  function waitsHtml(sid) {
    const d = delayedFor(sid).map((x) => `<div class="wrow ${x.status === 'failed' ? 'bad' : ''}" data-did="${esc(x.id)}">${I('clock', 'sm')}<b>${esc(x.kind === 'reset' && !x.at ? 'At the reset' : whenText(x.at))}</b><span class="ellip grow">${esc(x.preview || x.text || '')}</span>${x.status === 'failed' ? `<span class="faint" title="${esc(x.error || '')}">failed</span>` : ''}<button class="btn sm ghost" data-dnow>Send now</button><button class="btn sm ghost" data-dcancel>Cancel</button></div>`);
    const c = LV.conv[sid], machine = c && c.meta && c.meta.machine;
    const w = ((c && c.sends) || []).filter((x) => x.state === 'waiting' || x.state === 'failed').map((x) => `<div class="wrow ${x.state === 'failed' ? 'bad' : ''}" data-wsend="${esc(x.sendId)}">${I('pc', 'sm')}<b>${x.state === 'failed' ? 'Failed' : 'Waits for ' + esc((machine && machine.name) || 'the other PC')}</b><span class="ellip grow">${esc(x.text || '')}</span>${x.state === 'waiting' ? '<button class="btn sm ghost" data-wcancel>Cancel</button>' : ''}</div>`);
    const run = !isNew(sid) && LV.runs.find((x) => x.sessionId === sid && x.bgTasks && x.bgTasks.length);
    const b = run ? run.bgTasks.map((t) => `<div class="wrow bgrow" title="Started in a turn and still running: Claude is told when it ends">${MC.st('run', t.type === 'local_agent' ? 'Helper agent' : 'In the background')}<span class="ellip grow">${esc(t.description || (t.type === 'local_agent' ? 'A helper agent' : 'A command'))}</span><b class="mono" data-bg-since="${Number(t.since) || Date.now()}">${esc(clock(Date.now() - (Number(t.since) || Date.now())))}</b></div>`) : [];
    return b.concat(d, w).join('');
  }
  function paintWaits(sid) { convEls(sid).forEach((cv) => { const b = cv.querySelector('.waits'); if (b) b.innerHTML = waitsHtml(sid); }); }
  const paintAllWaits = () => $$('.convo[data-sid]').forEach((cv) => { const b = cv.querySelector('.waits'); if (b) b.innerHTML = waitsHtml(cv.dataset.sid); });
  function laterMenu(anchor, cv, doLater) {
    const u = LV.usage && LV.usage.fiveHour, rt = u && toMs(u.resetsAt), rOk = rt != null && rt > Date.now();
    MC.menu(anchor, [{ h: 'Send later' }, ...[[15, 'In 15 minutes'], [30, 'In 30 minutes'], [60, 'In 1 hour'], [120, 'In 2 hours'], [240, 'In 4 hours']].map(([m, l]) => ({ id: 'm' + m, label: l, icon: 'clock' })),
      { id: 'at', label: 'At a set time', icon: 'cal' }, { sep: 1 }, { id: 'reset', label: 'When the 5-hour limit resets', sub: rOk ? 'at ' + hhmm(rt) : 'time not known yet', icon: 'refresh' }],
    (id) => {
      if (id[0] === 'm') doLater('timer', new Date(Date.now() + Number(id.slice(1)) * 60000));
      if (id === 'reset') { if (!rOk) { MC.toast('The reset time is not known yet. Open Usage once, then try again.', 'clock'); return; } doLater('reset', null); }
      if (id === 'at') {
        const soon = new Date(Date.now() + 3600e3), row = cv.querySelector('.dpick');
        row.hidden = false; row.innerHTML = `${I('cal', 'sm')}<span>Send at</span><div class="input" style="width:calc(110px*var(--k))"><input value="${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}" maxlength="8" title="24 hour clock: 14:30, 1430 or 9:05"></div><button class="btn sm primary" data-dset>Schedule</button><button class="ibtn sm" data-dx title="Close">${I('x', 'sm')}</button><span class="faint dperr"></span>`;
        const inp = row.querySelector('input'); inp.focus(); inp.select();
        const go = () => {
          const m = /^\s*(\d{1,2})(?:\s*[:.h]?\s*(\d{2}))?\s*(am|pm|a|p)?\s*$/i.exec(inp.value);
          let h = m ? Number(m[1]) : NaN, mi = m && m[2] ? Number(m[2]) : 0; const ap = m && m[3] ? m[3][0].toLowerCase() : '';
          if (ap) h = h % 12 + (ap === 'p' ? 12 : 0);
          if (!(h <= 23 && mi <= 59)) { row.querySelector('.dperr').textContent = 'Type a time like 14:30'; return; }
          const t = new Date(); t.setHours(h, mi, 0, 0); if (t.getTime() <= Date.now() + 5000) t.setDate(t.getDate() + 1);
          row.hidden = true; doLater('time', t);
        };
        inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } if (e.key === 'Escape') row.hidden = true; };
        row.onclick = (e) => { if (e.target.closest('[data-dset]')) go(); if (e.target.closest('[data-dx]')) row.hidden = true; };
      }
    });
  }

  /* ---------- uploads ---------- */
  const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const fileKind = (f) => (IMG_TYPES.includes(f.type) ? 'image' : f.type === 'application/pdf' ? 'pdf' : 'file');
  /* POST JSON as MC.api.post does, with onProg(share sent, 0 to 1) while the body goes out */
  function postProgress(path, body, onProg) {
    return new Promise((ok, no) => {
      const x = new XMLHttpRequest();
      x.open('POST', path); x.setRequestHeader('X-MC', '1'); x.setRequestHeader('Content-Type', 'application/json');
      x.upload.onprogress = (e) => { if (e.lengthComputable && e.total) onProg(e.loaded / e.total); };
      const fail = (status, msg, data) => no(Object.assign(new Error(msg), { status, data }));
      x.onerror = () => fail(0, 'offline');
      x.onload = () => {
        let d = null; try { d = JSON.parse(x.responseText); } catch (e) { /* not JSON */ }
        if (x.status === 403 && d && d.error === 'not_paired') MC.removed();
        if (x.status >= 200 && x.status < 300) ok(d); else fail(x.status, (d && d.error) || 'HTTP ' + x.status, d);
      };
      x.send(JSON.stringify(body));
    });
  }
  let upSeq = 0;
  function upload(file, onChange) {
    const kind = fileKind(file), max = kind === 'image' ? 5 : 20;
    const a = { key: 'u' + ++upSeq, pct: 0, name: file.name || 'pasted.png', kind, size: file.size, status: 'up', src: kind === 'image' ? URL.createObjectURL(file) : '' };
    /* the ring follows the bytes without drawing the chips again */
    const prog = (p) => { a.pct = p; const n = Math.round(p * 100), busy = n <= 0 || n >= 100; document.querySelectorAll(`[data-upk="${a.key}"]`).forEach((e) => { if (e.classList.contains('upring')) { e.style.setProperty('--p', n); e.classList.toggle('spin', busy); e.title = `Sending ${n}%`; } else e.textContent = busy ? '' : n + '%'; }); };
    if (file.size > max * 1024 * 1024) { a.status = 'bad'; a.err = `Too big (the limit is ${max} MB)`; setTimeout(onChange); return a; }
    const rd = new FileReader();
    rd.onload = async () => {
      /* a phone's link can drop in the middle of a big upload (it goes quiet and is dialed again): the file goes again on the
         new link, which then takes it at once. Only when the link failed (no answer, or 502 to 504 from the bridge) */
      const body = { name: a.name, type: file.type || 'application/octet-stream', data: String(rd.result).split(',')[1] || '' };
      for (let n = 1; ; n++) {
        try { prog(0); const r = await postProgress('/api/uploads', body, prog); a.id = r.id; a.kind = r.kind || a.kind; a.size = r.size || a.size; a.status = 'ready'; break; }
        catch (e) {
          if (n < 3 && (!e.status || (e.status >= 502 && e.status <= 504))) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
          a.status = 'bad'; a.err = errText(e); break;
        }
      }
      onChange();
    };
    rd.onerror = () => { a.status = 'bad'; a.err = 'Could not read the file'; onChange(); };
    rd.readAsDataURL(file);
    return a;
  }

  /* ---------- sending ---------- */
  /* what POST /api/chat gets for a new process: the conversation (or the project or root folder of a new one), and the options */
  function chatReq(sid, prompt, ids) {
    const req = { prompt };
    if (ids.length) req.attachments = ids;
    const el = convEls(sid)[0], chat = kindOf(sid) === 'chat', pid = (el && el.dataset.pid) || pidOf();
    if (!isNew(sid)) req.sessionId = sid; else if (chat) req.chat = true; else if (isRootId(pid)) req.folder = pid.slice(5); else if (pid) req.projectId = pid;
    const model = isNew(sid) ? optValue('model', 'models') : switching(sid) ? LV.pick[sid] : '';
    if (model) req.model = model;
    /* the mode: picked in the box, or known for the conversation; for one not read yet, the server uses the one kept with it */
    if (!chat) { const c = LV.conv[sid], known = isNew(sid) || LV.modePick[sid] || (c && c.meta && c.meta.mode); const m = known ? modeOfConv(sid) : ''; if (m) req.mode = m; }
    const ef = effortOf(sid); if (ef) req.effort = ef;
    return req;
  }
  /* a new conversation in a project of the PC this one is linked to (Home): it starts there, through the link, and its
     answer streams in here as that PC's runs do (pc.chat); the tab moves to its id at the end of the first turn */
  async function startThere(sid, p, req, prompt, shown) {
    const name = (LV.link && LV.link.paired && LV.link.paired.name) || 'The other PC';
    if (!(LV.link && LV.link.online)) { MC.toast(`${name} is not online, so the conversation cannot start there now`, 'warn'); return false; }
    try {
      const r = await api.post('/api/pc/chat', { ...req, projectId: p.rid });
      const x = rec(r.runId); x.pc = true; x.key = sid;
      if (!x.items.length) x.startedAt = new Date().toISOString();
      x.notice = ''; addUser(x, prompt, shown, 'local');
      LV.view[sid] = r.runId; paintLive(sid); loadRuns();
      return true;
    } catch (e) { MC.toast('Not sent: ' + errText(e), 'warn'); return false; }
  }
  /* another PC's conversation while that PC cannot be reached through the link: the message waits for it on the hub */
  async function sendWaiting(sid, c, prompt, ids) {
    try {
      const r = await api.post(`/api/waiting/${enc(sid)}`, ids.length ? { prompt, attachments: ids } : { prompt });
      if (r && r.sendId) { c.sends = (c.sends || []).filter((x) => x.sendId !== r.sendId).concat([r]); paintWaits(sid); }
      if (r && r.originOnline === false) MC.toast(`It waits for ${(c.meta.machine && c.meta.machine.name) || 'the other PC'}, and runs when that PC is on`, 'pc');
      loadConv(sid); return true;
    } catch (e) { MC.toast('Not sent: ' + errText(e), 'warn'); return false; }
  }
  async function send(sid, text, atts, opts = {}) {
    const ready = atts.filter((a) => a.status === 'ready');
    const prompt = text || (ready.length > 1 ? 'See the attached files.' : 'See the attached file.');
    const ids = ready.map((a) => a.id), shown = ready.map((a) => ({ id: a.id, name: a.name, kind: a.kind, src: a.kind === 'image' ? '/api/uploads/' + enc(a.id) + '/file' : '' }));
    const c = LV.conv[sid];
    const link = !!(c && c.meta && c.meta.readOnly && c.meta.link);
    if (c && c.meta && c.meta.readOnly && !link) return sendWaiting(sid, c, prompt, ids);
    let cur = LV.view[sid] && LV.store[LV.view[sid]];
    if (cur && !(cur.status === 'working' || cur.status === 'starting')) cur = null;
    if (cur) {
      const it = addUser(cur, prompt, shown, 'local'); paintLive(sid);
      try { await api.post(cur.pc ? '/api/pc/chat' : '/api/chat', ids.length ? { runId: cur.runId, prompt, attachments: ids } : { runId: cur.runId, prompt }); loadRuns(); return true; }
      catch (e) { cur.items = cur.items.filter((x) => x !== it); if (e.status !== 409 && e.status !== 404) { cur.notice = 'Could not send: ' + errText(e); paintLive(sid); return false; } cur.status = 'done'; }
    }
    if (link) { /* that PC's own conversation, straight through the link: its answer streams in as it is written */
      try {
        /* a mode picked here goes with it; otherwise that PC runs the conversation with the mode it last had there */
        const r = await api.post('/api/pc/chat', { sessionId: sid, prompt, ...(ids.length ? { attachments: ids } : {}), ...(LV.modePick[sid] ? { mode: LV.modePick[sid] } : {}) });
        const x = rec(r.runId); x.pc = true; x.sessionId = sid;
        if (!r.joined && !x.items.length) x.startedAt = new Date().toISOString();
        if (r.joined && x.status === 'starting') x.status = 'working';
        x.notice = ''; addUser(x, prompt, shown, 'local');
        LV.view[sid] = r.runId; paintLive(sid);
        return true;
      } catch (e) {
        if (e.status === 502 || e.status === 503 || e.status === 504) return sendWaiting(sid, c, prompt, ids); /* the link went down: the hub keeps it */
        MC.toast('Not sent: ' + errText(e), 'warn'); return false;
      }
    }
    const req = chatReq(sid, prompt, ids);
    const there = isNew(sid) && req.projectId ? linkProj(req.projectId) : null;
    if (there) return startThere(sid, there, req, prompt, shown);
    if (opts.anyway) req.elsewhereOk = true;
    try {
      const r = await api.post('/api/chat', req);
      if (r.relayed) { MC.toast('Your message went to ' + r.to + '. The answer shows here when Claude is done.', 'share'); return true; }
      const x = rec(r.runId);
      if (isNew(sid)) x.key = sid; else x.sessionId = sid;
      if (!r.joined && !x.items.length) x.startedAt = new Date().toISOString();
      if (r.joined && x.status === 'starting') x.status = 'working';
      x.notice = ''; x.elsewhere = null;
      addUser(x, prompt, shown, 'local');
      LV.view[sid] = r.runId; paintLive(sid); loadRuns();
      return true;
    } catch (e) {
      const x = rec('err' + Date.now()); x.status = 'error'; x.key = sid;
      if (e.status === 409 && e.message === 'elsewhere') { x.status = 'idle'; x.notice = `This conversation is open in ${(e.data && e.data.where) || 'Claude Desktop'}. Two programs writing to it at once would split it.`; x.elsewhere = { text, atts }; }
      else x.error = 'Could not start: ' + (e.status === 400 && /folder/.test(errText(e)) ? 'restart the server once to start conversations in a root folder' : errText(e));
      LV.view[sid] = x.runId; paintLive(sid);
      return false;
    }
  }
  async function answerPerm(runId, rid, mode) {
    const r = LV.store[runId], it = r && r.items.find((i) => i.kind === 'perm' && i.requestId === rid); if (!it || it.state !== 'pending' || it.busy) return;
    let answers = null;
    if (mode === 'answers') { if (!it.questions || !askReady(it)) return; answers = {}; it.questions.forEach((q, qi) => (answers[q.question] = askAnswered(it, qi).join(', '))); }
    it.busy = true; it.err = ''; it.always = mode === 'always'; it.skipped = mode === 'deny'; paintLive(keyOf(r));
    try {
      const body = { requestId: rid, behavior: mode === 'deny' ? 'deny' : 'allow' };
      if (mode === 'always') body.always = true;
      if (answers) { body.answers = answers; it.answers = answers; }
      if (mode === 'deny' && it.questions) body.message = 'The user chose not to answer these questions.';
      await api.post(`${runApi(runId)}/permission`, body);
      resolvePerm(r, rid, body.behavior);
    } catch (e) {
      it.busy = false; it.always = false; it.answers = null; it.skipped = false;
      if (e.status === 404 || e.status === 409) { it.state = 'closed'; it.note = 'This question is no longer open.'; if (it.questions && qdHasText(it)) qdSave(r, it); } else it.err = 'Could not send your answer: ' + errText(e);
    }
    paintLive(keyOf(r)); buildAgents(); paintTrees();
  }

  /* ---------- dictation with BlitzVoice on this PC ----------
     The mic writes into the box. The live words show above the box; when they end with the send phrase ("send it") they go to
     the conversation alone and the box is left as it was, the cancel phrase ("cancel that") drops them. A wake dictation the
     server sends to this page goes to the conversation in the focused panel: its live words show there and its text is sent. */
  const VO = { available: false, state: 'idle', id: null, cv: null };
  const liveShow = (cv, t) => { const l = cv && cv.querySelector('.vlive'); if (l) { l.hidden = false; l.textContent = t; } };
  const liveHide = (cv) => { const l = cv && cv.querySelector('.vlive'); if (l) { l.hidden = true; l.textContent = ''; } };
  const sendSpoken = (cv, text) => { text = String(text || '').replace(/\s+/g, ' ').trim(); if (text && cv && cv.isConnected && cv.dataset.sid) send(cv.dataset.sid, text, []); };
  let wid = null, wcv = null; /* the dictation the phrase watch follows, and its conversation */
  const watch = MC.PhraseWatch ? new MC.PhraseWatch({ phrases: () => MC.phrases(false), onAct: (kind, rest) => onPhrase(kind, rest) }) : null;
  const follow = (id, cv) => { if (wid !== id) { wid = id; wcv = cv; if (watch) watch.reset(); } };
  const unfollow = () => { wid = null; wcv = null; if (watch) watch.reset(); };
  function onPhrase(kind, rest) {
    const cv = wcv, id = wid; unfollow();
    MC.wakeDone(id); MC.discardDictation(); /* ends the dictation at once: no text comes after */
    if (VO.id === id) { VO.id = null; VO.cv = null; paintMics(); }
    liveHide(cv);
    if (kind === 'send') sendSpoken(cv, rest);
  }
  MC.voiceSinks.talk = {
    wake: (id) => { const cv = MC.wakeConvo && MC.wakeConvo(); follow(id, cv); liveShow(cv, ''); },
    partial: (id, text) => { if (wid !== id) follow(id, MC.wakeConvo && MC.wakeConvo()); liveShow(wcv, text); if (watch) watch.push(text); },
    final: (id, text, err) => {
      const cv = wid === id ? wcv : MC.wakeConvo && MC.wakeConvo(); if (wid === id) unfollow(); liveHide(cv);
      if (err) { MC.toast(err === 'timeout' ? 'The dictation timed out, so nothing was sent' : 'BlitzVoice could not write that out, so nothing was sent', 'mic'); return; }
      const d = MC.detectPhrase(text); if (d) { if (d.kind === 'cancel') return; text = d.rest; }
      sendSpoken(cv, text);
    },
  };
  const voiceOn = () => VO.state === 'recording' || VO.state === 'transcribing';
  const paintMics = () => { paintPhoneVoice(); if (!onPhone()) paintPcMics(); };
  const paintPcMics = () => $$('[data-c="mic"]').forEach((b) => { const mine = VO.cv && b.closest('.convo') === VO.cv; b.classList.toggle('on', mine && VO.state === 'recording'); b.innerHTML = I(mine && VO.state === 'recording' ? 'stop' : mine && VO.state === 'transcribing' ? 'loader' : 'mic', 'sm'); b.title = !VO.available ? 'Dictate: BlitzVoice is not running, or its Mission Control link is off' : mine && VO.state === 'recording' ? 'Stop and write it out' : 'Dictate with BlitzVoice'; b.style.opacity = VO.available ? '' : '.45'; });
  async function micClick(cv) {
    if (onPhone()) { phoneMic(cv); return; }
    if (!VO.available) { MC.toast('Dictation needs BlitzVoice running, with its Mission Control link on', 'mic'); return; }
    if (VO.state === 'recording' && VO.cv === cv) { try { await api.post('/api/voice/stop', {}); } catch (e) { /* it ended already */ } return; }
    if (voiceOn()) return;
    VO.cv = cv;
    try { const r = await api.post('/api/voice/start', { partials: true }); VO.id = r && r.id != null ? String(r.id) : null; } catch (e) { MC.toast('Dictation did not start: ' + errText(e), 'warn'); VO.cv = null; }
    paintMics();
  }
  /* keep: a phone adds the words without focusing the box, so the keyboard does not pop up (at the end, unless the box has the focus) */
  function insertAtCursor(ta, text, keep) {
    text = String(text || '').replace(/\s+/g, ' ').trim(); if (!text || !ta) return;
    const v = ta.value, end = keep && document.activeElement !== ta;
    const a = !end && typeof ta.selectionStart === 'number' ? ta.selectionStart : v.length, b = !end && typeof ta.selectionEnd === 'number' ? ta.selectionEnd : v.length;
    const before = v.slice(0, a), after = v.slice(b), lead = before && !/\s$/.test(before) ? ' ' : '', trail = after && !/^\s/.test(after) ? ' ' : '';
    ta.value = before + lead + text + trail + after; const pos = (before + lead + text).length;
    if (!end) { ta.focus(); try { ta.setSelectionRange(pos, pos); } catch (e) { /* not focusable */ } }
    ta.dispatchEvent(new Event('input'));
  }

  /* ---------- dictation with a phone's own microphone ----------
     In the phone app the phone writes it out itself (MC.phoneSpeech, Moonshine): the words show above the box as they are said,
     and the mic again puts them in the box, also with the PC off. The first time, the speech model downloads (about 400 MB).
     Elsewhere the mic records on the phone (MC.audio), and the mic again has BlitzVoice on the PC write it out into the box.
     The same phrases as on the PC: the send phrase at the end sends those words at once, the cancel phrase drops them. The x
     beside the mic drops a recording. A recording stops when the page is left; after a minute of silence or at 20 minutes it is
     written out. The speaker button switches "Read replies aloud" for this phone, and stops an answer while one plays. */
  const onPhone = () => document.documentElement.hasAttribute('data-remote') || MC.remote === true;
  const PM = { step: 'idle', rec: null, ac: null, job: null, tok: 0, sid: null, t0: 0, tick: 0, words: '', dl: null };
  const pmCv = () => (PM.sid ? convEls(PM.sid)[0] || null : null);
  const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  function pmLive() {
    const cv = pmCv(); if (!cv) return;
    if (PM.step === 'recording') liveShow(cv, PM.words || 'Recording ' + mmss((Date.now() - PM.t0) / 1000));
    else if (PM.step === 'sending') liveShow(cv, PM.words || 'Writing it out');
    else if (PM.step === 'starting') liveShow(cv, PM.dl != null && PM.dl < 1 ? `Downloading the speech model, ${Math.floor(PM.dl * 100)}%` : 'Starting the microphone');
  }
  function pmStep(k) { PM.step = k; if (k !== 'recording') clearInterval(PM.tick); pmLive(); paintMics(); }
  function pmDone() { const cv = pmCv(); PM.words = ''; PM.dl = null; pmStep('idle'); PM.sid = null; liveHide(cv); paintMics(); }
  const micErr = (e) => { const n = e && e.name; return n === 'NotAllowedError' || n === 'SecurityError' ? 'The microphone is blocked. In Android settings, open Apps, this app, Permissions, and allow Microphone' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'No microphone was found on this phone' : n === 'TimeoutError' ? 'The microphone did not start. Try again' : 'Recording does not work here'; };
  async function pmStart(cv) {
    if (PM.step !== 'idle' || !cv.dataset.sid) return;
    MC.phoneVoice.stop();
    const tok = ++PM.tok, ac = new AbortController(); PM.ac = ac; PM.sid = cv.dataset.sid; PM.words = ''; PM.dl = null;
    pmStep('starting');
    const mine = () => tok === PM.tok;
    let rec;
    try {
      rec = await (MC.phoneSpeech ? MC.phoneSpeech.record.bind(MC.phoneSpeech) : MC.audio.record)({ signal: ac.signal, openMs: 12000, skipMs: 260,
        onProgress: (p) => { if (mine() && PM.step === 'starting') { PM.dl = p; pmLive(); } },
        onText: (t) => { if (mine()) { PM.words = t; pmLive(); } },
        onError: (m) => { if (mine()) { pmDrop(); MC.toast(m, 'mic'); MC.sound.play('cancel'); } },
        onLevel: (v) => { if (tok !== PM.tok || PM.step !== 'recording') return; const b = pmCv() && pmCv().querySelector('[data-c="mic"]'); if (b) b.style.setProperty('--lv', Math.sqrt(Math.min(1, v * 2.5)).toFixed(2)); },
        onLimit: () => { if (tok === PM.tok && PM.step === 'recording') { MC.toast('That is the 20-minute limit, so it was written out', 'mic'); pmSend(); } },
        onSilence: () => { if (tok === PM.tok && PM.step === 'recording') { MC.toast('Nothing was said for a minute, so it was written out', 'mic'); pmSend(); } } });
    } catch (e) {
      if (tok === PM.tok) { PM.ac = null; pmDone(); if (!e || e.name !== 'AbortError') { MC.toast(MC.phoneSpeech && e && e.name === 'Error' ? e.message : micErr(e), 'mic'); MC.sound.play('cancel'); } }
      return;
    }
    if (tok !== PM.tok) { rec.cancel().catch(() => {}); return; } /* dropped while the microphone was starting */
    PM.ac = null; PM.rec = rec; PM.t0 = Date.now();
    pmStep('recording'); PM.tick = setInterval(pmLive, 1000);
    MC.sound.play('listen');
  }
  /* drops a start, a recording or an upload: nothing is added */
  function pmDrop() {
    PM.tok++;
    if (PM.ac) { PM.ac.abort(); PM.ac = null; }
    if (PM.job) { PM.job.abort(); PM.job = null; }
    const r = PM.rec; PM.rec = null; if (r) r.cancel().catch(() => {});
    if (PM.step !== 'idle') pmDone();
  }
  async function pmSend() {
    const rec = PM.rec; if (!rec || PM.step !== 'recording') return;
    PM.rec = null;
    const tok = PM.tok, sidAt = PM.sid, ac = new AbortController(); let late = false; PM.job = ac;
    const timer = setTimeout(() => { late = true; ac.abort(); }, 70000 + Math.round(rec.seconds() * 600)); /* a long recording takes longer */
    pmStep('sending'); MC.sound.play('send');
    let text = '', fail = '';
    try {
      const out = await rec.stop().catch(() => null);
      if (out && typeof out.text === 'string') text = out.text.replace(/\s+/g, ' ').trim(); /* written out on the phone */
      else if (!out || out.seconds < 0.25 || out.peak < 0.001) fail = 'Heard nothing';
      else text = (await MC.phoneVoice.transcribe(out.wav, ac.signal)).replace(/\s+/g, ' ').trim();
      if (!fail && !text) fail = 'Heard nothing';
    } catch (e) { fail = ac.signal.aborted ? (late ? 'The PC took too long, so nothing was added' : '') : e.message; }
    clearTimeout(timer); if (PM.job === ac) PM.job = null;
    if (tok !== PM.tok) return; /* dropped meanwhile */
    const cv = pmCv() || convEls(sidAt)[0];
    pmDone();
    if (fail) { MC.toast(fail, 'mic'); MC.sound.play('cancel'); return; }
    if (!cv) return;
    const ph = MC.detectPhrase(text);
    if (ph && (ph.kind === 'cancel' || !ph.rest.trim())) { MC.sound.play('cancel'); return; }
    if (ph) sendSpoken(cv, ph.rest); else insertAtCursor(cv.querySelector('textarea'), text, true);
  }
  function phoneMic(cv) {
    if (PM.step === 'idle') pmStart(cv);
    else if (PM.step === 'recording' && PM.sid === cv.dataset.sid) pmSend();
  }
  function paintPhoneVoice() {
    const on = onPhone(), PV = MC.phoneVoice;
    $$('[data-c="read"]').forEach((b) => {
      b.hidden = !on; if (!on) return;
      const k = PV.speaking ? 'stop' : PV.readOn() ? 'vol' : 'volX';
      if (b.dataset.k !== k) { b.dataset.k = k; b.innerHTML = I(k, 'sm'); }
      b.classList.toggle('on', !!PV.speaking || PV.readOn());
      b.title = PV.speaking ? 'Stop reading aloud' : PV.readOn() ? 'Replies are read aloud. Tap to turn off' : 'Read replies aloud';
    });
    if (!on) { $$('[data-c="micx"]').forEach((b) => { b.hidden = true; }); return; }
    $$('[data-c="mic"]').forEach((b) => {
      const c = b.closest('.convo'), k = c && PM.sid && c.dataset.sid === PM.sid ? PM.step : 'idle';
      const ic = k === 'recording' ? 'stop' : k === 'idle' ? 'mic' : 'loader';
      if (b.dataset.k !== ic) { b.dataset.k = ic; b.innerHTML = I(ic, 'sm'); }
      b.classList.toggle('on', k === 'recording'); b.classList.toggle('rec', k === 'recording'); if (k !== 'recording') b.style.removeProperty('--lv');
      b.style.opacity = '';
      b.title = k === 'recording' ? 'Stop and write it out' : k === 'sending' ? 'Writing it out' : k === 'starting' ? 'Starting the microphone' : 'Dictate with this phone';
      const x = c && c.querySelector('[data-c="micx"]'); if (x) x.hidden = k === 'idle';
    });
  }
  MC.phoneVoice.on(paintMics);
  Promise.resolve(MC.whoami).then(() => paintMics());
  document.addEventListener('visibilitychange', () => { if (document.hidden && (PM.step === 'recording' || PM.step === 'starting')) { pmDrop(); MC.toast('Recording stopped when you left the page', 'mic'); } });
  addEventListener('pagehide', () => { if (PM.step !== 'idle') pmDrop(); });
  MC.events.on('voice', (d) => {
    if (!d) return;
    if (d.kind === 'status') { VO.available = !!d.available; paintMics(); }
    if (d.kind === 'state') { VO.state = d.state || 'idle'; if (VO.state === 'idle' || VO.state === 'speaking') { const live = VO.cv && VO.cv.querySelector('.vlive'); if (live) live.hidden = true; } paintMics(); }
    if (d.kind === 'partial' && !d.wake && VO.id && String(d.id) === VO.id && VO.cv) { follow(VO.id, VO.cv); liveShow(VO.cv, d.text); if (watch) watch.push(String(d.text || '')); }
    if (d.kind === 'transcript' && !d.wake && VO.id && String(d.id) === VO.id) {
      const cv = VO.cv; VO.id = null; VO.cv = null; paintMics(); if (wid === String(d.id)) unfollow();
      if (!cv || !cv.isConnected) return;
      liveHide(cv);
      if (d.error) MC.toast('BlitzVoice could not write that out, so nothing was added', 'mic');
      else if (!String(d.text || '').trim()) MC.toast('BlitzVoice heard nothing', 'mic');
      else {
        /* "send it" said at the very end: those words go to the conversation; "cancel that": nothing is added */
        const ph = MC.detectPhrase(String(d.text));
        if (!ph) insertAtCursor(cv.querySelector('textarea'), d.text); else if (ph.kind === 'send') sendSpoken(cv, ph.rest);
      }
    }
  });

  /* ---------- the Conversation module ---------- */
  const ring = (pct, warn) => { const c = 2 * Math.PI * 8; return `<svg class="ring" viewBox="0 0 22 22"><circle cx="11" cy="11" r="8" fill="none" stroke="var(--press)" stroke-width="3"/><circle cx="11" cy="11" r="8" fill="none" stroke="${warn ? 'var(--warn)' : 'var(--hi)'}" stroke-width="3" stroke-dasharray="${c * pct} ${c}" transform="rotate(-90 11 11)" stroke-linecap="round"/></svg>`; };
  /* the conversation this tab shows: none picked yet means the newest one of the project, once the list is in */
  function sidNow() {
    const cs = curSess();
    if (cs && cs !== 's1') return cs;
    const key = pidOf(), L = key && LV.lists[key];
    if (!key) { setCurSess(newKey()); return curSess(); }
    if (L && L.loaded) { setCurSess(L.rows.length ? L.rows[0].id : newKey(isChatId(key))); if (!MC.ctx) { MC.D && MC.D.saveTabs && MC.D.saveTabs(); setTimeout(() => MC.emit('rerender', 'usage')); } return curSess(); }
    if (!(L && L.busy)) loadList(key).then(() => MC.emit('rerender', 'convo'));
    return null;
  }
  /* an upload in progress: a ring that fills with the share sent, and the number; it turns while nothing is known yet
     (the file is being read) and once all of it is sent (the PC is saving it) */
  const upRing = (a) => { const p = Math.round((a.pct || 0) * 100), busy = p <= 0 || p >= 100; return `<span class="upring${busy ? ' spin' : ''}" data-upk="${a.key}" style="--p:${p}" title="Sending ${p}%"></span><span class="uppct faint" data-upk="${a.key}">${busy ? '' : p + '%'}</span>`; };
  /* a long file name stays on one line and is cut in the middle, so its end and extension still show */
  const attName = (n) => { const m = /^(.*?)(.{0,6}(\.[^.]{1,6})?)$/s.exec(n), x = m && m[1] ? m : [n, n, '']; return `<span class="cxn"><span class="cxa">${esc(x[1])}</span><span class="cxb">${esc(x[2])}</span></span>`; };
  const attChips = (k) => (LV.att[k] || []).map((a, i) => `<span class="cx ${a.status}" title="${esc(a.err || a.name)}"${a.kind === 'image' && a.src ? ` data-attimg="${i}"` : ''}>${a.kind === 'image' && a.src ? `<img src="${esc(a.src)}" alt="">` : I('doc', 'sm')}${attName(a.name)}${a.status === 'up' ? upRing(a) : a.status === 'bad' ? ' ' + I('warn', 'sm') : ''}<button class="ibtn sm" data-unatt="${i}" title="Remove">${I('x', 'sm')}</button></span>`).join('');
  M.convo = {
    label: 'Conversation', icon: 'chat',
    title: () => { const sid = sidNow(); return sid ? MC.sessionById(sid).title : 'Loading'; },
    pick: (vp, anchor) => {
      const key = pidOf(), rows = ((key && LV.lists[key] && LV.lists[key].rows) || []).slice(0, 14);
      MC.menu(anchor, [{ h: 'Switch conversation' }, ...rows.map((r) => ({ id: r.id, label: r.title || 'Untitled conversation', icon: 'chat', sub: ago(r.lastAt), on: r.id === curSess() })), { sep: 1 }, { id: 'new', label: isChatId(key) ? 'New chat' : 'New conversation', icon: 'plus' }],
        (id) => MC.setSession(id === 'new' ? newKey(isChatId(key)) : id));
    },
    render: (vp) => {
      const sid = sidNow();
      if (!sid) return `<div class="convo"><div class="lv-empty" style="margin:auto">${I('loader', 'sm')}Loading conversations</div></div>`;
      const s = MC.sessionById(sid), c = LV.conv[sid], meta = (c && c.meta) || {}, row = LV.rows[sid] || {};
      /* one button shows the session list and usage together (lu is the old usage-only button, still in saved layouts) */
      const ls = vp.state.ls || vp.state.lu, all = vp.state.scope === 'all', dk = draftKey(sid), dr = draftOf(dk);
      const side = ls ? `<aside class="cv-side"><div class="cvs grow1"><div class="cvs-h">${I('branch', 'sm')}Sessions<span class="grow"></span><span class="seg ico" data-lscope><button data-val="proj" class="${all ? '' : 'on'}" title="This project">${I('folder', 'sm')}</button><button data-val="all" class="${all ? 'on' : ''}" title="Everything">${I('globe', 'sm')}</button></span></div><div class="cvs-b"><div class="tree" data-sesstree data-scope="${all ? 'all' : ''}"></div></div></div>
        <div class="cvs"><div class="cvs-h">${I('chart', 'sm')}Usage</div><div class="cvs-b">${MC.usageMini()}</div></div></aside>` : '';
      const remote = meta.readOnly || row.readOnly, locked = meta.locked && !remote;
      /* the permission mode; a conversation of the linked PC shows it too, since a message sent from here runs with it there */
      const modePill = `<button class="pillsel" data-c="mode" title="${remote ? 'Permission mode on ' + esc((meta.machine && meta.machine.name) || 'that PC') : 'Permission mode'}">${I('lock', 'sm')}${esc(optLabel('modes', modeOfConv(sid)) || 'Mode')}${I('chev', 'sm')}</button>`;
      const ro = locked ? 'This conversation is locked. Unlock it with the ... menu to write in it.' : '';
      const p = MC.projectInfo(), chat = s.kind === 'chat';
      const pct = ctxPct(sid), left = MC.cacheLeft(), ttl = S.cacheTtl || 300;
      const where = chat ? 'Simple chat, no project' : meta.cwd || p.folder || '';
      return `<div class="cv-wrap">${side}<div class="convo" data-sid="${esc(sid)}" data-dk="${esc(dk)}" data-pid="${esc(pidOf() || '')}" data-cwd="${esc(chat ? '' : meta.cwd || p.folder || '')}"><div class="cv-head"><button class="ibtn sm ${ls ? 'on' : ''}" data-c="ls" title="${ls ? 'Hide' : 'Show'} the session list and usage">${I('sidebar', 'sm')}</button><span class="cv-sep"></span>
          ${chat ? '<span class="badge">Simple chat</span>' : ''}${remote ? `<span class="badge">${I('pc', 'sm')}On ${esc((meta.machine && meta.machine.name) || (row.machine && row.machine.name) || 'another PC')}</span>` : ''}${meta.elsewhere ? `<span class="badge" title="Open in ${esc(meta.elsewhere)}">${I('ext', 'sm')}${esc(meta.elsewhere)}</span>` : ''}${locked ? `<span class="badge">${I('lock', 'sm')}Locked</span>` : ''}${row.pinned ? `<span class="badge">${I('pin', 'sm')}Pinned</span>` : ''}
          <span class="grow"></span>${isNew(sid) ? '' : `<button class="ibtn sm" data-c="more" title="Rename, pin, lock, archive">${I('more', 'sm')}</button><button class="btn sm ghost" data-c="end">${I('stop', 'sm')}End${I('chev', 'sm')}</button>`}</div>
        <div class="cscroll"><div class="convo-scroll"><div class="convo-inner"><div class="older"></div><div class="hist"></div><div class="live"></div></div></div><div class="jumps"><button class="jbtn" data-jump="top" title="To the start of the conversation">${I('toTop', 'sm')}</button><button class="jbtn" data-jump="end" title="To the latest message">${I('toEnd', 'sm')}</button></div></div>
        <div class="composer"><div class="lbar"></div><div class="waits">${waitsHtml(sid)}</div><div class="dpick" hidden></div><div class="vlive" hidden></div><div class="cbox ${ro ? 'ro' : ''}"><div class="ctx">${attChips(dk)}</div>
          <textarea class="md-in" ${ro ? 'disabled' : ''} placeholder="${ro ? esc(ro) : remote ? 'Message (waits for that PC)' : 'Message Claude'}">${esc(dr ? dr.text : '')}</textarea>
          <div class="cbar"><button class="ibtn sm" data-c="attach" title="Attach files or pictures">${I('clip', 'sm')}</button><input type="file" multiple hidden data-file><button class="ibtn sm" data-c="mic" title="Dictate with BlitzVoice">${I('mic', 'sm')}</button><button class="ibtn sm" data-c="micx" hidden title="Drop the recording">${I('x', 'sm')}</button><button class="ibtn sm ${MC.phoneVoice.readOn() ? 'on' : ''}" data-c="read" ${onPhone() ? '' : 'hidden'} title="Read replies aloud">${I(MC.phoneVoice.readOn() ? 'vol' : 'volX', 'sm')}</button><button class="ibtn sm ${vp.state.tall ? 'on' : ''}" data-c="tall" title="${vp.state.tall ? 'Shorter message box' : 'Taller message box'}">${I(vp.state.tall ? 'min' : 'max', 'sm')}</button>
            ${remote ? (meta.link && !chat ? modePill : '') : `<button class="pillsel ${switching(sid) ? 'on' : ''}" data-c="model" title="${switching(sid) ? 'The next message switches this conversation to this model' : 'Model'}">${I('sparkle', 'sm')}<span>${esc(modelLabel(modelOf(sid)) || 'Model')}</span>${I('chev', 'sm')}</button><button class="pillsel" data-c="effort" title="Effort">${I('bolt', 'sm')}${esc(effortLabel(sid) || 'Effort')}${I('chev', 'sm')}</button>${chat ? '' : modePill}`}
            <span class="grow"></span>${remote ? '' : `<button class="pillsel ustat ${pct >= 80 ? 'warn' : ''}" data-c="ustat" data-ctx title="Context used, and the time the cache stays warm. Click for usage">${I('chart', 'sm')}<span class="uctx">${pct == null ? '--' : pct + '%'}</span><span class="cache-t mono">${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</span></button><button class="ibtn sm" data-c="later" title="Send later">${I('clock', 'sm')}</button>`}<button class="send" title="Send (Ctrl Enter)" ${ro ? 'disabled' : ''}>${I('send')}</button></div></div>
          <div class="cfoot"><span>${I(chat ? 'chat' : 'folder', 'sm')} <b>${esc(where)}</b></span><span>${esc(remote ? (meta.machine && meta.machine.name) || 'Another PC' : MC.place || 'This PC')}</span></div></div></div></div>`;
    },
    mount: (el, vp) => {
      const cv = el.querySelector('.convo'); if (!cv || !cv.dataset.sid) return;
      const sid = () => cv.dataset.sid, dk = () => cv.dataset.dk;
      const tr = el.querySelector('[data-sesstree]'); if (tr) MC.renderSessionTree(tr);
      const lsw = el.querySelector('[data-lscope]');
      if (lsw) lsw.onclick = (e) => {
        const b = e.target.closest('button[data-val]'); if (!b || b.classList.contains('on')) return;
        vp.state.scope = b.dataset.val; lsw.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        tr.dataset.scope = b.dataset.val === 'all' ? 'all' : ''; MC.renderSessionTree(tr); vp.owner && vp.owner.changed();
      };
      fillHist(cv, sid());
      { const r0 = LV.view[sid()] && LV.store[LV.view[sid()]]; cv.querySelector('.live').innerHTML = liveHtml(r0); cv.querySelector('.lbar').innerHTML = liveBar(r0); } requestAnimationFrame(() => fitQ(cv));
      const sc = cv.querySelector('.convo-scroll'); sc.scrollTop = sc.scrollHeight;
      if (!isNew(sid()) && (!LV.conv[sid()] || LV.conv[sid()].state === 'err')) loadConv(sid());
      if (!isNew(sid()) && !LV.stats[sid()]) loadStats(sid());
      if (!draftOf(dk()) || !cv._pulled) { cv._pulled = true; pullDraft(dk()); }
      /* on a phone, pulled up at the end of the conversation: it is read again (as on the old Talk page) */
      /* the message box grows with its lines (or attachments): the conversation keeps the same last line in view instead of
         the box covering it, and one read to the end stays at the end */
      if (!sc._keepEnd && window.ResizeObserver) { sc._keepEnd = true; let h = sc.clientHeight; new ResizeObserver(() => { const n = sc.clientHeight; if (n && h && n !== h) sc.scrollTop += h - n; h = n; }).observe(sc); }
      if (!sc._pull) { sc._pull = true; MC.pull.box(sc, 'bottom', () => { const s = sid(); if (s && !isNew(s)) return Promise.all([loadConv(s), loadRuns()]); }); }
      sc.onscroll = () => { if (sc.scrollTop < 40) { const b = cv.querySelector('[data-older]'); if (b) loadOlder(sid(), b); } };
      /* jump buttons: "to the latest" shows while you are more than half a screen up; "to the start" shows while you scroll
         up there, and fades a moment after you stop */
      const jm = cv.querySelector('.jumps'); let idle = 0;
      const fade = (ms) => { clearTimeout(idle); idle = setTimeout(() => { if (!jm.matches(':hover')) jm.classList.remove('up'); }, ms); };
      sc.addEventListener('scroll', () => {
        jm.classList.toggle('down', sc.scrollHeight - sc.scrollTop - sc.clientHeight > sc.clientHeight * .5);
        if (sc.scrollTop > sc.clientHeight * .5) { jm.classList.add('up'); fade(1800); } else jm.classList.remove('up');
      }, { passive: true });
      jm.onmouseleave = () => fade(1200);
      jm.onclick = async (e) => {
        const b = e.target.closest('[data-jump]'); if (!b) return;
        if (b.dataset.jump === 'end') { sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' }); return; }
        b.disabled = true; /* the whole conversation, from its first message: older pages load first */
        for (let i = 0; i < 60 && LV.conv[sid()] && LV.conv[sid()].hasMore; i++) { const c = LV.conv[sid()]; const n = c.msgs.length; await loadOlder(sid(), cv.querySelector('[data-older]')); if (c.msgs.length === n) break; }
        b.disabled = false; sc.scrollTo({ top: 0, behavior: 'smooth' });
      };
      const ta = cv.querySelector('textarea'), box = cv.querySelector('.cbox'), file = cv.querySelector('[data-file]');
      const fit = cv._fit = () => { const max = Math.max(120, Math.round(el.clientHeight * .5)); ta.style.height = 'auto'; const nat = ta.scrollHeight, h = vp.state.tall ? max : Math.min(nat, max); ta.style.height = h + 'px'; ta.style.overflowY = nat > h + 1 ? 'auto' : 'hidden'; };
      requestAnimationFrame(fit);
      cv._chips = () => { if (cv.isConnected) cv.querySelector('.ctx').innerHTML = attChips(dk()); };
      cv._atts = () => { if (!cv.isConnected) return; cv._chips(); noteDraft(sid(), ta.value); };
      const addFiles = (files) => { const k = dk(); LV.att[k] = LV.att[k] || []; [...files].forEach((f) => LV.att[k].push(upload(f, () => convEls(sid()).forEach((x) => x._atts && x._atts())))); cv._atts(); };
      file.onchange = () => { addFiles(file.files); file.value = ''; };
      ta.onpaste = (e) => { const fs = [...((e.clipboardData && e.clipboardData.files) || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } };
      box.ondragover = (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); box.classList.add('drop'); } };
      box.ondragleave = () => box.classList.remove('drop');
      box.ondrop = (e) => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); box.classList.remove('drop'); addFiles(e.dataTransfer.files); } };
      ta.oninput = () => { fit(); noteDraft(sid(), ta.value); };
      /* takes the words and files out of the box; puts them back when a send fails */
      const take = () => {
        const atts = LV.att[dk()] || [];
        if (atts.some((a) => a.status === 'up')) { MC.toast('Wait for the upload to finish, then send', 'clock'); return null; }
        if (atts.some((a) => a.status === 'bad')) { MC.toast('One file did not upload. Remove it, then send again', 'warn'); return null; }
        const text = ta.value.trim(); if (!text && !atts.length) return null;
        ta.value = ''; LV.att[dk()] = []; vp.state.tall = false; fit(); cv.querySelector('.ctx').innerHTML = '';
        DR.unsent[dk()] = { text: '', atts: [], project: (draftOf(dk()) || {}).project }; pushDraft(dk());
        return { text, atts, back: () => { if (!ta.value) { ta.value = text; LV.att[dk()] = atts; cv._atts(); fit(); noteDraft(sid(), text); } } };
      };
      const doSend = async (opts) => { const t = take(); if (!t) return; const ok = await send(sid(), t.text, t.atts, opts); if (!ok) t.back(); sc.scrollTop = sc.scrollHeight; };
      const doLater = async (kind, when) => {
        const t = take(); if (!t) { MC.toast('Write the message first, then choose when to send it', 'clock'); return; }
        const ready = t.atts.filter((a) => a.status === 'ready');
        const prompt = t.text || (ready.length > 1 ? 'See the attached files.' : 'See the attached file.');
        const req = chatReq(sid(), prompt, ready.map((a) => a.id)), lp = isNew(sid()) && req.projectId && linkProj(req.projectId);
        if (lp) req.pc = lp.rid; /* a new conversation on the other PC: this PC's server sends it there at the time */
        const body = { kind, req, atts: ready.map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size, src: a.kind === 'image' ? '/api/uploads/' + enc(a.id) + '/file' : '' })) };
        if (when) body.at = when.toISOString();
        try { const d = await api.post('/api/delayed', body); if (d && d.id && !LV.delayed.some((x) => x.id === d.id)) LV.delayed.push(d); paintAllWaits(); MC.toast(kind === 'reset' ? 'It goes when the 5-hour limit resets' : 'It goes at ' + whenText(when), 'clock'); }
        catch (e) { t.back(); MC.toast('Not scheduled: ' + errText(e), 'warn'); }
      };
      /* Enter makes a new line; Ctrl Enter sends (as on the Talk page) */
      ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); doSend(); } };
      cv.querySelector('.send').onclick = () => doSend();
      /* the Other box: kept on every keystroke, here and (a moment later) on the server; the card is not drawn again, so
         the box keeps its focus, only the Send button follows */
      cv.oninput = (e) => {
        const o = e.target.closest('textarea[data-qother]'); if (!o) return;
        const pm = o.closest('[data-prun]'), r = LV.store[pm.dataset.prun], it = r && r.items.find((i) => i.kind === 'perm' && i.requestId === pm.dataset.rid); if (!it || it.state !== 'pending') return;
        it.other[+o.dataset.qother] = o.value; fitQ(pm); qdSave(r, it); typingSoon(r, it);
        const sb = pm.querySelector('[data-pact="answers"]'); if (sb) sb.disabled = !!it.busy || !askReady(it);
      };
      paintMics();
      cv.onclick = async (e) => {
        const t = e.target;
        if (t.closest('[data-older]')) { loadOlder(sid(), t.closest('[data-older]')); return; }
        if (t.closest('[data-reload]')) { loadConv(sid()); return; }
        const mo = t.closest('[data-more]'); if (mo) { const open = mo.dataset.open !== '1'; LV.open[mo.dataset.more] = open; const k = mo.dataset.more; if (k.startsWith('live:')) paintLive(sid()); else paintHist(sid()); return; }
        /* the pictures on screen open at once; the conversation's full list (older ones not loaded yet) joins when the server answers */
        const im = t.closest('[data-img]'); if (im) { const all = [...cv.querySelectorAll('[data-img]')], s0 = sid(); MC.gallery.open(all.map((b) => ({ src: b.dataset.img, name: b.title || '' })), all.indexOf(im), { opener: im, more: s0 ? () => api.get(`/api/sessions/${enc(s0)}/images`).then((d) => (sid() === s0 && d && Array.isArray(d.images) ? d.images : null)) : null }); return; }
        const stp = t.closest('[data-stop]'); if (stp) { stp.disabled = true; api.post(`${runApi(stp.dataset.stop)}/stop`).catch((er) => MC.toast('Could not stop: ' + errText(er), 'warn')); return; }
        if (t.closest('[data-anyway]')) { const r = LV.view[sid()] && LV.store[LV.view[sid()]]; const el2 = r && r.elsewhere; if (el2) { r.notice = ''; r.elsewhere = null; send(sid(), el2.text, el2.atts, { anyway: true }); } return; }
        /* a picture attached and not sent yet opens in the viewer too, with the other pictures in the box */
        const ai = !t.closest('[data-unatt]') && t.closest('[data-attimg]'); if (ai) { const L = LV.att[dk()] || [], pics = L.filter((a) => a.kind === 'image' && a.src); MC.gallery.open(pics.map((a) => ({ src: a.src, name: a.name, from: 'you' })), Math.max(0, pics.indexOf(L[+ai.dataset.attimg])), { opener: ai }); return; }
        const ua = t.closest('[data-unatt]'); if (ua) { (LV.att[dk()] || []).splice(+ua.dataset.unatt, 1); cv._atts(); return; }
        const dl = t.closest('[data-did]'); if (dl && t.closest('button')) {
          const id = dl.dataset.did, now = !!t.closest('[data-dnow]'); t.closest('button').disabled = true;
          try { if (now) await api.post(`/api/delayed/${enc(id)}/now`, {}); else { const d = await api.post(`/api/delayed/${enc(id)}/cancel`, {}); if (d && !ta.value.trim()) { ta.value = d.text || ''; LV.att[dk()] = (d.atts || []).filter((a) => a && a.id).map((a) => ({ ...a, status: 'ready' })); cv._atts(); fit(); } } }
          catch (er) { MC.toast('Could not ' + (now ? 'send it' : 'cancel it') + ': ' + errText(er), 'warn'); }
          loadDelayed(); return;
        }
        const wc = t.closest('[data-wcancel]'); if (wc) { try { await api.post(`/api/waiting/${enc(sid())}/${enc(wc.closest('[data-wsend]').dataset.wsend)}/cancel`, {}); } catch (er) { MC.toast('Could not cancel: ' + errText(er), 'warn'); } loadConv(sid()); return; }
        const qk = t.closest('[data-qk]'); if (qk) {
          const box = qk.closest('[data-qkept]'), rid = box.dataset.qkept, d = qdAll()[rid];
          const live = Object.values(LV.store).map((r) => r.items.find((i) => i.kind === 'perm' && i.requestId === rid)).find(Boolean);
          const qs = live ? live.questions.map((q) => q.question) : (d && d.questions) || [], src = live || { other: (d && d.other) || {}, pick: (d && d.pick) || {} };
          const done = () => { qdDrop(rid); if (live) live.keptDone = true; paintLive(sid()); paintHist(sid()); };
          if (qk.dataset.qk === 'copy') { navigator.clipboard && navigator.clipboard.writeText(keptText(qs, src)).then(() => MC.toast('Copied'), () => MC.toast('Could not copy', 'warn')); return; }
          if (qk.dataset.qk === 'drop') { done(); return; }
          qk.disabled = true; if (await send(sid(), keptMessage(qs, src), [])) done(); else qk.disabled = false;
          return;
        }
        const pa = t.closest('[data-pact]'); if (pa) { const pm = pa.closest('[data-prun]'); answerPerm(pm.dataset.prun, pm.dataset.rid, pa.dataset.pact); return; }
        const qo = t.closest('[data-qopt]'); if (qo) {
          const pm = qo.closest('[data-prun]'), r = LV.store[pm.dataset.prun], it = r && r.items.find((i) => i.requestId === pm.dataset.rid); if (!it) return;
          const [qi, oi] = qo.dataset.qopt.split(':').map(Number), q = it.questions[qi], lab = q.options[oi].label, cur = it.pick[qi] || [];
          it.pick[qi] = q.multiSelect ? (cur.includes(lab) ? cur.filter((x) => x !== lab) : cur.concat(lab)) : (cur.includes(lab) ? [] : [lab]);
          qdSave(r, it); typingSoon(r, it); paintLive(keyOf(r)); return;
        }
        const h = t.closest('[data-h="copy"]'); if (h) { const tx = h.closest('.mb').querySelector('.tx'); navigator.clipboard && navigator.clipboard.writeText(tx ? tx.innerText : '').then(() => MC.toast('Copied'), () => MC.toast('Could not copy', 'warn')); return; }
        const c = t.closest('[data-c]'); if (!c) return;
        const k = c.dataset.c, sidC = sid();
        if (k === 'attach') { file.click(); return; }
        if (k === 'ustat') { usagePop(c); return; }
        if (k === 'mic') { micClick(cv); return; }
        if (k === 'micx') { pmDrop(); MC.sound.play('cancel'); return; }
        if (k === 'read') { if (MC.phoneVoice.speaking) MC.phoneVoice.stop(); else MC.phoneVoice.setRead(!MC.phoneVoice.readOn()); return; }
        if (k === 'later') { if (!LV.usage) { try { LV.usage = await api.get('/api/usage'); } catch (er) { /* no reset time then */ } } laterMenu(c, cv, doLater); return; }
        if (k === 'tall') { vp.state.tall = !vp.state.tall; c.classList.toggle('on', vp.state.tall); c.innerHTML = I(vp.state.tall ? 'min' : 'max', 'sm'); fit(); ta.focus(); return; }
        if (k === 'ls') { vp.state.ls = !(vp.state.ls || vp.state.lu); delete vp.state.lu; vp.rerender(); vp.owner && vp.owner.changed(); return; }
        if (k === 'model') MC.menu(c, [{ h: isNew(sidC) ? 'Model for new conversations' : 'Model for the next message' }, ...optList('models').map((o) => ({ id: o.id, label: o.label, icon: 'sparkle', on: o.id === modelOf(sidC), sub: !isNew(sidC) && o.id === ownModel(sidC) ? 'this conversation' : '' }))],
          (id) => { if (isNew(sidC)) { LV.prefs.model = id; savePrefs(); } else if (id === ownModel(sidC)) delete LV.pick[sidC]; else LV.pick[sidC] = id; vp.rerender(); });
        if (k === 'effort') { const mo = modelOpt(modelOf(sidC)), key = mo && mo.local ? 'effort:' + mo.id : 'effort'; MC.menu(c, effortsOf(sidC).map((o) => ({ id: o.id, label: o.label, icon: 'bolt', on: String(o.id) === effortOf(sidC) })), (id) => { LV.prefs[key] = id; savePrefs(); vp.rerender(); }); }
        if (k === 'mode') MC.menu(c, [{ h: isNew(sidC) ? 'Permissions for this new conversation' : 'Permissions for this conversation' }, ...optList('modes').map((o) => ({ id: o.id, label: o.label, icon: 'lock', on: String(o.id) === modeOfConv(sidC) }))], (id) => { pickMode(sidC, id); vp.rerender(); });
        if (k === 'more') rowMenu(c, sidC);
        if (k === 'end') MC.menu(c, [{ h: 'End this conversation' }, { id: 'archive', label: 'Archive', sub: 'hidden, searchable', icon: 'box' }, { sep: 1 }, { id: 'trash', label: 'Throw away', sub: 'Recycle Bin', icon: 'trash' }], (id) => endAs(sidC, id), { alignRight: true });
      };
    },
  };

  /* ---------- events from the server ---------- */
  MC.events.on('chat', onChat);
  const onTurn = (d) => { if (!d || !d.runId) return; const t = LV.turns[d.runId] || (LV.turns[d.runId] = {}); t.startedAt = d.startedAt || t.startedAt; if (d.outputTokens != null) t.out = d.outputTokens; };
  MC.events.on('chat.turn', onTurn);
  /* the PC this one is linked to: its live turns, relayed by this server (services/pcLink.js), as its phone sees them */
  let pcRunsT = 0; /* a question or permission of the linked PC appears or goes: read its processes again */
  MC.events.on('pc.chat', (d) => { if (!d || !d.runId) return; rec(d.runId).pc = true; onChat(d); if (d.permission || d.permissionDone != null || d.done) { clearTimeout(pcRunsT); pcRunsT = setTimeout(loadRuns, 300); } });
  MC.events.on('pc.chat.turn', onTurn);
  MC.events.on('sessions.changed', reloadLists);
  const onStats = (d) => { if (d && d.sessionId) { LV.stats[d.sessionId] = { ...(LV.stats[d.sessionId] || {}), ...d }; paintStats(d.sessionId); } };
  MC.events.on('session.stats', onStats);
  MC.events.on('pc.session.stats', onStats);
  MC.events.on('run.remote', loadRuns);
  let bgT = null; MC.events.on('run.background', () => { clearTimeout(bgT); bgT = setTimeout(loadRuns, 300); });
  MC.events.on('draft', (e) => { if (!e || e.tab === MC.tabId) return; if ($$(`.convo[data-dk="${CSS.escape(e.key)}"]`).length) pullDraft(e.key); else delete DR.known[e.key]; if (/^[nc]-/.test(e.key)) loadNewDrafts(); });
  MC.events.on('delayed', (d) => { LV.delayed = (d && d.items) || []; paintAllWaits(); });
  MC.events.on('delayed.sent', () => { loadRuns(); reloadLists(); });
  const remoteT = {};
  MC.events.on('waiting', (d) => {
    if (!d || !d.id || !LV.conv[d.id]) return;
    const c = LV.conv[d.id]; c.sends = d.sends || []; paintWaits(d.id); paintHist(d.id);
    if (!c.meta || !c.meta.readOnly || !convEls(d.id).length) return;
    const lr = c.meta.link && LV.view[d.id] && LV.store[LV.view[d.id]];
    if (lr && (lr.status === 'working' || lr.status === 'starting')) return; /* it streams through the link already */
    clearTimeout(remoteT[d.id]); remoteT[d.id] = setTimeout(() => { loadConv(d.id); loadStats(d.id); }, 300);
  });
  MC.events.on('machines.changed', () => { LV.remote = {}; if (LV.hub) loadProjects().then(() => { Object.keys(LV.lists).filter(hubKey).forEach(loadList); paintTrees(); }).catch(() => {}); else loadPcGroups().then(() => Object.keys(LV.lists).filter(hubKey).forEach(loadList)); loadPlaces(); });
  MC.events.on('usage', (u) => { if (u && u.fiveHour) LV.usage = u; });
  let pcLinkT = 0;
  MC.events.on('pc-link', () => { if (LV.hub) return; clearTimeout(pcLinkT); pcLinkT = setTimeout(() => { loadPcGroups(); loadPlaces(); }, 500); });
  MC.events.on('hub-link', () => loadPlaces());
  setInterval(loadRuns, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) $$('.convo[data-dk]').forEach((cv) => { if (!DR.unsent[cv.dataset.dk]) pullDraft(cv.dataset.dk); }); });

  /* ---------- start ---------- */
  /* git state, checks and names change: read the projects again (a burst of changes is read once) */
  let projT = 0;
  MC.events.on('projects.changed', () => { clearTimeout(projT); projT = setTimeout(() => loadProjects().then(() => { buildRoots(); paintTrees(); ['inbox', 'projects', 'brief'].forEach((m) => MC.emit('rerender', m)); }).catch(() => {}), 600); });
  LV.ready = (async () => {
    const opts = api.get('/api/chat/options').then((o) => (LV.opts = o)).catch(() => null);
    await Promise.all([loadProjects().catch((e) => { LV.err = errText(e); }), loadRuns(), opts, MC.whoami]);
    /* the other PCs' projects (Home's, the hub's) too, so the saved tabs of those open at once; a slow hub only waits so long */
    await Promise.race([LV.pcGroups, new Promise((r) => setTimeout(r, 2500))]).catch(() => {});
    loadList('*chat'); loadNewDrafts(); loadDelayed();
    api.get('/api/voice').then((v) => { VO.available = !!(v && v.available); VO.state = (v && (v.link || v.state)) || 'idle'; paintMics(); }).catch(() => {});
    D.places = [{ id: 'home', name: MC.place || 'This PC', sub: 'This computer', online: true, icon: 'pc' }];
    loadPlaces();
    setInterval(loadPlaces, 30000);
  })();
  /* The places in the status bar and the tree: this PC, the hub and the other PCs. The hub is on when its last answer is
     newer than its last error (an old error stays in the status). Another PC is on when the hub heard from it lately, or
     when this PC's direct link to it (Home, services/pcLink.js) is online. */
  let placesN = 0;
  async function loadPlaces() {
    const n = ++placesN;
    const [m, link] = await Promise.all([api.get('/api/machines').catch(() => null), LV.hub ? null : api.get('/api/pc-link').catch(() => null)]);
    if (n !== placesN || !m) return;
    const at = (v) => { const t = Date.parse(String(v || '').split(' ')[0]); return Number.isFinite(t) ? t : 0; };
    const hubOn = !!(m.hub && m.hub.linked) && (!m.hub.lastError || at(m.hub.lastOk) > at(m.hub.lastError));
    const linked = link && link.paired ? link : null;
    const places = [{ id: 'home', name: MC.place || 'This PC', sub: 'This computer', online: true, icon: 'pc' }];
    if (m.hub && m.hub.linked) places.push({ id: 'hub', name: 'Hub', sub: 'Always on', online: hubOn, icon: 'server' });
    const pcs = (m.machines || []).slice();
    if (linked && !pcs.some((x) => x.name === linked.paired.name)) pcs.push({ id: 'link', name: linked.paired.name, online: false });
    pcs.forEach((x) => { const on = !!x.online || !!(linked && linked.online && x.name === linked.paired.name); places.push({ id: 'm:' + x.id, name: x.name, sub: on ? 'Online' : 'Offline', online: on, icon: 'pc' }); });
    D.places = places;
    paintTrees(); MC.D && MC.D.drawSbar && MC.D.drawSbar();
  }
  /* files from elsewhere (a gallery picture) go into the open conversation's message box */
  function attachFiles(files) {
    const sid = S.session; if (!sid) return;
    const k = draftKey(sid); LV.att[k] = LV.att[k] || [];
    [...files].forEach((f) => LV.att[k].push(upload(f, () => convEls(sid).forEach((x) => x._atts && x._atts()))));
    convEls(sid).forEach((x) => x._atts && x._atts());
  }
  MC.live.helpers = { ago, hhmm, whenText, toMs, errText, loadList, loadRemote, hubKey, linkProj, loadConv, loadRuns, loadStats, newKey, isNew, pidOf, isRootId, isChatId, draftKey, attachFiles, sendText: (sid, text) => send(sid, text, []), modelLabel, busy: (sid) => { const c = LV.view[sid] && LV.store[LV.view[sid]]; return !!c && (c.status === 'working' || c.status === 'starting'); } };
})();
