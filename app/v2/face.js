/* Mission Control 2: the Com Link's faces, drawn as on the old pages (redline.js): the red HAL eye and Clawd, Claude's pixel
   crab. One loop draws every canvas[data-eye] on the page; MC.face holds the voice state (idle, listening, thinking,
   speaking) and the live mic level. Work mode stops the motion. Loads before home.js. */
(() => {
const fit = function(c){
  const D = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if(c.width !== Math.round(w*D) || c.height !== Math.round(h*D)){ c.width = Math.round(w*D); c.height = Math.round(h*D); }
  const x = c.getContext('2d'); x.setTransform(D,0,0,D,0,0); return [x,w,h];
};
const noise = t => (Math.sin(t*1.7)+Math.sin(t*2.9+1.3)*.6+Math.sin(t*5.3+.7)*.35+Math.sin(t*9.1+2.1)*.2)/2.15;
const STATES = { idle: [.25, .1, .05], listening: [3.2, .35, .5], thinking: [.9, .3, .2], speaking: [2.4, .4, .55] }; /* speed, base level, swing */
MC.reduce = MC.reduce || false;
MC.drawEye = function(ex, x, y, R, L, spin, mini){
  ex.lineWidth = 1; ex.strokeStyle = 'rgba(220,231,243,.35)';
  if(!mini){
    ex.beginPath(); ex.moveTo(x-R-6,y); ex.lineTo(x-R*.62,y); ex.moveTo(x+R*.62,y); ex.lineTo(x+R+6,y); ex.moveTo(x,y-R-6); ex.lineTo(x,y-R*.62); ex.moveTo(x,y+R*.62); ex.lineTo(x,y+R+6); ex.stroke();
    ex.beginPath(); ex.arc(x,y,R,0,7); ex.stroke();
    for(let i=0;i<72;i++){ const a=i/72*6.283, r2=R-(i%6?4:9); ex.beginPath(); ex.moveTo(x+Math.cos(a)*R,y+Math.sin(a)*R); ex.lineTo(x+Math.cos(a)*r2,y+Math.sin(a)*r2); ex.stroke(); }
    ex.save(); ex.translate(x,y); ex.rotate(spin); ex.setLineDash([22,10]); ex.strokeStyle='rgba(220,231,243,.55)'; ex.beginPath(); ex.arc(0,0,R*.86,.2,2.6); ex.stroke(); ex.setLineDash([]); ex.strokeStyle='#d6473c'; ex.lineWidth=3; ex.beginPath(); ex.arc(0,0,R*.86,3.4,3.9); ex.stroke(); ex.restore();
  }
  const N = mini ? 20 : 40, lit = Math.round(L*N), ro = mini ? R : R*.74, ri = mini ? R*.78 : R*.64;
  for(let i=0;i<N;i++){ const a0=-Math.PI/2+i/N*6.283+.02, a1=a0+6.283/N-(mini?.08:.05); ex.beginPath(); ex.arc(x,y,ro,a0,a1); ex.arc(x,y,ri,a1,a0,true); ex.closePath(); ex.fillStyle = i<lit ? (i>N*.8?'#e2e9f0':'#d6473c') : 'rgba(220,231,243,.08)'; ex.fill(); }
  const lr = mini ? R*.62 : R*.5;
  ex.beginPath(); ex.arc(x,y,lr+(mini?2:4),0,7); ex.fillStyle='#16161a'; ex.fill(); ex.strokeStyle='rgba(220,231,243,.5)'; ex.lineWidth=1; ex.stroke();
  const g = ex.createRadialGradient(x,y,0,x,y,lr); g.addColorStop(0,`rgba(255,${190+50*L|0},${120+80*L|0},1)`); g.addColorStop(.12+.18*L,'#ff3b2a'); g.addColorStop(.55,'#9d0f12'); g.addColorStop(1,'#1a0304');
  ex.beginPath(); ex.arc(x,y,lr,0,7); ex.fillStyle=g; ex.fill();
  ex.globalCompositeOperation='lighter'; const g2=ex.createRadialGradient(x,y,0,x,y,lr*(1.1+L*.8)); g2.addColorStop(0,`rgba(214,71,60,${.35+L*.4})`); g2.addColorStop(1,'rgba(214,71,60,0)'); ex.fillStyle=g2; ex.beginPath(); ex.arc(x,y,lr*2,0,7); ex.fill(); ex.globalCompositeOperation='source-over';
  ex.beginPath(); ex.ellipse(x-lr*.35,y-lr*.42,lr*.22,lr*.1,-.5,0,7); ex.fillStyle='rgba(220,231,243,.22)'; ex.fill();
};
MC.drawClawd = function(ex, w, h, L, t, state, mini){
  const u = Math.max(1, Math.floor(Math.min(w / 21, h / (mini ? 16 : 19))));
  const cx = Math.round(w / 2), cy = Math.round(h / 2 + u * (mini ? 0 : 1));
  let lift = 0, eyeDx = 0, eyeH = 2, arms = 'mid', squash = 0;
  if(!MC.reduce){
    if(state === 'thinking'){ eyeDx = Math.round(Math.sin(t * 1.6) * 1.2); lift = Math.round(Math.sin(t * 3.2) * .5 + .5); }
    else if(state === 'listening') arms = 'up';
    else if(state === 'speaking'){ lift = Math.round(L * 2); arms = L > .5 ? 'up' : 'mid'; }
    else squash = Math.sin(t * 1.8) > .6 ? 1 : 0;
    if((t % 4.2) < .14) eyeH = .35; /* blink */
  }
  const col = '#D77757', px = (x, y, ww, hh, c) => { ex.fillStyle = c || col; ex.fillRect(cx + x * u, cy + y * u - lift * u, ww * u, hh * u); };
  ex.save();
  if(!mini){ ex.shadowColor = 'rgba(215,119,87,' + (.25 + L * .4) + ')'; ex.shadowBlur = u * 3; }
  px(-6, -4 + squash, 12, 7 - squash); /* body: a breath squashes it by one pixel row */
  [-1, 1].forEach(side => {
    if(arms === 'up'){ px(side < 0 ? -8 : 6, -2, 2, 2); px(side < 0 ? -9 : 7, -4, 2, 2); }
    else px(side < 0 ? -8 : 6, -1, 2, 2);
  });
  ex.shadowBlur = 0;
  const legH = lift > 1 ? 1 : 2; /* legs tuck in when he jumps */
  [-5, -3, 2, 4].forEach(x => { ex.fillStyle = col; ex.fillRect(cx + x * u, cy + 3 * u - lift * u, u, legH * u); });
  const ey = -2 + squash + (2 - eyeH) / 2;
  px(-4 + eyeDx, ey, 1, eyeH, '#1a1a1a'); px(3 + eyeDx, ey, 1, eyeH, '#1a1a1a');
  ex.restore();
};
MC.face = { state: 'idle', level: .1, peak: 0, live: 0, liveAt: 0 };
MC.setFace = (s) => { MC.face.state = STATES[s] ? s : 'idle'; };
MC.events && MC.events.on('voice', (d) => { if (d && d.kind === 'level' && typeof d.level === 'number') { MC.face.live = d.level; MC.face.liveAt = performance.now(); } });
let t0 = performance.now(), spin = 0;
function loop(now) {
  const v = MC.face, S = STATES[v.state], t = (now - t0) / 1000, still = !!(MC.state && MC.state.work);
  let tg = S[1] + S[2] * (v.state === 'thinking' ? Math.sin(t * S[0] * 2) * .5 + .5 : Math.max(0, noise(t * S[0]) * .5 + .5));
  if (still) tg = S[1] + S[2] * .4;
  if (v.liveAt && now - v.liveAt > 400) v.live = 0; /* BlitzVoice level events stopped: back to silence */
  if (v.state === 'listening' && v.liveAt) tg = Math.min(1, .12 + .88 * Math.sqrt(v.live || 0));
  v.level += (tg - v.level) * (v.state === 'speaking' || v.state === 'listening' ? .35 : .08);
  const L = Math.max(0, Math.min(1, v.level)); v.peak = Math.max(L, v.peak - .006);
  if (!still) spin += .004 + (v.state === 'thinking' ? .02 : 0);
  MC.reduce = still;
  document.querySelectorAll('canvas[data-eye]').forEach((c) => {
    if (!c.getClientRects().length) return;
    const [ex, w, h] = fit(c); ex.clearRect(0, 0, w, h);
    if (w < 24 || h < 24) return; /* no size: a negative radius would throw and stop the loop */
    const mini = c.dataset.eye === 'mini';
    if (c.dataset.look === 'clawd') MC.drawClawd(ex, w, h, L, t, v.state, mini);
    else MC.drawEye(ex, w / 2, h / 2, Math.min(w, h) / 2 - (mini ? 2 : 8), L, spin, mini);
  });
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
})();
