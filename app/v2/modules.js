/* k-scaled */
/* scaled-125: sizes are 25% bigger, for 100% zoom */
/* Revamp mockups: shared state, icons, menus, palette, viewports and the modules a viewport can show.
   Everything is fake. Clicking things changes local state only. */
window.MC = window.MC || {};
(() => {
  const D = MC.data;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  MC.$ = $; MC.$$ = $$; MC.esc = esc;
  /* saved settings; a sandboxed page (Mission Control's /local/ viewer) has no storage, so fall back to memory */
  const mem = {};
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return k in mem ? mem[k] : null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { mem[k] = v; } } };

  /* ---------- icons (24 px grid, stroke) ---------- */
  const P = {
    menu: 'M4 6h16M4 12h16M4 18h16', chev: 'm6 9 6 6 6-6', chevR: 'm9 6 6 6-6 6', chevL: 'm15 6-6 6 6 6', chevUD: 'm7 15 5 5 5-5M7 9l5-5 5 5',
    chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z', branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
    tasks: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9', doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
    image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
    git: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 12h6M15 12h6', layout: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
    play: 'M7 4v16l13-8z', box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8', gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    zap: 'M13 2 3 14h9l-1 8 10-12h-9z', globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18', terminal: 'm4 17 6-6-6-6M12 19h8',
    note: 'M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z', code: 'm16 18 6-6-6-6M8 6l-6 6 6 6', chart: 'M3 3v18h18M8 17v-5M13 17V8M18 17v-9', cpu: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0', pulse: 'M22 12h-4l-3 9L9 3l-3 9H2', folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    pc: 'M3 4h18v12H3zM8 20h8M12 16v4', server: 'M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01', search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    plus: 'M12 5v14M5 12h14', x: 'M18 6 6 18M6 6l12 12', max: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7', min: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
    splitR: 'M3 3h18v18H3zM12 3v18', splitD: 'M3 3h18v18H3zM3 12h18', ext: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    check: 'M20 6 9 17l-5-5', tick: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3', clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    star: 'm12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z', pin: 'M12 17v5M9 10.8V4h6v6.8l3 3.2v2H6v-2z', more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    send: 'M12 19V5M5 12l7-7 7 7', clip: 'm21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-2.8-2.8L15.5 7', mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
    at: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8', slash: 'M16 3 8 21', sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', board: 'M3 3h5v18H3zM10 3h5v12h-5zM17 3h4v8h-4z', cal: 'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4',
    side: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12zM12 9v6M9 12h6', stop: 'M6 6h12v12H6z', vol: 'M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14', volX: 'M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6', refresh: 'M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5',
    arrowL: 'M19 12H5M12 19l-7-7 7-7', arrowR: 'M5 12h14M12 5l7 7-7 7', arrowU: 'M12 19V5M5 12l7-7 7 7', save: 'M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7', lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    sparkle: 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z', warn: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
    xc: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15 9l-6 6M9 9l6 6', circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', loader: 'M12 3a9 9 0 1 0 9 9',
    inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z', panels: 'M3 3h18v18H3zM9 3v18M15 3v18', panelL: 'M3 4h18v16H3zM9 4v16M16.5 9l-3 3 3 3', cmd: 'M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6z',
    hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18', camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    pointer: 'm3 3 7.1 17 2.5-7.4L20 10z', user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
    sidebar: 'M3 3h18v18H3zM9 3v18', link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    bolt: 'M13 2 3 14h9l-1 8 10-12h-9z', flag: 'M4 22V4M4 4h13l-2 4 2 4H4', grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01', down: 'M12 5v14M5 12l7 7 7-7', copy: 'M9 9h11v11H9zM5 15H4V4h11v1', toTop: 'M5 4h14M12 20V9M6.5 14.5 12 9l5.5 5.5', toEnd: 'M5 20h14M12 4v11M6.5 9.5 12 15l5.5-5.5',
    layers: 'M12 3 2 8l10 5 10-5zM2 12.5l10 5 10-5M2 17l10 5 10-5', brief: 'M3 7h18v13H3zM8 7V4h8v3M3 12.5h18', rocket: 'M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 15l-3-3c1-4 4-9 12-9 0 8-5 11-9 12zM15 9h.01',
    share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4', gantt: 'M4 6h9M8 12h12M6 18h8', undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
    hal: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z', type: 'M4 7V5h16v2M9 19h6M12 5v14', orbit: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM21 9.5c1 2.4-3.3 6-8.4 7.6S2.6 17.9 2 15.4s3.4-5.7 8.6-7.3 9.4-1 10.4 1.4z', copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    swap: 'M7 4 3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7', palette: 'M12 22a10 10 0 1 1 10-10c0 2.8-2.3 4-4.5 4H16a2 2 0 0 0-1.4 3.4A1.9 1.9 0 0 1 12 22zM7.5 12.5h.01M9.5 7.5h.01M14.5 7.5h.01M17 11.5h.01',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z', grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z', trash: 'M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15',
    dumbbell: 'M6 6v12M3 9v6M18 6v12M21 9v6M6 12h12', flame: 'M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-1.5 2-2.5 3-3.5 3 0-2-1-4-2.5-6 0 4-4 7-4 13a7 7 0 0 0 7 7z', trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01', help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01',
  };
  MC.icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24"><path d="${P[n] || P.circle}"/></svg>`;
  const I = MC.icon;
  /* a panel's size as a flex share, scaled up: a share under 1 on a panel that is alone (maximized, or the last one in its
     column) would leave the rest of the space empty */
  const fx = (n) => `${n * 1000} 1 0`;
  const SCROLLERS = '.vp-body, .convo-scroll';
  const ST = { done: ['tick', 'Done'], run: ['loader', 'Running'], wait: ['clock', 'Needs you'], warn: ['warn', 'Stale'], idle: ['circle', 'Idle'], fail: ['xc', 'Failed'] };
  MC.st = (s, label) => `<span class="st st-${s}">${I(ST[s][0])}${esc(label || ST[s][1])}</span>`;
  const URG = { crit: ['warn', 'Critical'], high: ['flag', 'High'], med: ['flag', 'Medium'], low: ['flag', 'Low'] };
  MC.urg = (u) => `<span class="urg ${u}">${I(URG[u][0])}${URG[u][1]}</span>`;

  /* ---------- state and events ---------- */
  const clone = (x) => JSON.parse(JSON.stringify(x));
  MC.state = {
    project: 'MissionControl', place: 'home', session: 's1', theme: ((t) => t === 'graphite' ? 'slate' : t)(store.get('mcrev-theme:' + location.pathname.split('/').pop())) || null, work: false,
    tasks: clone(D.tasks), gallery: clone(D.gallery), reminders: clone(D.reminders), picked: new Set(), extra: {}, draft: '',
    cacheLeft: 292, ctx: 38, model: 'Opus 5.5', effort: 'High', mode: 'Ask before edits', taskView: 'board', expanded: new Set(['t1']),
  };
  const S = MC.state;
  const subs = {};
  /* the pages a pg-*.js file draws: MC.drawPage[page](el) each time it is shown, MC.pageBar[page]() for the page bar ({ sub, html }) */
  MC.drawPage = {}; MC.pageBar = {};
  MC.on = (e, fn) => (subs[e] = subs[e] || []).push(fn);
  MC.emit = (e, d) => (subs[e] || []).forEach((fn) => fn(d));

  MC.allSessions = () => {
    const out = [];
    D.sessions.forEach((g) => g.items.forEach((s) => { out.push(s); (s.children || []).forEach((c) => out.push({ ...c, parent: s.id })); }));
    return out;
  };
  MC.sessionById = (id) => MC.allSessions().find((s) => s.id === id) || MC.allSessions()[0];
  /* A panel can show another project than its tab (its state.project). While such a panel draws, or handles a click or a key,
     MC.ctx names it: the project and conversation it shows come from it instead of the tab. */
  MC.ctx = null;
  MC.curProject = () => (MC.ctx && MC.ctx.project) || S.project;
  MC.curSession = () => (MC.ctx ? MC.ctx.vp.state.session || null : S.session);
  MC.setSession = (id) => {
    if (MC.ctx) { const v = MC.ctx.vp; v.state.session = id; setTimeout(() => { v.rerender && v.rerender(); v.owner && v.owner.changed(); }); return; }
    S.session = id; MC.emit('session', id);
  };
  MC.setProject = (name) => { S.project = name; MC.emit('project', name); MC.toast(`Opened ${name}`, 'folder'); };
  MC.projectInfo = (name = S.project) => {
    let hit = null;
    const walk = (items, root) => items.forEach((p) => { if (p.items) walk(p.items, root); else if (p.name === name) hit = { ...p, root }; });
    D.roots.forEach((r) => walk(r.items, r.path));
    return hit || { name, root: 'D:\\Dev', tint: '#9db4ff' };
  };
  MC.store = store;
  MC.setTheme = (t) => { if (t === 'graphite') t = 'slate'; S.theme = t; document.documentElement.dataset.theme = t; store.set('mcrev-theme:' + location.pathname.split('/').pop(), t); MC.emit('theme', t); };

  /* text size S M L: one factor (--k) that every size in base.css is multiplied by, so 1 px lines stay sharp */
  const SIZES = { S: .88, M: 1, L: 1.13 };
  MC.setSize = (z) => { S.size = SIZES[z] ? z : 'M'; document.documentElement.style.setProperty('--k', SIZES[S.size]); store.set('mcrev-size', S.size); MC.emit('size', S.size); };
  /* work mode: personal projects hidden, plain views (cards, list, no face), no sounds or animations; the theme stays what this PC picked */
  MC.setWork = (on) => { S.work = on; document.documentElement.toggleAttribute('data-work', on); MC.emit('work', on); };

  /* ---------- floating menu ---------- */
  let openMenu = null, subMenus = [];
  MC.closeMenus = () => { subMenus.forEach((x) => x.remove()); subMenus = []; if (openMenu) { openMenu.remove(); openMenu = null; } };
  const menuHtml = (items) => items.map((it, i) => it.h ? `<div class="mh">${esc(it.h)}</div>` : it.sep ? '<div class="msep"></div>'
    : `<button class="mi${it.on ? ' on' : ''}${it.kids ? ' kids' : ''}" data-i="${i}">${it.icon ? I(it.icon) : ''}<span class="ellip">${esc(it.label)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}${it.kids ? `<span class="mchev">${I('chevR', 'sm')}</span>` : ''}</button>`).join('');
  /* an item with kids opens its own menu beside it, on hover or click; menus nest to any depth */
  const wireMenu = (m, items, onPick, depth) => {
    let t = 0;
    const openKid = (b) => {
      subMenus.filter((x) => x._depth > depth).forEach((x) => x.remove()); subMenus = subMenus.filter((x) => x._depth <= depth);
      $$('.mi.hl', m).forEach((x) => x.classList.remove('hl'));
      const it = b && items[+b.dataset.i]; if (!it || !it.kids) return;
      b.classList.add('hl');
      const s = document.createElement('div'); s.className = 'menu subm'; s._depth = depth + 1; s.innerHTML = menuHtml(it.kids); document.body.appendChild(s);
      const r = b.getBoundingClientRect(), w = s.offsetWidth, h = s.offsetHeight;
      let x = r.right + 4; if (x + w > innerWidth - 8) x = r.left - w - 4;
      const y = Math.min(r.top - 7, innerHeight - h - 8);
      s.style.left = Math.max(8, x) + 'px'; s.style.top = Math.max(8, y) + 'px';
      s.addEventListener('mouseenter', () => clearTimeout(t));
      subMenus.push(s); wireMenu(s, it.kids, onPick, depth + 1);
    };
    m.addEventListener('mouseover', (e) => { const b = e.target.closest('.mi'); clearTimeout(t); if (!b || b.classList.contains('hl')) return; t = setTimeout(() => openKid(b), 110); });
    m.addEventListener('click', (e) => { const b = e.target.closest('.mi'); if (!b) return; const it = items[+b.dataset.i]; clearTimeout(t); if (it.kids) { openKid(b); return; } MC.closeMenus(); onPick && onPick(it.id, it); });
  };
  MC.menu = (anchor, items, onPick, opts = {}) => {
    const wasSame = openMenu && openMenu._anchor === anchor;
    MC.closeMenus();
    if (wasSame) return;
    const m = document.createElement('div');
    m.className = 'menu' + (opts.grid ? ' grid' : '');
    m._anchor = anchor;
    m.innerHTML = menuHtml(items);
    document.body.appendChild(m);
    /* opts.at: { x, y } opens it where the pointer is (a right-click) */
    const r = opts.at ? { left: opts.at.x, right: opts.at.x, top: opts.at.y, bottom: opts.at.y - 6 } : anchor.getBoundingClientRect();
    const w = m.offsetWidth, h = m.offsetHeight;
    let x = opts.alignRight ? r.right - w : r.left, y = r.bottom + 6;
    if (x + w > innerWidth - 8) x = innerWidth - w - 8;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
    m.style.left = Math.max(8, x) + 'px'; m.style.top = y + 'px';
    wireMenu(m, items, onPick, 0);
    openMenu = m;
  };
  document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target) && !subMenus.some((x) => x.contains(e.target)) && !(openMenu._anchor && openMenu._anchor.contains(e.target))) MC.closeMenus(); });

  /* ---------- toast, lightbox ---------- */
  /* act: { label, run, ms }: one button in the toast (Undo), which stays ms long (5 s) */
  MC.toast = (text, icon = 'check', act = null) => {
    let box = $('.toasts'); if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = I(icon) + `<span>${esc(text)}</span>` + (act ? `<button class="btn sm" style="pointer-events:auto;margin-left:calc(8px*var(--k))">${esc(act.label)}</button>` : '');
    if (act) t.querySelector('button').onclick = () => { t.remove(); act.run(); };
    box.appendChild(t); setTimeout(() => t.remove(), act ? act.ms || 5000 : 3200);
  };
  MC.lightbox = (g) => {
    let lb = $('.lightbox');
    if (!lb) { lb = document.createElement('div'); lb.className = 'lightbox'; document.body.appendChild(lb); lb.addEventListener('click', (e) => { if (e.target === lb) lb.classList.remove('on'); }); }
    lb.innerHTML = `<div><img src="${g.src}" alt=""><div class="lbbar"><b>${esc(g.title)}</b><span class="faint">${esc(g.when)} · by ${g.by === 'claude' ? 'Claude' : 'you'}</span>
      <button class="btn sm" data-a="send">${I('chat', 'sm')}Send to chat</button><button class="btn sm" data-a="task">${I('tasks', 'sm')}Attach to a task</button><button class="btn sm ghost" data-a="close">${I('x', 'sm')}Close</button></div></div>`;
    lb.classList.add('on');
    lb.onclick = (e) => { const a = e.target.closest('[data-a]'); if (!a) { if (e.target === lb) lb.classList.remove('on'); return; }
      if (a.dataset.a === 'send') { S.picked.add(g.src); MC.emit('picked'); MC.toast('Added to the message box'); }
      if (a.dataset.a === 'task') MC.toast('Attached to "Viewport layout engine"');
      lb.classList.remove('on'); };
  };

  /* ---------- command palette ---------- */
  MC.palette = () => {
    let pal = $('.pal'), scrim = $('.scrim');
    if (!pal) {
      scrim = document.createElement('div'); scrim.className = 'scrim'; document.body.appendChild(scrim);
      pal = document.createElement('div'); pal.className = 'pal';
      pal.innerHTML = `<div class="pin">${I('search', 'lg')}<input placeholder="Jump to a project, conversation, task, or type a command"><span class="kbd">Esc</span></div><div class="pres"></div>
        <div class="pfoot"><span><span class="kbd">↑</span> <span class="kbd">↓</span> move</span><span><span class="kbd">Enter</span> open</span><span><span class="kbd">></span> commands only</span><span style="margin-left:auto">Ctrl K anywhere</span></div>`;
      document.body.appendChild(pal);
      scrim.onclick = () => close();
      const inp = $('input', pal), res = $('.pres', pal);
      let items = [], hl = 0;
      const all = () => {
        const out = [];
        const projects = []; const walk = (it) => it.forEach((p) => p.items ? walk(p.items) : projects.push(p.name)); D.roots.forEach((r) => walk(r.items));
        out.push(...[['New conversation', 'chat', 'Ctrl N'], ['New task', 'tasks', 'T'], ['New reminder', 'bell', ''], ['Layout: one viewport', 'splitR', '1'], ['Layout: two viewports', 'splitR', '2'], ['Layout: three viewports', 'splitR', '3'],
          ['Theme: Slate', 'moon', ''], ['Text size: S', 'type', ''], ['Text size: M', 'type', ''], ['Text size: L', 'type', ''], ['Theme: Redline', 'moon', ''], ['Theme: Midnight', 'moon', ''], ['Work mode: on or off', 'brief', ''], ['Pop this viewport out to a window', 'ext', '']].map(([l, i, k]) => ({ g: 'Commands', l, i, k, cmd: true })));
        out.push(...projects.map((p) => ({ g: 'Projects', l: p, i: 'folder', k: '', proj: p })));
        out.push(...MC.allSessions().map((s) => ({ g: 'Conversations', l: s.title, i: s.kind === 'side' ? 'side' : 'chat', k: s.when, sess: s.id, alt: Array.isArray(s.pastTitles) ? s.pastTitles : null })));
        out.push(...S.tasks.map((t) => ({ g: 'Tasks', l: t.title, i: 'tasks', k: t.due, task: t.id })));
        out.push(...Object.entries(MC.modules).map(([id, m]) => ({ g: 'Open in a viewport', l: m.label, i: m.icon, k: '', mod: id })));
        return out;
      };
      const draw = () => {
        let q = inp.value.trim().toLowerCase(); const cmdOnly = q.startsWith('>'); if (cmdOnly) q = q.slice(1).trim();
        /* a conversation is found by the names it had before too (Claude renames it when the subject moves); that hit says "was ..." */
        const old = (x) => q && x.alt && !x.l.toLowerCase().includes(q) ? x.alt.slice().reverse().find((t) => t.toLowerCase().includes(q)) : null;
        items = all().filter((x) => (!cmdOnly || x.cmd) && (!q || x.l.toLowerCase().includes(q) || old(x))).map((x) => { const was = old(x); return was ? { ...x, k: 'was ' + was } : x; }).slice(0, 40);
        hl = Math.min(hl, items.length - 1); let g = '';
        res.innerHTML = items.map((x, i) => (x.g !== g ? `<div class="mh" style="font-size:calc(13px*var(--k));font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3);padding:calc(10px*var(--k)) calc(12px*var(--k)) calc(5px*var(--k))">${(g = x.g)}</div>` : '')
          + `<div class="mi${i === hl ? ' hl' : ''}" data-i="${i}" style="display:flex;gap:calc(12px*var(--k));align-items:center;padding:calc(10px*var(--k)) calc(12px*var(--k));border-radius:var(--r-xs);cursor:pointer;${i === hl ? 'background:var(--hover)' : ''}">${I(x.i)}<span class="grow ellip">${esc(x.l)}</span><span class="faint" style="font-size:calc(14px*var(--k))">${esc(x.k)}</span></div>`).join('') || '<div class="empty">Nothing found</div>';
      };
      const run = (x) => {
        if (!x) return; close();
        if (x.proj) MC.setProject(x.proj);
        else if (x.sess) { MC.setSession(x.sess); MC.emit('open', 'convo'); }
        else if (x.task) MC.emit('open', 'tasks');
        else if (x.mod) MC.emit('open', x.mod);
        else if (x.l.startsWith('Theme: ')) MC.setTheme(x.l.slice(7).toLowerCase());
        else if (x.l.startsWith('Layout: ')) MC.emit('cols', { one: 1, two: 2, three: 3 }[x.l.split(' ')[1]]);
        else if (x.l.startsWith('Text size: ')) MC.setSize(x.l.slice(11));
        else if (x.l.startsWith('Work mode')) MC.setWork(!S.work);
        else if (x.l === 'New task') { MC.emit('open', 'tasks'); MC.addTask('New task', 'me'); }
        else MC.toast(x.l + ' (mockup)', 'sparkle');
      };
      inp.oninput = () => { hl = 0; draw(); };
      inp.onkeydown = (e) => {
        if (e.key === 'ArrowDown') { hl = Math.min(items.length - 1, hl + 1); draw(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { hl = Math.max(0, hl - 1); draw(); e.preventDefault(); }
        else if (e.key === 'Enter') run(items[hl]);
        else if (e.key === 'Escape') close();
      };
      res.onclick = (e) => { const r = e.target.closest('[data-i]'); if (r) run(items[+r.dataset.i]); };
      pal._draw = draw;
      function close() { pal.classList.remove('on'); scrim.classList.remove('on'); }
    }
    pal.classList.add('on'); scrim.classList.add('on');
    const inp = $('input', pal); inp.value = ''; pal._draw(); setTimeout(() => inp.focus(), 10);
  };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); MC.palette(); }
    if (e.key === 'Escape') { MC.closeMenus(); const lb = $('.lightbox.on'); if (lb) lb.classList.remove('on'); }
  });

  /* ---------- trees ---------- */
  MC.renderProjectTree = (el, opts = {}) => {
    const closed = el._closed || (el._closed = new Set(['D:\\Games', 'Experiments']));
    const q = (el._q || '').toLowerCase();
    const match = (n) => !q || n.toLowerCase().includes(q);
    const proj = (p, depth) => {
      if (p.items) {
        const kids = p.items.filter((x) => x.items || match(x.name));
        if (q && !kids.length) return '';
        const open = q || !closed.has(p.name);
        return `<div class="tn ${open ? 'open' : ''}" data-fold="${esc(p.name)}"><span class="tw">${I('chevR', 'sm')}</span>${I('folder', 'sm')}<span class="nm">${esc(p.name)}</span><span class="meta">${p.items.length}</span></div>
          <div class="tkids ${open ? '' : 'closed'}">${p.items.map((x) => proj(x, depth + 1)).join('')}</div>`;
      }
      if (!match(p.name)) return '';
      return `<div class="tn ${p.name === S.project ? 'on' : ''}" data-proj="${esc(p.name)}"><span class="tw"></span><span class="tint" style="width:calc(22px*var(--k));height:calc(22px*var(--k));font-size:calc(12px*var(--k));background:${p.tint}">${esc(p.name[0])}</span><span class="nm">${esc(p.name)}</span>
        <span class="meta">${p.running ? `<span class="dot run pulse" title="${p.running} running"></span>${p.running}` : ''}${p.due ? `<span class="badge" title="${p.due} tasks due">${p.due}</span>` : ''}${p.fav ? I('star', 'sm') : ''}</span></div>`;
    };
    const favs = []; const walk = (it) => it.forEach((p) => p.items ? walk(p.items) : p.fav && favs.push(p)); D.roots.forEach((r) => walk(r.items));
    el.innerHTML = `
      <div class="input" style="margin:calc(5px*var(--k)) calc(5px*var(--k)) 2px">${I('search', 'sm')}<input placeholder="Find a project" value="${esc(el._q || '')}"><span class="kbd">/</span></div>
      <div class="tsec">Places</div>
      ${D.places.map((p) => `<div class="tn ${p.id === S.place ? 'on' : ''}" data-place="${p.id}"><span class="tw"></span>${I(p.icon, 'sm')}<span class="nm">${esc(p.name)}</span><span class="meta"><span class="dot ${p.online ? 'ok' : 'idle'}"></span>${p.online ? 'online' : 'offline'}</span>${openable(p) ? (MC.live.link.locked ? `<button class="ibtn sm" data-unlockpc title="Unlock ${esc(p.name)}">${I('lock', 'sm')}</button>` : `<button class="ibtn sm" data-openpc title="Open ${esc(p.name)}">${I('ext', 'sm')}</button>`) : ''}</div>`).join('')}
      <div class="tsec">Chats <button class="ibtn" title="New chat">${I('plus', 'sm')}</button></div>
      <div class="tn ${closed.has('chats') ? '' : 'open'}" data-fold="chats"><span class="tw">${I('chevR', 'sm')}</span>${I('chat', 'sm')}<span class="nm">Simple chats</span><span class="meta">${D.chats.length}</span></div>
      <div class="tkids ${closed.has('chats') ? 'closed' : ''}">${D.chats.map((c) => `<div class="tn" data-chat="${c.id}"><span class="tw"></span><span class="nm">${esc(c.title)}</span><span class="meta">${esc(c.when)}</span></div>`).join('')}</div>
      ${favs.length ? '<div class="tsec">Favorites</div>' : ''}
      ${favs.map((p) => proj(p, 0)).join('')}
      ${D.roots.filter((r) => !(S.work && r.path.includes('Games'))).map((r) => `<div class="tsec">${I('folder', 'sm')}${esc(r.path)} <button class="ibtn" title="Root folder options">${I('more', 'sm')}</button></div>
        <div class="tkids" style="margin-left:calc(5px*var(--k));border:0;padding-left:0">${r.items.map((p) => proj(p, 0)).join('')}</div>`).join('')}
      <div class="tn" style="margin-top:calc(10px*var(--k));color:var(--text-3)"><span class="tw"></span>${I('plus', 'sm')}<span class="nm">Add a root folder</span></div>`;
    const inp = $('input', el);
    inp.oninput = () => { el._q = inp.value; MC.renderProjectTree(el, opts); const i2 = $('input', el); i2.focus(); i2.setSelectionRange(99, 99); };
    el.onclick = (e) => {
      const f = e.target.closest('[data-fold]'); if (f) { const k = f.dataset.fold; closed.has(k) ? closed.delete(k) : closed.add(k); MC.renderProjectTree(el, opts); return; }
      const p = e.target.closest('[data-proj]'); if (p) { if ((e.ctrlKey || opts.newTab) && opts.onNewTab) { opts.onNewTab(p.dataset.proj); return; } MC.setProject(p.dataset.proj); opts.onPick && opts.onPick(p.dataset.proj); MC.renderProjectTree(el, opts); return; }
      if (e.target.closest('[data-openpc]')) { MC.openOtherPc(); return; }
      if (e.target.closest('[data-unlockpc]')) { MC.unlockPc(MC.live.link.paired.name); return; }
      const pl = e.target.closest('[data-place]'); if (pl) { const place = D.places.find((x) => x.id === pl.dataset.place); if (!place.online) { MC.toast(`${place.name} is offline. Its conversations are on the hub.`, 'pc'); return; } S.place = place.id; MC.toast(`Showing ${place.name}`, 'pc'); MC.renderProjectTree(el, opts); return; }
      const c = e.target.closest('[data-chat]'); if (c) { MC.setSession(c.dataset.chat); MC.emit('open', 'convo'); opts.onPick && opts.onPick(null); }
    };
  };

  /* the other PC's own Mission Control in a new browser tab, through the link (a one-use address, server/services/pcLink.js
     enterUrl). The tab is opened at the click, so the browser does not block it, and pointed there once the address comes. */
  /* the place is the PC this one is linked to, on, and this page runs at this PC */
  const openable = (p) => { const L = MC.live && MC.live.link, h = document.documentElement; return !!(L && L.paired && L.online && L.paired.name === p.name) && !(MC.remote === true || MC.hub || h.hasAttribute('data-remote') || h.hasAttribute('data-hub')); };
  MC.openOtherPc = async () => {
    const w = window.open('about:blank', '_blank');
    try {
      const d = await MC.api.post('/api/pc-link/enter', {});
      if (!d || !d.url) throw new Error('no address');
      if (w) w.location.href = d.url; else window.open(d.url, '_blank');
    } catch (e) { if (w) w.close(); MC.toast('Could not open it: ' + ((e && e.message) || e), 'warn'); }
  };

  MC.renderSessionTree = (el, opts = {}) => {
    const closed = el._closed || (el._closed = new Set(['Earlier']));
    const row = (s, kid) => {
      const st = { run: '<span class="dot run pulse"></span>', wait: '<span class="dot warn"></span>', done: '', idle: '', fail: '<span class="dot fail"></span>' }[s.state];
      const ic = s.kind === 'side' ? 'side' : s.kind === 'nested' ? 'branch' : s.master ? 'layout' : 'chat';
      const label = { run: 'running', wait: 'needs you', fail: 'failed' }[s.state] || s.when;
      return `<div class="tn ${s.id === S.session ? 'on' : ''}" data-sess="${s.id}" title="${esc(s.title)}"><span class="tw">${s.children ? I('chevR', 'sm') : ''}</span>${I(ic, 'sm')}<span class="nm">${esc(s.title)}</span><span class="meta">${st}${label}</span></div>`
        + (s.children ? `<div class="tkids">${s.children.map((c) => row(c, true)).join('')}</div>` : '');
    };
    el.innerHTML = D.sessions.map((g) => `<div class="tsec" data-grp="${esc(g.group)}" style="cursor:pointer">${I(closed.has(g.group) ? 'chevR' : 'chev', 'sm')}${esc(g.group)}<span class="faint" style="margin-left:calc(5px*var(--k))">${g.items.length}</span><button class="ibtn" title="Section options">${I('more', 'sm')}</button></div>
      <div class="${closed.has(g.group) ? 'tkids closed' : ''}">${g.items.map((s) => row(s)).join('')}</div>`).join('')
      + `<div class="tn" style="margin-top:calc(8px*var(--k));color:var(--text-3)" data-newsec><span class="tw"></span>${I('plus', 'sm')}<span class="nm">New section</span></div>`;
    el.querySelectorAll('.tn[data-sess]').forEach((n) => { if (n.nextElementSibling && n.nextElementSibling.classList.contains('tkids')) n.classList.add('open'); });
    el.onclick = (e) => {
      if (e.target.closest('.ibtn')) { MC.menu(e.target.closest('.ibtn'), [{ id: 'r', label: 'Rename section', icon: 'note' }, { id: 'c', label: 'Collapse all', icon: 'chev' }, { id: 'm', label: 'Move to another project', icon: 'folder' }, { sep: 1 }, { id: 'a', label: 'Archive section', icon: 'box' }], (id) => MC.toast('Section: ' + id + ' (mockup)')); return; }
      const g = e.target.closest('[data-grp]'); if (g) { const k = g.dataset.grp; closed.has(k) ? closed.delete(k) : closed.add(k); MC.renderSessionTree(el, opts); return; }
      if (e.target.closest('[data-newsec]')) { D.sessions.push({ group: 'New section', items: [] }); MC.renderSessionTree(el, opts); MC.toast('Drag conversations into the new section'); return; }
      const s = e.target.closest('[data-sess]'); if (s) { MC.setSession(s.dataset.sess); MC.emit('open', 'convo'); opts.onPick && opts.onPick(s.dataset.sess); }
    };
  };
  MC.on('session', () => $$('[data-sesstree]').forEach((el) => MC.renderSessionTree(el)));

  /* ---------- tasks helpers ---------- */
  MC.pct = (t) => t.status === 'done' ? 100 : t.subs.length ? Math.round(100 * t.subs.filter((s) => s[1]).length / t.subs.length) : 0;
  MC.addTask = (title, by = 'claude', urg = 'med') => {
    const t = { id: 't' + Date.now(), title, status: 'todo', urg, due: 'Nov 1', tags: ['New'], by, subs: [] };
    S.tasks.unshift(t); MC.emit('tasks'); return t;
  };

  /* ---------- modules ---------- */
  const M = {};
  MC.modules = M;
  MC.groups = [['Talk', ['convo', 'sessions', 'inbox', 'comlink']], ['Plan', ['tasks', 'nextup', 'reminders', 'notes', 'activity', 'timeline']], ['Files', ['docs', 'gallery', 'artifacts']],
    ['Code', ['overview', 'git', 'scripts', 'console', 'browser', 'skills']], ['Watch', ['usage', 'system', 'running', 'crew', 'projects', 'brief']], ['Project', ['settings']]];

  /* conversation */
  const msgHtml = (m, i) => {
    const me = m.who === 'me';
    let h = `<div class="msg ${me ? 'me' : ''}" data-m="${i}"><div class="mb">
      <div class="mt"><b>${me ? 'You' : 'Claude'}</b>${esc(m.t)}</div>`;
    if (m.text) h += `<div class="tx">${esc(m.text)}</div>`;
    if (m.steps) h += `<div class="steps">${m.steps.map((s) => `<div class="step">${I('check', 'sm')}<b>${esc(s.k)}</b><span>${esc(s.d)}</span><span class="x">${esc(s.x)}</span></div>`).join('')}</div>`;
    if (m.cmd) h += `<div class="cmdb"><div class="ch">${I('terminal', 'sm')}<span>Run this in ${esc(m.cmd.shell)}</span><span class="grow"></span><button class="btn sm" data-cmd="copy">${I('copy', 'sm')}Copy</button><button class="btn sm primary" data-cmd="paste">${I('terminal', 'sm')}Paste in the console</button></div><code>${esc(m.cmd.line)}</code></div>`;
    if (m.actions) h += `<div class="mcacts">${m.actions.map((a) => `<button class="mcact" data-open="${a.mod}">${I(a.icon, 'sm')}${esc(a.text)} <i>${esc(a.ref)}</i></button>`).join('')}${m.undone ? '<span class="faint" style="font-size:calc(14px*var(--k));align-self:center">Undone</span>' : `<button class="mcact undo" data-undo title="Undo what Claude did here">${I('undo', 'sm')}Undo</button>`}</div>`;
    if (m.ask) h += m.ask.answered ? `<div class="mcacts"><span class="st st-done">${I('check')}You approved: ${esc(m.ask.body)}</span></div>`
      : `<div class="ask"><div class="at">${I('warn')}${esc(m.ask.title)}</div><code>${esc(m.ask.body)}</code><div class="faint" style="font-size:calc(15px*var(--k))">${esc(m.ask.note)}</div>
        <div class="row"><button class="btn primary sm" data-ask="yes">${I('check', 'sm')}Approve</button><button class="btn sm" data-ask="always">Always for npm</button><button class="btn sm ghost" data-ask="no">Deny</button></div></div>`;
    if (!m.ask) h += `<div class="hov"><button data-h="side">${I('side', 'sm')}Side chat</button><button data-h="task">${I('tasks', 'sm')}To task</button><button data-h="remind">${I('bell', 'sm')}Remind</button><button data-h="pin">${I('pin', 'sm')}Pin</button><button data-h="copy">${I('doc', 'sm')}Copy</button></div>`;
    return h + '</div></div>';
  };
  const convMsgs = () => (S.extra[S.session] = S.extra[S.session] || (S.session === 's1' ? clone(D.messages) : [
    { who: 'me', t: 'Oct 24', text: 'Pick up where we left off on: ' + MC.sessionById(S.session).title },
    { who: 'claude', t: 'Oct 24', text: 'I read the handoff. The last step was the test on the hub. It passes now. Two things are left, and I added them as tasks.', actions: [{ icon: 'check', text: 'Added task', ref: 'Pairing code test fails on the hub', mod: 'tasks' }] },
  ]));
  const cacheTxt = () => { const s = Math.max(0, S.cacheLeft); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const ring = (pct, warn) => { const c = 2 * Math.PI * 8; return `<svg class="ring" viewBox="0 0 22 22"><circle cx="11" cy="11" r="8" fill="none" stroke="var(--press)" stroke-width="3"/><circle cx="11" cy="11" r="8" fill="none" stroke="${warn ? 'var(--warn)' : 'var(--hi)'}" stroke-width="3" stroke-dasharray="${c * pct} ${c}" transform="rotate(-90 11 11)" stroke-linecap="round"/></svg>`; };
  /* the cache clock: live.js says how long the open conversation's cache has left (MC.cacheLeft) */
  setInterval(() => { S.cacheLeft = MC.cacheLeft ? MC.cacheLeft() : S.cacheLeft <= 0 ? 300 : S.cacheLeft - 1; const ttl = S.cacheTtl || 300; $$('.cache-t').forEach((e) => (e.textContent = cacheTxt())); $$('.cache-r').forEach((e) => (e.innerHTML = ring(S.cacheLeft / ttl, S.cacheLeft < 60))); }, 1000);

  M.convo = {
    label: 'Conversation', icon: 'chat',
    title: () => MC.sessionById(S.session).title,
    pick: (vp, anchor) => MC.menu(anchor, [{ h: 'Switch conversation' }, ...MC.allSessions().slice(0, 12).map((s) => ({ id: s.id, label: (s.parent ? '↳ ' : '') + s.title, icon: s.kind === 'side' ? 'side' : 'chat', sub: s.when, on: s.id === S.session })), { sep: 1 }, { id: 'new', label: 'New conversation', icon: 'plus', sub: 'Ctrl N' }],
      (id) => id === 'new' ? MC.toast('New conversation (mockup)', 'plus') : MC.setSession(id)),
    render: (vp) => {
      const s = MC.sessionById(S.session);
      const kids = (s.children || []).length;
      const ls = vp.state.ls, lu = vp.state.lu;
      const side = ls || lu ? `<aside class="cv-side">${ls ? `<div class="cvs grow1"><div class="cvs-h">${I('branch', 'sm')}Sessions<span class="grow"></span><button class="ibtn sm" data-c="ls" title="Hide the session list">${I('x', 'sm')}</button></div><div class="cvs-b"><div class="tree" data-sesstree></div></div></div>` : ''}
        ${lu ? `<div class="cvs ${ls ? '' : 'grow1'}"><div class="cvs-h">${I('chart', 'sm')}Usage<span class="grow"></span><button class="ibtn sm" data-c="lu" title="Hide usage">${I('x', 'sm')}</button></div><div class="cvs-b">${MC.usageMini()}</div></div>` : ''}</aside>` : '';
      return `<div class="cv-wrap">${side}<div class="convo"><div class="cv-head"><button class="ibtn sm ${ls ? 'on' : ''}" data-c="ls" title="Show the session list in this panel">${I('sidebar', 'sm')}</button><button class="ibtn sm ${lu ? 'on' : ''}" data-c="lu" title="Show usage in this panel">${I('chart', 'sm')}</button><span class="cv-sep"></span>${s.master ? `<span class="badge accent">${I('layout', 'sm')} Master session</span>` : ''}${s.kind === 'nested' ? '<span class="badge">Nested session</span>' : ''}${s.kind === 'side' ? '<span class="badge">Side chat</span>' : ''}
          <span class="grow"></span>${kids ? `<button class="btn sm ghost" data-c="kids">${I('branch', 'sm')}${kids} sub-sessions</button>` : ''}<button class="btn sm ghost" data-c="spawn">${I('plus', 'sm')}Nested session${I('chev', 'sm')}</button><button class="btn sm ghost" data-c="end">${I('stop', 'sm')}End${I('chev', 'sm')}</button></div>
        <div class="convo-scroll"><div class="convo-inner">
        ${convMsgs().map(msgHtml).join('')}<div class="tail"></div></div></div>
        <div class="composer"><div class="cbox"><div class="ctx">${[...S.picked].map((src) => `<span class="cx"><img src="${src}" alt="">${esc(src.split('/').pop())}<button class="ibtn sm" data-unpick="${src}">${I('x', 'sm')}</button></span>`).join('')}</div>
          <textarea placeholder="Message Claude. Type / for commands, @ for files, pictures and tasks">${esc(S.draft)}</textarea>
          <div class="cbar"><button class="ibtn sm" title="Attach">${I('clip', 'sm')}</button><button class="ibtn sm" data-c="at" title="Mention">${I('at', 'sm')}</button><button class="ibtn sm" data-c="slash" title="Commands">${I('slash', 'sm')}</button><button class="ibtn sm ${vp.state.tall ? 'on' : ''}" data-c="tall" title="${vp.state.tall ? 'Shorter message box' : 'Taller message box'}">${I(vp.state.tall ? 'min' : 'max', 'sm')}</button>
            <button class="pillsel" data-c="model">${I('sparkle', 'sm')}${S.model}${I('chev', 'sm')}</button><button class="pillsel" data-c="effort">${I('bolt', 'sm')}${S.effort}${I('chev', 'sm')}</button><button class="pillsel" data-c="mode">${I('lock', 'sm')}${S.mode}${I('chev', 'sm')}</button>
            <span class="grow"></span><span class="pillsel" title="Prompt cache: time left before it expires"><span class="cache-r">${ring(S.cacheLeft / 300)}</span><span class="cache-t mono">${cacheTxt()}</span></span>
            <span class="pillsel" title="Context used">${I('chart', 'sm')}${S.ctx}%</span><button class="ibtn sm" title="Dictate">${I('mic', 'sm')}</button><button class="send" title="Send">${I('send')}</button></div></div>
          <div class="cfoot"><span>${I('folder', 'sm')} <b>D:\\Dev\\${esc(S.project)}</b></span><span>Home PC</span><span class="grow"></span><span>Enter sends · Shift Enter new line · Ctrl Enter sends later</span></div></div></div></div>`;
    },
    mount: (el, vp) => {
      const sc = $('.convo-scroll', el); sc.scrollTop = sc.scrollHeight;
      const tr = $('[data-sesstree]', el); if (tr) MC.renderSessionTree(tr);
      const s0 = () => MC.sessionById(S.session);
      const ta = $('textarea', el), box = $('.cbox', el);
      let pop = null;
      const closePop = () => { if (pop) { pop.remove(); pop = null; } };
      const showPop = (kind, q) => {
        closePop();
        let items;
        if (kind === '/') items = D.slash.filter((x) => x[0].includes(q)).map((x) => ({ id: x[0], label: x[0], sub: x[1], icon: x[2] === 'MC' ? 'layout' : x[2] === 'skill' ? 'zap' : 'sparkle' }));
        else items = [...D.docs.slice(0, 4).map((d) => ({ id: '@' + d.name, label: d.name, sub: d.where, icon: 'doc' })), ...S.gallery.slice(0, 4).map((g) => ({ id: 'img:' + g.src, label: g.title, sub: 'gallery', icon: 'image' })), ...S.tasks.slice(0, 3).map((t) => ({ id: '@task ' + t.title, label: t.title, sub: 'task', icon: 'tasks' }))].filter((x) => x.label.toLowerCase().includes(q));
        if (!items.length) return;
        pop = document.createElement('div'); pop.className = 'popup-list';
        pop.innerHTML = `<div class="menu" style="animation:none">${kind === '/' ? '<div class="mh">Commands: Mission Control, Claude and skills</div>' : '<div class="mh">Files, pictures and tasks</div>'}${items.map((it, i) => `<button class="mi${i === 0 ? ' hl' : ''}" data-id="${esc(it.id)}">${I(it.icon)}<span>${esc(it.label)}</span><span class="sub">${esc(it.sub)}</span></button>`).join('')}</div>`;
        box.appendChild(pop);
        pop.onmousedown = (e) => { e.preventDefault(); const b = e.target.closest('.mi'); if (!b) return; insert(b.dataset.id); };
      };
      const insert = (id) => {
        if (id.startsWith('img:')) { ta.value = ta.value.replace(/@\S*$/, ''); S.picked.add(id.slice(4)); S.draft = ta.value; closePop(); MC.emit('picked'); return; }
        ta.value = ta.value.replace(/[/@]\S*$/, '') + id + ' '; S.draft = ta.value; closePop(); ta.focus();
      };
      /* the box grows with the text up to half the panel, then scrolls; Taller makes it that tall at once (like today's Talk page) */
      const fit = () => { const max = Math.max(120, Math.round(el.clientHeight * .5)); ta.style.height = 'auto'; const nat = ta.scrollHeight, h = vp.state.tall ? max : Math.min(nat, max); ta.style.height = h + 'px'; ta.style.overflowY = nat > h + 1 ? 'auto' : 'hidden'; };
      requestAnimationFrame(fit);
      ta.oninput = () => {
        fit();
        S.draft = ta.value;
        const m = ta.value.match(/(^|\s)([/@])(\S*)$/);
        if (m) showPop(m[2], m[3].toLowerCase()); else closePop();
      };
      ta.onkeydown = (e) => {
        if (pop && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); insert($('.mi.hl', pop).dataset.id); return; }
        if (pop && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); const all = $$('.mi', pop); let i = all.findIndex((x) => x.classList.contains('hl')); all[i].classList.remove('hl'); i = (i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length; all[i].classList.add('hl'); return; }
        if (e.key === 'Escape') closePop();
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      };
      const send = () => {
        const text = ta.value.trim(); if (!text && !S.picked.size) return;
        const msgs = convMsgs();
        msgs.push({ who: 'me', t: 'now', text: text + (S.picked.size ? `  [${S.picked.size} picture${S.picked.size > 1 ? 's' : ''}]` : '') });
        S.draft = ''; S.picked.clear(); vp.state.tall = false;
        const low = text.toLowerCase();
        let reply;
        if (low.startsWith('/task') || low.includes('task')) { const title = text.replace(/^\/task\s*/i, '').slice(0, 60) || 'Follow up'; MC.addTask(title, 'claude', 'high'); reply = { text: 'Done. I added it to the task list with high urgency, due Friday.', actions: [{ icon: 'check', text: 'Added task', ref: title, mod: 'tasks' }] }; }
        else if (low.startsWith('/remind') || low.includes('remind')) { S.reminders.unshift({ t: 'Today 18:00', text: text.replace(/^\/remind\s*/i, ''), by: 'claude', src: MC.sessionById(S.session).title }); MC.emit('reminders'); reply = { text: 'I set a reminder for 18:00 today. It shows on the phone too.', actions: [{ icon: 'bell', text: 'Reminder set', ref: 'Today 18:00', mod: 'reminders' }] }; }
        else if (low.startsWith('/browse') || low.includes('browser') || low.includes('open')) { reply = { text: 'I opened it in the built-in browser and took a screenshot for the gallery.', steps: [{ k: 'Browser', d: 'open localhost:1700', x: '0 console errors', ok: 1 }], actions: [{ icon: 'globe', text: 'Used the browser', ref: 'localhost:1700', mod: 'browser' }, { icon: 'image', text: 'Saved to gallery', ref: 'page.png', mod: 'gallery' }] }; MC.emit('open', 'browser'); }
        else if (low.startsWith('/side')) { msgs.pop(); vp.rerender(); MC.openSide(vp.body, msgs[msgs.length - 1]); return; }
        else if (low.startsWith('/layout')) { MC.emit('cols', 3); reply = { text: 'Switched to three viewports.' }; }
        else reply = { text: 'Got it. This is a mockup, so I only pretend to work. Try "/task", "/remind", "/browse" or "/side" to see Claude use Mission Control.' };
        vp.rerender();
        if (!reply) return;
        const tail = $('.tail', vp.body); if (tail) { tail.outerHTML = '<div class="thinking"><i></i><i></i><i></i> Claude is working</div>'; $('.convo-scroll', vp.body).scrollTop = 1e6; }
        setTimeout(() => { msgs.push({ who: 'claude', t: 'now', ...reply }); vp.rerender(); }, 900);
      };
      $('.send', el).onclick = send;
      el.onclick = (e) => {
        const o = e.target.closest('[data-open]'); if (o) { MC.emit('open', o.dataset.open); return; }
        const up = e.target.closest('[data-unpick]'); if (up) { S.picked.delete(up.dataset.unpick); vp.rerender(); return; }
        const un = e.target.closest('[data-undo]'); if (un) { const m = convMsgs()[+un.closest('.msg').dataset.m]; m.undone = true; vp.rerender(); MC.toast(`Undone: ${m.actions.length > 1 ? 'all ' + m.actions.length + ' things' : 'that'} Claude did in this message`, 'undo'); return; }
        const cm = e.target.closest('[data-cmd]'); if (cm) { const m = convMsgs()[+cm.closest('.msg').dataset.m]; if (cm.dataset.cmd === 'copy') MC.toast('Copied'); else { MC.emit('paste', m.cmd.line); MC.toast('Pasted in the console. Check it, then press Enter.', 'terminal'); } return; }
        const a = e.target.closest('[data-ask]'); if (a) { const m = convMsgs().find((x) => x.ask); if (a.dataset.ask === 'no') { MC.toast('Denied'); m.ask.answered = true; m.ask.body = 'denied'; } else m.ask.answered = true; vp.rerender(); return; }
        const h = e.target.closest('[data-h]');
        if (h) {
          const mi = +h.closest('.msg').dataset.m, m = convMsgs()[mi];
          if (h.dataset.h === 'side') MC.openSide(el, m);
          if (h.dataset.h === 'task') { MC.addTask((m.text || 'Follow up').slice(0, 54) + '…', 'me'); MC.toast('Task added from this message', 'tasks'); }
          if (h.dataset.h === 'remind') MC.menu(h, [{ h: 'Remind me' }, { id: 1, label: 'In 1 hour', icon: 'clock' }, { id: 2, label: 'Tonight 20:00', icon: 'clock' }, { id: 3, label: 'Tomorrow 9:00', icon: 'clock' }, { id: 4, label: 'Pick a date…', icon: 'cal' }], () => MC.toast('Reminder set', 'bell'));
          if (h.dataset.h === 'pin') MC.toast('Pinned to the top of the conversation', 'pin');
          if (h.dataset.h === 'copy') MC.toast('Copied');
          return;
        }
        const c = e.target.closest('[data-c]'); if (!c) return;
        const k = c.dataset.c;
        if (k === 'model') MC.menu(c, ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1'].map((x) => ({ id: x, label: x, on: x === S.model, icon: 'sparkle' })), (id) => { S.model = id; vp.rerender(); });
        if (k === 'effort') MC.menu(c, ['Low', 'Medium', 'High', 'Max'].map((x) => ({ id: x, label: x, on: x === S.effort, icon: 'bolt' })), (id) => { S.effort = id; vp.rerender(); });
        if (k === 'mode') MC.menu(c, ['Ask before edits', 'Edit automatically', 'Plan only', 'Bypass (danger)'].map((x) => ({ id: x, label: x, on: x === S.mode, icon: 'lock' })), (id) => { S.mode = id; vp.rerender(); });
        if (k === 'slash') { ta.value += (ta.value && !ta.value.endsWith(' ') ? ' ' : '') + '/'; ta.focus(); ta.oninput(); }
        if (k === 'at') { ta.value += (ta.value && !ta.value.endsWith(' ') ? ' ' : '') + '@'; ta.focus(); ta.oninput(); }
        if (k === 'tall') { vp.state.tall = !vp.state.tall; c.classList.toggle('on', vp.state.tall); c.innerHTML = I(vp.state.tall ? 'min' : 'max', 'sm'); c.title = vp.state.tall ? 'Shorter message box' : 'Taller message box'; fit(); ta.focus(); return; }
        if (k === 'ls' || k === 'lu') { vp.state[k] = !vp.state[k]; vp.rerender(); return; }
        if (k === 'spawn') MC.menu(c, [{ h: 'Start a nested session' }, { id: 'Sonnet 5.5 · medium', label: 'Narrow job', sub: 'Sonnet 5.5 · medium', icon: 'branch', on: true }, { id: 'Sonnet 5.5 · high', label: 'Narrow job, harder', sub: 'Sonnet 5.5 · high', icon: 'branch' }, { id: 'Opus 5.5 · medium', label: 'Bigger stakes', sub: 'Opus 5.5 · medium', icon: 'branch' }, { id: 'Opus 5.5 · high', label: 'Bigger stakes, harder', sub: 'Opus 5.5 · high', icon: 'branch' }, { sep: 1 }, { id: 'ask', label: 'Let Claude pick, like /delegate', icon: 'sparkle' }],
          (id) => MC.toast(id === 'ask' ? 'Claude picks the model from the size of the job, and says which' : `Nested session started on ${id}. It reports back here.`, 'branch'), { alignRight: true });
        if (k === 'end') MC.endMenu(c, s0());
        if (k === 'kids') MC.emit('open', 'sessions');
      };
    },
  };
  /* ending a conversation: what happens to it */
  MC.endMenu = (anchor, s, onDone) => {
    const sub = s && (s.kind === 'side' || s.kind === 'nested' || s.side);
    MC.menu(anchor, [{ h: sub ? 'End this ' + (s.kind === 'nested' ? 'nested session' : 'side chat') : 'End this conversation' },
      ...(sub ? [{ id: 'back', label: 'Send a summary to the main conversation', icon: 'arrowL' }] : []),
      { id: 'save', label: 'Save and close', sub: 'stays in the list', icon: 'check' }, { id: 'archive', label: 'Archive', sub: 'hidden, searchable', icon: 'box' },
      { id: 'handoff', label: 'Handoff to a new conversation', icon: 'ext' }, { sep: 1 }, { id: 'trash', label: 'Throw away', sub: 'Recycle Bin', icon: 'trash' }],
    (id) => { MC.toast({ back: 'Summary sent to the main conversation', save: 'Saved and closed', archive: 'Archived. Search still finds it.', handoff: 'Handoff written. A new conversation continues from it.', trash: 'Thrown away. It is in the Recycle Bin for 30 days.' }[id], id === 'trash' ? 'trash' : 'check'); onDone && onDone(id); }, { alignRight: true });
  };
  MC.openSide = (el, m) => {
    const old = $('.side', el); if (old) old.remove();
    const host = el.closest('.vp-body') || el;
    const sd = document.createElement('div'); sd.className = 'side';
    const thread = [{ who: 'me', t: 'now', text: 'Why that order?' }, { who: 'claude', t: 'now', text: 'Because the viewport engine is what every other piece sits in. This side chat does not touch the main conversation or its context.' }];
    const draw = () => {
      sd.innerHTML = `<div class="side-h">${I('side')}Side chat<span class="faint ellip" style="font-weight:400;min-width:0">does not change the main thread</span><span class="grow"></span><button class="ibtn sm" data-s="pop" title="Open in its own viewport">${I('ext', 'sm')}</button><button class="btn sm ghost" data-s="x">End${I('chev', 'sm')}</button></div>
        <div class="side-q">${esc((m && m.text) || 'The last answer').slice(0, 180)}</div>
        <div class="convo-scroll"><div class="convo-inner">${thread.map(msgHtml).join('')}</div></div>
        <div class="composer" style="padding:calc(10px*var(--k)) calc(15px*var(--k)) calc(15px*var(--k))"><div class="cbox"><textarea placeholder="Ask on the side" style="min-height:calc(50px*var(--k))"></textarea></div></div>`;
      const ta = $('textarea', sd);
      ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!ta.value.trim()) return; thread.push({ who: 'me', t: 'now', text: ta.value }); thread.push({ who: 'claude', t: 'now', text: 'Good question. (Mockup answer.) When you are done, "Bring back" copies a summary into the main thread.' }); draw(); $('.convo-scroll', sd).scrollTop = 1e6; } };
    };
    draw();
    sd.onclick = (e) => { const b = e.target.closest('[data-s]'); if (!b) return; if (b.dataset.s === 'x') MC.endMenu(b, { side: true }, () => sd.remove()); else { sd.remove(); MC.emit('open', 'convo'); MC.toast('Side chat opened in its own viewport', 'side'); } };
    host.appendChild(sd);
  };

  /* sessions */
  M.sessions = {
    label: 'Sessions', icon: 'branch', tabs: ['This project', 'All projects', 'Other PCs'],
    render: () => `<div style="padding:calc(10px*var(--k)) calc(10px*var(--k)) calc(18px*var(--k))"><div class="row" style="padding:calc(5px*var(--k)) calc(5px*var(--k)) calc(8px*var(--k))"><div class="input grow" style="height:calc(38px*var(--k))">${I('search', 'sm')}<input placeholder="Search conversations"></div><button class="btn sm primary">${I('plus', 'sm')}New</button></div><div class="tree" data-sesstree></div></div>`,
    mount: (el) => MC.renderSessionTree($('[data-sesstree]', el)),
  };

  /* needs you */
  M.inbox = {
    label: 'Needs you', icon: 'inbox',
    render: () => `<div class="list">${D.inbox.map((x, i) => `<div class="li" style="align-items:flex-start;border:1px solid var(--line);margin-bottom:calc(10px*var(--k));background:var(--bg-2)" data-ib="${i}">${I(x.kind === 'perm' ? 'lock' : 'chat')}
      <div class="grow"><div style="font-weight:600">${esc(x.what)}</div><div class="lm">${esc(x.proj)} · ${esc(x.sess)}</div>
      <div class="row" style="margin-top:calc(10px*var(--k))">${x.kind === 'perm' ? `<button class="btn sm primary" data-a="ok">${I('check', 'sm')}Approve</button><button class="btn sm ghost" data-a="no">Deny</button>` : '<button class="btn sm" data-a="ans">Answer</button>'}<button class="btn sm ghost" data-a="go">Open</button></div></div>${MC.st(x.kind === 'perm' ? 'wait' : 'idle', x.kind === 'perm' ? 'Permission' : 'Question')}</div>`).join('')}</div>`,
    mount: (el) => el.onclick = (e) => { const b = e.target.closest('[data-a]'); if (!b) return; if (b.dataset.a === 'go') { MC.emit('open', 'convo'); return; } b.closest('.li').remove(); MC.toast(b.dataset.a === 'ok' ? 'Approved' : b.dataset.a === 'no' ? 'Denied' : 'Answer sent'); },
  };

  /* tasks */
  const findT = (id) => S.tasks.find((x) => x.id === id) || D.otherTasks.find((x) => x.id === id);
  /* a project chip, shown when a list mixes projects (the Everything switch) */
  MC.pchip = (name) => { const p = MC.projectInfo(name); return `<span class="pchip"><span class="tint" style="background:${p.tint}">${esc(name[0])}</span>${esc(name)}</span>`; };
  let ALL = false;
  const LANES = [['todo', 'To do', 'idle'], ['doing', 'In progress', 'run'], ['review', 'Review', 'warn'], ['blocked', 'Blocked', 'fail'], ['done', 'Done', 'done']];
  const subsHtml = (t) => `<div class="subs">${t.subs.map((s, i) => `<div class="sub ${s[1] ? 'done' : ''}" data-sub="${t.id}:${i}"><span class="cbx">${s[1] ? I('check') : ''}</span>${esc(s[0])}</div>`).join('')}<div class="sub faint" data-addsub="${t.id}"><span class="cbx" style="border-style:dashed">${I('plus')}</span>Add a step</div></div>`;
  const cardHtml = (t) => `<div class="tcard" draggable="true" data-t="${t.id}">${ALL ? MC.pchip(t.proj || S.project) : ''}<div class="row" style="gap:calc(8px*var(--k))">${MC.urg(t.urg)}<span class="urg">${I('cal')}${esc(t.due)}</span><span class="grow"></span>${t.by === 'claude' ? `<span title="Added by Claude" class="avatar av-claude" style="width:calc(22px*var(--k));height:calc(22px*var(--k))">${I('sparkle', 'sm')}</span>` : ''}</div>
    <div class="tt">${esc(t.title)}</div>
    <div class="tp"><div class="bar ${MC.pct(t) === 100 ? 'ok' : ''}"><i style="width:${MC.pct(t)}%"></i></div>${MC.pct(t)}%</div>
    ${S.expanded.has(t.id) ? subsHtml(t) : `<div class="tm">${I('tasks', 'sm')}${t.subs.filter((s) => s[1]).length}/${t.subs.length} steps · ${t.tags.map(esc).join(', ')}</div>`}</div>`;
  M.tasks = {
    label: 'Tasks', icon: 'tasks', tabs: ['Board', 'List', 'Week'], scope: true,
    render: (vp) => {
      const tab = vp.tab || 'Board';
      ALL = vp.state.scope === 'all'; const TS = ALL ? TS.concat(D.otherTasks) : S.tasks;
      const open = TS.filter((t) => t.status !== 'done').length;
      let h = `<div class="tasks"><div class="tbar"><div class="input" style="width:calc(275px*var(--k));height:calc(38px*var(--k))">${I('search', 'sm')}<input placeholder="Filter tasks"></div>
        <button class="btn sm ghost">${I('flag', 'sm')}Urgency</button><button class="btn sm ghost">${I('sparkle', 'sm')}Added by Claude</button><button class="btn sm ghost">${I('cal', 'sm')}Due this week</button>
        <span class="grow"></span><span class="faint" style="font-size:calc(15px*var(--k))">${open} open · ${TS.filter((t) => t.status === 'done').length} done</span><button class="btn sm primary" data-newtask>${I('plus', 'sm')}New task</button></div>`;
      if (tab === 'Board') h += `<div class="board">${LANES.map(([k, l, s]) => { const ts = TS.filter((t) => t.status === k); return `<div class="lane" data-lane="${k}"><div class="lane-h">${MC.st(s, l)}<span class="faint">${ts.length}</span><button class="ibtn sm" data-addin="${k}">${I('plus', 'sm')}</button></div>${ts.map(cardHtml).join('')}</div>`; }).join('')}</div>`;
      else if (tab === 'List') h += `<div class="tlist"><div class="trow hd"><span></span><span>Task</span><span>Status</span><span>Urgency</span><span>Due</span><span>Progress</span><span></span></div>${TS.map((t) => { const L = LANES.find((x) => x[0] === t.status); return `<div class="trow" data-t="${t.id}"><span class="cbx" data-done="${t.id}" style="${t.status === 'done' ? 'background:var(--ok);border-color:var(--ok);color:var(--ok-ink)' : ''}">${t.status === 'done' ? I('check') : ''}</span><span class="${t.status === 'done' ? 'ttl-done' : ''}">${ALL ? MC.pchip(t.proj || S.project) + ' ' : ''}${esc(t.title)} ${t.by === 'claude' ? '<span class="faint" style="font-size:calc(14px*var(--k))">· by Claude</span>' : ''}</span><span>${MC.st(L[2], L[1])}</span><span>${MC.urg(t.urg)}</span><span class="muted">${esc(t.due)}</span><span class="row"><span class="bar grow ${MC.pct(t) === 100 ? 'ok' : ''}"><i style="width:${MC.pct(t)}%"></i></span><span class="faint" style="width:calc(40px*var(--k));text-align:right">${MC.pct(t)}%</span></span><button class="ibtn sm">${I('more', 'sm')}</button></div>`; }).join('')}</div>`;
      else { const days = [['Mon', 27], ['Tue', 28], ['Wed', 29], ['Thu', 30], ['Fri', 31], ['Sat', 1], ['Sun', 2]]; h += `<div class="week" style="padding:0">${days.map(([d, n]) => `<div class="day ${n === 28 ? 'today' : ''}" style="min-height:calc(225px*var(--k))">${d}<b>${n}</b>${TS.filter((t) => t.due.endsWith(' ' + n)).map((t) => `<i title="${esc(t.title)}">${esc(t.title)}</i>`).join('')}</div>`).join('')}</div>`; }
      return h + '</div>';
    },
    mount: (el, vp) => {
      el.onclick = (e) => {
        const sb = e.target.closest('[data-sub]'); if (sb) { const [id, i] = sb.dataset.sub.split(':'); const t = findT(id); t.subs[i][1] = !t.subs[i][1]; if (MC.pct(t) === 100 && t.status !== 'done') { t.status = 'done'; MC.toast(`"${t.title}" is done`, 'tick'); } MC.emit('tasks'); return; }
        const as = e.target.closest('[data-addsub]'); if (as) { const t = findT(as.dataset.addsub); t.subs.push(['New step', false]); MC.emit('tasks'); return; }
        const dn = e.target.closest('[data-done]'); if (dn) { const t = findT(dn.dataset.done); t.status = t.status === 'done' ? 'todo' : 'done'; MC.emit('tasks'); return; }
        if (e.target.closest('[data-newtask]')) { MC.addTask('New task', 'me'); return; }
        const ai = e.target.closest('[data-addin]'); if (ai) { const t = MC.addTask('New task', 'me'); t.status = ai.dataset.addin; MC.emit('tasks'); return; }
        const c = e.target.closest('.tcard'); if (c) { const id = c.dataset.t; S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id); MC.emit('tasks'); }
      };
      $$('.tcard', el).forEach((c) => { c.ondragstart = (e) => { e.dataTransfer.setData('text', c.dataset.t); c.classList.add('dragging'); }; c.ondragend = () => c.classList.remove('dragging'); });
      $$('.lane', el).forEach((l) => {
        l.ondragover = (e) => { e.preventDefault(); l.classList.add('drop'); };
        l.ondragleave = () => l.classList.remove('drop');
        l.ondrop = (e) => { e.preventDefault(); const t = findT(e.dataTransfer.getData('text')); if (t) { t.status = l.dataset.lane; MC.emit('tasks'); } };
      });
    },
  };

  /* reminders */
  M.reminders = {
    label: 'Reminders', icon: 'bell',
    render: () => { const days = [['Mon', 27], ['Tue', 28], ['Wed', 29], ['Thu', 30], ['Fri', 31], ['Sat', 1], ['Sun', 2]]; return `<div class="week">${days.map(([d, n]) => `<div class="day ${n === 28 ? 'today' : ''}">${d}<b>${n}</b>${n === 28 ? '<i>16:00 hub fix</i>' : n === 29 ? '<i>9:00 Electron?</i>' : n === 31 ? '<i>18:00 handoff</i>' : ''}</div>`).join('')}</div>
      <div class="list">${S.reminders.map((r) => `<div class="li">${I('bell')}<div class="grow"><div>${esc(r.text)}</div><div class="lm">${esc(r.t)}${r.src ? ' · from "' + esc(r.src) + '"' : ''}</div></div>${r.by === 'claude' ? '<span class="badge accent">by Claude</span>' : ''}<button class="btn sm ghost">Snooze</button></div>`).join('')}
      <div class="li faint">${I('plus')}Add a reminder. Or ask Claude: "remind me Friday to…"</div></div>`; },
  };

  /* Scratchpad: one free text box, kept in this browser. Its id stays "notes" so saved layouts keep it; the notes folders
     themselves are in the Documents panel (panels.js). */
  M.notes = {
    label: 'Scratchpad', icon: 'note',
    render: () => `<textarea class="notes" spellcheck="false" placeholder="Jot anything down. It stays in this browser, on this computer.">${esc(store.get('mcrev-notes') || '')}</textarea>`,
    mount: (el) => { const t = $('textarea', el); t.oninput = () => store.set('mcrev-notes', t.value); },
  };


  /* activity */
  M.activity = {
    label: 'Activity', icon: 'pulse', scope: true,
    render: (vp) => `<div class="feed">${(vp.state.scope === 'all' ? [['10:05', 'commit', 'BlitzRaw: commit 3f1a2c0, history panel list view', 'BlitzRaw'], ...D.activity.slice(0, 3), ['09:58', 'play', 'BlitzRaw: Build release started', 'BlitzRaw'], ['09:40', 'bell', 'BlitzVoice: Claude asks which voice to keep', 'BlitzVoice'], ...D.activity.slice(3)] : D.activity).map(([t, ic, tx, src]) => `<div class="fi"><span class="fic">${I(ic === 'commit' ? 'git' : ic, 'sm')}</span><div><div class="ft">${esc(tx)}</div><div class="fm">${t} · ${esc(src)}</div></div></div>`).join('')}</div>`,
  };

  /* docs */
  const docBody = (d) => d.name === 'SPEC.md' ? `<h1>Mission Control 2: spec</h1><p class="faint">design/revamp/SPEC.md · updated now</p><h2>Goal</h2><p>One project screen. Conversations, tasks, docs and the gallery sit side by side in viewports. Mission Control runs as a desktop app with a tray icon and starts its own server.</p><h2>Viewports</h2><ul><li>One, two or three viewports, up to four on an ultrawide.</li><li>Each has a menu to pick what it shows.</li><li>Layouts are saved per project.</li></ul><h2>Claude tools</h2><p>Claude gets <code>add_task</code>, <code>tick_task</code>, <code>set_reminder</code>, <code>gallery_search</code> and <code>browser_open</code> through an MCP server that Mission Control runs.</p>`
    : d.name === 'README.md' ? `<h1>Mission Control</h1><p><b>A dev dashboard for people who build with Claude Code.</b> Every project on your PC in one place: its build state, its changes, its conversations with Claude, its scripts, and the GPU memory your local AI models are using.</p><h2>What it does</h2><ul><li>Home: your projects, and what is running now</li><li>Project pages: status, launch buttons, docs, screenshots</li><li>Talk: chat with Claude Code about any project</li></ul>`
      : `<h1>${esc(d.name)}</h1><p class="faint">${esc(d.where)} · ${esc(d.when)}</p><p>This is a stand-in for the real file. The real viewer renders Markdown, PDFs and Obsidian notes, and links back to the conversations that changed them.</p><h2>Notes</h2><ul><li>Opened from ${esc(d.where)}</li><li>Read only. Ask Claude to change it.</li></ul>`;
  M.docs = {
    label: 'Documents', icon: 'doc', tabs: ['All', 'Repo', 'Obsidian', 'Attached'],
    render: (vp) => { const sel = vp.state.doc || 'SPEC.md'; const d = D.docs.find((x) => x.name === sel); return `<div class="docs"><div class="dlist">${D.docs.map((x) => `<div class="ditem ${x.name === sel ? 'on' : ''}" draggable="true" data-doc="${esc(x.name)}"><span class="k">${x.kind}</span><div class="grow"><div class="dn ellip">${esc(x.name)}</div><div class="dw">${esc(x.where)} · ${esc(x.when)}</div></div></div>`).join('')}</div><div class="dview">${docBody(d)}</div></div>`; },
    mount: (el, vp) => el.onclick = (e) => { const d = e.target.closest('[data-doc]'); if (d) { vp.state.doc = d.dataset.doc; vp.rerender(); } },
  };

  /* gallery */
  M.gallery = {
    label: 'Gallery', icon: 'image', tabs: ['All', 'Screenshots', 'References', 'Attached', 'Generated'],
    render: (vp) => {
      const k = { Screenshots: 'shot', References: 'ref', Attached: 'attach', Generated: 'gen' }[vp.tab];
      const list = S.gallery.filter((g) => !k || g.kind === k);
      const kl = { shot: 'Screenshot', ref: 'Reference', attach: 'Attached', gen: 'Generated' };
      return `<div class="gal"><div class="tbar"><div class="input" style="width:calc(300px*var(--k));height:calc(38px*var(--k))">${I('search', 'sm')}<input placeholder="Search pictures (Claude can too)"></div><span class="grow"></span>
        ${S.picked.size ? `<button class="btn sm primary" data-g="send">${I('chat', 'sm')}${S.picked.size} in the message box</button>` : '<span class="faint" style="font-size:calc(15px*var(--k))">Tick pictures to send them to Claude</span>'}<button class="btn sm">${I('camera', 'sm')}Screenshot</button></div>
        <div class="ggrid">${list.map((g) => `<div class="gi ${S.picked.has(g.src) ? 'picked' : ''}" draggable="true" data-src="${esc(g.src)}"><span class="gk">${kl[g.kind]}</span><span class="gsel" data-pick>${I('check', 'sm')}</span><img src="${g.src}" loading="lazy" alt=""><div class="gc"><span>${esc(g.title)}</span>${g.by === 'claude' ? `<span class="avatar av-claude" style="width:calc(20px*var(--k));height:calc(20px*var(--k))" title="Saved by Claude">${I('sparkle', 'sm')}</span>` : ''}<span class="faint">${esc(g.when.split(' ')[0])}</span></div></div>`).join('')}</div></div>`;
    },
    mount: (el, vp) => el.onclick = (e) => {
      if (e.target.closest('[data-g="send"]')) { MC.emit('open', 'convo'); return; }
      const gi = e.target.closest('.gi'); if (!gi) return;
      if (e.target.closest('[data-pick]')) { const s = gi.dataset.src; S.picked.has(s) ? S.picked.delete(s) : S.picked.add(s); MC.emit('picked'); return; }
      MC.lightbox(S.gallery.find((g) => g.src === gi.dataset.src));
    },
  };

  /* artifacts */
  const ARTS = [['Orbit proposal', '../proposals-v2/1-orbit.html', 'HTML · 3 w'], ['Redline proposal', '../proposals-v2/2-redline.html', 'HTML · 3 w'], ['Strata proposal', '../proposals-v2/3-strata.html', 'HTML · 3 w'], ['First mockups', '../../research/first-mockups/index.html', 'HTML · 2 mo']];
  M.artifacts = {
    label: 'Artifacts', icon: 'box',
    render: (vp) => { const sel = vp.state.art || 0; return `<div class="art"><div class="dlist">${ARTS.map((a, i) => `<div class="ditem ${i === sel ? 'on' : ''}" data-art="${i}"><span class="k">ART</span><div class="grow"><div class="dn ellip">${a[0]}</div><div class="dw">${a[2]}</div></div></div>`).join('')}<div class="ditem faint">${I('plus', 'sm')}Claude adds artifacts here</div></div><iframe src="${ARTS[sel][1]}" loading="lazy"></iframe></div>`; },
    mount: (el, vp) => el.onclick = (e) => { const a = e.target.closest('[data-art]'); if (a) { vp.state.art = +a.dataset.art; vp.rerender(); } },
  };

  /* overview */
  M.overview = {
    label: 'Overview', icon: 'layout',
    render: () => { const p = MC.projectInfo(); const open = S.tasks.filter((t) => t.status !== 'done');
      return `<div class="ov"><div class="row" style="gap:calc(15px*var(--k))"><span class="tint" style="width:calc(50px*var(--k));height:calc(50px*var(--k));font-size:calc(22px*var(--k));background:${p.tint}">${esc(p.name[0])}</span><div class="grow"><div class="h" style="font-size:calc(25px*var(--k))">${esc(p.name)}</div><div class="faint" style="font-size:calc(15px*var(--k))">${esc(p.root)}\\${esc(p.name)} · main · 1.9.4 · Node, no packages</div></div>
        <button class="btn sm">${I('folder', 'sm')}Folder</button><button class="btn sm">${I('ext', 'sm')}VS Code</button><button class="btn sm primary">${I('play', 'sm')}Run dev</button></div>
        <div class="tiles"><div class="tile"><div class="tl">Open tasks</div><div class="tv">${open.length}</div><div class="ts">${open.filter((t) => t.urg === 'crit' || t.urg === 'high').length} high or critical</div></div><div class="tile"><div class="tl">Running now</div><div class="tv">3</div><div class="ts">1 master, 2 nested</div></div><div class="tile"><div class="tl">Not committed</div><div class="tv">4</div><div class="ts">files, +593 −50</div></div><div class="tile"><div class="tl">This week</div><div class="tv">$96</div><div class="ts">at API prices</div></div></div>
        <div><div class="sect-h">Build chain<span class="grow"></span></div><div class="chain">${D.builds.map((b, i) => `<div class="link"><span class="ln">Step ${i + 1}</span><span class="lt">${b.step}</span>${MC.st(b.state, b.state === 'warn' ? 'Old' : null)}<span class="lx">${b.note}</span></div>`).join('')}</div></div>
        <div><div class="sect-h">Crew<span class="grow"></span></div><div class="crew">${D.crew.map((c) => `<div class="crewm"><span class="avatar av-claude">${I('sparkle', 'sm')}</span><b>${c.name}</b><span class="faint">${c.model}</span><span class="grow muted">${c.job}</span>${MC.st(c.state)}</div>`).join('')}</div></div></div>`; },
  };

  /* git */
  M.git = {
    label: 'Changes and commits', icon: 'git', tabs: ['Changes', 'History', 'Branches'],
    render: (vp) => {
      if (vp.tab === 'History') { const sel = vp.state.cm || D.commits[0][0]; return `<div class="git"><div>${D.commits.map((c) => `<div class="cm ${c[0] === sel ? 'on' : ''}" data-cm="${c[0]}"><span class="h">${c[0]}</span><span class="grow ellip">${esc(c[2])}</span><span class="d">${c[3]}</span><span class="w">${c[1]}</span></div>`).join('')}</div>
        <div class="sect-h">${sel}<span class="grow"></span></div><div class="diff"><div class="hh">@@ app/connections.html @@</div><div class="c">  &lt;div class="tabs"&gt;</div><div class="r">    &lt;button class="tab"&gt;Hub&lt;/button&gt;</div><div class="a">    ${'${hubTabs()}'}</div><div class="c">  &lt;/div&gt;</div></div></div>`; }
      if (vp.tab === 'Branches') return `<div class="list">${[['main', 'current · 2 not pushed'], ['revamp-viewports', '12 commits ahead'], ['hub-step-3', 'merged']].map((b) => `<div class="li">${I('branch')}<span class="grow">${b[0]}</span><span class="lm">${b[1]}</span></div>`).join('')}</div>`;
      return `<div class="git"><div class="row"><span class="st st-wait">${I('warn')}4 changed</span><span class="st st-idle">${I('send')}2 not pushed</span><span class="grow"></span><button class="btn sm" data-g="commit">${I('check', 'sm')}Commit</button><button class="btn sm ghost">${I('lock', 'sm')}Push, ask first</button></div>
        <div>${D.changes.map((c) => `<div class="cm"><span class="fl">${c[0]}</span><span class="grow mono">${c[1]}</span><span class="d">${c[2]}</span></div>`).join('')}</div>
        <div class="sect-h">app/viewports.js<span class="grow"></span></div><div class="diff"><div class="hh">@@ new file @@</div><div class="a">export function split(vp, dir) {</div><div class="a">  const col = vp.closest('.vcol');</div><div class="a">  if (cols().length >= maxCols()) return toast('No room');</div><div class="a">  insertAfter(col, newCol(vp.module));</div><div class="a">}</div></div></div>`;
    },
    mount: (el, vp) => el.onclick = (e) => { const c = e.target.closest('[data-cm]'); if (c) { vp.state.cm = c.dataset.cm; vp.rerender(); } if (e.target.closest('[data-g="commit"]')) MC.toast('Claude writes the message in your voice and commits locally', 'git'); },
  };

  /* scripts */
  M.scripts = {
    label: 'Scripts', icon: 'play',
    render: () => `<div class="list">${D.scripts.map((s, i) => `<div class="lrow" style="margin:0 0 calc(8px*var(--k))">${I('play')}<div class="grow"><div style="font-weight:600">${s.name}</div><div class="lm mono" style="font-size:calc(14px*var(--k));color:var(--text-3)">${s.cmd}</div></div><span class="faint" style="font-size:calc(14px*var(--k))">${s.last}</span>${MC.st(s.state, s.state === 'idle' ? 'Not run' : null)}<button class="btn sm" data-run="${i}">${s.state === 'run' ? I('stop', 'sm') + 'Stop' : I('play', 'sm') + 'Run'}</button></div>`).join('')}</div>`,
    mount: (el, vp) => el.onclick = (e) => { const b = e.target.closest('[data-run]'); if (!b) return; const s = D.scripts[+b.dataset.run]; if (s.state === 'run') { s.state = 'idle'; s.last = 'stopped now'; } else { s.state = 'run'; s.last = 'started now'; setTimeout(() => { if (s.state === 'run' && s.name !== 'Start server') { s.state = 'done'; s.last = 'finished now'; vp.rerender(); MC.toast(s.name + ' finished', 'tick'); } }, 2200); } D.consoleLines.push([new Date().toTimeString().slice(0, 8), 'info', 'script', s.name + ': ' + s.state]); vp.rerender(); MC.emit('console'); },
  };

  /* console */
  M.console = {
    label: 'Console', icon: 'terminal', tabs: ['Terminal', 'Server log', 'Dev server'],
    render: (vp) => vp.tab === 'Terminal' ? `<div class="cons"><div class="grow" style="overflow:auto">${(vp.state.term || ['PowerShell 7.5 · D:\\Dev\\MissionControl']).map((l) => `<div class="ln">${esc(l)}</div>`).join('')}</div>${vp.state.prefill ? `<div class="ln faint" style="margin-top:calc(8px*var(--k))">${I('sparkle', 'sm')} Pasted from Claude's message. Read it, then press Enter to run it.</div>` : ''}<div class="prompt"><span style="color:var(--hi)">PS&gt;</span><input placeholder="type a command (fake)" value="${esc(vp.state.prefill || '')}" class="${vp.state.prefill ? 'pasted' : ''}"></div></div>`
      : `<div class="cons"><div class="grow" style="overflow:auto">${D.consoleLines.map(([t, lv, src, tx]) => `<div class="ln"><span class="tm">${t}</span><span class="lv ${lv}">${lv.toUpperCase()}</span><span class="src">${src}</span><span>${esc(tx)}</span></div>`).join('')}</div><div class="prompt faint">${I('search', 'sm')}<input placeholder="Filter the log, or ask Claude about a line"></div></div>`,
    mount: (el, vp) => { const i = $('.prompt input', el); if (vp.tab === 'Terminal') { if (vp.state.prefill) setTimeout(() => i.focus(), 30); i.onkeydown = (e) => { if (e.key === 'Enter' && i.value) { vp.state.prefill = ''; vp.state.term = (vp.state.term || ['PowerShell 7.5 · D:\\Dev\\MissionControl']).concat('PS> ' + i.value, i.value === 'git status' ? 'On branch main. 4 files changed.' : '(mockup) ran ' + i.value); vp.rerender(); $('.prompt input', vp.body).focus(); } }; } },
  };
  MC.on('console', () => MC.emit('rerender', 'console'));

  /* browser */
  const TABS = [['Mission Control', 'localhost:1700', '../redline-soft/index.html'], ['Project page', 'localhost:1700/project', '../redline-soft/project.html'], ['Strata', 'localhost:5173', '../proposals-v2/3-strata.html']];
  M.browser = {
    label: 'Browser', icon: 'globe',
    render: (vp) => { const t = vp.state.btab || 0; return `<div class="brw"><div class="brw-tabs">${TABS.map((x, i) => `<div class="brw-tab ${i === t ? 'on' : ''}" data-bt="${i}">${I('globe', 'sm')}<span class="ellip">${x[0]}</span></div>`).join('')}<button class="ibtn sm">${I('plus', 'sm')}</button></div>
      <div class="brw-bar"><button class="ibtn sm">${I('arrowL', 'sm')}</button><button class="ibtn sm">${I('arrowR', 'sm')}</button><button class="ibtn sm">${I('refresh', 'sm')}</button><div class="brw-url">${I('lock', 'sm')}<span>http://<b>${TABS[t][1]}</b></span><span class="grow"></span><span class="faint">3440 × 1440</span></div>
      <button class="ibtn sm" title="Pick an element and send it to Claude" data-b="pick">${I('pointer', 'sm')}</button><button class="ibtn sm" title="Screenshot to the gallery" data-b="shot">${I('camera', 'sm')}</button><button class="ibtn sm" title="Console: 0 errors" data-b="cons">${I('terminal', 'sm')}</button><button class="btn sm ghost" title="Sites where you are logged in open in Brave, where Claude uses the Claude extension" data-b="brave">${I('shield', 'sm')}Open in Brave</button></div>
      ${t === 2 && !vp.state.okSite ? `<div class="brw-ask">${I('lock', 'sm')}<span class="grow">Claude wants to use <b>localhost:5173</b>. Other sites than Mission Control: you say yes once, for this session.</span><button class="btn sm primary" data-b="ok">Yes, this session</button><button class="btn sm ghost" data-b="no">No</button></div>` : ''}
      <div class="brw-frame"><iframe src="${TABS[t][2]}"></iframe>${vp.state.drive !== false ? `<div class="drive"><span class="dot pulse"></span>Claude is using this tab <button class="btn sm ghost" style="height:calc(28px*var(--k));color:#fff" data-b="take">Take over</button></div>` : ''}</div></div>`; },
    mount: (el, vp) => el.onclick = (e) => { const t = e.target.closest('[data-bt]'); if (t) { vp.state.btab = +t.dataset.bt; vp.rerender(); return; } const b = e.target.closest('[data-b]'); if (!b) return;
      if (b.dataset.b === 'shot') { S.gallery.unshift({ src: '../redline-soft/shots/1-home.png', title: 'Browser screenshot', kind: 'shot', when: 'now', by: 'me' }); MC.emit('gallery'); MC.toast('Saved to the gallery', 'camera'); }
      if (b.dataset.b === 'pick') MC.toast('Click an element: it goes to the message box with its HTML and a screenshot', 'pointer');
      if (b.dataset.b === 'cons') MC.emit('open', 'console');
      if (b.dataset.b === 'brave') MC.toast('Opened in Brave with your logins. Claude drives it with the Claude extension.', 'shield');
      if (b.dataset.b === 'ok' || b.dataset.b === 'no') { vp.state.okSite = true; vp.rerender(); MC.toast(b.dataset.b === 'ok' ? 'Claude may use other sites until this session ends' : 'Claude stays on localhost', 'lock'); }
      if (b.dataset.b === 'take') { vp.state.drive = false; vp.rerender(); MC.toast('You have the tab. Claude waits.'); } },
  };

  /* skills */
  M.skills = {
    label: 'Skills', icon: 'zap',
    render: () => `<div class="list">${D.skills.map(([n, d]) => `<div class="li">${I('zap')}<div class="grow"><div class="mono" style="font-size:calc(16px*var(--k))">/${n}</div><div class="lm">${d}</div></div><button class="btn sm" data-sk="${n}">Run</button></div>`).join('')}</div>`,
    mount: (el) => el.onclick = (e) => { const b = e.target.closest('[data-sk]'); if (b) { S.draft = '/' + b.dataset.sk + ' '; MC.emit('open', 'convo'); MC.emit('rerender', 'convo'); } },
  };

  /* usage: single-series bar chart, one hue, hover tooltip */
  const barChart = (vals) => {
    const W = 600, H = 160, pad = 22, n = vals.length, bw = (W - pad) / n, max = 100;
    const bars = vals.map((v, i) => { const h = (v / max) * (H - 24); const x = pad + i * bw + 1; const y = H - 16 - h; return `<path d="M${x},${H - 16}V${y + 4}q0,-4 4,-4h${bw - 10}q4,0 4,4V${H - 16}z" fill="var(--hi)" opacity="${i === n - 1 ? .95 : .55}"/><rect x="${x - 1}" y="0" width="${bw}" height="${H - 16}" fill="transparent" data-v="${v}" data-d="${i + 1}"/>`; }).join('');
    const grid = [0, 50, 100].map((g) => { const y = H - 16 - (g / max) * (H - 24); return `<line x1="${pad}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="0" y="${y + 4}" font-size="10" fill="var(--text-3)">$${g}</text>`; }).join('');
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${bars}<text x="${pad}" y="${H - 2}" font-size="10" fill="var(--text-3)">Sep 29</text><text x="${W - 34}" y="${H - 2}" font-size="10" fill="var(--text-3)">Today</text></svg><div class="tip"></div></div>`;
  };
  /* usage: plan usage first, then context and cache, what fills the context, and cost at API prices; each one shows or hides */
  S.expAct = 'Compact';
  const planHtml = () => D.usage.plan.map(([l, p, r]) => `<div class="meter"><div class="row"><b>${l}</b><span>${p}% · ${r}</span></div><div class="bar ${p > 80 ? 'warn' : ''}"><i style="width:${p}%"></i></div></div>`).join('');
  const ctxUsed = () => D.context.filter((c) => !/Free|buffer/.test(c[0])).reduce((a, c) => a + c[1], 0);
  const cacheHtml = () => `<div class="kc"><span class="cache-r">${ring(S.cacheLeft / 300)}</span><div class="grow"><div><b>Cache warm</b>, <span class="cache-t mono">${cacheTxt()}</span> left</div><div class="faint" style="font-size:calc(14px*var(--k))">A message sent now reuses the cache</div></div></div>
    <div class="kc"><span class="muted grow">At 5 min left</span><button class="pillsel" data-u="exp">${I('zap', 'sm')}${S.expAct}${I('chev', 'sm')}</button></div>
    <div class="meter"><div class="row"><b>Context</b><span>${ctxUsed().toFixed(1)}k of 200k · ${S.ctx}%</span><button class="btn sm ghost" data-u="compact" style="margin-left:calc(8px*var(--k));height:calc(28px*var(--k))">Compact</button></div><div class="bar"><i style="width:${S.ctx}%"></i></div></div>`;
  const ctxDetail = () => `<div class="ctxd">${D.context.map(([n, k]) => `<div class="cd ${/Free|buffer/.test(n) ? 'free' : ''}"><span class="ellip">${n}</span><span class="bar"><i style="width:${Math.max(.6, k / 200 * 100)}%"></i></span><span class="mono">${k}k</span><span class="faint mono">${(k / 2).toFixed(1)}%</span></div>`).join('')}</div>`;
  MC.usageMini = () => `<div class="umini"><div class="sect-h">Plan<span class="grow"></span></div>${planHtml()}<div class="sect-h" style="margin-top:calc(6px*var(--k))">This conversation<span class="grow"></span></div>${cacheHtml()}</div>`;
  const expMenu = (b) => MC.menu(b, [{ h: 'At 5 min of cache left' }, ...[['Compact', 'sums up, cache still warm'], ['Handoff', 'for a new conversation'], ['Nothing', 'the cache runs out']].map(([id, sub]) => ({ id, label: id, sub, icon: 'zap', on: S.expAct === id }))], (id) => { S.expAct = id; MC.emit('rerender', 'usage'); MC.emit('rerender', 'convo'); });
  M.usage = {
    label: 'Usage', icon: 'chart', scope: true,
    render: (vp) => {
      const o = vp.state.u || (vp.state.u = { plan: 1, cache: 1, ctxd: 0, api: 0 });
      const all = vp.state.scope === 'all';
      const chip = (k, l) => `<button class="chip ${o[k] ? 'on' : ''}" data-u="${k}">${I(o[k] ? 'check' : 'plus', 'sm')}${l}</button>`;
      const tiles = all ? D.usage.tiles : [['Cost at API prices', '$247', 'this month'], ['Tokens', '10.9 M', 'this month'], ['Conversations', '23', 'this month'], ['Cache hits', '93%', 'of input']];
      return `<div class="use"><div class="row" style="flex-wrap:wrap;gap:calc(8px*var(--k))">${chip('plan', 'Plan usage')}${chip('cache', 'Context and cache')}${chip('ctxd', 'What fills the context')}${chip('api', 'Cost at API prices')}</div>
        ${o.plan ? `<section><div class="sect-h">Plan usage<span class="grow"></span><span class="note">your whole account</span></div><div class="meters">${planHtml()}</div><div class="faint row" style="font-size:calc(14px*var(--k));margin-top:calc(12px*var(--k));gap:calc(8px*var(--k))">${I('clock', 'sm')}At this pace the session limit comes at 12:40, 20 min before it resets.</div></section>` : ''}
        ${o.cache ? `<section><div class="sect-h">Context and cache<span class="grow"></span><span class="note">${esc(MC.sessionById(S.session).title)}</span></div><div class="meters">${cacheHtml()}</div></section>` : ''}
        ${o.ctxd ? `<section><div class="sect-h">What fills the context<span class="grow"></span><span class="note">like /context</span></div>${ctxDetail()}</section>` : ''}
        ${o.api ? `<section><div class="sect-h">Cost at API prices<span class="grow"></span><span class="note">${all ? 'every project' : esc(S.project)}</span></div><div class="tiles">${tiles.map(([l, v, s]) => `<div class="tile"><div class="tl">${l}</div><div class="tv">${v}</div><div class="ts">${s}</div></div>`).join('')}</div><div style="margin-top:calc(14px*var(--k))">${barChart(all ? D.usage.days : D.usage.days.map((d) => Math.round(d * .6)))}</div></section>` : ''}
        ${!o.plan && !o.cache && !o.ctxd && !o.api ? '<div class="empty">Turn on a section above.</div>' : ''}</div>`;
    },
    mount: (el, vp) => {
      el.onclick = (e) => { const b = e.target.closest('[data-u]'); if (!b) return; const k = b.dataset.u;
        if (k === 'exp') expMenu(b); else if (k === 'compact') MC.toast('Compact sent. The context drops to about 12%.', 'zap'); else { vp.state.u[k] = !vp.state.u[k]; vp.rerender(); } };
      const ch = $('.chart', el); if (!ch) return; const tip = $('.tip', ch); ch.onmousemove = (e) => { const r = e.target.closest('rect[data-v]'); if (!r) { tip.style.display = 'none'; return; } const b = ch.getBoundingClientRect(); tip.style.display = 'block'; tip.style.left = e.clientX - b.left + 'px'; tip.style.top = e.clientY - b.top + 'px'; tip.innerHTML = `Day ${r.dataset.d}: <b>$${r.dataset.v}</b>`; }; ch.onmouseleave = () => (tip.style.display = 'none'); },
  };
  /* the small usage panel inside a conversation */

  /* timeline: what you worked on and for how long, per project (Everything) or per conversation (This project) */
  const hh = (h) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  const dur = (h) => { const m = Math.round(h * 60); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' m' : ''}` : m + ' m'; };
  const spanSum = (sp) => sp.reduce((a, [x, y]) => a + y - x, 0);
  M.timeline = {
    label: 'Timeline', icon: 'gantt', tabs: ['Day', 'Week'], scope: true,
    render: (vp) => {
      const T = D.timeline, all = vp.state.scope === 'all';
      const weekOf = (n) => T.week.reduce((a, [, ps]) => a + ps.filter((p) => !n || p[0] === n).reduce((x, p) => x + p[1], 0), 0);
      const mine = T.projects.find((p) => p[0] === S.project);
      const today = all ? T.projects.reduce((a, p) => a + spanSum(p[2]), 0) : spanSum(mine ? mine[2] : []);
      const top = `<div class="tiles"><div class="tile"><div class="tl">Today</div><div class="tv">${dur(today)}</div><div class="ts">${all ? 'every project' : esc(S.project)}</div></div><div class="tile"><div class="tl">This week</div><div class="tv">${dur(weekOf(all ? null : S.project))}</div><div class="ts">Mon 23 to Sun 29</div></div><div class="tile"><div class="tl">Longest stretch</div><div class="tv">1 h 27 m</div><div class="ts">today, 8:42 to 10:09</div></div><div class="tile"><div class="tl">${all ? 'Most time' : 'Conversations'}</div><div class="tv">${all ? 'MissionControl' : T.sessions.length}</div><div class="ts">${all ? '62% of the week' : 'touched today'}</div></div></div>`;
      if (vp.tab === 'Week') {
        const max = 9.5;
        const rows = T.week.map(([d, parts]) => { const ps = all ? parts : parts.filter((p) => p[0] === S.project); const sh = ps.reduce((a, p) => a + p[1], 0);
          return `<div class="wk"><span class="wd">${d}</span><span class="wbar">${ps.map(([n, h]) => `<i style="width:${h / max * 100}%;background:${MC.projectInfo(n).tint}" title="${n}: ${dur(h)}"></i>`).join('')}</span><span class="wt">${sh ? dur(sh) : 'none'}</span></div>`; }).join('');
        const names = [...new Set(T.week.flatMap(([, ps]) => ps.map((p) => p[0])))].filter((n) => all || n === S.project);
        return `<div class="tlm">${top}<div class="wks">${rows}</div><div class="legend">${names.map((n) => `<span>${MC.pchip(n)}<b>${dur(weekOf(n))}</b></span>`).join('')}</div></div>`;
      }
      const pos = (h) => h / 24 * 100;
      const lanes = all ? T.projects.map(([n, c, sp]) => ({ lab: MC.pchip(n), col: c, sp, tot: dur(spanSum(sp)) }))
        : T.sessions.map(([n, st, sp]) => ({ lab: `${I(st === 'run' ? 'loader' : 'tick', 'sm')}<span class="ellip">${esc(n)}</span>`, col: st === 'run' ? 'var(--run)' : 'var(--ok)', sp, tot: dur(spanSum(sp)) + (st === 'run' ? ', running' : '') }));
      const ticks = Array.from({ length: 6 }, (_, i) => `<span style="left:${pos(i * 4)}%">${i * 4}:00</span>`).join('');
      return `<div class="tlm">${top}<div class="tlg"><div class="tlr hd"><div class="lab faint">${all ? 'Project' : 'Conversation'}</div><div class="trk ticks">${ticks}</div><div class="tot faint">Time</div></div>
        ${lanes.map((l) => `<div class="tlr"><div class="lab">${l.lab}</div><div class="trk">${l.sp.map(([a, b]) => `<span class="sp" style="left:${pos(a)}%;width:${pos(b) - pos(a)}%;background:${l.col}" title="${hh(a)} to ${hh(b)}"></span>`).join('')}<span class="nowl" style="left:${pos(T.now)}%"></span></div><div class="tot">${l.tot}</div></div>`).join('')}
        <div class="tlr"><div class="lab faint">${I('pulse', 'sm')}Events</div><div class="trk">${T.events.map(([h, ic, l]) => `<span class="ev" style="left:${pos(h)}%" title="${hh(h)} ${esc(l)}" data-l="${esc(l)}">${I(ic)}</span>`).join('')}<span class="nowl" style="left:${pos(T.now)}%"><b>NOW</b></span></div><div class="tot"></div></div></div>
        <div class="faint" style="font-size:calc(14px*var(--k));padding:calc(4px*var(--k)) 2px">Time counts while a conversation runs or you type in it. Click a mark to jump there.</div></div>`;
    },
    mount: (el) => el.onclick = (e) => { const ev = e.target.closest('.ev'); if (!ev) return; const l = ev.dataset.l; MC.toast(l, 'clock'); MC.emit('open', /task/.test(l) ? 'tasks' : /Commit/.test(l) ? 'git' : /Screenshot/.test(l) ? 'gallery' : /Asks/.test(l) ? 'convo' : 'activity'); },
  };

  /* projects: a star system or cards; work mode always shows cards */
  const allProjects = () => { const out = []; const walk = (it, root) => it.forEach((p) => p.items ? walk(p.items, root) : out.push({ ...p, root })); D.roots.filter((r) => !(S.work && r.path.includes('Games'))).forEach((r) => walk(r.items, r.path)); return out; };
  const LAST = { MissionControl: 'now', BlitzRaw: '2 m', BlitzVoice: '14 m', PhotoSync: '3 d', SpaceRacer: 'yesterday', Website: '6 d', WakeTrainer: '2 w', TimeTracker: '1 w' };
  M.projects = {
    label: 'Projects', icon: 'orbit', views: [['solar', 'orbit', 'Star system'], ['cards', 'grid', 'Cards']], workView: 'cards',
    render: (vp) => {
      const ps = allProjects();
      if ((vp.state.view || 'solar') === 'cards') return `<div class="pcards">${ps.map((p) => `<div class="pcard ${p.name === S.project ? 'on' : ''}" data-proj="${esc(p.name)}"><div class="row"><span class="tint" style="background:${p.tint}">${esc(p.name[0])}</span><div class="grow"><div class="pn ellip">${esc(p.name)}</div><div class="faint ellip" style="font-size:calc(14px*var(--k))">${esc(p.root)}</div></div>${p.fav ? I('star', 'sm') : ''}</div>
        <div class="row" style="gap:calc(8px*var(--k));flex-wrap:wrap">${p.running ? MC.st('run', p.running + ' running') : MC.st('idle', 'Idle')}${p.due ? `<span class="badge">${I('tasks', 'sm')}${p.due} due</span>` : ''}<span class="grow"></span><span class="faint" style="font-size:calc(14px*var(--k))">${LAST[p.name] || '1 mo'}</span></div></div>`).join('')}</div>`;
      const top = ps.filter((p) => p.root.includes('Dev')).slice(0, 8).concat(ps.filter((p) => p.name === 'SpaceRacer'));
      return `<div class="solar"><svg viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid meet"><defs><radialGradient id="sun${vp.id}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff"/><stop offset=".25" style="stop-color:var(--accent)"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></radialGradient>
        <radialGradient id="pl${vp.id}" cx="38%" cy="35%" r="70%"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.55"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:.06"/></radialGradient></defs>
        ${top.map((p, i) => `<ellipse class="orb" cx="500" cy="285" rx="${110 + i * 46}" ry="${(110 + i * 46) * .36}"/>`).join('')}
        <circle cx="500" cy="285" r="58" fill="url(#sun${vp.id})" opacity=".9"/><circle cx="500" cy="285" r="20" style="fill:var(--accent)"/>
        ${top.map((p, i) => { const r = 9 + (p.running ? 6 : 0) + (p.due ? 3 : 0); return `<g class="planet ${p.name === S.project ? 'on' : ''}" data-proj="${esc(p.name)}" data-i="${i}"><circle r="${r}" fill="url(#pl${vp.id})"/><ellipse rx="${r}" ry="${r * .38}"/><ellipse rx="${r * .45}" ry="${r}"/><circle r="${r}"/>${p.running ? `<circle class="ring2" r="${r + 6}"/>` : ''}<text x="${r + 9}" y="5">${esc(p.name)}${p.running ? ' · ' + p.running + ' running' : ''}</text></g>`; }).join('')}
        </svg></div>`;
    },
    mount: (el) => {
      el.onclick = (e) => { const p = e.target.closest('[data-proj]'); if (p) MC.setProject(p.dataset.proj); };
      const svg = $('svg', el); if (!svg) return;
      const gs = $$('.planet', svg); const t0 = performance.now(); const A0 = [3.6, .5, 2.2, 5.0, 1.3, 4.1, 2.9, .2, 5.6];
      const place = (now) => gs.forEach((g) => { const i = +g.dataset.i, rx = 110 + i * 46, a = A0[i % 9] + (now - t0) / 1000 * (.05 / (1 + i * .45)); g.setAttribute('transform', `translate(${(500 + Math.cos(a) * rx).toFixed(1)},${(285 + Math.sin(a) * rx * .36).toFixed(1)})`); });
      place(performance.now());
      /* a hidden tab skips the drawing, and work mode stops the motion */
      const tick = (now) => { if (!svg.isConnected) return; if (svg.getClientRects().length && !S.work) place(now); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    },
  };

  /* running: the crew ship, or the list of every Claude that runs now */
  M.running = {
    label: 'Running', icon: 'rocket', views: [['ship', 'rocket', 'Crew ship'], ['list', 'list', 'Agents list']], workView: 'list', scope: true,
    render: (vp) => {
      const ag = D.agents.filter((a) => vp.state.scope === 'all' || a.proj === S.project);
      const work = ag.filter((a) => a.state === 'run').length;
      if ((vp.state.view || 'ship') === 'ship') return `<div class="ship"><img src="../redline-soft/shots/7-crew.png" alt=""><div class="ship-c">${I('rocket', 'sm')}<b>${ag.length} aboard</b>, ${work} working</div><div class="ship-n">Stand-in picture. The real app keeps today's live 3D ship here.</div></div>`;
      return `<div class="list">${ag.map((a) => `<div class="agent"><span class="avatar av-claude">${I('sparkle', 'sm')}</span><div class="grow"><div class="row" style="gap:calc(8px*var(--k))"><b>${esc(a.name)}</b>${vp.state.scope === 'all' ? MC.pchip(a.proj) : ''}<span class="faint" style="font-size:calc(14px*var(--k))">${esc(a.model)}</span></div><div class="faint ellip" style="font-size:calc(15px*var(--k))">${esc(a.job)} · ${a.for}</div></div>${MC.st(a.state)}<button class="btn sm ghost" data-ag="open">Open</button><button class="ibtn sm" title="Stop" data-ag="stop">${I('stop', 'sm')}</button></div>`).join('') || '<div class="empty">Nothing runs in this project now.</div>'}</div>`;
    },
    mount: (el) => el.onclick = (e) => { const b = e.target.closest('[data-ag]'); if (!b) return; if (b.dataset.ag === 'open') MC.emit('open', 'convo'); else MC.toast('Stopped. Its work so far is saved.', 'stop'); },
  };

  /* Com Link: the voice assistant, with a face: HAL's eye, Clawd, or plain (work mode) */
  const halFace = (id) => `<svg viewBox="0 0 200 200" class="face hal"><defs><radialGradient id="eye${id}" cx="44%" cy="40%" r="62%"><stop offset="0" stop-color="#fff8ec"/><stop offset=".16" style="stop-color:var(--accent)"/><stop offset=".72" style="stop-color:var(--accent);stop-opacity:.45"/><stop offset="1" stop-color="#050505"/></radialGradient></defs>
    ${Array.from({ length: 72 }, (_, i) => { const a = i * 5 * Math.PI / 180, r1 = i % 6 ? 93 : 89; return `<line x1="${(100 + Math.cos(a) * r1).toFixed(1)}" y1="${(100 + Math.sin(a) * r1).toFixed(1)}" x2="${(100 + Math.cos(a) * 97).toFixed(1)}" y2="${(100 + Math.sin(a) * 97).toFixed(1)}" class="tk"/>`; }).join('')}
    <g class="arc">${Array.from({ length: 30 }, (_, i) => { const a0 = (i * 12 - 90) * Math.PI / 180, a1 = (i * 12 - 82) * Math.PI / 180; return `<path d="M${(100 + Math.cos(a0) * 78).toFixed(1)} ${(100 + Math.sin(a0) * 78).toFixed(1)}A78 78 0 0 1 ${(100 + Math.cos(a1) * 78).toFixed(1)} ${(100 + Math.sin(a1) * 78).toFixed(1)}" style="opacity:${i < 19 ? (1 - i * .04).toFixed(2) : .14}"/>`; }).join('')}</g>
    <circle cx="100" cy="100" r="60" fill="#070707"/><circle cx="100" cy="100" r="55" fill="url(#eye${id})" class="eye"/><ellipse cx="84" cy="80" rx="15" ry="8" fill="#fff" opacity=".18" transform="rotate(-30 84 80)"/></svg>`;
  const CLAWD = ['..XXXXXXX..', '..X.XXX.X..', 'XXXXXXXXXXX', 'XXXXXXXXXXX', '..XXXXXXX..', '..X.X.X.X..'];
  const clawdFace = () => `<svg viewBox="0 0 176 120" class="face clawd">${CLAWD.map((row, y) => [...row].map((c, x) => c === 'X' ? `<rect x="${x * 16}" y="${y * 16 + 12}" width="16.5" height="16.5"/>` : '').join('')).join('')}</svg>`;
  const plainFace = () => `<div class="face plain">${I('mic', 'lg')}<span class="wave">${'<i></i>'.repeat(5)}</span></div>`;
  M.comlink = {
    label: 'Com Link', icon: 'hal', views: [['hal', 'hal', 'HAL eye'], ['clawd', 'sparkle', 'Clawd'], ['plain', 'mic', 'Plain']], workView: 'plain',
    render: (vp) => {
      const v = vp.state.view || 'hal', st = vp.state.cl || 'idle';
      const lab = { idle: 'Standing by', listen: 'Listening', talk: 'Claude is talking' }[st];
      const log = vp.state.log || [['Com Link', 'Morning. BlitzRaw finished its build, and one question waits for you in MissionControl.']];
      return `<div class="cl st-${st}"><div class="cl-face">${v === 'hal' ? halFace(vp.id) : v === 'clawd' ? clawdFace() : plainFace()}</div><div class="cl-state h">${lab}</div>
        <div class="cl-log">${log.slice(-3).map(([w, t]) => `<div><b>${esc(w)}</b> ${esc(t)}</div>`).join('')}</div>
        <div class="cl-run"><div class="sect-h">Running now<span class="grow"></span></div>${D.agents.filter((a) => a.state === 'run').slice(0, 3).map((a) => `<div class="row" style="font-size:calc(15px*var(--k));gap:calc(8px*var(--k))"><span class="dot run pulse"></span><span class="ellip grow">${esc(a.proj)}: ${esc(a.job)}</span><span class="faint">${a.for}</span></div>`).join('')}</div>
        <div class="cl-in input"><input placeholder="New task, any project. Or just talk."><button class="cl-mic" title="Talk (or say the wake word)">${I('mic')}</button></div></div>`;
    },
    mount: (el, vp) => {
      const say = (you) => { vp.state.log = (vp.state.log || []).concat([['You', you]]); vp.state.cl = 'listen'; vp.rerender();
        setTimeout(() => { vp.state.cl = 'talk'; vp.state.log.push(['Com Link', /task/i.test(you) ? 'Added it to MissionControl, high urgency, due Friday.' : 'Two things run now: the BlitzRaw build, almost done, and the revamp mockup.']); vp.rerender(); if (/task/i.test(you)) MC.addTask(you.replace(/^.*task:?\s*/i, '').slice(0, 50) || 'New task', 'claude', 'high'); }, 1300);
        setTimeout(() => { vp.state.cl = 'idle'; vp.rerender(); }, 5200); };
      $('.cl-mic', el).onclick = () => say('What runs right now?');
      const i = $('.cl-in input', el); i.onkeydown = (e) => { if (e.key === 'Enter' && i.value.trim()) say(i.value.trim()); };
    },
  };

  /* morning brief: the mission board from mockup C, as a module */
  M.brief = {
    label: 'Morning brief', icon: 'sun',
    render: () => { const due = S.tasks.concat(D.otherTasks).filter((t) => /Oct (28|29|30)/.test(t.due) && t.status !== 'done');
      return `<div class="brief"><div class="kpis"><div class="kpi warn"><span>Needs you</span><b>${D.inbox.length}</b><i>${I('clock', 'sm')}2 permissions, 1 question</i></div><div class="kpi run"><span>Running</span><b>${D.agents.length}</b><i>${I('loader', 'sm')}3 working, 2 waiting</i></div><div class="kpi ok"><span>Done overnight</span><b>4</b><i>${I('tick', 'sm')}2 builds, 2 tasks</i></div><div class="kpi"><span>Session</span><b>62%</b><i>${I('clock', 'sm')}resets 13:00</i></div></div>
        <div class="bfx"><span class="avatar av-claude">${I('sparkle', 'sm')}</span><div><div class="faint" style="font-size:calc(14px*var(--k))">Claude, 07:30</div><p>Overnight the BlitzRaw build passed and the Shrink test finished. The hub pairing test still fails on the clock skew, and Release 1.4.3 waits for its notes. Two answers needed from you, both in MissionControl.</p></div></div>
        <div class="sect-h">Due soon<span class="grow"></span></div>${due.map((t) => `<div class="li" style="padding:calc(8px*var(--k)) calc(6px*var(--k))"><span class="cbx"></span><span class="grow">${esc(t.title)}</span>${MC.pchip(t.proj || 'MissionControl')}${MC.urg(t.urg)}<span class="faint" style="font-size:calc(14px*var(--k));width:calc(56px*var(--k));text-align:right">${esc(t.due)}</span></div>`).join('')}</div>`; },
  };
  M.system = {
    label: 'GPU and RAM', icon: 'cpu',
    render: () => { const tot = 24, used = D.gpu.reduce((a, g) => a + g[1], 0); return `<div class="use"><div class="tiles"><div class="tile"><div class="tl">VRAM used</div><div class="tv">${used.toFixed(1)} GB</div><div class="ts">of ${tot} GB · RTX 4090</div></div><div class="tile"><div class="tl">RAM used</div><div class="tv">41 GB</div><div class="ts">of 64 GB</div></div><div class="tile"><div class="tl">GPU</div><div class="tv">63 °C</div><div class="ts">71% load</div></div></div>
      <div><div class="sect-h">VRAM by process<span class="grow"></span></div><div style="display:flex;flex-direction:column;gap:calc(12px*var(--k))">${D.gpu.map(([n, v]) => `<div class="meter"><div class="row"><b>${n}</b><span>${v} GB</span>${v > 1 ? '<button class="btn sm ghost" style="margin-left:calc(10px*var(--k));height:calc(28px*var(--k))">Unload</button>' : ''}</div><div class="bar"><i style="width:${(v / tot) * 100}%"></i></div></div>`).join('')}</div></div></div>`; },
  };

  /* settings */
  M.settings = {
    label: 'Project settings', icon: 'gear', tabs: ['General', 'Claude', 'Viewports', 'Phone'],
    render: (vp) => { const rows = {
      General: [['Display name', 'MissionControl', 'text'], ['Tint color', 'Used for the project icon and its accents', 'tint'], ['Notes folders', 'Obsidian: Mission Control, research/notes', 'text'], ['Screenshot folder', 'D:\\Dev\\Temp\\scratch\\mc-shots', 'text'], ['Show on the Work PC', 'Hide this project when work mode is on', 'tog']],
      Claude: [['Default model', 'Opus 5.5', 'text'], ['Permission mode', 'Ask before edits', 'text'], ['Let Claude add and tick tasks', 'Through the Mission Control tools', 'togon'], ['Let Claude set reminders', 'They show on the phone too', 'togon'], ['Let Claude use the browser', 'Only on localhost unless you say yes', 'togon'], ['Auto handoff at 5 min of cache left', '', 'togon']],
      Viewports: [['Default layout', 'Conversation · Tasks · Documents', 'text'], ['Remember layout per project', '', 'togon'], ['Most viewports side by side', '3 (4 above 3840 px)', 'text']],
      Phone: [['Show on the phone', '', 'togon'], ['Notify when Claude needs me', '', 'togon']] }[vp.tab || 'General'];
      const sw = ['#9db4ff', '#e8a25a', '#7fd0c8', '#b59cff', '#d58fb8', '#9ccf7a'];
      return `<div class="form">${rows.map(([l, d, k]) => `<div class="fr"><div class="fl2"><b>${l}</b><span>${k === 'text' ? '' : d}</span></div>${k === 'text' ? `<div class="input" style="width:calc(350px*var(--k));height:calc(38px*var(--k))"><input value="${esc(d)}"></div>` : k === 'tint' ? sw.map((c, i) => `<span class="swatch ${i === 0 ? 'on' : ''}" style="background:${c}"></span>`).join('') : `<span class="tog ${k === 'togon' ? 'on' : ''}" data-tog></span>`}</div>`).join('')}</div>`; },
    mount: (el) => el.onclick = (e) => { const t = e.target.closest('[data-tog]'); if (t) t.classList.toggle('on'); const s = e.target.closest('.swatch'); if (s) { $$('.swatch', el).forEach((x) => x.classList.remove('on')); s.classList.add('on'); } },
  };

  /* ---------- viewport manager ---------- */
  /* The module name in a viewport header opens the module menu (no separate hamburger). No hard limit on viewports.
     opts.active() says if this set is on screen: a hidden tab skips its updates and catches up when it shows (wake). */
  let vpSeq = 0;
  const KEEP = ['view', 'scope', 'ls', 'lu', 'u', 'project', 'session', 'cid'];
  const keepState = (st) => { const o = {}; KEEP.forEach((k) => { if (st[k] !== undefined) o[k] = clone(st[k]); }); return o; };
  MC.Viewports = class {
    constructor(root, layout, opts = {}) {
      this.root = root; this.opts = opts;
      this.cols = this.build(layout);
      this.focused = this.cols[0].rows[0];
      const on = (ev, fn) => MC.on(ev, (d) => { if (this.active()) fn(d); else this.dirty = true; });
      on('tasks', () => this.refresh(['tasks', 'overview', 'brief']));
      on('session', () => this.refresh(['convo', 'usage']));
      on('picked', () => this.refresh(['convo', 'gallery']));
      on('gallery', () => this.refresh(['gallery']));
      on('reminders', () => this.refresh(['reminders']));
      on('project', () => this.refresh(null));
      on('rerender', (m) => this.refresh([m]));
      on('open', (m) => { if (!this.opts.noOpen) this.open(m); });
      on('cols', (n) => this.setCols(n));
      on('paste', (line) => this.paste(line));
      MC.on('work', (w) => { this.all().forEach((v) => this.forceView(v, w)); if (this.active()) this.refresh(null); else this.dirty = true; });
      this.render();
    }
    active() { return !this.opts.active || this.opts.active(); }
    wake() { if (this.dirty) { this.dirty = false; this.refresh(null); } }
    forceView(v, w) { const m = M[v.mod]; if (!m.workView) return; if (w) { if (v.state.view !== m.workView) v.state.prevView = v.state.view; v.state.view = m.workView; } else if (v.state.prevView !== undefined) { v.state.view = v.state.prevView; delete v.state.prevView; } }
    build(layout) { return layout.map((c) => ({ w: c.w || 1, rows: c.rows.map((r) => this.mk(r.mod, r.tab, r.h, r.state)) })); }
    serial() { return this.cols.map((c) => ({ w: +(+c.w).toFixed(3), rows: c.rows.map((r) => ({ mod: r.mod, tab: r.tab, h: +(+r.h).toFixed(3), state: keepState(r.state) })) })); }
    changed() { this.opts.onLayout && this.opts.onLayout(this); }
    mk(mod, tab, h, state) { const v = { id: ++vpSeq, mod, tab: tab || (M[mod].tabs ? M[mod].tabs[0] : null), h: h || 1, state: state ? clone(state) : {} }; if (S.work) this.forceView(v, true); return v; }
    all() { return this.cols.flatMap((c) => c.rows); }
    /* scroll places survive a redraw (a panel added, removed, moved, maximized): the panel body from the top, a conversation
       from the bottom (new messages arrive there), and only for the same conversation. A conversation seen for the first time
       starts at the bottom. A hidden panel keeps what it had. */
    takeScroll(v) {
      if (!v.el || !v.el.isConnected) return;
      const got = [...v.el.querySelectorAll(SCROLLERS)].filter((e) => e.clientHeight).map((e) => ({ convo: e.classList.contains('convo-scroll'), sid: (e.closest('[data-sid]') || {}).dataset?.sid || '', top: e.scrollTop, end: e.scrollHeight - e.scrollTop - e.clientHeight }));
      if (got.length) v._keep = got;
    }
    giveScroll(v) {
      if (!v.el || !v.el.isConnected) return;
      const keep = v._keep || [];
      v.el.querySelectorAll(SCROLLERS).forEach((e) => {
        if (!e.clientHeight) return;
        const convo = e.classList.contains('convo-scroll'), sid = (e.closest('[data-sid]') || {}).dataset?.sid || '';
        const k = keep.find((x) => x.convo === convo && (!convo || x.sid === sid));
        if (convo) e.scrollTop = k ? e.scrollHeight - e.clientHeight - k.end : e.scrollHeight;
        else if (k) e.scrollTop = k.top;
      });
    }
    render() {
      this.all().forEach((v) => this.takeScroll(v));
      this.root.innerHTML = '';
      this.root.classList.add('vps');
      this.cols.forEach((c, ci) => {
        if (ci) this.root.appendChild(this.gutter(ci));
        const col = document.createElement('div'); col.className = 'vcol'; col.style.flex = fx(c.w); c.el = col;
        c.rows.forEach((v, ri) => { if (ri) col.appendChild(this.gutter(ci, ri)); col.appendChild(this.vpEl(v)); });
        this.root.appendChild(col);
      });
      this.applyMax();
      this.all().forEach((v) => this.giveScroll(v));
      this.edges();
      this.opts.onChange && this.opts.onChange(this);
    }
    /* near any side of a viewport (in the gap, or on the outer edge) two buttons show: add a panel on that side, swap with the neighbor there */
    edges() {
      const bar0 = document.createElement('div'); bar0.className = 'edgebar'; this.root.appendChild(bar0);
      if (this.root._edgeMove) return;
      const hide = () => { const b = this.root.querySelector('.edgebar'); if (b) { b.classList.remove('on'); b._key = ''; } };
      /* a gap is one place, whichever panel the mouse is closer to: the gap between two columns, or between two panels in a column.
         The outer edges are gaps too (before the first, after the last). The buttons only redraw when the gap changes, so they never flicker. */
      this.root._edgeMove = (e) => {
        const bar = this.root.querySelector('.edgebar'); if (!bar || e.buttons || e.target.closest('.edgebar, .menu')) return;
        const x = e.clientX, y = e.clientY; let best = null;
        this.all().forEach((v) => { if (!v.el || !v.el.offsetParent) return; const r = v.el.getBoundingClientRect();
          const inY = y >= r.top && y <= r.bottom, inX = x >= r.left && x <= r.right;
          [['l', inY, r.left - x], ['r', inY, x - r.right], ['t', inX, r.top - y], ['b', inX, y - r.bottom]].forEach(([side, ok, d]) => {
            if (ok && d >= -7 && d <= 16 && (!best || Math.abs(d) < best.d)) best = { v, side, d: Math.abs(d) }; }); });
        if (!best) { hide(); bar._key = ''; return; }
        const { v, side } = best, c = this.cols.find((c) => c.rows.includes(v)), ci = this.cols.indexOf(c), ri = c.rows.indexOf(v);
        const col = side === 'l' || side === 'r';
        const gi = col ? ci + (side === 'r' ? 1 : 0) : ri + (side === 'b' ? 1 : 0);
        const key = col ? 'c' + gi : 'r' + ci + ':' + gi;
        if (bar._key === key && bar.classList.contains('on')) return;
        const R = this.root.getBoundingClientRect(), keep = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
        const list = col ? this.cols : c.rows, n = list.length, swap = gi > 0 && gi < n;
        const elOf = (k) => (col ? this.cols[k].el : c.rows[k].el).getBoundingClientRect();
        let px, py;
        if (col) { px = gi === 0 ? elOf(0).left - 5 : gi === n ? elOf(n - 1).right + 5 : (elOf(gi - 1).right + elOf(gi).left) / 2; const cr = this.root.getBoundingClientRect(); py = (cr.top + cr.bottom) / 2; }
        else { const cr = c.el.getBoundingClientRect(); px = (cr.left + cr.right) / 2; py = gi === 0 ? elOf(0).top - 5 : gi === n ? elOf(n - 1).bottom + 5 : (elOf(gi - 1).bottom + elOf(gi).top) / 2; }
        const where = col ? (gi === 0 ? 'on the far left' : gi === n ? 'on the far right' : 'here, between these two') : (gi === 0 ? 'at the top' : gi === n ? 'at the bottom' : 'here, between these two');
        bar.className = 'edgebar on ' + (col ? 'v' : 'hz');
        bar.innerHTML = `<button data-e="add" title="Add a panel ${where}">${I('plus', 'sm')}</button>${swap ? `<button data-e="swap" title="Swap the panels on each side">${I('swap', 'sm')}</button>` : ''}`;
        bar.style.left = keep(px - R.left, 18, R.width - 18) + 'px';
        bar.style.top = keep(py - R.top, 18, R.height - 18) + 'px';
        bar._key = key; bar._t = { col, ci, gi };
      };
      this.root.addEventListener('mousemove', this.root._edgeMove);
      this.root.addEventListener('mouseleave', hide);
      this.root.addEventListener('click', (e) => {
        const b = e.target.closest('.edgebar [data-e]'); if (!b) return;
        const { col, ci, gi } = b.parentNode._t, list = col ? this.cols : this.cols[ci].rows;
        if (b.dataset.e === 'add') list.splice(gi, 0, col ? { w: 1, rows: [this.mk(this.nextMod())] } : this.mk(this.nextMod(), null, .8));
        else [list[gi - 1], list[gi]] = [list[gi], list[gi - 1]];
        this.maxed = null; this.render(); this.changed();
      });
    }
    vpEl(v) {
      const el = document.createElement('section'); el.className = 'vp' + (v === this.focused ? ' focus' : ''); el.style.flex = fx(v.h); v.el = el;
      el.innerHTML = `<header class="vp-head"><span class="vp-title"></span><nav class="vp-tabs"></nav><span class="vp-sw"></span>
        <div class="vp-acts"><button class="ibtn sm" data-v="more" title="More">${I('more', 'sm')}</button><button class="ibtn sm" data-v="max" title="Maximize (Ctrl Space)">${I(this.maxed === v ? 'min' : 'max', 'sm')}</button><button class="ibtn sm" data-v="close" title="Close this viewport">${I('x', 'sm')}</button></div></header><div class="vp-body"></div>`;
      v.body = $('.vp-body', el); v.owner = this;
      v.rerender = () => this.paint(v);
      ['click', 'auxclick', 'contextmenu', 'mousedown', 'input', 'change', 'keydown', 'paste', 'drop', 'dragstart', 'focusin'].forEach((ty) => el.addEventListener(ty, () => {
        if (!v.state.project) return;
        MC.ctx = { vp: v, project: v.state.project }; clearTimeout(this._ctxT); this._ctxT = setTimeout(() => { MC.ctx = null; });
      }, true));
      el.addEventListener('mousedown', () => { if (this.focused !== v) { this.focused = v; this.all().forEach((x) => x.el && x.el.classList.toggle('focus', x === v)); this.opts.onFocus && this.opts.onFocus(v); } });
      $('.vp-head', el).addEventListener('mousedown', (e) => this.dragStart(e, v));
      $('.vp-head', el).onclick = (e) => {
        if (this._dragged) return;
        const sw = e.target.closest('[data-sw] button'); if (sw) { const k = sw.parentNode.dataset.sw; if (k === 'view' && S.work && M[v.mod].workView) { MC.toast('Work mode keeps the plain view. Turn work mode off to change it.', 'brief'); return; } v.state[k] = sw.dataset.val; this.paint(v); this.changed(); return; }
        const b = e.target.closest('[data-v],[data-tab]'); if (!b) return;
        if (b.dataset.tab) { v.tab = b.dataset.tab; this.paint(v); this.changed(); return; }
        const k = b.dataset.v;
        if (k === 'ham') this.moduleMenu(v, b);
        if (k === 'pick') M[v.mod].pick(v, b);
        if (k === 'split') this.split(v);
        if (k === 'down') this.splitDown(v);
        if (k === 'max') { this.maxed = this.maxed === v ? null : v; this.render(); }
        if (k === 'close') { this.close(v); return; }
        if (k === 'proj') { this.projectMenu(v, b); return; }
        if (k === 'more') MC.menu(b, [{ id: 'split', label: 'Split to the right', icon: 'splitR' }, { id: 'down', label: 'Split down', icon: 'splitD' }, { sep: 1 }, { id: 'proj', label: 'Show another project…', icon: 'folder' }, ...(v.state.project ? [{ id: 'mine', label: "Back to this tab's project", icon: 'undo' }] : []), { id: 'pop', label: 'Pop out to its own window', icon: 'ext', sub: 'desktop app' }, { sep: 1 }, { id: 'close', label: 'Close this viewport', icon: 'x' }], (id) => {
          if (id === 'split') this.split(v); if (id === 'down') this.splitDown(v);
          if (id === 'proj') this.projectMenu(v, b); if (id === 'mine') this.showProject(v, null);
          if (id === 'close') this.close(v);
          if (id === 'pop') MC.toast('In the desktop app this opens a separate window you can put on another screen', 'ext');
        }, { alignRight: true });
      };
      this.paint(v);
      return el;
    }
    /* drag a panel by its header: drop on the middle of another panel to swap them, near one of its sides to put it there.
       Left and right make a new column next to that panel's column; top and bottom stack it in that column. */
    dragStart(e, v) {
      if (e.button !== 0 || e.target.closest('button:not(.vp-pick):not(.vp-sub), input, .seg, nav')) return;
      const x0 = e.clientX, y0 = e.clientY; let ghost = null, hint = null, drop = null, host = this, hoverId = null, hoverT = 0;
      const origin = this.opts.origin ? this.opts.origin() : null;
      const zoneOf = (x, y) => {
        for (const t of host.all()) {
          if (t === v || !t.el.offsetParent) continue; const r = t.el.getBoundingClientRect();
          if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
          const d = { l: (x - r.left) / r.width, r: (r.right - x) / r.width, t: (y - r.top) / r.height, b: (r.bottom - y) / r.height };
          const side = Object.keys(d).reduce((a, k) => (d[k] < d[a] ? k : a), 'l');
          return { t, r, side: d[side] < .28 ? side : 'mid' };
        }
        return null;
      };
      /* in another tab the drop is a copy; Shift makes it a move. Esc cancels the drag (and goes back to this tab). */
      let shift = false, last = null;
      const mv = (ev) => {
        last = ev; shift = !!ev.shiftKey;
        if (!ghost) { if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 6) return;
          ghost = document.createElement('div'); ghost.className = 'vpghost'; ghost.innerHTML = I(M[v.mod].icon, 'sm') + esc(M[v.mod].label); document.body.appendChild(ghost);
          hint = document.createElement('div'); hint.className = 'vpdrop'; this.root.appendChild(hint);
          v.el.classList.add('dragsrc'); document.body.classList.add('vpdragging'); }
        ghost.style.left = ev.clientX + 14 + 'px'; ghost.style.top = ev.clientY + 12 + 'px';
        /* over another tab for half a second: that tab opens, and the panel can be placed in it (a copy; this one stays) */
        const tabEl = this.opts.onHoverTab && document.elementFromPoint(ev.clientX, ev.clientY);
        const overTab = tabEl && tabEl.closest && tabEl.closest('.ptab[data-tab]:not(.on)');
        $$('.ptab.drop').forEach((x) => x !== overTab && x.classList.remove('drop')); if (overTab) overTab.classList.add('drop');
        const oid = overTab ? overTab.dataset.tab : null;
        if (oid !== hoverId) { clearTimeout(hoverT); hoverId = oid; if (oid) hoverT = setTimeout(() => { this.opts.onHoverTab(oid); }, 500); }
        host = (this.opts.hostOf && this.opts.hostOf()) || this;
        if (hint.parentNode !== host.root) host.root.appendChild(hint);
        const cross = host !== this;
        ghost.innerHTML = I(M[v.mod].icon, 'sm') + esc(M[v.mod].label) + (cross ? (shift ? ' · move' : ' · copy (Shift: move)') : '');
        drop = overTab ? null : zoneOf(ev.clientX, ev.clientY);
        if (!drop) { hint.style.display = 'none'; return; }
        if (cross && drop.side === 'mid') drop.side = 'r';
        const { r, side } = drop, R = host.root.getBoundingClientRect(), half = side === 'mid' ? null : side;
        const box = { left: r.left, top: r.top, width: r.width, height: r.height };
        if (half === 'l' || half === 'r') { box.width = r.width / 2; if (half === 'r') box.left = r.left + r.width / 2; }
        if (half === 't' || half === 'b') { box.height = r.height / 2; if (half === 'b') box.top = r.top + r.height / 2; }
        Object.assign(hint.style, { display: 'grid', left: box.left - R.left + 'px', top: box.top - R.top + 'px', width: box.width + 'px', height: box.height + 'px' });
        const arrow = { mid: 'swap', l: 'arrowL', r: 'arrowR', t: 'arrowU', b: 'down' }[side];
        hint.innerHTML = `<span>${I(arrow, 'sm')}${side === 'mid' ? 'Swap' : cross && !shift ? 'Copy here' : 'Move here'}</span>`;
      };
      const end = () => {
        removeEventListener('mousemove', mv); removeEventListener('mouseup', up); removeEventListener('keydown', key, true); removeEventListener('keyup', key, true);
        clearTimeout(hoverT); $$('.ptab.drop').forEach((x) => x.classList.remove('drop'));
        if (!ghost) return false;
        ghost.remove(); hint.remove(); v.el.classList.remove('dragsrc'); document.body.classList.remove('vpdragging');
        this._dragged = true; setTimeout(() => (this._dragged = false), 0); /* the click after a drag does not open the menu */
        return true;
      };
      const hostNow = () => (this.opts.hostOf && this.opts.hostOf()) || this;
      const up = () => {
        host = hostNow();
        if (!end()) return;
        if (host !== this) { if (drop && this.opts.copyTo) this.opts.copyTo(v, host, drop, shift, this); return; }
        if (drop) this.move(v, drop.t, drop.side);
      };
      const key = (ev) => {
        if (ev.key === 'Escape' && ev.type === 'keydown') { ev.preventDefault(); ev.stopPropagation(); const away = hostNow() !== this; end(); if (away && this.opts.back) this.opts.back(origin); return; }
        if (ev.key === 'Shift' && last && ghost) mv(new MouseEvent('mousemove', { clientX: last.clientX, clientY: last.clientY, shiftKey: ev.type === 'keydown' }));
      };
      addEventListener('mousemove', mv); addEventListener('mouseup', up); addEventListener('keydown', key, true); addEventListener('keyup', key, true);
    }
    /* the project a panel shows: null is its tab's project */
    projectMenu(v, anchor) {
      const names = (MC.live && MC.live.projects ? MC.live.projects.map((p) => p.name) : []).filter((n) => !(S.work && /games/i.test((MC.projectInfo(n).folder || ''))));
      const cur = v.state.project || S.project;
      MC.menu(anchor, [{ h: 'Show in this panel' }, ...(v.state.project ? [{ id: '*tab', label: "This tab's project", sub: S.project || '', icon: 'undo' }, { sep: 1 }] : []), ...names.concat(['Simple chats']).map((n) => ({ id: n, label: n, icon: n === 'Simple chats' ? 'chat' : 'folder', on: n === cur }))],
        (id) => this.showProject(v, id === '*tab' ? null : id), { alignRight: true });
    }
    showProject(v, name) {
      if (!name || name === S.project) delete v.state.project; else v.state.project = name;
      delete v.state.session; this.paint(v); this.changed();
    }
    /* a copy of a panel from another tab, put next to one of this layout's panels (drop.t, on drop.side) */
    place(item, drop) {
      const v = this.mk(item.mod, item.tab, 1, item.state);
      const c = this.cols.find((c) => c.rows.includes(drop.t)), side = drop.side === 'mid' ? 'r' : drop.side;
      if (!c || side === 'l' || side === 'r') this.cols.splice(c ? this.cols.indexOf(c) + (side === 'r' ? 1 : 0) : this.cols.length, 0, { w: 1, rows: [v] });
      else c.rows.splice(c.rows.indexOf(drop.t) + (side === 'b' ? 1 : 0), 0, v);
      this.maxed = null; this.focused = v; this.render(); this.changed();
      if (v.el) v.el.animate([{ boxShadow: '0 0 0 2px var(--accent)' }, { boxShadow: '0 0 0 0 transparent' }], 900);
      return v;
    }
    move(v, t, side) {
      const at = (x) => { const c = this.cols.find((c) => c.rows.includes(x)); return { c, i: c.rows.indexOf(x) }; };
      if (side === 'mid') { const a = at(v), b = at(t); a.c.rows[a.i] = t; b.c.rows[b.i] = v; [v.h, t.h] = [t.h, v.h]; }
      else {
        const a = at(v); a.c.rows.splice(a.i, 1); if (!a.c.rows.length) this.cols.splice(this.cols.indexOf(a.c), 1);
        const b = at(t); v.h = 1;
        if (side === 'l' || side === 'r') this.cols.splice(this.cols.indexOf(b.c) + (side === 'r' ? 1 : 0), 0, { w: 1, rows: [v] });
        else b.c.rows.splice(b.i + (side === 'b' ? 1 : 0), 0, v);
      }
      this.maxed = null; this.focused = v; this.render(); this.changed();
    }
    paint(v) {
      const prev = MC.ctx; MC.ctx = v.state.project ? { vp: v, project: v.state.project } : null;
      try { this.paintIn(v); } finally { MC.ctx = prev; }
    }
    paintIn(v) {
      const m = M[v.mod];
      this.takeScroll(v);
      v.el.classList.toggle('foreign', !!v.state.project);
      v.el.style.setProperty('--pt-line', v.state.project ? MC.projectInfo(v.state.project).tint : '');
      const fp = v.state.project && MC.projectInfo(v.state.project);
      $('.vp-title', v.el).innerHTML = (fp ? `<button class="vp-proj" data-v="proj" title="This panel shows ${esc(fp.name)}, not this tab's project. Click to pick another" style="--pt:${fp.tint}"><span class="tint" style="background:${fp.tint}">${esc(fp.name[0])}</span>${esc(fp.name)}</button>` : '')
        + `<button class="vp-pick" data-v="ham" title="Pick what this viewport shows">${I(m.icon)}<span>${esc(m.label)}</span>${I('chev', 'sm chev')}</button>`
        + (m.title ? `<button class="vp-sub" data-v="pick" title="Switch">${esc(m.title())}${I('chev', 'sm chev')}</button>` : '');
      $('.vp-tabs', v.el).innerHTML = (m.tabs || []).map((t) => `<button data-tab="${t}" class="${t === v.tab ? 'on' : ''}">${t}</button>`).join('');
      const view = v.state.view || (m.views && m.views[0][0]);
      $('.vp-sw', v.el).innerHTML = (m.views ? `<span class="seg ico ${S.work && m.workView ? 'locked' : ''}" data-sw="view">${m.views.map(([id, ic, l]) => `<button data-val="${id}" class="${id === view ? 'on' : ''}" title="${l}${S.work && m.workView ? ' (work mode)' : ''}">${I(ic, 'sm')}</button>`).join('')}</span>` : '')
        + (m.scope ? `<span class="seg ico" data-sw="scope"><button data-val="proj" class="${v.state.scope !== 'all' ? 'on' : ''}" title="This project">${I('folder', 'sm')}</button><button data-val="all" class="${v.state.scope === 'all' ? 'on' : ''}" title="Everything">${I('globe', 'sm')}</button></span>` : '');
      v.body.innerHTML = m.render(v);
      m.mount && m.mount(v.body, v);
      this.giveScroll(v);
    }
    refresh(mods) { this.all().forEach((v) => { if (!mods || mods.includes(v.mod)) { const st = v.body.scrollTop; this.paint(v); if (v.mod !== 'convo') v.body.scrollTop = st; } }); }
    moduleMenu(v, anchor) {
      const items = [];
      MC.groups.forEach(([g, ids]) => { items.push({ h: g }); ids.forEach((id) => items.push({ id, label: M[id].label, icon: M[id].icon, on: id === v.mod })); });
      MC.menu(anchor, items, (id) => { v.mod = id; v.tab = M[id].tabs ? M[id].tabs[0] : null; v.state = {}; if (S.work) this.forceView(v, true); this.paint(v); this.opts.onChange && this.opts.onChange(this); this.changed(); }, { grid: true });
    }
    nextMod() { return ['tasks', 'docs', 'gallery', 'browser', 'usage', 'timeline', 'notes', 'activity'].find((m) => !this.all().some((x) => x.mod === m)) || 'notes'; }
    split(v) {
      const ci = this.cols.findIndex((c) => c.rows.includes(v));
      this.cols.splice(ci + 1, 0, { w: 1, rows: [this.mk(this.nextMod())] }); this.maxed = null; this.render(); this.changed();
    }
    splitDown(v) { const c = this.cols.find((c) => c.rows.includes(v)); c.rows.splice(c.rows.indexOf(v) + 1, 0, this.mk(this.nextMod(), null, .7)); this.maxed = null; this.render(); this.changed(); }
    close(v) { const c = this.cols.find((c) => c.rows.includes(v)); if (this.all().length === 1) return; c.rows.splice(c.rows.indexOf(v), 1); if (!c.rows.length) this.cols.splice(this.cols.indexOf(c), 1); if (this.maxed === v) this.maxed = null; if (this.focused === v) this.focused = this.all()[0]; this.render(); this.changed(); }
    setCols(n) {
      const def = ['convo', 'tasks', 'docs', 'gallery'];
      while (this.cols.length > n) this.cols.pop();
      while (this.cols.length < n) { const m = def.find((d) => !this.all().some((x) => x.mod === d)) || 'notes'; this.cols.push({ w: 1, rows: [this.mk(m)] }); }
      this.cols.forEach((c) => (c.w = 1)); this.maxed = null; this.render(); this.changed();
    }
    setLayout(layout) { this.cols = this.build(layout); this.maxed = null; this.focused = this.cols[0].rows[0]; this.render(); }
    /* st: the state a panel that is new for it starts with (a panel that shows it already keeps its own) */
    open(mod, st) {
      const hit = this.all().find((x) => x.mod === mod);
      if (hit) { if (this.maxed && this.maxed !== hit) { this.maxed = null; this.render(); } hit.el.animate([{ boxShadow: '0 0 0 2px var(--accent)' }, { boxShadow: '0 0 0 0 transparent' }], 900); return hit; }
      const v = this.focused && this.focused.mod !== 'convo' ? this.focused : (this.all().filter((x) => x.mod !== 'convo').pop() || null);
      if (!v) { this.cols.push({ w: 1, rows: [this.mk(mod, null, null, st)] }); this.render(); this.changed(); return this.all().pop(); }
      v.mod = mod; v.tab = M[mod].tabs ? M[mod].tabs[0] : null; v.state = st ? clone(st) : {}; if (S.work) this.forceView(v, true); this.paint(v);
      this.opts.onChange && this.opts.onChange(this); this.changed();
      return v;
    }
    /* a command from a conversation, typed into the console (not run: the user reads it and presses Enter). d is the line,
       or { line, cwd }: a console that is new starts in the conversation's folder */
    paste(d) { const o = typeof d === 'string' ? { line: d } : d || {}; const v = this.open('console', o.cwd ? { cwd: o.cwd } : null); if (!v) return; v.tab = 'Terminal'; v.state.prefill = o.line || ''; v.state.typed = ''; this.paint(v); }
    applyMax() { this.all().forEach((v) => v.el.classList.toggle('max-hidden', !!this.maxed && v !== this.maxed)); this.cols.forEach((c) => { c.el.style.display = this.maxed && !c.rows.includes(this.maxed) ? 'none' : ''; }); $$('.gut', this.root).forEach((g) => (g.style.display = this.maxed ? 'none' : '')); }
    gutter(ci, ri) {
      const g = document.createElement('div'); g.className = 'gut' + (ri ? ' h' : '');
      g.onmousedown = (e) => {
        e.preventDefault(); g.classList.add('drag');
        const horiz = !ri; const c = this.cols[ci];
        const a = horiz ? this.cols[ci - 1] : c.rows[ri - 1], b = horiz ? c : c.rows[ri];
        const sa = horiz ? a.el.offsetWidth : a.el.offsetHeight, sb = horiz ? b.el.offsetWidth : b.el.offsetHeight, wa = horiz ? a.w : a.h, wb = horiz ? b.w : b.h;
        const start = horiz ? e.clientX : e.clientY;
        document.body.style.cursor = horiz ? 'col-resize' : 'row-resize';
        const mv = (ev) => { const d = (horiz ? ev.clientX : ev.clientY) - start; const na = Math.max(200, sa + d), nb = Math.max(200, sb - d); const tot = wa + wb;
          const fa = tot * na / (na + nb), fb = tot - fa; if (horiz) { a.w = fa; b.w = fb; } else { a.h = fa; b.h = fb; } a.el.style.flex = fx(fa); b.el.style.flex = fx(fb); };
        const up = () => { g.classList.remove('drag'); document.body.style.cursor = ''; removeEventListener('mousemove', mv); removeEventListener('mouseup', up); this.changed(); };
        addEventListener('mousemove', mv); addEventListener('mouseup', up);
      };
      return g;
    }
  };

  /* apply a saved theme early */
  if (S.theme) document.documentElement.dataset.theme = S.theme;
  MC.setSize(store.get('mcrev-size') || 'M');
})();
