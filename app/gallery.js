// Mission Control, the picture viewer: one picture over the whole page, with every picture of its set in a strip at the bottom.
// The left and right arrow keys, a swipe or the side buttons step through the set; Escape, Close or a click on the dark area
// closes it and puts the focus back where it was. Used by the Talk page (the pictures of a conversation) and the project page
// (the Screenshots tab).
//
// MC.gallery.open(list, index, opt)
//   list: [{ src, name, from, caption, label }]. from "you", "claude" or "tool" (Claude looked at it) names who shared it;
//         label replaces that word (for example a folder name); tag is the word under its thumbnail in the strip (default: the
//         same word, '' for none); name is the file name shown in the header.
//   opt.opener: the element to focus again on close.  opt.more: a function returning a promise of a longer list, merged in
//   when it answers (the picture on screen stays).  opt.title: a word for the set, read by screen readers.
// MC.gallery.close(), MC.gallery.isOpen()
window.MC = window.MC || {};
MC.gallery = (function(){
  let lb = null; /* { el, opener, list, i } */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safe = s => typeof s === 'string' && /^(\/|blob:|data:image\/)/.test(s);
  const CHEV_L = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  const CHEV_R = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  const word = p => p.label != null ? String(p.label) : p.from === 'you' ? 'YOU' : p.from === 'tool' ? 'CLAUDE LOOKED AT' : p.from === 'claude' ? 'CLAUDE' : '';
  const short = p => p.tag != null ? String(p.tag) : p.label != null ? String(p.label) : p.from === 'you' ? 'YOU' : p.from ? 'CLAUDE' : '';
  const whoText = p => p.from === 'you' ? 'shared by you' : p.from === 'tool' ? 'looked at by Claude' : p.from === 'claude' ? 'shared by Claude' : '';

  function style(){
    if(document.getElementById('mc-gallery-css')) return;
    const st = document.createElement('style'); st.id = 'mc-gallery-css';
    st.textContent = '.lb{position:fixed;inset:0;z-index:120;background:rgba(5,9,15,.96);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;cursor:zoom-out}' +
      '.lb > img{max-width:min(92vw,calc(100vw - 150px));max-height:calc(100vh - 210px);object-fit:contain;cursor:default;background:rgba(0,0,0,.4)}' +
      '.lb .lbx{position:absolute;top:16px;right:18px}' +
      /* who shared it, which one of how many, the file name: one mono line above the picture, like a message header */
      '.lbhead{display:flex;align-items:baseline;gap:12px;max-width:92vw;font:11px var(--mono);letter-spacing:.06em;color:var(--w2);cursor:default}' +
      '.lbwho{font-weight:700;color:var(--white);padding-left:8px;border-left:3px solid var(--red)}.lbwho.me{border-left-color:var(--w2)}.lbwho:empty{display:none}' +
      '.lbnum{color:var(--w3)}.lb .lbn{color:var(--w3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}' +
      '.lbcap{max-width:min(760px,92vw);font-size:calc(var(--md-size,15px) * .9);color:var(--w2);text-align:center;line-height:1.4;cursor:default}' +
      '.lbcap[hidden],.lbstrip[hidden],.lbnav[hidden]{display:none}' +
      '.lbnav{position:absolute;top:50%;transform:translateY(-50%);width:52px;height:72px;display:flex;align-items:center;justify-content:center;background:rgba(9,16,27,.55);border:1px solid var(--line-2);color:var(--white);cursor:pointer}' +
      '.lbnav svg{width:22px;height:22px}.lbnav:hover{border-color:var(--w2);background:rgba(9,16,27,.8)}.lbnav:focus-visible{outline:1px solid var(--white);outline-offset:2px}' +
      '.lbnav.prev{left:18px}.lbnav.next{right:18px}' +
      '.lbstrip{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:8px;max-width:92vw;overflow-x:auto;padding:4px 2px 2px;cursor:default;scrollbar-width:thin}' +
      '.lb:has(.lbstrip:not([hidden])){padding-bottom:96px}' +
      '.lbth{flex:none;display:flex;flex-direction:column;align-items:center;gap:3px;width:64px;padding:0;background:none;border:0;cursor:pointer;opacity:.55}' +
      '.lbth img{width:64px;height:44px;object-fit:cover;border:1px solid var(--line-2);background:rgba(0,0,0,.4)}' +
      '.lbth span{font:600 8.5px var(--mono);letter-spacing:.08em;color:var(--w3);max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lbth span:empty{display:none}.lbth.me span{color:var(--w2)}' +
      '.lbth:hover{opacity:.85}.lbth.on{opacity:1}.lbth.on img{border-color:var(--white)}.lbth.on span{color:var(--white)}.lbth:focus-visible{outline:1px solid var(--white);outline-offset:2px}' +
      '@media (max-width:560px){.lb{padding:12px 8px}.lb > img{max-width:96vw;max-height:calc(100dvh - 230px)}.lbnav{display:none}}';
    document.head.appendChild(st);
  }

  function paint(strip){
    if(!lb) return;
    const p = lb.list[lb.i], n = lb.list.length, el = lb.el;
    const img = el.querySelector('img'); img.src = p.src; img.alt = p.name || 'Picture';
    el.setAttribute('aria-label', 'Picture ' + (lb.i + 1) + ' of ' + n + (whoText(p) ? ', ' + whoText(p) : ''));
    el.querySelector('.lbhead').innerHTML = '<span class="lbwho ' + (p.from === 'you' ? 'me' : 'ai') + '">' + esc(word(p)) + '</span>' + (n > 1 ? '<span class="lbnum">' + (lb.i + 1) + ' of ' + n + '</span>' : '') + '<span class="lbn">' + esc(p.name || '') + '</span>';
    const cap = el.querySelector('.lbcap'); cap.textContent = p.caption || ''; cap.hidden = !p.caption;
    el.querySelectorAll('.lbnav').forEach(b => { b.hidden = n < 2; });
    const sb = el.querySelector('.lbstrip');
    sb.hidden = n < 2;
    if(strip && n > 1) sb.innerHTML = lb.list.map((q, k) => '<button type="button" role="listitem" class="lbth ' + (q.from === 'you' ? 'me' : 'ai') + '" data-lbi="' + k + '" aria-label="Picture ' + (k + 1) + (whoText(q) ? ', ' + whoText(q) : '') + '"><img src="' + esc(q.src) + '" alt="" loading="lazy"><span>' + esc(short(q)) + '</span></button>').join('');
    sb.querySelectorAll('.lbth').forEach(b => { const on = Number(b.dataset.lbi) === lb.i; b.classList.toggle('on', on); if(on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
    const cur = sb.querySelector('.lbth.on'); if(cur && cur.scrollIntoView) cur.scrollIntoView({ block:'nearest', inline:'center' });
  }
  function step(d){ if(!lb || lb.list.length < 2) return; lb.i = (lb.i + d + lb.list.length) % lb.list.length; paint(false); }
  function close(){
    if(!lb) return;
    const o = lb.opener; if(lb.el.parentNode) lb.el.parentNode.removeChild(lb.el); lb = null;
    if(o && document.body.contains(o)){ try { o.focus(); } catch(e){} }
  }
  /* keys while open: Escape closes, arrows step, Tab stays inside (Close, the side buttons, the strip). Caught first, so the
     page under it never sees them. */
  function onKey(e){
    if(!lb) return;
    if(e.key === 'Escape'){ e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if(e.key === 'ArrowLeft' || e.key === 'ArrowRight'){ e.preventDefault(); e.stopImmediatePropagation(); step(e.key === 'ArrowLeft' ? -1 : 1); }
    else if(e.key === 'Tab'){
      e.preventDefault(); e.stopImmediatePropagation();
      const fs = Array.from(lb.el.querySelectorAll('button')).filter(b => b.offsetParent !== null);
      const fi = fs.indexOf(document.activeElement);
      if(fs.length) fs[(fi + (e.shiftKey ? fs.length - 1 : 1) + fs.length) % fs.length].focus();
    }
  }
  addEventListener('keydown', onKey, true);

  function open(list, index, opt){
    opt = opt || {};
    list = (list || []).filter(p => p && safe(p.src));
    if(!list.length) return;
    close(); style();
    const el = document.createElement('div');
    el.className = 'lb'; el.id = 'lb'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
    el.innerHTML = '<button type="button" class="act lbx" aria-label="Close picture">Close</button>' +
      '<button type="button" class="lbnav prev" aria-label="Previous picture">' + CHEV_L + '</button><button type="button" class="lbnav next" aria-label="Next picture">' + CHEV_R + '</button>' +
      '<div class="lbhead"></div><img alt=""><div class="lbcap"></div><div class="lbstrip" role="list"></div>';
    document.body.appendChild(el);
    lb = { el, opener: opt.opener || document.activeElement, list, i: Math.max(0, Math.min(list.length - 1, index || 0)) };
    paint(true);
    el.querySelector('.lbx').focus();
    el.addEventListener('click', e => {
      if(e.target.closest('.lbx')){ close(); return; }
      if(e.target.closest('.lbnav')){ step(e.target.closest('.prev') ? -1 : 1); return; }
      const th = e.target.closest('[data-lbi]');
      if(th){ lb.i = Number(th.dataset.lbi); paint(false); return; }
      if(!e.target.closest('img, .lbhead, .lbcap, .lbstrip')) close(); /* only the dark area around closes it */
    });
    let sx = null, sy = 0;
    el.addEventListener('touchstart', e => { sx = null; if(e.touches.length === 1 && !e.target.closest('.lbstrip')){ sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, { passive:true }); /* the strip scrolls on its own */
    el.addEventListener('touchend', e => {
      if(sx == null || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
      if(Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    });
    if(typeof opt.more === 'function'){
      const mine = lb;
      Promise.resolve().then(opt.more).then(more => {
        if(lb !== mine || !Array.isArray(more)) return;
        const cur = lb.list[lb.i].src, seen = new Set(), merged = [];
        more.concat(lb.list).forEach(p => { if(p && safe(p.src) && !seen.has(p.src)){ seen.add(p.src); merged.push(p); } });
        lb.list = merged; lb.i = Math.max(0, merged.findIndex(p => p.src === cur));
        paint(true);
      }).catch(() => { /* the list it opened with is enough */ });
    }
  }
  return { open, close, isOpen: () => !!lb };
})();
