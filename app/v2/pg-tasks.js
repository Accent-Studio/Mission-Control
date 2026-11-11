/* Mission Control 2: Tasks on real data. One list for every project (GET /api/tasks), shared with Claude through
   Mission Control's MCP tools. Board (Inbox, To do, In progress, Review, Done), List and Week, and the task in full in a
   side panel (New task opens it, and its title takes the quick add words). Loads after panels.js and replaces the sample
   Tasks module of modules.js. */
(() => {
  const { $, $$, esc, icon: I } = MC;
  const M = MC.modules, api = MC.api, H = MC.live.helpers, LV = MC.live;
  const enc = encodeURIComponent;
  MC.tasks = MC.tasks || {};
  /* the project picked in the side panel, as a task names it: a project of the linked PC (Home) by its id there; a root
     folder, the chats or a project of a PC seen only through the hub name none */
  const realPid = () => {
    const id = H.pidOf(); if (!id || H.isRootId(id) || H.isChatId(id)) return null;
    if (!H.hubKey(id)) return id;
    const p = H.linkProj(id); return p ? p.rid : null;
  };

  /* ---------- the data ---------- */
  const TK = { list: [], targets: [], loaded: false, err: '', busy: false, again: false };
  const byId = (id) => TK.list.find((t) => t.id === id);
  async function load() {
    if (TK.busy) { TK.again = true; return; }
    TK.busy = true;
    try { const d = await api.get('/api/tasks'); TK.list = (d && d.tasks) || []; TK.targets = (d && d.targets) || []; TK.err = ''; }
    catch (e) { TK.err = H.errText(e); }
    TK.busy = false; TK.loaded = true;
    if (TK.again) { TK.again = false; return load(); }
    repaint();
  }
  /* a repaint waits while you type in the side panel, and happens when you leave the field */
  let held = false;
  const typing = () => { const a = document.activeElement; return !!(a && a.closest && a.closest('.tk-side') && /INPUT|TEXTAREA/.test(a.tagName)); };
  function repaint() { MC.emit('rerender', 'nextup'); MC.emit('rerender', 'inbox'); if (typing()) { held = true; return; } held = false; MC.emit('rerender', 'tasks'); }
  document.addEventListener('focusout', () => setTimeout(() => { if (held && !typing()) repaint(); }));
  let soon = 0;
  MC.events.on('tasks', () => { clearTimeout(soon); soon = setTimeout(load, 120); });
  /* a task that comes due, or whose planned time comes (services/tasks.js reminders) */
  MC.events.on('task.due', (d) => { if (!d || !d.id) return; MC.toast(`${d.kind === 'due' ? 'Due now' : 'Planned now'}: ${d.id} ${d.title}${d.for === 'claude' ? ' (for Claude)' : ''}`, 'bell'); });
  const fail = (what) => (e) => { MC.toast(what + ': ' + H.errText(e), 'warn'); load(); };
  const put = (id, patch) => api.put(`/api/tasks/${enc(id)}`, patch).then(load, fail('Not saved'));

  /* ---------- words ---------- */
  const LANES = [['inbox', 'Inbox', 'idle', 'inbox'], ['todo', 'To do', 'idle', 'circle'], ['doing', 'In progress', 'run', 'loader'], ['review', 'Review', 'wait', 'eye'], ['done', 'Done', 'done', 'tick']];
  const STATUS = { inbox: 'Inbox', todo: 'To do', doing: 'In progress', review: 'Review', done: 'Done', dropped: 'Dropped' };
  /* what each lane means (its header's tooltip). Inbox is the untriaged pile: what Claude proposes lands there, and
     moving a task on to To do (or Start with Claude) says yes to it. */
  const LANE_HELP = {
    inbox: 'Inbox: new tasks nobody has said yes to yet. What Claude proposes lands here. Drag one to To do to accept it, or drop it.',
    todo: 'To do: accepted, waiting to be started. Tasks you make yourself start here.',
    doing: 'In progress: being worked on now.',
    review: 'Review: Claude says it is finished. Approve it (Done) or send it back.',
    done: 'Done: finished. Only you mark a task done.',
  };
  const STRANK = { doing: 0, review: 1, todo: 2, inbox: 3, done: 4, dropped: 5 };
  const PRIO = { 1: ['crit', 'warn', 'Urgent'], 2: ['high', 'flag', 'High'], 3: ['med', 'flag', 'Normal'], 4: ['low', 'flag', 'Low'] };
  const prio = (p) => { const x = PRIO[p] || PRIO[3]; return `<span class="urg ${x[0]}">${I(x[1])}${x[2]}</span>`; };
  const projects = () => (LV.projects || []).filter((p) => p && p.id && !H.isRootId(p.id) && !H.isChatId(p.id));
  /* the PC this one is linked to (Home) and its projects, as last read through the link (services/pcLink.js) */
  const linkName = () => (LV.link && LV.link.paired && LV.link.paired.name) || 'the other PC';
  const homeAll = () => (LV.link && LV.link.paired && Array.isArray(LV.link.projects) ? LV.link.projects.filter((q) => q && q.id) : []);
  const homeProj = (id) => homeAll().find((q) => q.id === id) || null;
  const hereProj = (id) => projects().find((p) => p.id === id) || null;
  const projName = (id) => (!id ? 'Personal' : hereProj(id) ? hereProj(id).name : homeProj(id) ? `${homeProj(id).name} on ${linkName()}` : (LV.byId[id] || {}).name || id);
  /* every project a task can name, for a picker: this PC's, then the linked PC's */
  const projectItems = (on) => {
    const home = homeAll().filter((q) => !q.hidden && !hereProj(q.id));
    return [...(home.length ? [{ h: MC.place || 'This PC' }] : []), ...projects().map((p) => ({ id: p.id, label: p.name, icon: 'folder', on: on === p.id })),
      ...(home.length ? [{ h: linkName() }, ...home.map((q) => ({ id: q.id, label: q.name, icon: 'pc', on: on === q.id }))] : [])];
  };
  const pad = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => isoDay(new Date());
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function dayText(s) {
    if (!s) return '';
    const d = new Date(s.length === 10 ? s + 'T00:00' : s), t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t) / 864e5);
    const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : diff > 1 && diff < 7 ? DOW[d.getDay()] : `${MON[d.getMonth()]} ${d.getDate()}`;
    return day + (s.length > 10 ? ' ' + s.slice(11, 16) : '');
  }
  const overdue = (t) => !!t.due && t.status !== 'done' && t.status !== 'dropped' && (t.due.length === 10 ? t.due < today() : new Date(t.due) < new Date());
  const stepsOf = (t) => t.steps.length ? `${t.steps.filter((s) => s.done).length}/${t.steps.length}` : '';
  const working = (t) => t.status === 'doing' && (t.links || []).some((l) => l.kind === 'session' && H.busy(l.id));

  /* ---------- quick add words: "Fix the build !1 @claude #hub due fri 14:00 plan tomorrow" ---------- */
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  function when(words) {
    /* reads a day (and a time) from the front of words; gives [value, words used] or null */
    const w0 = (words[0] || '').toLowerCase(); let d = null, used = 1;
    const now = new Date(); now.setHours(0, 0, 0, 0);
    if (w0 === 'today') d = now;
    else if (w0 === 'tomorrow' || w0 === 'tmr') { d = new Date(now); d.setDate(d.getDate() + 1); }
    else if (/^\d{4}-\d{2}-\d{2}$/.test(w0)) d = new Date(w0 + 'T00:00');
    else if (/^\d{1,2}\/\d{1,2}$/.test(w0)) { const [m, dd] = w0.split('/').map(Number); d = new Date(now.getFullYear(), m - 1, dd); if (d < now) d.setFullYear(d.getFullYear() + 1); }
    else {
      const k = DAYS.findIndex((x) => w0.length >= 3 && x.startsWith(w0));
      if (k >= 0) { d = new Date(now); d.setDate(d.getDate() + (((k - d.getDay()) + 7) % 7 || 7)); }
      else {
        const m = MON.findIndex((x) => w0.startsWith(x.toLowerCase())), n = Number(words[1]);
        if (m >= 0 && n >= 1 && n <= 31) { d = new Date(now.getFullYear(), m, n); if (d < now) d.setFullYear(d.getFullYear() + 1); used = 2; }
      }
    }
    if (!d || Number.isNaN(+d)) return null;
    let val = isoDay(d);
    const tm = /^(\d{1,2})(?:[:h](\d{2}))?\s*(am|pm)?$/i.exec(words[used] || '');
    if (tm && (tm[2] || tm[3] || /h$/i.test(words[used]))) {
      let h = Number(tm[1]); const mi = Number(tm[2] || 0);
      if (tm[3]) h = (h % 12) + (/pm/i.test(tm[3]) ? 12 : 0);
      if (h < 24 && mi < 60) { val += `T${pad(h)}:${pad(mi)}`; used++; }
    }
    return [val, used];
  }
  function parseQuick(line) {
    const out = { tags: [] }, words = line.trim().split(/\s+/), title = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i], low = w.toLowerCase();
      if (/^!([1-4])$/.test(w)) { out.priority = Number(w[1]); continue; }
      if (low === '@claude' || low === '@me') { out.for = low.slice(1); continue; }
      if (/^#[\w-]+$/.test(w)) { out.tags.push(w.slice(1)); continue; }
      if ((low === 'due' || low === 'plan') && i + 1 < words.length) {
        const r = when(words.slice(i + 1));
        if (r) { out[low === 'due' ? 'due' : 'planned'] = r[0]; i += r[1]; continue; }
      }
      title.push(w);
    }
    out.title = title.join(' ');
    return out;
  }

  /* ---------- targets: a goal with a date, and how it is going ---------- */
  const tgById = (id) => TK.targets.find((g) => g.id === id);
  function pace(g) {
    const ts = TK.list.filter((t) => t.target === g.id && t.status !== 'dropped'), total = ts.length, done = ts.filter((t) => t.status === 'done').length;
    if (total && done === total) return { total, done, k: 'done', word: 'Done', icon: 'tick' };
    if (!g.due) return total ? { total, done, k: 'open', word: `${total - done} open`, icon: 'circle' } : { total, done, k: 'none', word: 'No tasks yet', icon: 'circle' };
    const start = Date.parse(g.created), end = Date.parse(g.due.length === 10 ? g.due + 'T23:59' : g.due), now = Date.now(), days = Math.max(1, (end - start) / 864e5);
    if (now > end) return { total, done, k: 'late', word: 'Late', icon: 'warn' };
    if (!total) return { total, done, k: 'none', word: 'No tasks yet', icon: 'circle' };
    const behind = Math.round((Math.min(1, Math.max(0, (now - start) / (end - start))) - done / total) * days);
    if (behind >= 1) return { total, done, k: 'behind', word: `Behind by ${behind} day${behind === 1 ? '' : 's'}`, icon: 'warn' };
    if (behind <= -1) return { total, done, k: 'ahead', word: `Ahead by ${-behind} day${behind === -1 ? '' : 's'}`, icon: 'zap' };
    return { total, done, k: 'pace', word: 'On pace', icon: 'clock' };
  }
  /* a goal may hold tasks of any project: a project shows its own goals, the goals with no project, and any goal that
     holds one of its tasks. Dated goals first, soonest first, then the others by name. */
  const goalIn = (g, pid) => g.project === pid || !g.project || TK.list.some((t) => t.target === g.id && t.project === pid);
  const goalSort = (a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : a.title.localeCompare(b.title));
  const targetsOf = (vp) => { const { pid, all } = scopeOf(vp); return TK.targets.filter((g) => all || goalIn(g, pid)).sort(goalSort); };
  /* the left column: every goal of the projects in view, each one a group. A click shows only its tasks, a drop puts a
     task in it, right click (or ...) renames, moves or deletes it. "No goal" holds the tasks that are in none. */
  const isOpen = (t) => t.status !== 'done' && t.status !== 'dropped';
  const inNone = (t) => !t.target || !tgById(t.target);
  function goalsHtml(vp) {
    const { pid, all } = scopeOf(vp), gs = targetsOf(vp), cur = vp.state.tg || '';
    const scoped = TK.list.filter((t) => all || t.project === pid);
    const done = (g) => pace(g).k === 'done', order = gs.filter((g) => !done(g)).concat(gs.filter(done));
    const row = (id, icon, title, n) => `<button class="tk-goal plain${cur === id ? ' on' : ''}" data-goal="${esc(id)}"><span class="tk-goal-h">${I(icon, 'sm')}<b class="ellip">${title}</b><span class="grow"></span><span class="faint">${n}</span></span></button>`;
    const goal = (g) => { const p = pace(g), pc = p.total ? Math.round(100 * p.done / p.total) : 0; return `<div class="tk-goal${cur === g.id ? ' on' : ''}${p.k === 'done' ? ' isdone' : ''}" data-goal="${esc(g.id)}" title="${esc(g.title)}" role="button" tabindex="0">
      <span class="tk-goal-h">${I('flag', 'sm')}<b class="ellip">${esc(g.title)}</b><span class="grow"></span><button class="ibtn sm tk-goal-more" data-goalmenu="${esc(g.id)}" title="Rename, change the date, delete">${I('more', 'sm')}</button></span>
      ${all ? MC.pchip(projName(g.project)) : ''}
      <span class="tp"><span class="bar ${p.k === 'done' ? 'ok' : p.k === 'late' || p.k === 'behind' ? 'warn' : ''}"><i style="width:${pc}%"></i></span>${p.done}/${p.total}</span>
      <span class="tk-goal-f"><span class="tk-pace ${p.k}">${I(p.icon, 'sm')}${esc(p.word)}</span><span class="grow"></span>${g.due ? `<span class="faint">${esc(dayText(g.due))}</span>` : ''}</span></div>`; };
    const nAll = scoped.filter(isOpen).length, nNone = scoped.filter((t) => isOpen(t) && inNone(t)).length;
    const col = `<aside class="tk-goals"><div class="tk-goals-h">Goals<span class="grow"></span><button class="ibtn sm" data-act="newtarget" title="New goal">${I('plus', 'sm')}</button></div>
      ${row('', 'tasks', 'All tasks', nAll)}${order.map(goal).join('')}${gs.length ? row('*none', 'circle', 'No goal', nNone) : `<div class="faint tk-goals-e">A goal holds tasks that belong together, from any project, with a date if it has one. Drag a task onto it to put it in; a click shows only its tasks.</div><button class="tk-goal plain add" data-act="newtarget">${I('plus', 'sm')}New goal</button>`}</aside>`;
    /* a narrow panel has no room for the column: the same choice in a dropdown above the tasks */
    const cg = cur && cur !== '*none' ? gs.find((g) => g.id === cur) : null, cp = cg ? pace(cg) : null;
    const [cIcon, cLabel, cN] = cg ? ['flag', cg.title, `${cp.done}/${cp.total}`] : cur === '*none' ? ['circle', 'No goal', nNone] : ['tasks', 'All tasks', nAll];
    const strip = `<button class="btn sm tk-gpick" data-gpick title="Show the tasks of one goal">${I(cIcon, 'sm')}<span class="ellip">${esc(cLabel)}</span><span class="faint">${cN}</span>${I('chev', 'sm')}</button>`;
    vp._goalItems = [{ id: 'g:', label: 'All tasks', sub: String(nAll), icon: 'tasks', on: !cur }, ...order.map((g) => { const p = pace(g); return { id: 'g:' + g.id, label: g.title, sub: `${p.done}/${p.total} done${g.due ? ' · ' + dayText(g.due) : ''}`, icon: 'flag', on: cur === g.id }; }),
      ...(gs.length ? [{ id: 'g:*none', label: 'No goal', sub: String(nNone), icon: 'circle', on: cur === '*none' }] : []), { sep: 1 }, { id: 'new', label: 'New goal', icon: 'plus' }];
    return { col, strip };
  }
  async function newTarget(pid) {
    const title = await MC.askText('New goal', 'Tasks that belong together, for example "Beta ready to test"', ''); if (!title || !title.trim()) return;
    const ds = await MC.askText('Its date (optional)', 'For example: fri, nov 20, 2026-12-01. Leave empty for no date.', ''); if (ds == null) return;
    const r = ds.trim() ? when(ds.trim().split(/\s+/)) : null; if (ds.trim() && !r) { MC.toast('That is not a date I know', 'warn'); return; }
    try { await api.post('/api/targets', { title: title.trim(), due: r ? r[0].slice(0, 10) : null, project: pid }); await load(); } catch (e) { MC.toast('Not added: ' + H.errText(e), 'warn'); }
  }
  function targetMenu(anchor, g, vp) {
    MC.menu(anchor, [{ h: g.title }, { id: 'show', label: vp.state.tg === g.id ? 'Show every task' : 'Show its tasks', icon: 'tasks' }, { id: 'name', label: 'Rename', icon: 'text' }, { id: 'date', label: g.due ? 'Change the date' : 'Give it a date', icon: 'cal' }, { id: 'del', label: 'Delete the goal', icon: 'trash', sub: 'its tasks stay' }], async (v) => {
      if (v === 'show') { vp.state.tg = vp.state.tg === g.id ? null : g.id; MC.emit('rerender', 'tasks'); return; }
      if (v === 'name') { const n = await MC.askText('Rename the goal', '', g.title); if (n && n.trim()) api.put(`/api/targets/${enc(g.id)}`, { title: n.trim() }).then(load, fail('Not saved')); return; }
      if (v === 'date') { const ds = await MC.askText('Its date', 'For example: fri, nov 20, 2026-12-01. Leave empty for no date.', g.due || ''); if (ds == null) return; const r = ds.trim() ? when(ds.trim().split(/\s+/)) : null; if (ds.trim() && !r) { MC.toast('That is not a date I know', 'warn'); return; } api.put(`/api/targets/${enc(g.id)}`, { due: r ? r[0].slice(0, 10) : null }).then(load, fail('Not saved')); return; }
      if (v === 'del' && await MC.askYes(`Delete ${g.title}?`, 'Its tasks stay; they no longer count toward it.', 'Delete')) { if (vp.state.tg === g.id) vp.state.tg = null; api.post(`/api/targets/${enc(g.id)}/delete`, {}).then(load, fail('Not deleted')); }
    });
  }

  /* ---------- the module ---------- */
  const scopeOf = (vp) => { const pid = realPid(); return { pid, all: vp.state.scope === 'all' || !pid }; };
  const weekEnd = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); return isoDay(d); };
  function shown(vp) {
    const { pid, all } = scopeOf(vp), F = vp.state.fl || {}, q = (vp.state.q || '').toLowerCase(), we = weekEnd();
    return TK.list.filter((t) => (all || t.project === pid) && (!vp.state.tg || (vp.state.tg === '*none' ? inNone(t) : t.target === vp.state.tg))
      && (!F.me || t.for === 'me') && (!F.claude || t.for === 'claude')
      && (!F.week || (t.due && t.due.slice(0, 10) <= we && t.status !== 'done' && t.status !== 'dropped'))
      && (!q || (t.id + ' ' + t.title + ' ' + t.notes + ' ' + t.tags.join(' ')).toLowerCase().includes(q)));
  }
  const laneSort = (k) => (a, b) => (k === 'done' ? String(b.updated).localeCompare(String(a.updated)) : (a.order || 0) - (b.order || 0));
  const pct = (t) => (t.status === 'done' ? 100 : t.steps.length ? Math.round(100 * t.steps.filter((s) => s.done).length / t.steps.length) : 0);
  const dueTag = (t) => !t.due ? '' : overdue(t)
    ? `<span class="urg crit" title="Due ${esc(t.due)}">${I('warn')}Overdue · ${esc(dayText(t.due))}</span>`
    : `<span class="urg" title="Due ${esc(t.due)}">${I('cal')}${esc(dayText(t.due))}</span>`;
  const claudeMark = (t) => (t.for === 'claude' ? `<span title="For Claude" class="avatar av-claude tk-av">${I('sparkle', 'sm')}</span>` : '');

  const laneOf = (s) => LANES.find((x) => x[0] === s) || ['dropped', 'Dropped', 'idle', 'x'];
  const card = (t, all, byPrio) => `<div class="tcard tk-card${t.blocked ? ' blocked' : ''}${t.status === 'done' ? ' isdone' : ''}" draggable="true" data-t="${esc(t.id)}">${all ? MC.pchip(projName(t.project)) : ''}
    <div class="row" style="gap:calc(8px*var(--k))">${byPrio ? MC.st(laneOf(t.status)[2], STATUS[t.status]) : prio(t.priority)}${dueTag(t)}<span class="grow"></span>${working(t) ? `<span class="tk-now" title="Claude is working on it now">${I('loader', 'sm')}Now</span>` : ''}${claudeMark(t)}</div>
    <div class="tt">${esc(t.title)}</div>
    ${t.blocked ? `<div class="tk-blk">${I('warn', 'sm')}Blocked: ${esc(t.blocked)}</div>` : ''}
    ${t.steps.length ? `<div class="tp"><div class="bar ${pct(t) === 100 ? 'ok' : ''}"><i style="width:${pct(t)}%"></i></div>${pct(t)}%</div>` : ''}
    <div class="tm"><span class="tk-id">${esc(t.id)}</span>${t.steps.length ? `<span>·</span>${I('tasks', 'sm')}${stepsOf(t)} steps` : ''}${t.tags.length ? '<span>·</span>' + t.tags.map((g) => esc(g)).join(', ') : ''}${t.from === 'claude' && t.for === 'me' ? `<span>·</span>${I('sparkle', 'sm')}from Claude` : ''}${t.target && tgById(t.target) ? `<span>·</span><span class="tk-tg-in">${I('flag', 'sm')}${esc(tgById(t.target).title)}</span>` : ''}</div></div>`;

  /* the board by priority: a column per priority, open tasks only (Done and Dropped stay in the status board and the
     List). A card dropped in another column takes its priority; in a column, the most advanced status comes first. */
  const PLANES = [[1, 'Urgent'], [2, 'High'], [3, 'Normal'], [4, 'Low']];
  function prioBoardHtml(vp, list, all) {
    const open = list.filter(isOpen);
    return `<div class="board tk-board tk-pboard">${PLANES.map(([p, label]) => {
      const ts = open.filter((t) => (PRIO[t.priority] ? t.priority : 3) === p).sort((a, b) => STRANK[a.status] - STRANK[b.status] || (a.order || 0) - (b.order || 0));
      return `<div class="lane" data-plane="${p}"><div class="lane-h">${prio(p)}<span class="faint">${ts.length}</span><button class="ibtn sm" data-addprio="${p}" title="New task, ${label}">${I('plus', 'sm')}</button></div>${ts.map((t) => card(t, all, true)).join('')}</div>`;
    }).join('')}</div>`;
  }
  function boardHtml(vp, list, all) {
    if (vp.state.by === 'prio') return prioBoardHtml(vp, list, all);
    return `<div class="board tk-board">${LANES.map(([k, label, st]) => {
      let ts = list.filter((t) => t.status === k).sort(laneSort(k));
      const n = ts.length, more = k === 'done' && n > 20 ? n - 20 : 0; if (more) ts = ts.slice(0, 20);
      return `<div class="lane" data-lane="${k}"><div class="lane-h" title="${esc(LANE_HELP[k])}">${MC.st(st, label)}<span class="faint">${n}</span><button class="ibtn sm" data-addin="${k}" title="New task in ${label}">${I('plus', 'sm')}</button></div>${ts.map((t) => card(t, all)).join('')}${more ? `<div class="faint tk-more">${more} more in the List</div>` : ''}</div>`;
    }).join('')}</div>`;
  }
  /* the List sorts by a column: a click sorts by it, a second click turns the order around, a third goes back to the
     usual order (status, then priority, then due date). Tasks with no due date stay last either way. */
  const LCOLS = [['title', 'Task'], ['status', 'Status'], ['priority', 'Priority'], ['due', 'Due'], ['progress', 'Progress']];
  const dueMs = (t) => (t.due ? new Date(t.due.length === 10 ? t.due + 'T23:59' : t.due).getTime() : null);
  const byUsual = (a, b) => STRANK[a.status] - STRANK[b.status] || a.priority - b.priority || String(a.due || '9').localeCompare(String(b.due || '9'));
  const LSORT = {
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
    status: (a, b) => STRANK[a.status] - STRANK[b.status],
    priority: (a, b) => a.priority - b.priority,
    progress: (a, b) => pct(a) - pct(b),
  };
  function listSort(rows, so) {
    if (!so || !LCOLS.some((c) => c[0] === so.k)) return rows.sort(byUsual);
    const dir = so.d === 'desc' ? -1 : 1;
    if (so.k === 'due') return rows.sort((a, b) => { const x = dueMs(a), y = dueMs(b); return x == null || y == null ? (x == null) - (y == null) || byUsual(a, b) : dir * (x - y) || byUsual(a, b); });
    return rows.sort((a, b) => dir * LSORT[so.k](a, b) || byUsual(a, b));
  }
  function listHtml(vp, list, all) {
    const so = vp.state.sort;
    const rows = listSort(list.filter((t) => vp.state.dropped || t.status !== 'dropped'), so);
    const hd = LCOLS.map(([k, label]) => { const on = so && so.k === k; return `<button class="tk-sort${on ? ' on' : ''}" data-sort="${k}" title="Sort by ${label.toLowerCase()}">${label}${on ? `<span class="tk-arr">${so.d === 'desc' ? '↓' : '↑'}</span>` : ''}</button>`; }).join('');
    return `<div class="tlist tk-list"><div class="trow hd"><span></span>${hd}</div>${rows.map((t) => `<div class="trow" data-t="${esc(t.id)}" draggable="true"><span class="cbx${t.status === 'done' ? ' on' : ''}" data-done="${esc(t.id)}" title="${t.status === 'done' ? 'Open it again' : 'Mark done'}">${t.status === 'done' ? I('check') : ''}</span><span class="tk-ttl ${t.status === 'done' || t.status === 'dropped' ? 'ttl-done' : ''}">${all ? MC.pchip(projName(t.project)) + ' ' : ''}${esc(t.title)}${t.for === 'claude' ? ' <span class="faint" style="font-size:calc(14px*var(--k))">· for Claude</span>' : ''}${t.blocked ? ` <span class="tk-blk in">${I('warn', 'sm')}Blocked</span>` : ''}</span><span>${MC.st(laneOf(t.status)[2], STATUS[t.status])}</span><span>${prio(t.priority)}</span><span>${dueTag(t) || '<span class="faint">None</span>'}</span><span class="row">${t.steps.length ? `<span class="bar grow ${pct(t) === 100 ? 'ok' : ''}"><i style="width:${pct(t)}%"></i></span><span class="faint" style="width:calc(40px*var(--k));text-align:right">${pct(t)}%</span>` : ''}</span></div>`).join('') || '<div class="trow"><span></span><span class="faint">No tasks</span></div>'}</div>`;
  }
  /* the week: what is due (and what is planned) each day, Monday to Sunday */
  function weekHtml(vp, list) {
    const off = vp.state.wk || 0, mon = new Date(); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) + off * 7);
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(d.getDate() + i); return d; });
    const on = (s, k) => !!s && s.slice(0, 10) === k;
    const items = (d) => { const k = isoDay(d); return list.filter((t) => t.status !== 'dropped' && (on(t.due, k) || on(t.planned, k))).sort((a, b) => String((on(a.planned, k) ? a.planned : a.due)).localeCompare(String(on(b.planned, k) ? b.planned : b.due))); };
    const label = `${MON[days[0].getMonth()]} ${days[0].getDate()} to ${MON[days[6].getMonth()]} ${days[6].getDate()}`;
    const tgs = targetsOf(vp), tray = list.filter((t) => !t.due && !t.planned && t.status !== 'done' && t.status !== 'dropped').sort((a, b) => a.priority - b.priority).slice(0, 40);
    return `<div class="row tk-wkbar"><button class="ibtn sm" data-wk="-1" title="Week before">${I('chevL', 'sm')}</button><b>${label}</b><button class="ibtn sm" data-wk="1" title="Week after">${I('chevR', 'sm')}</button>${off ? '<button class="btn sm ghost" data-wk="0">This week</button>' : ''}</div>
      ${tray.length ? `<div class="tk-tray"><span class="faint">${I('grip', 'sm')}Not planned</span>${tray.map((t) => `<span class="tk-tray-i" draggable="true" data-drag="${esc(t.id)}" data-t="${esc(t.id)}">${esc(t.title)}</span>`).join('')}</div>` : ''}
      <div class="week tk-week">${days.map((d) => { const k = isoDay(d); return `<div class="day ${k === today() ? 'today' : ''}" data-day="${k}">${DOW[d.getDay()]}<b>${d.getDate()}</b>${tgs.filter((g) => g.due && g.due.slice(0, 10) === k).map((g) => `<i class="tgt" data-tg="${esc(g.id)}" title="Goal: ${esc(g.title)}">${I('flag', 'sm')}<span>${esc(g.title)}</span></i>`).join('')}${items(d).map((t) => { const isDue = on(t.due, k), tm = (isDue ? t.due : t.planned).slice(11, 16); return `<i data-t="${esc(t.id)}" draggable="true" data-drag="${esc(t.id)}" data-kind="${isDue ? 'due' : 'planned'}" class="${t.status === 'done' ? 'done' : isDue && overdue(t) ? 'late' : ''}" title="${isDue ? 'Due' : 'Planned'}: ${esc(t.title)}">${I(isDue ? 'flag' : 'clock', 'sm')}<span>${tm ? esc(tm) + ' ' : ''}${esc(t.title)}</span></i>`; }).join('')}</div>`; }).join('')}</div>`;
  }

  /* ---------- the task in full ---------- */
  const chip = (k, icon, label, val, set) => `<button class="tk-chip${set ? '' : ' unset'}" data-chip="${k}" title="${esc(label)}">${I(icon, 'sm')}<span class="ellip">${esc(val)}</span></button>`;
  function sideHtml(t, vp) {
    if (!t) return '';
    const open = t.status !== 'done' && t.status !== 'dropped';
    const sessions = (t.links || []).filter((l) => l.kind === 'session');
    const L = LANES.find((x) => x[0] === t.status) || ['dropped', 'Dropped', 'idle'];
    const acts = t.status === 'review'
      ? `<button class="btn sm primary" data-act="approve">${I('check', 'sm')}Approve: done</button><button class="btn sm" data-act="back">${I('undo', 'sm')}Send back</button>`
      : open ? `<button class="btn sm primary" data-act="claude">${I('sparkle', 'sm')}Start with Claude</button><button class="btn sm" data-act="done">${I('check', 'sm')}Mark done</button>`
        : `<button class="btn sm" data-act="reopen">${I('undo', 'sm')}Open again</button>`;
    const logOpen = !!vp.state.log;
    return `<div class="tk-side" data-t="${esc(t.id)}">
      <div class="tk-sh"><span class="tk-id">${esc(t.id)}</span><button class="tk-stat" data-chip="status" title="Status">${MC.st(L[2], STATUS[t.status])}${I('chev', 'sm')}</button><span class="faint ellip">${t.from === 'claude' ? 'by Claude' : 'by you'}, ${esc(H.ago(t.created))}</span><span class="grow"></span>${vp.state.solo ? `<button class="btn sm ghost" data-act="intasks" title="Open it in the Tasks panel">${I('ext', 'sm')}Open in Tasks</button>` : ''}<button class="ibtn sm" data-act="more" title="More">${I('more', 'sm')}</button><button class="ibtn sm" data-act="close" title="Close">${I('x', 'sm')}</button></div>
      <div class="input tk-titlebox"><textarea class="tk-title" data-f="title" rows="1" spellcheck="false">${esc(t.title)}</textarea></div>
      <div class="tk-chips">
        ${chip('for', t.for === 'claude' ? 'sparkle' : 'user', 'Who does it', t.for === 'claude' ? 'For Claude' : 'For you', true)}
        ${chip('priority', (PRIO[t.priority] || PRIO[3])[1], 'Priority', (PRIO[t.priority] || PRIO[3])[2], t.priority !== 3)}
        ${chip('due', 'cal', 'Due', t.due ? 'Due ' + dayText(t.due) : 'Due date', !!t.due)}
        ${chip('planned', 'clock', 'Planned', t.planned ? 'Planned ' + dayText(t.planned) : 'Plan', !!t.planned)}
        ${chip('estimate', 'box', 'Size', t.estimate ? 'Size ' + t.estimate : 'Size', !!t.estimate)}
        ${chip('project', 'folder', 'Project', projName(t.project), true)}
        ${chip('target', 'flag', 'Goal', t.target && tgById(t.target) ? tgById(t.target).title : 'Goal', !!(t.target && tgById(t.target)))}
        ${chip('tags', 'hash', 'Tags', t.tags.length ? t.tags.join(', ') : 'Tags', !!t.tags.length)}
      </div>
      ${t.blocked ? `<div class="tk-blk big">${I('warn', 'sm')}<span class="grow">Blocked: ${esc(t.blocked)}</span><button class="btn sm ghost" data-act="unblock">Clear</button></div>` : ''}
      <div class="tk-acts">${acts}</div>
      <div class="tk-h">Notes</div><div class="input tk-area tk-notes"><textarea data-f="notes" rows="5" spellcheck="false">${esc(t.notes)}</textarea></div>
      <div class="tk-h">Steps <span class="faint">${stepsOf(t)}</span></div>
      <div class="subs">${t.steps.map((s, i) => `<div class="sub ${s.done ? 'done' : ''}" data-step="${i + 1}"><span class="cbx">${s.done ? I('check') : ''}</span><span class="grow">${esc(s.text)}</span><button class="ibtn sm tk-rm" data-rmstep="${i}" title="Remove this step">${I('x', 'sm')}</button></div>`).join('')}
        <div class="sub tk-addstep"><span class="cbx" style="border-style:dashed">${I('plus')}</span><input class="grow" data-addstep placeholder="Add a step"></div></div>
      <div class="tk-h">Done when</div><div class="input tk-area tk-dw"><textarea data-f="doneWhen" rows="2" spellcheck="false">${esc(t.doneWhen.join('\n'))}</textarea></div>
      ${sessions.length ? `<div class="tk-h">Conversations</div><div class="tk-links">${sessions.map((l) => `<button class="btn sm ghost" data-sess="${esc(l.id)}">${I('chat', 'sm')}<span class="ellip">${esc(((LV.rows || {})[l.id] || {}).title || 'Conversation ' + l.id.slice(0, 8))}</span><span class="faint">${esc(H.ago(l.at))}</span></button>`).join('')}</div>` : ''}
      <div class="row tk-note"><div class="input grow"><input data-note placeholder="Add a note"></div><button class="btn sm" data-act="note">Add</button></div>
      <button class="tk-h tk-logh" data-act="log">${I(logOpen ? 'chev' : 'chevR', 'sm')}Log <span class="faint">${(t.log || []).length}</span></button>
      ${logOpen ? `<div class="tk-log">${(t.log || []).slice(-40).reverse().map((l) => `<div><span class="tk-lw">${l.who === 'claude' ? I('sparkle', 'sm') + 'Claude' : I('user', 'sm') + 'You'}</span><span class="grow">${esc(l.text)}</span><span class="faint">${esc(H.ago(l.at))}</span></div>`).join('')}</div>` : ''}
    </div>`;
  }
  /* the choices behind a chip */
  function whenItems(cur) {
    const d = new Date(); d.setHours(0, 0, 0, 0); const out = [];
    const add = (label, x, sub) => out.push({ id: isoDay(x), label, sub, icon: 'cal', on: !!cur && cur.slice(0, 10) === isoDay(x) });
    add('Today', d); const t1 = new Date(d); t1.setDate(d.getDate() + 1); add('Tomorrow', t1);
    for (let i = 2; i < 7; i++) { const x = new Date(d); x.setDate(d.getDate() + i); add(DOW[x.getDay()], x, `${MON[x.getMonth()]} ${x.getDate()}`); }
    [[7, 'In a week'], [14, 'In two weeks']].forEach(([n, l]) => { const x = new Date(d); x.setDate(d.getDate() + n); add(l, x, `${DOW[x.getDay()]} ${MON[x.getMonth()]} ${x.getDate()}`); });
    return [...out, { sep: 1 }, { id: '*pick', label: 'Another day or a time…', icon: 'clock' }, ...(cur ? [{ id: '*none', label: 'None', icon: 'x' }] : [])];
  }
  async function chipMenu(anchor, t, k) {
    const pick = (items, fn) => MC.menu(anchor, items, fn);
    if (k === 'status') return pick([{ h: 'Status' }, ...Object.entries(STATUS).map(([v, l]) => ({ id: v, label: l, icon: (LANES.find((x) => x[0] === v) || [0, 0, 0, 'x'])[3], on: t.status === v }))], (v) => put(t.id, { status: v }));
    if (k === 'for') return pick([{ h: 'Who does it' }, { id: 'me', label: 'You', icon: 'user', on: t.for === 'me' }, { id: 'claude', label: 'Claude', icon: 'sparkle', on: t.for === 'claude' }], (v) => put(t.id, { for: v }));
    if (k === 'priority') return pick([{ h: 'Priority' }, ...[1, 2, 3, 4].map((p) => ({ id: String(p), label: PRIO[p][2], icon: PRIO[p][1], on: t.priority === p }))], (v) => put(t.id, { priority: Number(v) }));
    if (k === 'estimate') return pick([{ h: 'Size' }, ...['S', 'M', 'L', 'XL'].map((s) => ({ id: s, label: s, icon: 'box', on: t.estimate === s })), { id: '*none', label: 'None', icon: 'x' }], (v) => put(t.id, { estimate: v === '*none' ? null : v }));
    if (k === 'project') return pick([{ h: 'Project' }, { id: '*none', label: 'Personal', icon: 'user', on: !t.project }, ...projectItems(t.project)], (v) => put(t.id, { project: v === '*none' ? null : v }));
    if (k === 'target') {
      const gs = TK.targets.filter((g) => goalIn(g, t.project) || g.id === t.target).sort(goalSort);
      return pick([{ h: 'Goal' }, ...gs.map((g) => ({ id: g.id, label: g.title, sub: g.due ? dayText(g.due) : '', icon: 'flag', on: t.target === g.id })), ...(gs.length ? [{ sep: 1 }] : []), { id: '*new', label: 'New goal…', icon: 'plus' }, ...(t.target ? [{ id: '*none', label: 'None', icon: 'x' }] : [])], async (v) => {
        if (v === '*none') return put(t.id, { target: null });
        if (v === '*new') { const before = new Set(TK.targets.map((g) => g.id)); await newTarget(t.project); const g = TK.targets.find((x) => !before.has(x.id)); if (g) put(t.id, { target: g.id }); return; }
        put(t.id, { target: v });
      });
    }
    if (k === 'tags') { const v = await MC.askText('Tags', 'Words, with commas between them', t.tags.join(', ')); if (v != null) put(t.id, { tags: v.split(/[,\s]+/).filter(Boolean) }); return; }
    if (k === 'due' || k === 'planned') {
      const cur = t[k];
      return pick([{ h: k === 'due' ? 'Due' : 'Planned' }, ...whenItems(cur)], async (v) => {
        if (v === '*none') return put(t.id, { [k]: null });
        if (v === '*pick') {
          const s = await MC.askText(k === 'due' ? 'Due' : 'Planned', 'For example: fri 14:00, nov 12, 2026-11-20 9:30', cur ? cur.replace('T', ' ') : '');
          if (s == null) return; if (!s.trim()) return put(t.id, { [k]: null });
          const r = when(s.trim().split(/\s+/)); if (!r) { MC.toast('That is not a date I know', 'warn'); return; }
          return put(t.id, { [k]: r[0] });
        }
        put(t.id, { [k]: v + (cur && cur.length > 10 ? cur.slice(10) : '') });
      });
    }
  }

  /* where Claude works on a task: { pid } a project of this PC, { home } one of the linked PC's (its id there). The task's
     own project first (the side panel's pick says which PC when both have it), else the project picked in the side panel,
     which the task then keeps (save). null: ask. */
  function startPlace(t) {
    const sel = H.pidOf(), lp = sel && H.linkProj(sel), picked = realPid();
    if (t.project) {
      const here = !!hereProj(t.project), there = !!homeProj(t.project);
      if (there && (!here || (lp && lp.rid === t.project))) return { home: t.project };
      return here ? { pid: t.project } : null;
    }
    if (!picked) return null;
    return lp ? { home: picked, save: true } : hereProj(picked) ? { pid: picked, save: true } : null;
  }
  async function startTask(t, place, btn) {
    if (btn) btn.disabled = true;
    const pid = place.home || place.pid;
    try {
      if (place.home && !(LV.link && LV.link.online)) throw new Error(`${linkName()} is not online`);
      const patch = { ...(t.for !== 'claude' || t.status === 'inbox' ? { for: 'claude', ...(t.status === 'inbox' ? { status: 'todo' } : {}) } : {}), ...(place.save ? { project: pid } : {}) };
      if (Object.keys(patch).length) await api.put(`/api/tasks/${enc(t.id)}`, patch);
      const prompt = `Work on task ${t.id}: ${t.title}\n\nRead it in full with task_get, then call task_start. Do the work, tick its steps with task_step as you go, and note anything I should know with task_note. When its "done when" checks pass, call task_finish with a short summary. If you cannot go on, call task_block with the reason.`;
      await api.post(place.home ? '/api/pc/chat' : '/api/chat', { prompt, ...(pid ? { projectId: pid } : {}) });
      H.loadRuns();
      MC.toast(place.home ? `Claude started on ${t.id} on ${linkName()}, in ${homeProj(pid).name}.` : `Claude started on ${t.id}. The conversation is in ${projName(pid)}.`, 'sparkle');
    } catch (er) { MC.toast('Not started: ' + H.errText(er), 'warn'); }
    if (btn) btn.disabled = false;
    load();
  }
  async function newTask(vp, status, pid, extra = {}) {
    const g = vp.state.tg && tgById(vp.state.tg);
    try {
      const r = await api.post('/api/tasks', { title: 'New task', project: g && g.project ? g.project : pid, ...(g ? { target: g.id } : {}), ...(status ? { status } : {}), ...extra });
      vp.state.open = r.tasks[0].id; vp.state.fresh = r.tasks[0].id; await load();
    } catch (e) { MC.toast('Not added: ' + H.errText(e), 'warn'); }
  }

  M.tasks = {
    label: 'Tasks', icon: 'tasks', tabs: ['Board', 'List', 'Week'], scope: true,
    render: (vp) => {
      if (!TK.loaded) { load(); return '<div class="tasks"><div class="faint">Loading tasks…</div></div>'; }
      if (vp.state.solo) { const t = byId(vp.state.open); return `<div class="tk tk-solo" data-pid="${esc((t && t.project) || '')}">${t ? sideHtml(t, vp) : '<div class="lv-empty">This task is gone</div>'}</div>`; }
      pendingFor(vp);
      if (vp.state.tg && (vp.state.tg === '*none' ? !targetsOf(vp).length : !targetsOf(vp).some((g) => g.id === vp.state.tg))) vp.state.tg = null;
      const G = goalsHtml(vp);
      const tab = ['List', 'Week'].includes(vp.tab) ? vp.tab : 'Board', { pid, all } = scopeOf(vp), list = shown(vp), F = vp.state.fl || {};
      const nOpen = list.filter((t) => t.status !== 'done' && t.status !== 'dropped').length, nDone = list.filter((t) => t.status === 'done').length;
      const t = vp.state.open && byId(vp.state.open);
      const fb = (k, icon, label) => `<button class="btn sm ghost tk-wide${F[k] ? ' on' : ''}" data-fl="${k}">${I(icon, 'sm')}${label}</button>`;
      /* a narrow panel: who, this week and dropped go in one dropdown next to the goal one */
      const fWho = F.me ? ['user', 'For you'] : F.claude ? ['sparkle', 'For Claude'] : ['user', 'Everyone'], fMore = (F.week ? 1 : 0) + (tab === 'List' && vp.state.dropped ? 1 : 0);
      vp._filterItems = [{ h: 'Who does it' }, { id: 'who:', label: 'Everyone', icon: 'user', on: !F.me && !F.claude }, { id: 'who:me', label: 'For you', icon: 'user', on: !!F.me }, { id: 'who:claude', label: 'For Claude', icon: 'sparkle', on: !!F.claude }, { sep: 1 },
        { id: 'week', label: 'Due this week', icon: 'cal', on: !!F.week }, ...(tab === 'List' ? [{ id: 'dropped', label: 'Show dropped', icon: 'x', on: !!vp.state.dropped }] : [])];
      const strip = `<div class="tk-gstrip">${G.strip}<button class="btn sm tk-gpick${F.me || F.claude || fMore ? ' on' : ''}" data-fpick title="Who, this week, dropped">${I(fWho[0], 'sm')}<span class="ellip">${fWho[1]}</span>${fMore ? `<span class="faint">+${fMore}</span>` : ''}${I('chev', 'sm')}</button></div>`;
      return `<div class="tk${t ? ' with-side' : ''}" data-pid="${esc(pid || '')}">${G.col}<div class="tk-main tasks">
        ${TK.err ? `<div class="tk-err">${I('warn', 'sm')}Could not load the tasks: ${esc(TK.err)} <button class="btn sm ghost" data-act="retry">Try again</button></div>` : ''}
        <div class="tbar"><div class="input tk-q">${I('search', 'sm')}<input data-q placeholder="Filter tasks" value="${esc(vp.state.q || '')}"></div>
          ${fb('me', 'user', 'For you')}${fb('claude', 'sparkle', 'For Claude')}${fb('week', 'cal', 'Due this week')}
          ${tab === 'List' ? `<button class="btn sm ghost tk-wide${vp.state.dropped ? ' on' : ''}" data-act="dropped">${I('x', 'sm')}Dropped</button>` : ''}
          ${tab === 'Board' ? `<span class="seg tk-seg" role="group" aria-label="Columns" title="Columns by status or by priority"><button class="${vp.state.by === 'prio' ? '' : 'on'}" data-by="status">Status</button><button class="${vp.state.by === 'prio' ? 'on' : ''}" data-by="prio">Priority</button></span>` : ''}
          <span class="grow tk-wide"></span><span class="faint tk-count">${nOpen} open · ${nDone} done</span><button class="btn sm primary tk-new" data-newtask title="New task">${I('plus', 'sm')}<span>New task</span></button></div>
        ${strip}
        ${tab === 'List' ? listHtml(vp, list, all) : tab === 'Week' ? weekHtml(vp, list) : boardHtml(vp, list, all)}
      </div>${sideHtml(t, vp)}</div>`;
    },
    mount: (el, vp) => {
      const root = $('.tk', el); if (!root) return;
      const pid = root.dataset.pid || null;
      const rerender = () => MC.emit('rerender', 'tasks');
      root.onclick = async (e) => {
        const tg = e.target;
        const fl = tg.closest('[data-fl]'); if (fl) { const F = vp.state.fl = { ...(vp.state.fl || {}) }, k = fl.dataset.fl; F[k] = !F[k]; if (k === 'me' && F.me) F.claude = false; if (k === 'claude' && F.claude) F.me = false; rerender(); return; }
        if (tg.closest('[data-newtask]')) return newTask(vp, null, pid);
        const by = tg.closest('[data-by]'); if (by) { vp.state.by = by.dataset.by === 'prio' ? 'prio' : null; rerender(); return; }
        const so = tg.closest('[data-sort]'); if (so) { const k = so.dataset.sort, cur = vp.state.sort; vp.state.sort = !cur || cur.k !== k ? { k, d: 'asc' } : cur.d === 'asc' ? { k, d: 'desc' } : null; rerender(); return; }
        const ap = tg.closest('[data-addprio]'); if (ap) return newTask(vp, null, pid, { priority: Number(ap.dataset.addprio) });
        const gm = tg.closest('[data-goalmenu]'); if (gm) { const g = tgById(gm.dataset.goalmenu); if (g) targetMenu(gm, g, vp); return; }
        const gl = tg.closest('[data-goal]'); if (gl) { vp.state.tg = gl.dataset.goal || null; rerender(); return; }
        const fp = tg.closest('[data-fpick]'); if (fp) { MC.menu(fp, vp._filterItems || [], (id) => { const F = vp.state.fl = { ...(vp.state.fl || {}) }; if (id.startsWith('who:')) { F.me = id === 'who:me'; F.claude = id === 'who:claude'; } else if (id === 'week') F.week = !F.week; else if (id === 'dropped') vp.state.dropped = !vp.state.dropped; rerender(); }); return; }
        const gp = tg.closest('[data-gpick]'); if (gp) { MC.menu(gp, vp._goalItems || [], (id) => { if (id === 'new') newTarget(pid); else { vp.state.tg = id.slice(2) || null; rerender(); } }); return; }
        const tgb = tg.closest('[data-tg]'); if (tgb) { const g = tgById(tgb.dataset.tg); if (g) targetMenu(tgb, g, vp); return; }
        if (tg.closest('[data-act="newtarget"]')) return newTarget(pid);
        const ai = tg.closest('[data-addin]'); if (ai) return newTask(vp, ai.dataset.addin, pid);
        const wk = tg.closest('[data-wk]'); if (wk) { vp.state.wk = wk.dataset.wk === '0' ? 0 : (vp.state.wk || 0) + Number(wk.dataset.wk); rerender(); return; }
        const dn = tg.closest('[data-done]'); if (dn) { const t = byId(dn.dataset.done); if (t) put(t.id, { status: t.status === 'done' ? 'todo' : 'done' }); return; }
        const side = tg.closest('.tk-side'), st = side && byId(side.dataset.t);
        const ch = tg.closest('[data-chip]'); if (ch && st) return chipMenu(ch, st, ch.dataset.chip);
        const sp = tg.closest('[data-step]'); if (sp && st && !tg.closest('[data-rmstep]')) { api.post(`/api/tasks/${enc(st.id)}/step`, { step: Number(sp.dataset.step) }).then(load, fail('Not ticked')); return; }
        const rs = tg.closest('[data-rmstep]'); if (rs && st) { put(st.id, { steps: st.steps.filter((_, i) => i !== Number(rs.dataset.rmstep)) }); return; }
        const ss = tg.closest('[data-sess]'); if (ss) { MC.setSession(ss.dataset.sess); MC.emit('open', 'convo'); return; }
        const a = tg.closest('[data-act]');
        if (a) {
          const act = a.dataset.act, t = st;
          if (act === 'retry') return load();
          if (act === 'dropped') { vp.state.dropped = !vp.state.dropped; return rerender(); }
          if (act === 'close') { if (vp.state.solo) return popClose(); delete vp.state.open; return rerender(); }
          if (act === 'intasks') { const t0 = byId(vp.state.open); popClose(); if (t0) openTask(t0); return; }
          if (act === 'log') { vp.state.log = !vp.state.log; return rerender(); }
          if (!t) return;
          if (act === 'approve' || act === 'done') return put(t.id, { status: 'done' });
          if (act === 'reopen') return put(t.id, { status: 'todo' });
          if (act === 'unblock') return put(t.id, { blocked: null });
          if (act === 'more') return MC.menu(a, [{ id: 'drop', label: t.status === 'dropped' ? 'Open again' : 'Drop', icon: t.status === 'dropped' ? 'undo' : 'x' }, { id: 'delete', label: 'Delete', icon: 'trash' }], async (v) => {
            if (v === 'drop') return put(t.id, { status: t.status === 'dropped' ? 'todo' : 'dropped' });
            if (await MC.askYes(`Delete ${t.id}?`, `"${t.title}" goes away for good.`, 'Delete')) { delete vp.state.open; api.post(`/api/tasks/${enc(t.id)}/delete`, {}).then(load, fail('Not deleted')); }
          });
          if (act === 'back') { const why = $('[data-note]', side).value.trim(); if (why) await api.post(`/api/tasks/${enc(t.id)}/note`, { text: why }).catch(() => {}); return put(t.id, { status: 'todo' }); }
          if (act === 'note') { const inp = $('[data-note]', side), v = inp.value.trim(); if (!v) return inp.focus(); inp.value = ''; vp.state.log = true; return api.post(`/api/tasks/${enc(t.id)}/note`, { text: v }).then(load, fail('Not added')); }
          if (act === 'claude') {
            const place = startPlace(t);
            if (place) return startTask(t, place, a);
            /* no project to go by: ask, and the task keeps the answer */
            return MC.menu(a, [{ h: t.project ? `${projName(t.project)} is not on this PC or ${linkName()}. Start it in:` : 'Start it in which project?' }, ...projectItems(null), { id: '*none', label: `No project (${MC.place || 'this PC'})`, icon: 'user' }], (v) => {
              if (v === '*none') return startTask(t, { pid: null }, a);
              startTask(t, { ...(hereProj(v) ? { pid: v } : { home: v }), save: !t.project }, a);
            });
          }
          return;
        }
        const c = tg.closest('[data-t]'); if (c && !side) { vp.state.open = c.dataset.t; delete vp.state.log; rerender(); }
      };
      $$('.tk-goals [data-goal]', root).forEach((r) => {
        const id = r.dataset.goal, g = tgById(id);
        if (g) r.oncontextmenu = (e) => { e.preventDefault(); targetMenu(r, g, vp); };
        r.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === r) { e.preventDefault(); r.click(); } };
        if (!id) return; /* All tasks takes no drop */
        const ok = (e) => e.dataTransfer.types.includes('text/mc-task') || e.dataTransfer.types.includes('text/mc-plan');
        r.ondragover = (e) => { if (!ok(e)) return; e.preventDefault(); r.classList.add('drop'); };
        r.ondragleave = (e) => { if (!r.contains(e.relatedTarget)) r.classList.remove('drop'); };
        r.ondrop = (e) => {
          e.preventDefault(); r.classList.remove('drop'); $$('.tk-gap', root).forEach((x) => x.remove());
          const tid = e.dataTransfer.getData('text/mc-task') || e.dataTransfer.getData('text/mc-plan').split('|')[0], t = byId(tid); if (!t) return;
          const v = g ? g.id : null; if ((t.target || null) === v || (!g && inNone(t))) return;
          t.target = v; rerender(); api.put(`/api/tasks/${enc(tid)}`, { target: v }).then(() => { MC.toast(g ? `${t.id} is in ${g.title}` : `${t.id} is in no goal`, 'flag'); load(); }, fail('Not moved'));
        };
      });
      const q = $('[data-q]', root);
      if (q) q.oninput = () => { vp.state.q = q.value; clearTimeout(q._t); q._t = setTimeout(() => { rerender(); setTimeout(() => { const n = $('[data-q]', el); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); }, 250); };
      const side = $('.tk-side', root);
      if (side) {
        const id = side.dataset.t, t = byId(id);
        const ttl = $('.tk-title', side); const fit = () => { ttl.style.height = 'auto'; ttl.style.height = ttl.scrollHeight + 'px'; }; fit(); ttl.oninput = fit;
        /* again whenever its width changes (a window that just opened, a phone turned, the fonts arriving): the height follows the lines */
        if (window.ResizeObserver) { let w = 0; new ResizeObserver(() => { if (ttl.clientWidth !== w) { w = ttl.clientWidth; fit(); } }).observe(ttl); } else requestAnimationFrame(fit);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => ttl.isConnected && fit());
        ttl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ttl.blur(); } };
        if (vp.state.fresh === id) { delete vp.state.fresh; setTimeout(() => { ttl.focus(); ttl.select(); }); }
        const save = (inp) => {
          const k = inp.dataset.f, v = inp.value;
          if (k === 'title') {
            /* the title takes the quick add words too: !1 @claude #tag due fri 14:00 plan tomorrow */
            const x = parseQuick(v); if (!x.title) { inp.value = t.title; return; }
            const patch = { title: x.title }; ['priority', 'for', 'due', 'planned'].forEach((f) => { if (x[f] !== undefined) patch[f] = x[f]; }); if (x.tags.length) patch.tags = [...new Set(t.tags.concat(x.tags))];
            if (Object.keys(patch).length > 1 || x.title !== t.title) put(id, patch);
            return;
          }
          if (k === 'notes') { if (v !== t.notes) put(id, { notes: v }); return; }
          if (k === 'doneWhen' && v.trim() !== t.doneWhen.join('\n')) put(id, { doneWhen: v.split('\n') });
        };
        $$('textarea[data-f]', side).forEach((inp) => { inp.onchange = () => save(inp); });
        const as = $('[data-addstep]', side);
        as.onkeydown = (e) => { if (e.key === 'Enter' && as.value.trim()) { const v = as.value.trim(); as.value = ''; api.post(`/api/tasks/${enc(id)}/step`, { add: v }).then(() => load().then(() => { const n = $('[data-addstep]', el); n && n.focus(); }), fail('Not added')); } };
        const nt = $('[data-note]', side);
        nt.onkeydown = (e) => { if (e.key === 'Enter') $('[data-act="note"]', side).click(); };
      }
      /* the week: drag a task onto a day to plan it there (a due date moves when its own mark is dragged) */
      $$('[data-drag]', root).forEach((x) => {
        x.ondragstart = (e) => { e.dataTransfer.setData('text/mc-plan', x.dataset.drag + '|' + (x.dataset.kind || 'planned')); e.dataTransfer.effectAllowed = 'move'; x.classList.add('dragging'); };
        x.ondragend = () => x.classList.remove('dragging');
      });
      $$('.tk-week .day', root).forEach((d) => {
        d.ondragover = (e) => { if (!e.dataTransfer.types.includes('text/mc-plan')) return; e.preventDefault(); d.classList.add('drop'); };
        d.ondragleave = (e) => { if (!d.contains(e.relatedTarget)) d.classList.remove('drop'); };
        d.ondrop = (e) => {
          e.preventDefault(); d.classList.remove('drop');
          const [id, kind] = e.dataTransfer.getData('text/mc-plan').split('|'), t = byId(id); if (!t) return;
          const cur = t[kind], v = d.dataset.day + (cur && cur.length > 10 ? cur.slice(10) : '');
          if (cur === v) return;
          t[kind] = v; rerender(); put(id, { [kind]: v });
        };
      });
      /* drag a card to another lane, or to another place in its lane */
      $$('.tk-card, .tk-list .trow[data-t]', root).forEach((c) => {
        c.ondragstart = (e) => { e.dataTransfer.setData('text/mc-task', c.dataset.t); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); };
        c.ondragend = () => { c.classList.remove('dragging'); $$('.tk-gap', root).forEach((g) => g.remove()); };
      });
      const gapAt = (lane, y) => { const cards = $$('.tk-card:not(.dragging)', lane); return cards.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; }); };
      $$('.tk-pboard .lane[data-plane]', root).forEach((l) => {
        l.ondragover = (e) => { if (!e.dataTransfer.types.includes('text/mc-task')) return; e.preventDefault(); l.classList.add('drop'); };
        l.ondragleave = (e) => { if (!l.contains(e.relatedTarget)) l.classList.remove('drop'); };
        l.ondrop = (e) => {
          e.preventDefault(); l.classList.remove('drop');
          const id = e.dataTransfer.getData('text/mc-task'), t = byId(id), p = Number(l.dataset.plane); if (!t || t.priority === p) return;
          t.priority = p; rerender(); put(id, { priority: p });
        };
      });
      $$('.tk-board .lane[data-lane]', root).forEach((l) => {
        l.ondragover = (e) => {
          if (!e.dataTransfer.types.includes('text/mc-task')) return;
          e.preventDefault(); l.classList.add('drop');
          let g = $('.tk-gap', root); if (!g) { g = document.createElement('div'); g.className = 'tk-gap'; }
          const cards = $$('.tk-card:not(.dragging)', l), i = gapAt(l, e.clientY);
          if (i < 0) l.insertBefore(g, $('.tk-more', l)); else l.insertBefore(g, cards[i]);
        };
        l.ondragleave = (e) => { if (!l.contains(e.relatedTarget)) { l.classList.remove('drop'); const g = $('.tk-gap', l); g && g.remove(); } };
        l.ondrop = (e) => {
          e.preventDefault(); l.classList.remove('drop');
          const id = e.dataTransfer.getData('text/mc-task'), t = byId(id); if (!t) return;
          const k = l.dataset.lane, i = gapAt(l, e.clientY);
          $$('.tk-gap', root).forEach((g) => g.remove());
          /* the whole lane in its new order (every project's tasks of the lane, so the order of the hidden ones is kept) */
          const ids = TK.list.filter((x) => x.status === k && x.id !== id).sort(laneSort(k)).map((x) => x.id);
          const shownIds = $$('.tk-card:not(.dragging)', l).map((c) => c.dataset.t).filter((x) => x !== id);
          const before = i < 0 ? null : shownIds[i];
          ids.splice(before ? ids.indexOf(before) : ids.length, 0, id);
          t.status = k; ids.forEach((x, n) => { const y = byId(x); if (y) y.order = n + 1; }); rerender(); /* at once, then the server's answer */
          api.post(`/api/task-lanes/${enc(k)}`, { ids }).then(load, fail('Not moved'));
        };
      });
    },
  };

  /* ---------- Next up (Home): every project, what needs doing now ---------- */
  /* opens a task in its project's Plan layout (the Tasks panel there picks up MC.tasks.pending) */
  function openTask(t) {
    const name = t.project && (LV.byId[t.project] || {}).name; if (!name) { MC.toast(`${t.id} is a personal task. Open the Tasks panel with every project to see it.`, 'tasks'); return; }
    MC.tasks.pending = t.id;
    const tab = MC.D.tabs().find((x) => x.project === name);
    if (tab) { tab.ws = 'Plan'; tab.page = 'projects'; MC.D.showTab(tab); } else MC.D.newTab(name, { ws: 'Plan', fly: false });
    setTimeout(() => MC.emit('rerender', 'tasks'), 300);
  }
  function nextUp() {
    const open = TK.list.filter((t) => t.status !== 'done' && t.status !== 'dropped'), k = today();
    const on = (v) => !!v && v.slice(0, 10) === k;
    return {
      late: open.filter(overdue).sort((a, b) => a.due.localeCompare(b.due)),
      today: open.filter((t) => !overdue(t) && (on(t.due) || on(t.planned))).sort((a, b) => String(a.planned || a.due).localeCompare(String(b.planned || b.due))),
      claude: open.filter((t) => t.status === 'doing' && t.for === 'claude'),
      you: open.filter((t) => t.status === 'review' || t.blocked),
    };
  }
  MC.tasks.nextUp = nextUp;
  const nuRow = (t, right) => `<div class="li nu" data-nu="${esc(t.id)}">${I(t.for === 'claude' ? 'sparkle' : 'user', 'sm')}<span class="grow ellip">${esc(t.title)}</span>${t.project ? MC.pchip(projName(t.project)) : '<span class="faint">Personal</span>'}${right}</div>`;
  M.nextup = {
    label: 'Next up', icon: 'tasks',
    render: () => {
      if (!TK.loaded) { load(); return '<div class="lv-empty">' + I('loader', 'sm') + 'Looking</div>'; }
      const N = nextUp(), when2 = (v) => (v ? `<span class="faint mono">${esc(dayText(v))}</span>` : '');
      const sect = (title, icon, list, right) => (list.length ? `<div class="sect-h">${I(icon, 'sm')}${title}<span class="faint">${list.length}</span></div>${list.slice(0, 8).map((t) => nuRow(t, right(t))).join('')}${list.length > 8 ? `<div class="faint nu-more">${list.length - 8} more</div>` : ''}` : '');
      const body = sect('Overdue', 'warn', N.late, (t) => `<span class="urg crit">${I('warn')}${esc(dayText(t.due))}</span>`)
        + sect('Today', 'cal', N.today, (t) => when2(t.planned && t.planned.slice(0, 10) === today() ? t.planned : t.due))
        + sect('Claude works on', 'loader', N.claude, (t) => `<span class="faint">${stepsOf(t) || ''}</span>`)
        + sect('Waits for you', 'eye', N.you, (t) => (t.blocked ? `<span class="tk-blk in">${I('warn', 'sm')}Blocked</span>` : MC.st('wait', 'Review')));
      return `<div class="list nextup">${body || '<div class="empty">Nothing due. Nothing waits.</div>'}</div>`;
    },
    mount: (el) => { el.onclick = (e) => { const r = e.target.closest('[data-nu]'); if (r) { const t = byId(r.dataset.nu); if (t) openTask(t); } }; },
  };
  /* the Tasks panel opens the task Next up or Needs you pointed at */
  const pendingFor = (vp) => { const id = MC.tasks.pending, t = id && byId(id); if (!t) return; const { pid, all } = scopeOf(vp); if (all || t.project === pid) { vp.state.open = id; MC.tasks.pending = null; } };

  /* "To task" and the palette's New task add a real task to the project on screen */
  MC.addTask = (title, by = 'me') => {
    const pid = realPid();
    api.post('/api/tasks', { title: String(title || 'New task').slice(0, 300), project: pid, for: by === 'claude' ? 'claude' : 'me' }).then((r) => { load(); MC.toast(`Added ${r.tasks[0].id}`, 'tasks'); }, fail('Not added'));
    return { id: '', title };
  };
  /* ---------- a task id in a message (md.js links it): a click shows the task, or the goal and its tasks, in a small window ---------- */
  const targetOf = (id) => TK.targets.find((g) => g.id === id);
  MC.md.isTask = (id) => !!(byId(id) || targetOf(id));
  let pop = null, popHost = null, popVps = null;
  const popClose = () => { if (pop) { pop.remove(); pop = null; } };
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop && !e.defaultPrevented) { e.preventDefault(); popClose(); } });
  function popTask(id) {
    const t = byId(id), g = !t && targetOf(id); if (!t && !g) return false;
    popClose();
    if (t) {
      pop = document.createElement('div'); pop.className = 'mdlg';
      pop.innerHTML = `<div class="mbox mcv2 tkp tkp-full" role="dialog" aria-modal="true" aria-label="${esc(t.id)}"></div>`;
      if (!popHost) { popHost = document.createElement('div'); popHost.className = 'tkp-host vps'; }
      pop.firstChild.appendChild(popHost); document.body.appendChild(pop);
      if (!popVps) popVps = new MC.Viewports(popHost, [{ w: 1, rows: [{ mod: 'tasks', tab: 'List', state: { solo: true, open: t.id } }] }], { noOpen: true, active: () => !!pop });
      else { popVps.all()[0].state.open = t.id; popVps.refresh(['tasks']); }
      pop.onclick = (e) => { if (e.target === pop) popClose(); };
      return true;
    }
    const mark = (on) => I(on ? 'tick' : 'circle', 'sm');
    const sect = (h, body) => (body ? `<div class="tkp-s"><div class="sect-h">${h}</div>${body}</div>` : '');
    const row = (x) => `<div class="li tkp-row" data-tkpop="${esc(x.id)}">${mark(x.status === 'done')}<span class="mono faint">${esc(x.id)}</span><span class="grow ellip">${esc(x.title)}</span><span class="faint">${esc(STATUS[x.status] || x.status)}</span></div>`;
    let head, body;
    if (t) {
      const meta = [`<b>${esc(STATUS[t.status] || t.status)}</b>`, prio(t.priority), esc(t.for === 'claude' ? 'For Claude' : 'For you'), esc(projName(t.project)), t.due ? esc('Due ' + dayText(t.due)) : '', t.blocked ? `<span class="urg crit">${I('warn')}Blocked</span>` : ''].filter(Boolean).join('<span class="faint"> · </span>');
      const steps = (t.steps || []).map((s) => `<div class="tkp-step">${mark(s.done)}<span>${esc(s.text)}</span></div>`).join('');
      const dw = (t.doneWhen || []).map((s) => `<div class="tkp-step">${I('check', 'sm')}<span>${esc(s)}</span></div>`).join('');
      const log = (t.log || []).slice(-4).reverse().map((l) => `<div class="tkp-log"><span class="faint">${esc(dayText(l.at.slice(0, 10)))} ${esc(l.at.slice(11, 16))} ${esc(l.who === 'claude' ? 'Claude' : 'You')}</span> ${esc(l.text)}</div>`).join('');
      head = `<span class="badge">${esc(t.id)}</span><b class="ellip">${esc(t.title)}</b>`;
      body = `<div class="tkp-meta">${meta}</div>${t.notes ? `<div class="md tkp-notes">${MC.md(t.notes)}</div>` : ''}${sect('Done when', dw)}${sect(`Steps ${(t.steps || []).filter((s) => s.done).length} of ${(t.steps || []).length}`, steps)}${sect('Latest', log)}`;
    } else {
      const kids = TK.list.filter((x) => x.target === g.id).sort((a, b) => (STRANK[a.status] ?? 9) - (STRANK[b.status] ?? 9));
      head = `<span class="badge">${esc(g.id)}</span><b class="ellip">${esc(g.title)}</b>`;
      body = `<div class="tkp-meta"><b>Goal</b><span class="faint"> · </span>${esc(kids.filter((x) => x.status === 'done').length + ' of ' + kids.length + ' done')}${g.due ? `<span class="faint"> · </span>${esc('Due ' + dayText(g.due))}` : ''}</div>${sect('Tasks', kids.map(row).join('') || '<div class="faint">No task in it yet</div>')}`;
    }
    pop = document.createElement('div'); pop.className = 'mdlg';
    pop.innerHTML = `<div class="mbox mcv2 short tkp" role="dialog" aria-modal="true" aria-label="${esc(id)}"><div class="row mcv2-h">${I('tasks')}${head}<span class="grow"></span>${t ? `<button class="btn sm ghost" data-tkopen>${I('ext', 'sm')}Open in Tasks</button>` : ''}<button class="ibtn sm" data-x title="Close">${I('x', 'sm')}</button></div><div class="mcv2-b">${body}</div></div>`;
    document.body.appendChild(pop);
    pop.onclick = (e) => {
      if (e.target === pop || e.target.closest('[data-x]')) { popClose(); return; }
      if (e.target.closest('[data-tkopen]')) { popClose(); openTask(t); return; }
      const r = e.target.closest('[data-tkpop]'); if (r) popTask(r.dataset.tkpop);
    };
    pop.querySelector('[data-x]').focus();
    return true;
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a.md-task'); if (!a) return;
    e.preventDefault();
    if (!popTask(a.dataset.task)) MC.toast(`${a.dataset.task} is not in the task list`, 'tasks');
  });
  /* the list is read at the start, so task ids in messages link; messages drawn before it came are drawn again once */
  load().then(() => MC.emit('rerender', 'convo'));
  Object.assign(MC.tasks, { load, list: () => TK.list, parseQuick, when, dayText, isoDay, openTask, popTask });
})();
