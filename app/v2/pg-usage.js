/* Mission Control 2: the Usage page on real data, ported from today's Usage page (usage.html).
   Range and measure in the page bar; the stat tiles, the year of activity, records, cost over time by model, models, plan
   usage (the two meters now and the two windows over time), when I work, token mix, projects and conversations.
   Everything comes from GET /api/usage/stats (the transcripts, read by the server) and GET /api/usage (the plan meters).
   Loads after panels.js. */
(() => {
  const { $$, esc, icon: I } = MC;
  const api = MC.api, LV = MC.live, H0 = LV.helpers;
  const errText = (e) => (e && e.data && e.data.error) || (e && e.message) || 'the server did not answer';
  const HR = 3600e3, DAY = 24 * HR;
  const FAM = ['opus', 'fable', 'sonnet', 'haiku', 'local', 'other']; /* stack order = the validated color order */
  const FNAME = { opus: 'Opus', fable: 'Fable', sonnet: 'Sonnet', haiku: 'Haiku', local: 'Local (electricity)', other: 'Other' };
  /* model colors: a validated categorical order for dark surfaces (blue, orange, aqua, yellow), always with the name next to
     them, so no chart reads by color alone. Gray is everything else. */
  const FCOL = { opus: '#3987e5', fable: '#d95926', sonnet: '#199e70', haiku: '#c98500', local: '#b48ce8', other: '#627488' }; /* local: a light violet, lighter than the others */
  const MNAME = { cost: 'API cost', tokens: 'Tokens', req: 'Requests', time: 'Active time' };
  /* the activity scale: one blue, darker for little and lighter for a lot, so lightness carries the amount */
  const HEAT = ['var(--press)', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#b7d3f6'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /* the same saved view as the old page, so a pick carries over */
  const LS = 'mc.usage.view';
  const view = Object.assign({ range: '30', measure: 'cost', step: 'auto' }, (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; } })());
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(view)); } catch (e) { /* no storage */ } };
  let el = null, data = null, err = null, busy = false, seq = 0, convShown = 15, again = 0, plan = { err: null, busy: false };
  const shown = () => !!(el && el.isConnected && el.closest('.page.on'));
  const kk = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--k')) || 1;

  /* ---------- numbers ---------- */
  function money(v) { if (!v) return '$0'; if (v < 10) return '$' + v.toFixed(2); if (v < 1000) return '$' + Math.round(v); return '$' + Math.round(v).toLocaleString('en-US'); }
  function toks(n) { if (!n) return '0'; if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'; if (n >= 1e3) return Math.round(n / 1e3) + 'k'; return String(Math.round(n)); }
  function dur(ms) { if (!ms) return '0 min'; const m = ms / 60000; if (m < 60) return Math.max(1, Math.round(m)) + ' min'; const h = m / 60; return (h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h).toLocaleString('en-US')) + 'h'; }
  function count(n) { return Math.round(n || 0).toLocaleString('en-US'); }
  function fmtM(m, v) { return m === 'cost' ? money(v) : m === 'tokens' ? toks(v) : m === 'time' ? dur(v) : count(v); }
  function pct(a, b) { return b ? Math.round(a / b * 100) + '%' : '0%'; }
  const tokOf = (t) => t[1] + t[2] + t[3] + t[4] + t[5];
  function famOf(model) { if (data && data.local && data.local.ids.includes(model)) return 'local'; const m = /(fable|mythos|opus|sonnet|haiku)/.exec(model || ''); return m ? (m[1] === 'mythos' ? 'fable' : m[1]) : 'other'; }
  /* one hour's value of a measure, per family: { fam: v } and the total */
  function hourVals(hr, m) {
    const out = {}; let tot = 0;
    for (const [model, t] of Object.entries(hr.m || {})) {
      const f = famOf(model), v = m === 'cost' ? t[7] : m === 'tokens' ? tokOf(t) : m === 'req' ? t[0] : t[6];
      out[f] = (out[f] || 0) + v; tot += v;
    }
    if (m === 'time') tot = hr.a || 0; /* active time is the conversation's, the per model part splits it */
    return { f: out, tot };
  }
  function dayKey(ms) { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function startOfWeek(ms) { const d = new Date(startOfDay(ms)); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d.getTime(); } /* weeks start on Monday */
  function startOfMonth(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
  function dateText(ms, withYear) { const d = new Date(ms); return MON[d.getMonth()] + ' ' + d.getDate() + (withYear ? ', ' + d.getFullYear() : ''); }
  const hh = (h) => String(h).padStart(2, '0') + ':00';

  /* ---------- the range ---------- */
  const rangeFrom = () => (view.range === 'all' ? 0 : startOfDay(Date.now()) - (Number(view.range) - 1) * DAY);
  function rangeStart() {
    if (view.range !== 'all') return rangeFrom();
    const first = data && data.hours.find((x) => Object.keys(x.m || {}).length || x.a);
    return first ? startOfDay(first.h * HR) : startOfDay(Date.now());
  }
  const inRange = (hr) => hr.h * HR >= rangeStart();
  const autoStep = () => { const days = (Date.now() - rangeStart()) / DAY; return days <= 45 ? 'day' : days <= 200 ? 'week' : 'month'; };
  /* more than about two years of days would be bars too thin to see: weeks then */
  const step = () => { const s = view.step === 'auto' ? autoStep() : view.step; return s === 'day' && (Date.now() - rangeStart()) / DAY > 760 ? 'week' : s; };

  /* ---------- tooltip: one floating box for every [data-ut] on the page ---------- */
  let tip = null;
  function showTip(t, x, y) { if (!tip) { tip = document.createElement('div'); tip.className = 'utip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); } tip.innerHTML = t.getAttribute('data-ut'); tip.hidden = false; placeTip(x, y); }
  function placeTip(x, y) { const w = tip.offsetWidth, h = tip.offsetHeight; let l = x + 14, t = y + 14; if (l + w > innerWidth - 8) l = x - w - 14; if (t + h > innerHeight - 8) t = y - h - 14; tip.style.left = Math.max(8, l) + 'px'; tip.style.top = Math.max(8, t) + 'px'; }
  const hideTip = () => { if (tip) tip.hidden = true; };
  const tipRows = (title, rows) => '<b>' + esc(title) + '</b>' + rows.map((r) => '<div class="ur"><span>' + (r[2] ? '<i style="background:' + r[2] + '"></i>' : '') + esc(r[0]) + '</span><span>' + esc(r[1]) + '</span></div>').join('');
  const ut = (title, rows) => ' data-ut="' + esc(tipRows(title, rows)) + '"';

  /* ---------- loading ---------- */
  async function load() {
    const my = ++seq; busy = true; MC.D.drawBar();
    try { const d = await api.get('/api/usage/stats?from=' + rangeFrom() + '&to=' + (Date.now() + HR)); if (my !== seq) return; data = d; err = null; }
    catch (e) { if (my !== seq) return; err = errText(e); }
    busy = false; draw();
    clearTimeout(again);
    if (data && !data.index.ready) again = setTimeout(() => { if (shown()) load(); }, 4000); /* the first read of every transcript is still going */
  }
  /* the plan meters: the reading panels.js keeps in MC.live.usage, read here too when there is none yet */
  async function loadPlan(force) {
    if (plan.busy) return; plan.busy = true; plan.err = null; paintPlan();
    try { const u = force ? await api.post('/api/usage/refresh', {}) : await api.get('/api/usage'); if (u && u.fiveHour !== undefined) LV.usage = u; }
    catch (e) { plan.err = errText(e); if (force) MC.toast('Could not check: ' + plan.err, 'warn'); }
    plan.busy = false; paintPlan(); if (force && data) load();
  }

  /* ---------- the page ---------- */
  const card = (cls, id, title, right) => `<div class="card ucard ${cls}"><h3>${title}<span class="grow"></span>${right || ''}</h3><div id="${id}"></div></div>`;
  const seg = (attr, opts, cur) => `<span class="seg useg">${opts.map(([v, l]) => `<button data-${attr}="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</span>`;
  function shell() {
    el.innerHTML = `<div class="u-tiles tiles" id="uTiles"></div>`
      + card('c8', 'uHeat', 'Activity', '<span class="faint" id="uHeatN"></span>') + card('c4', 'uRec', 'Records')
      + card('', 'uSeries', 'Over time', `<span id="uStep">${seg('ustep', [['day', 'Day'], ['week', 'Week'], ['month', 'Month']], step())}</span>`)
      + card('c6', 'uModels', 'Models', '<span class="faint">share of each measure</span>') + card('c6', 'uPlan', 'Plan usage', '<span class="faint" id="uPlanN"></span>').replace('<div id="uPlan"></div>', '<div id="uPlan"><div id="uPlanNow"></div><div id="uPlanTs"></div></div>')
      + card('c6', 'uPunch', 'When I work', '<span class="faint" id="uPunchN"></span>') + card('c6', 'uMix', 'Token mix', '<span class="faint" id="uMixN"></span>')
      + card('c5', 'uProj', 'Projects', '<span class="faint" id="uProjN"></span>') + card('c7', 'uConv', 'Conversations', '<span class="faint" id="uConvN"></span>');
  }
  const $id = (id) => el.querySelector('#' + id);
  const empty = (t) => `<div class="lv-empty">${esc(t)}</div>`;
  function draw() {
    if (!shown()) return;
    MC.D.drawBar();
    if (!el.querySelector('#uTiles')) shell();
    paintPlan();
    if (!data) {
      const msg = err ? `<div class="lv-err">${I('xc', 'sm')}Could not load the numbers: ${esc(err)} <button class="btn sm" data-uretry>Try again</button></div>` : `<div class="lv-empty">${I('loader', 'sm')}Adding up</div>`;
      $id('uTiles').innerHTML = `<div class="card" style="grid-column:1/-1">${msg}</div>`; return;
    }
    $id('uStep').innerHTML = seg('ustep', [['day', 'Day'], ['week', 'Week'], ['month', 'Month']], step());
    drawTiles(); drawHeat(); drawRecords(); drawSeries(); drawModels(); drawPlanChart(); drawPunch(); drawMix(); drawProjects(); drawConvs();
  }

  /* ---------- stat tiles ---------- */
  function drawTiles() {
    const T = data.total, days = Math.max(1, Math.round((Date.now() - rangeStart()) / DAY));
    const activeDays = new Set(data.hours.filter(inRange).filter((x) => x.a || Object.keys(x.m).length).map((x) => dayKey(x.h * HR))).size;
    /* [number, label, short note, tooltip] */
    const tiles = [
      [money(T.cost), 'API-equivalent cost', money(T.cost / Math.max(1, activeDays)) + ' per active day', 'What the same work would cost at pay-as-you-go API prices. On a subscription you are not billed this.'],
      [toks(T.tokens), 'Tokens', toks(T.t[2]) + ' written', toks(T.t[2]) + ' written by Claude, the rest read (mostly from the cache)'],
      [count(T.req), 'Requests', count(T.prompts) + ' prompts', count(T.prompts) + ' prompts and ' + count(T.tools) + ' tool calls'],
      [dur(T.activeMs), 'Active time', activeDays + ' of ' + days + ' days', 'Time with Claude at work, added up over conversations: two at once count twice'],
      [count(T.sessions), 'Conversations', pct(T.subCost, T.cost) + ' by helpers', pct(T.subCost, T.cost) + ' of the cost was spent by helper agents'],
      [money(T.saved), 'Saved by the cache', pct(T.t[3], T.t[1] + T.t[3] + T.t[4] + T.t[5]) + ' read from cache', 'What the cache reads would have cost as plain input, minus what they cost'],
    ];
    $id('uTiles').innerHTML = tiles.map((t) => `<div class="tile" title="${esc(t[3])}"><div class="tl">${esc(t[1])}</div><div class="tv">${esc(t[0])}</div><div class="ts ellip">${esc(t[2])}</div></div>`).join('');
  }

  /* ---------- activity: the last 53 weeks, a column per week, Monday on top ---------- */
  function dayTotals(m) {
    const map = new Map();
    for (const hr of data.hours) { const k = dayKey(hr.h * HR), v = hourVals(hr, m).tot; map.set(k, (map.get(k) || 0) + v); }
    return map;
  }
  function drawHeat() {
    const m = view.measure, days = dayTotals(m), box = $id('uHeat'), k = kk();
    const w = box.clientWidth || 800, end = startOfDay(Date.now()), start = startOfWeek(end - 52 * 7 * DAY);
    const cols = Math.round((startOfWeek(end) - start) / (7 * DAY)) + 1, lw = 34 * k, gap = 2, top = 18 * k, cs = Math.max(6, Math.min(18 * k, Math.floor((w - lw) / cols) - gap));
    const vals = [...days.values()].filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0);
    const cuts = [q(0.25), q(0.5), q(0.75), q(0.93)];
    const lvl = (v) => (!v ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : v <= cuts[3] ? 4 : 5);
    let s = '', lastMonth = -1, activeDays = 0, sum = 0;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < 7; r++) {
        const d = new Date(start); d.setDate(d.getDate() + c * 7 + r); const ms = d.getTime(); /* calendar steps, so a daylight saving change never shifts a day */
        if (ms > end) continue;
        if (r === 0 && d.getMonth() !== lastMonth && d.getDate() <= 7) { s += `<text x="${lw + c * (cs + gap)}" y="${11 * k}">${MON[d.getMonth()]}</text>`; lastMonth = d.getMonth(); }
        const v = days.get(dayKey(ms)) || 0; if (v) { activeDays++; sum += v; }
        s += `<rect x="${lw + c * (cs + gap)}" y="${top + r * (cs + gap)}" width="${cs}" height="${cs}" rx="2" style="fill:${HEAT[lvl(v)]}"${ut(d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), [[MNAME[m], fmtM(m, v)]])}/>`;
      }
    }
    [0, 2, 4].forEach((r) => { s += `<text x="0" y="${top + r * (cs + gap) + cs - 2}">${WD[r]}</text>`; });
    const W = lw + cols * (cs + gap), Hh = top + 7 * (cs + gap);
    box.innerHTML = `<svg class="uc" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Activity over the last year">${s}</svg>`
      + `<div class="u-key"><span>Less</span>${HEAT.map((c) => `<i style="background:${c}"></i>`).join('')}<span>More</span></div>`;
    $id('uHeatN').textContent = activeDays + ' active days in the last year, ' + fmtM(m, sum);
  }

  /* ---------- records ---------- */
  function drawRecords() {
    const days = dayTotals('time'), cost = dayTotals('cost');
    /* calendar steps (setDate), so a daylight saving change never skips or repeats a day; today without activity yet does not end the streak */
    const dayN = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return dayKey(d.getTime()); };
    const on = (k) => (days.get(k) || 0) > 0;
    let cur = 0; for (let n = on(dayN(0)) ? 0 : -1; n > -1000 && on(dayN(n)); n--) cur++;
    let best = 0, run = 0; for (let n = -371; n <= 0; n++) { if (on(dayN(n))) { run++; best = Math.max(best, run); } else run = 0; }
    const inR = (k) => new Date(k + 'T12:00:00').getTime() >= rangeStart();
    const topDay = [...cost.entries()].filter((e) => inR(e[0])).sort((a, b) => b[1] - a[1])[0];
    const longDay = [...days.entries()].filter((e) => inR(e[0])).sort((a, b) => b[1] - a[1])[0];
    const byHour = new Array(24).fill(0); data.hours.filter(inRange).forEach((hr) => { byHour[new Date(hr.h * HR).getHours()] += hr.a || 0; });
    const bh = byHour.indexOf(Math.max(...byHour));
    const c0 = data.conversations[0], cl = data.conversations.slice().sort((a, b) => b.activeMs - a.activeMs)[0];
    const T = data.total;
    const rows = [
      ['Streak now', cur ? cur + (cur === 1 ? ' day' : ' days') : 'none', ''],
      ['Longest streak', best + ' days', 'last year'],
      ['Busiest day', topDay ? money(topDay[1]) : 'none', topDay ? dateText(new Date(topDay[0] + 'T12:00:00').getTime()) : ''],
      ['Most active day', longDay ? dur(longDay[1]) : 'none', longDay ? dateText(new Date(longDay[0] + 'T12:00:00').getTime()) : ''],
      ['Busiest hour', byHour[bh] ? hh(bh) : 'none', byHour[bh] ? dur(byHour[bh]) + ' in this range' : ''],
      ['Top conversation', c0 ? c0.title || 'Deleted conversation' : 'none', c0 ? money(c0.cost) : ''],
      ['Longest conversation', cl ? cl.title || 'Deleted conversation' : 'none', cl ? dur(cl.activeMs) : ''],
      ['Cost per prompt', T.prompts ? money(T.cost / T.prompts) : 'none', T.prompts ? count(T.prompts) + ' prompts' : ''],
    ];
    $id('uRec').innerHTML = `<dl class="u-rec">${rows.map((r) => `<dt>${esc(r[0])}</dt><dd title="${esc(r[1] + (r[2] ? ' (' + r[2] + ')' : ''))}"><b>${esc(r[1])}</b>${r[2] ? `<small>${esc(r[2])}</small>` : ''}</dd>`).join('')}</dl>`;
  }

  /* ---------- over time: stacked bars by model family ---------- */
  function bucketsOf(stp) {
    const start = rangeStart(), end = Date.now(), out = [];
    const next = stp === 'day' ? (t) => t + DAY : stp === 'week' ? (t) => t + 7 * DAY : (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); };
    let t = stp === 'day' ? startOfDay(start) : stp === 'week' ? startOfWeek(start) : startOfMonth(start);
    while (t <= end && out.length < 2000) { const n = next(t); out.push({ t, n: startOfDay(n + HR), f: {}, tot: 0 }); t = startOfDay(n + HR); }
    return out;
  }
  function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), r = v / p; return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p; }
  const legend = (fams) => `<div class="u-leg">${fams.map((f) => `<span><i style="background:${FCOL[f]}"></i>${FNAME[f]}</span>`).join('')}</div>`;
  function drawSeries() {
    const m = view.measure, stp = step(), bs = bucketsOf(stp), box = $id('uSeries'), k = kk();
    let bi = 0;
    for (const hr of data.hours) {
      const ms = hr.h * HR; if (!bs.length || ms < bs[0].t) continue;
      while (bi < bs.length - 1 && ms >= bs[bi].n) bi++;
      const v = hourVals(hr, m); bs[bi].tot += v.tot;
      if (m === 'time') { /* the hour's active time split by the models' shares; an hour with no answer in it goes to Other */
        const ft = Object.values(v.f).reduce((a, b) => a + b, 0);
        if (ft) for (const f in v.f) bs[bi].f[f] = (bs[bi].f[f] || 0) + v.f[f] / ft * v.tot;
        else if (v.tot) bs[bi].f.other = (bs[bi].f.other || 0) + v.tot;
      } else for (const f in v.f) bs[bi].f[f] = (bs[bi].f[f] || 0) + v.f[f];
    }
    if (!bs.some((b) => b.tot > 0)) { box.innerHTML = empty('Nothing in this range'); return; }
    const used = FAM.filter((f) => bs.some((b) => b.f[f] > 0));
    const W = Math.max(320, box.clientWidth || 900), Hh = Math.round(250 * k), L = 64 * k, R = 8, T = 10, B = 26 * k, pw = W - L - R, ph = Hh - T - B;
    const max = niceMax(Math.max(...bs.map((b) => b.tot), 0)), bw = pw / bs.length, w = Math.max(2, Math.min(42, bw * 0.72));
    let s = '';
    for (let i = 0; i <= 4; i++) { const y = T + ph - ph * i / 4; s += `<line class="${i ? 'grid' : 'base'}" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text x="${L - 8}" y="${y + 4}" text-anchor="end">${esc(fmtM(m, max * i / 4))}</text>`; }
    const every = Math.ceil(bs.length / Math.max(1, Math.floor(pw / (76 * k))));
    bs.forEach((b, i) => {
      const x = L + i * bw + (bw - w) / 2; let y = T + ph;
      used.forEach((f) => {
        const v = b.f[f] || 0; if (!v) return;
        const hgt = v / max * ph; if (hgt < 0.5) return;
        y -= hgt; s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0.5, hgt - 1.5).toFixed(1)}" style="fill:${FCOL[f]}"/>`;
      });
      const d = new Date(b.t);
      if (i % every === 0) s += `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${Hh - 8}" text-anchor="middle">${esc(stp === 'month' ? MON[d.getMonth()] + (d.getMonth() === 0 ? ' ' + d.getFullYear() : '') : dateText(b.t))}</text>`;
      const label = stp === 'day' ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : stp === 'week' ? 'Week of ' + dateText(b.t, true) : MON[d.getMonth()] + ' ' + d.getFullYear();
      const rows = used.filter((f) => b.f[f] > 0).map((f) => [FNAME[f], fmtM(m, b.f[f]), FCOL[f]]); rows.push(['Total', fmtM(m, b.tot)]);
      s += `<rect class="hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${ph}"${ut(label, rows)}/>`;
    });
    box.innerHTML = legend(used) + `<svg class="uc" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(MNAME[m])} over time by model">${s}</svg>`;
  }

  /* ---------- models ---------- */
  function drawModels() {
    const fam = {}; FAM.forEach((f) => (fam[f] = { req: 0, tokens: 0, cost: 0, time: 0, models: [] }));
    for (const [model, x] of Object.entries(data.byModel)) { const f = fam[x.family] || fam.other; f.req += x.t[0]; f.tokens += tokOf(x.t); f.cost += x.cost; f.time += x.t[6]; f.models.push(model); }
    const used = FAM.filter((f) => fam[f].req > 0), box = $id('uModels');
    if (!used.length) { box.innerHTML = empty('Nothing in this range'); return; }
    const ms = [['req', 'Requests'], ['tokens', 'Tokens'], ['cost', 'Cost'], ['time', 'Time']];
    const share = ms.map(([k, name]) => {
      const tot = used.reduce((a, f) => a + fam[f][k], 0);
      return `<span class="k">${name}</span><span class="sb">${used.map((f) => { const v = fam[f][k]; return v ? `<i style="flex:${v};background:${FCOL[f]}" tabindex="0"${ut(FNAME[f] + ', ' + name.toLowerCase(), [[fmtM(k, v), pct(v, tot)]])}></i>` : ''; }).join('')}</span>`;
    }).join('');
    const totCost = used.reduce((a, f) => a + fam[f].cost, 0);
    box.innerHTML = `<div class="u-share">${share}</div><div class="tbl u-t5"><div class="tr hd"><span>Model</span><span class="r">Requests</span><span class="r">Tokens</span><span class="r">Time</span><span class="r">Cost</span></div>`
      + used.map((f) => `<div class="tr"><span class="ellip" title="${esc(fam[f].models.join(', '))}"><i class="u-sw" style="background:${FCOL[f]}"></i>${FNAME[f]}</span><span class="mono r">${count(fam[f].req)}</span><span class="mono r">${toks(fam[f].tokens)}</span><span class="mono r">${dur(fam[f].time)}</span><span class="mono r"${f === 'local' ? ` title="Electricity: the card's measured draw plus the rest of the PC, at ${data.local.pricePerKWh} ${esc(data.local.currency)} per kWh"` : ''}>${money(fam[f].cost)}${f === 'local' ? ` <span class="faint">(${esc(data.local.currency === 'JPY' ? '¥' : data.local.currency + ' ')}${Math.round(fam[f].cost * data.local.perDollar).toLocaleString('en-US')})</span>` : ''} <span class="faint">${pct(fam[f].cost, totCost)}</span></span></div>`).join('') + '</div>';
  }

  /* ---------- plan usage: the two meters now (Session and Week only), and the two windows over time on one percent axis ---------- */
  const resetText = (iso, week) => { const t = H0.toMs(iso); if (!t) return ''; return 'resets ' + (week && t - Date.now() > DAY ? new Date(t).toLocaleDateString('en-US', { weekday: 'short' }) + ' ' : '') + H0.hhmm(t); };
  function paintPlan() {
    const box = el && el.querySelector('#uPlanNow'); if (!box) return;
    const u = LV.usage;
    if (!u) { if (!plan.busy && !plan.err) loadPlan(); box.innerHTML = plan.err ? `<div class="lv-err">${I('xc', 'sm')}Could not read plan usage: ${esc(plan.err)} <button class="btn sm" data-uplan="get">Try again</button></div>` : `<div class="lv-empty">${I('loader', 'sm')}Reading plan usage</div>`; return; }
    const m = (l, w, week) => { if (!w) return `<div class="meter"><div class="row"><b>${l}</b><span class="faint">not known yet</span></div><div class="bar"><i style="width:0"></i></div></div>`; const p = Math.round(w.pct || 0); return `<div class="meter"><div class="row"><b>${l}</b><span>${p}% · ${esc(resetText(w.resetsAt, week))}</span></div><div class="bar ${p >= 80 ? 'warn' : ''}"><i style="width:${Math.min(100, p)}%"></i></div></div>`; };
    box.innerHTML = `<div class="meters">${m('Session (5 h)', u.fiveHour) + m('Week', u.sevenDay, true)}</div><div class="faint row u-chk">${I('clock', 'sm')}Checked ${esc(H0.ago(u.observedAt))}<span class="grow"></span><button class="linkb" data-uplan="refresh" ${plan.busy ? 'disabled' : ''}>${plan.busy ? 'Checking' : 'Check now'}</button></div>`;
  }
  function drawPlanChart() {
    const k = kk(), out = $id('uPlanTs'), pts = (data.plan || []).filter((p) => p.t >= rangeStart());
    const S1 = '#3987e5', S2 = '#d95926';
    $id('uPlanN').textContent = pts.length ? pts.length + ' readings' : '';
    if (pts.length < 2) { out.innerHTML = empty('No readings in this range'); return; }
    const W = Math.max(300, out.clientWidth || 600), Hh = Math.round(200 * k), L = 44 * k, R = 46 * k, T = 10, B = 24 * k, pw = W - L - R, ph = Hh - T - B;
    const t0 = view.range === 'all' ? pts[0].t : Math.min(pts[0].t, rangeStart()), t1 = Date.now(), X = (t) => L + (t - t0) / (t1 - t0) * pw, Y = (v) => T + ph - Math.min(100, v) / 100 * ph;
    let s = '';
    [0, 25, 50, 75, 100].forEach((v) => { s += `<line class="${v ? 'grid' : 'base'}" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v}%</text>`; });
    const line = (key, col, name) => {
      const p = pts.filter((x) => x[key] != null); if (!p.length) return '';
      /* a window that resets drops to zero: the step is drawn as it happened, not as a slope */
      let d = ''; p.forEach((x, i) => { d += (i ? 'L' : 'M') + X(x.t).toFixed(1) + ' ' + Y(x[key]).toFixed(1); });
      const last = p[p.length - 1];
      return `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>` + p.map((x) => `<circle cx="${X(x.t).toFixed(1)}" cy="${Y(x[key]).toFixed(1)}" r="6" class="hitc"${ut(name + ', ' + new Date(x.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }), [['Used', Math.round(x[key]) + '%']])}/>`).join('')
        + `<text class="val" x="${X(last.t) + 6}" y="${Y(last[key]) + 4}">${Math.round(last[key])}%</text>`;
    };
    s += line('five', S1, 'Session (5 h)') + line('seven', S2, 'Week');
    const days = (t1 - t0) / DAY, ticks = Math.min(6, Math.max(2, Math.floor(pw / (90 * k))));
    for (let i = 0; i <= ticks; i++) { const t = t0 + (t1 - t0) * i / ticks; s += `<text x="${X(t)}" y="${Hh - 6}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${esc(days <= 2 ? new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : dateText(t))}</text>`; }
    out.innerHTML = `<div class="u-leg"><span><i class="ln" style="background:${S1}"></i>Session (5 h)</span><span><i class="ln" style="background:${S2}"></i>Week</span></div><svg class="uc" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Plan usage over time">${s}</svg>`;
  }

  /* ---------- when I work: weekday by hour, a dot sized by the measure ---------- */
  function drawPunch() {
    const m = view.measure, g = Array.from({ length: 7 }, () => new Array(24).fill(0)), k = kk();
    data.hours.filter(inRange).forEach((hr) => { const d = new Date(hr.h * HR); g[(d.getDay() + 6) % 7][d.getHours()] += hourVals(hr, m).tot; });
    const max = Math.max(...g.flat()), box = $id('uPunch');
    if (!max) { box.innerHTML = empty('Nothing in this range'); $id('uPunchN').textContent = ''; return; }
    const W = Math.max(300, box.clientWidth || 600), L = 40 * k, T = 6, cw = (W - L) / 24, rh = 26 * k, Hh = T + 7 * rh + 20 * k, rmax = Math.min(cw, rh) / 2 - 1;
    let s = '';
    g.forEach((row, r) => {
      s += `<text x="0" y="${T + r * rh + rh / 2 + 4}">${WD[r]}</text>`;
      row.forEach((v, c) => {
        const cx = L + c * cw + cw / 2, cy = T + r * rh + rh / 2;
        s += `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="1.2" class="dot0"/>`;
        if (v) s += `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${Math.max(2, Math.sqrt(v / max) * rmax).toFixed(1)}" style="fill:#3987e5"/>`;
        s += `<rect class="hit" x="${(cx - cw / 2).toFixed(1)}" y="${cy - rh / 2}" width="${cw.toFixed(1)}" height="${rh}"${ut(WD[r] + ' ' + hh(c), [[MNAME[m], fmtM(m, v)]])}/>`;
      });
    });
    for (let c = 0; c < 24; c += 3) s += `<text x="${(L + c * cw + cw / 2).toFixed(1)}" y="${Hh - 2}" text-anchor="middle">${String(c).padStart(2, '0')}</text>`;
    box.innerHTML = `<svg class="uc" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(MNAME[m])} by weekday and hour">${s}</svg>`;
    let bw = 0, bh = 0; g.forEach((row, r) => row.forEach((v, c) => { if (v > g[bw][bh]) { bw = r; bh = c; } }));
    $id('uPunchN').textContent = 'peak ' + WD[bw] + ' ' + hh(bh);
  }

  /* ---------- token mix: where the tokens go, and what each part costs ---------- */
  function drawMix() {
    const T = data.total.t, box = $id('uMix');
    const parts = [['Cache read', T[3], 'Reused context, the cheap part'], ['Cache write', T[4] + T[5], 'Context stored for reuse (' + toks(T[5]) + ' for 1h)'], ['Input', T[1], 'New input not cached'], ['Output', T[2], 'Written by Claude']];
    const P = data.total.parts || {}, cost = { 'Cache read': P.read || 0, 'Cache write': P.write || 0, Input: P.input || 0, Output: P.output || 0 }; /* priced by the server, per model */
    const tot = T[1] + T[2] + T[3] + T[4] + T[5];
    if (!tot) { box.innerHTML = empty('Nothing in this range'); $id('uMixN').textContent = ''; return; }
    /* three steps of one blue, light to dark, then orange for the output: lightness and the table both name each part */
    const cols = ['#b7d3f6', '#6da7ec', '#256abf', '#d95926'];
    const bar = (get, fmt, of) => parts.map((p, i) => (get(p) ? `<i style="flex:${get(p)};background:${cols[i]}" tabindex="0"${ut(p[0], [[fmt(get(p)), pct(get(p), of)]])}></i>` : '')).join('');
    box.innerHTML = `<div class="u-share"><span class="k">Tokens</span><span class="sb">${bar((p) => p[1], toks, tot)}</span><span class="k">Cost</span><span class="sb">${bar((p) => cost[p[0]], money, data.total.cost)}</span></div>`
      + `<div class="tbl u-t3"><div class="tr hd"><span>Part</span><span class="r">Tokens</span><span class="r">Cost</span></div>${parts.map((p, i) => `<div class="tr"><span class="ellip" title="${esc(p[2])}"><i class="u-sw" style="background:${cols[i]}"></i>${esc(p[0])}</span><span class="mono r">${toks(p[1])} <span class="faint">${pct(p[1], tot)}</span></span><span class="mono r">${money(cost[p[0]])} <span class="faint">${pct(cost[p[0]], data.total.cost)}</span></span></div>`).join('')}</div>`;
    $id('uMixN').textContent = 'cache hit ' + pct(T[3], T[1] + T[3] + T[4] + T[5]);
  }

  /* ---------- projects and conversations ---------- */
  function drawProjects() {
    const m = view.measure, key = m === 'time' ? 'activeMs' : m, list = data.projects.filter((p) => p[key] > 0 || p.cost > 0).sort((a, b) => b[key] - a[key]);
    const max = Math.max(...list.map((p) => p[key]), 1), box = $id('uProj');
    $id('uProjN').textContent = list.length + ' projects';
    if (!list.length) { box.innerHTML = empty('Nothing in this range'); return; }
    /* the measure first (the bar shows it), then cost, or time when the measure is cost */
    const n2 = m === 'cost' ? 'Time' : 'Cost';
    box.innerHTML = `<div class="tbl u-proj"><div class="tr hd"><span>Project</span><span class="r">${esc(MNAME[m])} ${I('down', 'sm')}</span><span class="r u-hs">${n2}</span><span class="r u-hs">Chats</span></div>`
      + list.map((p) => `<div class="tr${p.id ? ' click" tabindex="0" data-uproj="' + esc(p.id) + '" data-name="' + esc(p.name || '') : ''}"><span class="u-nm"><span class="ellip">${esc(p.name || 'No project')}</span><span class="u-pb"><i style="width:${(p[key] / max * 100).toFixed(1)}%"></i></span></span><span class="mono r">${esc(fmtM(m, p[key]))}</span><span class="mono r u-hs">${esc(m === 'cost' ? dur(p.activeMs) : money(p.cost))}</span><span class="mono r u-hs">${count(p.sessions)}</span></div>`).join('') + '</div>';
  }
  function drawConvs() {
    const m = view.measure, key = m === 'time' ? 'activeMs' : m, list = data.conversations.slice().sort((a, b) => b[key] - a[key]), box = $id('uConv');
    $id('uConvN').textContent = data.conversationCount + ' with activity';
    if (!list.length) { box.innerHTML = empty('Nothing in this range'); return; }
    const mark = (k) => (k === key ? ' ' + I('down', 'sm') : ''); /* the column the list is sorted by (requests sort by the hidden count) */
    const pname = (id) => (data.projects.find((p) => p.id === id) || {}).name || id;
    const rows = list.slice(0, convShown).map((c) => {
      const proj = c.projects.map(pname).join(', '), title = c.title || 'Deleted conversation';
      return `<div class="tr${c.gone ? '' : ' click" tabindex="0" data-uconv="' + esc(c.id) + '" data-pid="' + esc(c.projects[0] || '')}"><span class="u-nm" title="${esc(title + (c.model ? ', mostly ' + c.model : ''))}"><span class="ellip">${esc(title)}</span><small class="ellip">${esc(proj || 'No project')}${c.subCost > 0.01 ? ' · helpers ' + pct(c.subCost, c.cost) : ''}</small></span><span class="mono r">${money(c.cost)}</span><span class="mono r">${toks(c.tokens)}</span><span class="mono r u-hs">${dur(c.activeMs)}</span><span class="mono r u-hs">${esc(dateText(new Date(c.last).getTime()))}</span></div>`;
    }).join('');
    const more = list.length > convShown ? `Show ${Math.min(30, list.length - convShown)} more` : convShown > 15 ? 'Show fewer' : '';
    box.innerHTML = `<div class="tbl u-conv"><div class="tr hd"><span>Conversation${m === 'req' ? ' (by requests ' + I('down', 'sm') + ')' : ''}</span><span class="r">Cost${mark('cost')}</span><span class="r">Tokens${mark('tokens')}</span><span class="r u-hs">Time${mark('activeMs')}</span><span class="r u-hs">Last</span></div>${rows}</div>`
      + (more ? `<button class="btn sm ghost u-more" data-umore>${esc(more)}</button>` : '');
  }

  /* a project or conversation row: the open tab moves there; Ctrl click or the middle button opens a new tab */
  function openRow(r, inNew) {
    const pid = r.dataset.uproj || r.dataset.pid, sid = r.dataset.uconv || null;
    const p = (LV.byId && LV.byId[pid]) || null, name = p ? p.name : r.dataset.name || null;
    if (!name) { MC.toast('This conversation is not in a project', 'folder'); return; }
    if (inNew && MC.D) { MC.D.newTab(name, { session: sid }); return; }
    MC.setProject(name); if (sid) MC.setSession(sid);
  }

  function bind() {
    el.addEventListener('click', (e) => {
      const t = e.target;
      const sb = t.closest('[data-ustep]'); if (sb) { view.step = sb.dataset.ustep; save(); $id('uStep').innerHTML = seg('ustep', [['day', 'Day'], ['week', 'Week'], ['month', 'Month']], step()); drawSeries(); return; }
      if (t.closest('[data-umore]')) { const n = data ? data.conversations.length : 0; convShown = convShown < n ? convShown + 30 : 15; drawConvs(); return; }
      if (t.closest('[data-uretry]')) { load(); return; }
      const pl = t.closest('[data-uplan]'); if (pl) { loadPlan(pl.dataset.uplan === 'refresh'); return; }
      const r = t.closest('[data-uconv],[data-uproj]'); if (r) openRow(r, e.ctrlKey || e.metaKey);
    });
    el.addEventListener('auxclick', (e) => { const r = e.target.closest('[data-uconv],[data-uproj]'); if (r && e.button === 1) { e.preventDefault(); openRow(r, true); } });
    el.addEventListener('keydown', (e) => { const r = e.target.closest('[data-uconv],[data-uproj]'); if (r && e.key === 'Enter') openRow(r, e.ctrlKey || e.metaKey); });
    el.addEventListener('mouseover', (e) => { const t = e.target.closest('[data-ut]'); if (t) showTip(t, e.clientX, e.clientY); else hideTip(); });
    el.addEventListener('mousemove', (e) => { if (tip && !tip.hidden) placeTip(e.clientX, e.clientY); });
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('scroll', hideTip);
    el.addEventListener('focusin', (e) => { const t = e.target.closest('[data-ut]'); if (t) { const b = t.getBoundingClientRect(); showTip(t, b.right, b.top); } });
    el.addEventListener('focusout', hideTip);
  }

  /* the range and the measure live in the page bar (outside the page), so their clicks are caught on the document */
  document.addEventListener('click', (e) => {
    const r = e.target.closest('[data-urange]'); if (r) { view.range = r.dataset.urange; view.step = 'auto'; save(); convShown = 15; load(); return; }
    const m = e.target.closest('[data-umeasure]'); if (m) { view.measure = m.dataset.umeasure; save(); draw(); }
  });
  MC.pageBar.usage = () => ({
    sub: err && !data ? 'Could not load' : !data ? 'Adding up' : !data.index.ready ? 'Reading the transcripts' : `${data.conversationCount} conversations${busy ? ' · updating' : ''}`,
    html: `<span class="u-bar"><span class="faint">Range</span>${seg('urange', [['7', '7d'], ['30', '30d'], ['90', '90d'], ['365', '1y'], ['all', 'All']], view.range)}<span class="faint">Measure</span>${seg('umeasure', [['cost', 'Cost'], ['tokens', 'Tokens'], ['req', 'Requests'], ['time', 'Time']], view.measure)}</span>`,
  });

  /* a new plan reading: the meters at once, and the chart gets its new point a little later */
  let rz = 0;
  MC.events.on('usage', () => { if (!shown()) return; paintPlan(); clearTimeout(rz); rz = setTimeout(load, 1500); });
  MC.on('rerender', (m) => { if (m === 'usage' && shown()) paintPlan(); });
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (data && shown()) draw(); }, 150); });
  MC.on('size', () => { if (data && shown()) setTimeout(draw); });

  /* the page shell calls this each time Usage is shown: draw what is known at once, then read the numbers again */
  MC.drawPage.usage = (target) => {
    el = target;
    if (!el._ubound) { el._ubound = true; bind(); }
    draw(); load();
  };
})();
