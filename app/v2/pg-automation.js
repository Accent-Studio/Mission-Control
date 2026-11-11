/* Mission Control 2: the Automation page on real data, ported from today's Skills and schedules page (automation.html).
   Today (a 24 hour ruler of today's runs), the Mission Control tasks in Windows Task Scheduler with Run now, the other
   tasks on this PC (read only) and the skill library. Also makes the Skills panel real. Loads after settings.js. */
(() => {
  const { $$, esc, icon: I } = MC;
  const api = MC.api, M = MC.modules, H = MC.live.helpers, enc = encodeURIComponent;
  const errText = (e) => (e && (e.body && e.body.error)) || (e && e.message) || 'No answer';
  const pad = (n) => String(n).padStart(2, '0');

  const ST = { sched: null, skills: null, err: {}, busy: false, starting: {} };
  let el = null;

  /* ---------- times: the server gives 7 decimals and an offset ---------- */
  const pd = (v) => { if (!v) return null; const d = new Date(String(v).replace(/(\.\d{3})\d+/, '$1')); return isNaN(d) ? null : d; };
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
  function fmt(v) {
    const d = pd(v); if (!d) return '';
    const diff = Math.round((day0(d) - day0(new Date())) / 86400000);
    if (diff === 0) return 'Today ' + hm(d);
    if (diff === 1) return 'Tomorrow ' + hm(d);
    if (diff === -1) return 'Yesterday ' + hm(d);
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) + ', ' + hm(d);
  }
  /* the Task Scheduler result codes: 0 done, 267009 running, 267011 never ran, anything else failed */
  const failed = (t) => !t.neverRan && t.lastResult !== 0 && t.lastResult !== 267009;
  const result = (t) => (t.neverRan ? MC.st('idle', 'Never ran') : t.lastResult === 0 ? MC.st('done', 'OK') : t.lastResult === 267009 ? MC.st('run', 'Running') : MC.st('fail', 'Failed 0x' + Number(t.lastResult).toString(16).toUpperCase().padStart(8, '0')));

  async function loadSched() {
    ST.busy = true; paint();
    try { ST.sched = await api.get('/api/schedules'); ST.err.sched = null; } catch (e) { ST.err.sched = errText(e); }
    ST.busy = false; paint(); MC.D && MC.D.drawBar && MC.D.drawBar();
  }
  async function loadSkills() {
    try { ST.skills = await api.get('/api/skills'); ST.err.skills = null; } catch (e) { ST.err.skills = errText(e); }
    paint();
  }

  /* ---------- Today: the runs left today (both lists) and today's runs of the Mission Control tasks ---------- */
  const pos = (h) => (Math.min(Math.max(h / 24 * 100, 3), 96)).toFixed(2) + '%';
  function todayRuns() {
    const now = new Date(), t0 = day0(now), today = (d) => d && day0(d) === t0, s = ST.sched || {};
    const next = (s.tasks || []).concat(s.other || []).map((t) => ({ n: t.name, d: pd(t.nextRun) })).filter((x) => today(x.d));
    const past = (s.tasks || []).filter((t) => !t.neverRan).map((t) => ({ n: t.name, d: pd(t.lastRun), past: true, fail: failed(t) })).filter((x) => today(x.d) && x.d <= now);
    return { next, all: next.concat(past).sort((a, b) => a.d - b.d) };
  }
  function ruler() {
    const now = new Date(), { next, all } = todayRuns(), hr = (d) => d.getHours() + d.getMinutes() / 60;
    const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<span class="tk" style="left:${(h / 24 * 100).toFixed(2)}%"><span ${h === 0 ? 'style="left:0"' : h === 24 ? 'style="left:calc(-42px*var(--k))"' : ''}>${pad(h)}:00</span></span>`).join('');
    const evs = all.map((e, i) => { const nm = e.n.length > 24 ? e.n.slice(0, 23) + '...' : e.n, h = hr(e.d), at = pos(h), side = h < 2.5 ? 'l' : h > 21.5 ? 'r' : '';
      return `<span class="dm ${e.fail ? 'fail' : ''} ${e.past && !e.fail ? 'past' : ''}" style="left:${at}" title="${esc(e.n)} ${hm(e.d)}"></span><span class="dl ${i % 2 ? 'lo' : 'hi'} ${side} ${e.past ? 'past' : ''}" style="left:${at}">${esc(nm)}${e.fail ? ' · failed' : ''}</span>`; }).join('');
    const label = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + next.length + ' left to run';
    return `<div class="card"><h3>Today<span class="grow"></span><span class="faint">${esc(label)}</span></h3><div class="ruler au-ruler"><div class="ax"></div>${ticks}${evs}<span class="now" style="left:${(hr(now) / 24 * 100).toFixed(2)}%"><b>NOW ${hm(now)}</b></span></div></div>`;
  }

  /* ---------- the Mission Control tasks, then the others on this PC ---------- */
  function schedCard() {
    const s = ST.sched, tasks = (s && s.tasks) || [];
    const head = `<h3>Schedules<span class="grow"></span><span class="faint">${s ? tasks.length : ''}</span>${ST.busy ? I('loader', 'sm') : ''}</h3>`;
    if (!s) return `<div class="card">${head}${ST.err.sched ? `<div class="lv-err">${I('xc', 'sm')}Could not read the schedules: ${esc(ST.err.sched)} <button class="btn sm" data-au="refresh">Try again</button></div>` : `<div class="lv-empty">${I('loader', 'sm')}Reading the schedules</div>`}</div>`;
    const err = s.error ? `<div class="lv-err">${I('xc', 'sm')}${esc(s.error)} <button class="btn sm" data-au="refresh">Try again</button></div>` : '';
    if (!tasks.length) return `<div class="card">${head}${err}${s.error ? '' : `<div class="lv-empty">No tasks in ${esc(s.folder || '\\MissionControl\\')} yet</div>`}</div>`;
    const rows = tasks.map((t, i) => {
      const st = ST.starting[t.name];
      const act = st === 'busy' ? `<span class="faint au-st">${I('loader', 'sm')}Starting</span>` : st === 'ok' ? `<span class="au-st">${MC.st('done', 'Started')}</span>` : `<button class="btn sm" data-run="${esc(t.name)}">${I('play', 'sm')}Run now</button>`;
      return `<div class="tr ${failed(t) ? 'hot' : ''}"><span class="faint mono">${pad(i + 1)}</span><span class="ellip" title="${esc(t.name)}">${esc(t.name)}</span><span class="mono muted au-m">${esc(t.when || 'No trigger')}</span><span class="mono muted au-m">${t.neverRan ? 'Never' : esc(fmt(t.lastRun) || 'Unknown')}</span><span class="au-res">${result(t)}</span><span class="mono muted au-m">${esc(fmt(t.nextRun) || 'Not scheduled')}</span>${act}</div>`;
    }).join('');
    return `<div class="card au-sched">${head}${err}<div class="tbl"><div class="tr hd"><span>#</span><span>Task</span><span>When</span><span>Last run</span><span>Last result</span><span>Next</span><span></span></div>${rows}</div></div>`;
  }
  function otherCard() {
    const o = (ST.sched && ST.sched.other) || [];
    if (!o.length) return '';
    return `<div class="card au-other"><h3>Other tasks on this PC<span class="grow"></span><span class="faint">${o.length}, read only</span></h3><div class="tbl"><div class="tr hd"><span>Task</span><span>State</span><span>Next</span></div>${o.map((t) => `<div class="tr"><span class="ellip" title="${esc(t.name)}">${esc(t.name)}</span><span class="muted au-m">${esc(t.state || '')}</span><span class="mono muted au-m">${esc(fmt(t.nextRun) || 'Not scheduled')}</span></div>`).join('')}</div></div>`;
  }

  /* ---------- the skill library: global, plugins, the rest ---------- */
  const groups = (list) => [['Project', list.filter((s) => s.scope === 'project')], ['Global', list.filter((s) => s.scope === 'global')], ['Plugins', list.filter((s) => s.scope === 'plugin')], ['Other', list.filter((s) => !['project', 'global', 'plugin'].includes(s.scope))]].filter((g) => g[1].length);
  const short = (s) => (s.plugin ? s.plugin + ': ' : '') + String(s.description || '').slice(0, 110);
  function skillCard() {
    const L = ST.skills;
    const body = !L ? (ST.err.skills ? `<div class="lv-err">${I('xc', 'sm')}Could not read the skills: ${esc(ST.err.skills)} <button class="btn sm" data-au="skills">Try again</button></div>` : `<div class="lv-empty">${I('loader', 'sm')}Reading the skills</div>`)
      : !L.length ? '<div class="lv-empty">No skills found</div>'
      : `<div class="skills au-skills">${groups(L).map(([g, a]) => `<span class="lbl">${g} · ${a.length}</span>${a.map((s) => `<button class="au-sk" data-sk="${esc(s.name)}" title="${esc(s.description || '')}">${I('zap', 'sm')}<span class="grow"><b class="ellip">${esc(s.name)}</b><small>${esc(short(s))}</small></span></button>`).join('')}`).join('')}</div>`;
    return `<div class="card"><h3>Skill library<span class="grow"></span><span class="faint">${L ? L.length : ''}</span></h3>${body}</div>`;
  }

  function paint() {
    if (!el || !el.isConnected) return;
    el.innerHTML = ruler() + schedCard() + otherCard() + skillCard();
  }

  /* ---------- a skill goes in front of what a message box holds, never sent: the open conversation's box, else the Com Link's on Home ---------- */
  const shown = (x) => x && !x.disabled && x.getClientRects().length > 0;
  function fillBox(text) {
    const box = $$('.convo textarea.md-in').find(shown) || $$('.cl-in input').find(shown);
    if (!box) return false;
    box.value = text + box.value.replace(/^\/\S+ /, ''); box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus(); box.setSelectionRange(text.length, text.length);
    return true;
  }
  function useSkill(name) {
    const text = '/' + name + ' ';
    if (fillBox(text)) return;
    if (MC.D && MC.D.setPage) MC.D.setPage('home');
    setTimeout(() => { if (fillBox(text)) return; if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {}); MC.toast('Copied ' + text.trim(), 'copy'); }, 60);
  }

  /* ---------- Run now: asked first, then schtasks starts it ---------- */
  async function runNow(name) {
    if (!(await MC.askYes('Run ' + name + ' now?', '', 'Run'))) return;
    ST.starting[name] = 'busy'; paint();
    try {
      await api.post('/api/schedules/' + enc(name) + '/run', {});
      ST.starting[name] = 'ok'; paint(); MC.toast('Started ' + name, 'play');
      setTimeout(() => { delete ST.starting[name]; loadSched(); }, 4000);
    } catch (e) { delete ST.starting[name]; paint(); MC.toast('Not started: ' + errText(e), 'warn'); }
  }

  MC.drawPage.automation = (node) => {
    el = node;
    if (!el._au) {
      el._au = true;
      el.addEventListener('click', (e) => {
        const r = e.target.closest('[data-run]'); if (r) { runNow(r.dataset.run); return; }
        const s = e.target.closest('[data-sk]'); if (s) { useSkill(s.dataset.sk); return; }
        const a = e.target.closest('[data-au]'); if (a && a.dataset.au === 'skills') loadSkills();
      });
      /* the NOW line moves while the page is open */
      setInterval(() => { if (el.offsetParent && !ST.busy) { const r = el.querySelector('.au-ruler'); if (r) r.parentNode.outerHTML = ruler(); } }, 60000);
    }
    paint(); loadSched(); loadSkills();
  };
  MC.pageBar.automation = () => {
    const s = ST.sched;
    const sub = !s ? '' : (s.tasks || []).length + ' Mission Control task' + ((s.tasks || []).length === 1 ? '' : 's') + ', ' + (s.other || []).length + ' other on this PC';
    return { sub, html: `<button class="btn sm" data-au="refresh" ${ST.busy ? 'disabled' : ''}>${I(ST.busy ? 'loader' : 'refresh', 'sm')}Refresh</button>` };
  };
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-au="refresh"]'); if (b) { loadSched(); loadSkills(); } });

  /* ---------- the Skills panel on Home and in a project: that project's skills too ---------- */
  const SK = {};
  const realPid = () => { const id = H.pidOf(); return id && !H.isRootId(id) && !H.isChatId(id) ? id : ''; };
  function panelSkills(pid) {
    const x = SK[pid] || (SK[pid] = {});
    if (!x.busy && (!x.at || Date.now() - x.at > 60000)) {
      x.busy = true;
      api.get('/api/skills' + (pid ? '?project=' + enc(pid) : '')).then((v) => { x.v = v; x.err = null; }, (e) => { x.err = errText(e); }).then(() => { x.busy = false; x.at = Date.now(); MC.emit('rerender', 'skills'); });
    }
    return x;
  }
  M.skills = {
    label: 'Skills', icon: 'zap',
    render: () => {
      const x = panelSkills(realPid());
      if (!x.v) return x.err ? `<div class="list"><div class="lv-err">${I('xc', 'sm')}Could not read the skills: ${esc(x.err)}</div></div>` : `<div class="lv-empty">${I('loader', 'sm')}Reading the skills</div>`;
      if (!x.v.length) return '<div class="lv-empty">No skills found</div>';
      return `<div class="list">${groups(x.v).map(([g, a]) => `<div class="sect-h au-gh">${g}<span class="grow"></span>${a.length}</div>${a.map((s) => `<div class="li">${I('zap')}<div class="grow" style="min-width:0"><div class="mono ellip" style="font-size:calc(16px*var(--k))">/${esc(s.name)}</div><div class="lm au-lm" title="${esc(s.description || '')}">${esc(short(s))}</div></div><button class="btn sm" data-sk="${esc(s.name)}">Use</button></div>`).join('')}`).join('')}</div>`;
    },
    mount: (node) => node.onclick = (e) => { const b = e.target.closest('[data-sk]'); if (b) useSkill(b.dataset.sk); },
  };
})();
