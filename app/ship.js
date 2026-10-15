// Mission Control: the crew ship. An isometric spaceship where little Clawd agents work, rest and play.
// Needs three.js (r128) and redline.js loaded first.
MC.ship = function(host, stageEl){
  const W3 = THREE;
  const RED = 0xd6473c, CLAWD = 0xd97757, LINE = 0xdce7f3, WHITE = 0xe2e9f0, DK = 0x2a3a52, FURN = 0x22324a, GOLD = 0xe9c46a, DENIM = 0x3d5a8a;
  /* The ship fills a fixed full-screen layer (stage) behind the page. The panels dock around the edges and the
     free area (an empty cell of the page grid, host or host's .free) marks where the ship is centered. */
  const stage = stageEl || host.querySelector('.stage'), overlay = stage.querySelector('.overlay'), freeEl = host.querySelector('.free') || host, card = document.getElementById('crewCard');
  const renderer = new W3.WebGLRenderer({antialias:true, alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  stage.prepend(renderer.domElement);
  const el = renderer.domElement;
  el.style.cssText = 'position:absolute;left:0;top:0;display:block;touch-action:none;pointer-events:auto';
  const scene = new W3.Scene();
  const cam = new W3.OrthographicCamera(-10, 10, 10, -10, -150, 300);
  scene.add(new W3.HemisphereLight(0xd6e4ff, 0x0b1322, .9));
  const sun = new W3.DirectionalLight(0xffffff, .6); sun.position.set(8, 14, 6); scene.add(sun);
  const ship = new W3.Group(); scene.add(ship);
  const V = (x, z) => new W3.Vector3(x, 0, z);

  /* ---------- helpers ---------- */
  const rnd = (a, b) => a + Math.random()*(b - a);
  const pick = arr => arr[Math.floor(Math.random()*arr.length)];
  const edgeMat = (o = .35, c = LINE) => new W3.LineBasicMaterial({color:c, transparent:true, opacity:o});
  function box(w, h, d, color, opt = {}){
    const m = new W3.Mesh(new W3.BoxGeometry(w, h, d), new W3.MeshLambertMaterial({color, transparent:opt.op !== undefined, opacity:opt.op ?? 1, emissive:opt.em || 0}));
    if(opt.edge !== false) m.add(new W3.LineSegments(new W3.EdgesGeometry(m.geometry), edgeMat(opt.eo ?? .35, opt.ec ?? LINE)));
    return m;
  }
  const cyl = (rt, rb, h, color, seg = 16, open) => new W3.Mesh(new W3.CylinderGeometry(rt, rb, h, seg, 1, !!open), new W3.MeshLambertMaterial({color, side:open ? W3.DoubleSide : W3.FrontSide}));
  const glow = (geo, color, o = .9) => new W3.Mesh(geo, new W3.MeshBasicMaterial({color, transparent:true, opacity:o}));
  const glassMat = o => new W3.MeshLambertMaterial({color:0xcfe6ff, transparent:true, opacity:o, side:W3.DoubleSide});
  const at = (o, x, y, z) => { o.position.set(x, y, z); return o; };
  const add = (parent, o, x, y, z) => { parent.add(at(o, x, y, z)); return o; };
  const line = (pts, o = .3, c = LINE) => new W3.Line(new W3.BufferGeometry().setFromPoints(pts.map(p => new W3.Vector3(...p))), edgeMat(o, c));
  function flat(pts, color, o, y){ const s = new W3.Shape(pts.map(p => new W3.Vector2(p[0], -p[1]))); const g = new W3.ShapeGeometry(s); g.rotateX(-Math.PI/2); const m = new W3.Mesh(g, new W3.MeshLambertMaterial({color, transparent:true, opacity:o, side:W3.DoubleSide})); m.position.y = y; return m; }
  function slab(pts, depth, color, o = 1){ const s = new W3.Shape(pts.map(p => new W3.Vector2(p[0], -p[1]))); const g = new W3.ExtrudeGeometry(s, {depth, bevelEnabled:false}); g.rotateX(-Math.PI/2); const m = new W3.Mesh(g, new W3.MeshLambertMaterial({color, transparent:o < 1, opacity:o})); m.add(new W3.LineSegments(new W3.EdgesGeometry(g, 20), edgeMat(.4))); return m; }
  function wallSeg(x0, z0, x1, z1, h, th, color, o, eo = .4){ const len = Math.hypot(x1 - x0, z1 - z0); if(len < .05) return null; const w = box(len, h, th, color, {op:o, eo, edge:eo > 0}); w.position.set((x0 + x1)/2, h/2, (z0 + z1)/2); w.rotation.y = -Math.atan2(z1 - z0, x1 - x0); ship.add(w); return w; }
  const blinkers = [], spinners = [], sways = [];

  /* ---------- hull: pointed nose, pointed tail, side walls, windows, wings ---------- */
  const HULL = [[-19.2,-11],[12,-11],[21.8,-4.2],[21.8,4.2],[12,11],[-19.2,11],[-24.8,5.4],[-24.8,-5.4]];
  ship.add(flat(HULL, 0x101b2b, .6, 0));
  for(let i = 0; i < HULL.length; i++){
    const [x0, z0] = HULL[i], [x1, z1] = HULL[(i + 1) % HULL.length];
    const glass = (i === 1 || i === 2 || i === 3);
    wallSeg(x0, z0, x1, z1, glass ? 1.4 : 1.05, .28, glass ? 0x9fd0ff : 0x1a2840, glass ? .14 : .5, glass ? .55 : .45);
    if(!glass){ const s = wallSeg(x0, z0, x1, z1, .08, .32, RED, 1, 0); if(s) s.position.y = .78; }
  }
  // round windows along both long sides
  for(let x = -16.5; x < 11; x += 2.4) [-1, 1].forEach(s => {
    const rim = glow(new W3.TorusGeometry(.24, .05, 6, 18), LINE, .55); rim.position.set(x, .5, s*11.16); ship.add(rim);
    const pane = glow(new W3.CircleGeometry(.22, 16), 0x9fd0ff, .22); pane.position.set(x, .5, s*11.17); if(s < 0) pane.rotation.y = Math.PI; ship.add(pane);
  });
  // swept wings with blinking wingtip lights
  [-1, 1].forEach(s => {
    const w = slab([[4, s*11], [-12, s*11], [-17, s*16.2], [-11.4, s*16.2]], .3, 0x1a2840, .9); w.position.y = .15; ship.add(w);
    ship.add(line([[4, .47, s*11], [-11.4, .47, s*16.2]], .9, RED));
    blinkers.push(add(ship, glow(new W3.SphereGeometry(.18, 10, 8), s < 0 ? RED : WHITE), -14.2, .62, s*16.2));
    for(let i = 0; i < 3; i++) add(ship, box(1.8, .05, .5, 0x24344c, {eo:.3}), -6 - i*2.4, .47, s*(12.4 + i*1.1));
  });
  // nose light and a sensor dish
  add(ship, glow(new W3.SphereGeometry(.22, 10, 8), RED), 22.1, .7, 0);
  const dish = add(ship, new W3.Mesh(new W3.SphereGeometry(.6, 14, 8, 0, Math.PI*2, 0, Math.PI/2.4), new W3.MeshLambertMaterial({color:0x9fb2c7, side:W3.DoubleSide})), 10, 1.4, -11.4);
  dish.rotation.x = -1.2; spinners.push([dish, .01, 'z']);

  /* ---------- engines: three nacelles packed at the tail ---------- */
  const flames = [];
  [-3.5, 0, 3.5].forEach((z, i) => {
    const g = new W3.Group(); g.position.set(-26.6, .95, z); ship.add(g);
    const big = i === 1 ? 1.12 : 1;
    const body = cyl(1.25*big, 1.45*big, 3.8, 0x24344c, 22); body.rotation.z = Math.PI/2; g.add(body);
    [-1.1, .3, 1.5].forEach(x => { const r = glow(new W3.TorusGeometry(1.42*big, .07, 6, 30), 0xbfe6ff, .6); r.rotation.y = Math.PI/2; r.position.x = x; g.add(r); });
    const noz = cyl(1.35*big, 1.75*big, .9, FURN, 22, true); noz.rotation.z = Math.PI/2; noz.position.x = -2.3; g.add(noz);
    const disk = glow(new W3.CircleGeometry(1.3*big, 26), RED, .85); disk.rotation.y = -Math.PI/2; disk.position.x = -2.4; g.add(disk);
    const plume = new W3.Mesh(new W3.ConeGeometry(1.1*big, 3.2, 20, 1, true), new W3.MeshBasicMaterial({color:0xff7a5e, transparent:true, opacity:.35, blending:W3.AdditiveBlending, depthWrite:false, side:W3.DoubleSide}));
    plume.rotation.z = Math.PI/2; plume.position.x = -4.1; g.add(plume); flames.push({disk, plume, i});
    add(g, box(1.6, .5, .6, 0x1a2840, {eo:.4}), 2.2, -.3, 0);
  });

  /* ---------- rooms ---------- */
  const ROOMS = {
    bridge:  {poly:[[12,-10.6],[21.4,-4],[21.4,4],[12,10.6]], rect:[13.4,19.6,-5.6,5.6], dx:12, door:'x0', label:'Bridge', tint:0x1d2a40},
    research:{x0:3,     x1:11.6, z0:-10.5, z1:-1.8, door:'z1', label:'Research lab', tint:0x16243a},
    code:    {x0:3,     x1:11.6, z0:1.8,   z1:10.5, door:'z0', label:'Code bay', tint:0x142234},
    art:     {x0:-7.2,  x1:2.6,  z0:-10.5, z1:-1.8, door:'z1', label:'Art studio', tint:0x1a2236},
    test:    {x0:-7.2,  x1:2.6,  z0:1.8,   z1:10.5, door:'z0', label:'Build and test', tint:0x152233},
    living:  {x0:-15.6, x1:-7.6, z0:-10.5, z1:-1.8, door:'z1', label:'Living room', tint:0x1f2238},
    bed:     {x0:-15.6, x1:-7.6, z0:1.8,   z1:10.5, door:'z0', label:'Bunks', tint:0x1a2034},
    engine:  {poly:[[-16,-10.6],[-19.1,-10.6],[-24.5,-5.3],[-24.5,5.3],[-19.1,10.6],[-16,10.6]], rect:[-22.6,-17,-5.4,5.4], dx:-16, door:'x1', label:'Engine room', tint:0x1c1d30}
  };
  // corridor down the middle, with a dashed red line and small floor lights at the edges
  ship.add(at(box(28, .04, 2.8, 0x172539, {op:.75, eo:.18}), -2, .03, 0));
  for(let x = -15.4; x < 11.8; x += .9) ship.add(at(box(.45, .02, .06, RED, {edge:false, em:0x5a1010}), x, .07, 0));
  for(let x = -14.8; x < 11.8; x += 3.4) [-1.25, 1.25].forEach(z => blinkers.push(add(ship, glow(new W3.BoxGeometry(.25, .02, .08), LINE, .5), x, .07, z)));
  const wallH = .6, wallC = 0x24344c;
  for(const [k, r] of Object.entries(ROOMS)){
    if(r.poly){
      ship.add(flat(r.poly, r.tint, .78, .04));
      const g = 1.1; wallSeg(r.dx, -10.6, r.dx, -g, wallH, .08, wallC, .35); wallSeg(r.dx, g, r.dx, 10.6, wallH, .08, wallC, .35);
    } else {
      ship.add(at(box(r.x1 - r.x0, .05, r.z1 - r.z0, r.tint, {op:.78, eo:.25}), (r.x0 + r.x1)/2, .04, (r.z0 + r.z1)/2));
      const sides = {z0:[r.x0, r.z0, r.x1, r.z0], z1:[r.x0, r.z1, r.x1, r.z1], x0:[r.x0, r.z0, r.x0, r.z1], x1:[r.x1, r.z0, r.x1, r.z1]};
      for(const [s, v] of Object.entries(sides)){
        if(s === r.door){ const m = (r.x0 + r.x1)/2, g = 1.1; wallSeg(v[0], v[1], m - g, v[3], wallH, .08, wallC, .35); wallSeg(m + g, v[1], v[2], v[3], wallH, .08, wallC, .35); }
        else wallSeg(...v, wallH, .08, wallC, .35);
      }
      r.rect = [r.x0 + 1.1, r.x1 - 1.1, r.z0 + 1.1, r.z1 - 1.1];
    }
    const dxm = r.poly ? r.dx : (r.x0 + r.x1)/2;
    r.doorIn  = r.door === 'z1' ? V(dxm, r.z1 - 1) : r.door === 'z0' ? V(dxm, r.z0 + 1) : r.door === 'x0' ? V(r.dx + 1.1, 0) : V(r.dx - 1.1, 0);
    r.doorOut = r.door === 'z1' ? V(dxm, r.z1 + .9) : r.door === 'z0' ? V(dxm, r.z0 - .9) : r.door === 'x0' ? V(r.dx - .9, 0) : V(r.dx + .9, 0);
    r.doorAt  = r.door === 'z1' ? V(dxm, r.z1) : r.door === 'z0' ? V(dxm, r.z0) : V(r.dx, 0);
  }

  /* ---------- screens with live canvas textures ---------- */
  const screens = [];
  function screen(w, h, kind, cw = 128, ch = 80){
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const s = {c, x:c.getContext('2d'), tex:new W3.CanvasTexture(c), kind, t:Math.random()*100, active:false, prog:0, always:false};
    const m = new W3.Mesh(new W3.PlaneGeometry(w, h), new W3.MeshBasicMaterial({map:s.tex, side:W3.DoubleSide}));
    screens.push(s); drawScreen(s); m.userData.screen = s; return m;
  }
  function drawScreen(s){
    const x = s.x, W = s.c.width, H = s.c.height; x.globalAlpha = 1; x.fillStyle = '#0b1422'; x.fillRect(0, 0, W, H);
    if(s.kind === 'code'){ for(let i = 0; i < 9; i++){ const w = 20 + (((Math.sin(i*7.3 + Math.floor(s.t))*43758.5) % 1 + 1) % 1)*80; x.fillStyle = i % 4 === 1 ? '#d6473c' : i % 3 ? '#9fb2c7' : '#e2e9f0'; x.globalAlpha = s.active ? .95 : .3; x.fillRect(8 + (i % 3)*6, 6 + i*8, w, 3); } }
    else if(s.kind === 'test'){ for(let i = 0; i < 24; i++){ const done = s.active && i < s.prog*24; x.fillStyle = done ? (i % 11 === 7 ? '#d6473c' : '#e2e9f0') : '#26364c'; x.fillRect(10 + (i % 8)*14, 10 + Math.floor(i/8)*20, 10, 12); } }
    else if(s.kind === 'paint'){ const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#20314a'); g.addColorStop(1, '#0b1422'); x.fillStyle = g; x.fillRect(0, 0, W, H); x.fillStyle = '#d6473c'; x.beginPath(); x.arc(64, 40, 6 + s.prog*24, 0, 7); x.fill(); x.strokeStyle = '#e2e9f0'; x.lineWidth = 2; x.beginPath(); for(let i = 0; i <= s.prog*40; i++){ const a = i*.3; x.lineTo(64 + Math.cos(a)*(10 + i), 40 + Math.sin(a)*(8 + i*.6)); } x.stroke(); }
    else if(s.kind === 'bridge'){ x.strokeStyle = '#9fb2c7'; x.globalAlpha = .7; for(let i = 0; i < 4; i++){ x.beginPath(); x.arc(64, 40, 8 + i*9, 0, 7); x.stroke(); } x.globalAlpha = 1; x.fillStyle = '#d6473c'; x.fillRect(60 + Math.sin(s.t)*24, 36 + Math.cos(s.t*.7)*14, 6, 6); }
    else if(s.kind === 'graph'){ x.strokeStyle = '#d6473c'; x.lineWidth = 2; x.beginPath(); for(let i = 0; i < 32; i++){ const v = 40 + Math.sin(i*.5 + s.t*.6)*16 + Math.sin(i*1.7 + s.t)*6; i ? x.lineTo(4 + i*4, v) : x.moveTo(4, v); } x.stroke(); }
    else if(s.kind === 'game'){ // a tiny space invaders match on the living room TV
      x.fillStyle = '#05080f'; x.fillRect(0, 0, W, H); const off = Math.sin(s.t*.15)*14;
      for(let r = 0; r < 3; r++) for(let c = 0; c < 7; c++){ if((r*7 + c + Math.floor(s.t/9)) % 9 === 0) continue; x.fillStyle = r === 0 ? '#d6473c' : '#e2e9f0'; const ax = 22 + c*16 + off, ay = 12 + r*11 + Math.floor(s.t/30) % 3; x.fillRect(ax, ay, 9, 5); x.fillRect(ax + 1 + (Math.floor(s.t) % 2), ay + 5, 2, 2); x.fillRect(ax + 6 - (Math.floor(s.t) % 2), ay + 5, 2, 2); }
      const px = 80 + Math.sin(s.t*.31)*50; x.fillStyle = '#9fd0ff'; x.fillRect(px - 7, 78, 14, 5); x.fillRect(px - 1, 74, 2, 4);
      x.fillStyle = '#fff'; for(let i = 0; i < 3; i++){ const by = 72 - ((s.t*6 + i*22) % 66); x.fillRect(px + Math.sin(i)*2, by, 1, 4); }
      x.fillStyle = '#e9c46a'; x.font = '8px monospace'; x.fillText('1UP ' + (1200 + Math.floor(s.t)*10), 4, 9);
    }
    else if(s.kind === 'commits'){ // a GitHub style grid of the last 26 weeks
      const cols = 26, rows = 7, cs = W/cols, rh = H/rows;
      for(let c = 0; c < cols; c++) for(let r = 0; r < rows; r++){ const i = c*rows + r, last = i === cols*rows - 1;
        const v = ((Math.sin(i*12.9898)*43758.5453) % 1 + 1) % 1, lvl = c > 18 ? Math.min(1, v*1.5) : v*v;
        x.fillStyle = last ? (Math.sin(s.t*3) > 0 ? '#ff6a5c' : '#d6473c') : `rgba(226,233,240,${lvl < .15 ? .07 : .15 + lvl*.85})`; x.fillRect(c*cs + 1.5, r*rh + 1.5, cs - 3, rh - 3); }
    }
    s.tex.needsUpdate = true;
  }

  /* ---------- small props ---------- */
  function mug(p, x, y, z){ add(p, cyl(.07, .06, .14, WHITE, 10), x, y + .07, z); }
  function stack(p, x, y, z, n = 3, cols = [WHITE, RED, 0x7d8ea3]){ for(let i = 0; i < n; i++){ const b = box(.34, .05, .26, cols[i % cols.length], {edge:false}); b.rotation.y = rnd(-.3, .3); add(p, b, x, y + .03 + i*.055, z); } }
  function papers(p, x, y, z, n){ for(let i = 0; i < n; i++){ const b = box(.36, .018, .27, i % 7 === 3 ? 0xd9c9a8 : 0xf2f4f7, {edge:false}); b.rotation.y = rnd(-.2, .2); add(p, b, x + rnd(-.02, .02), y + .01 + i*.02, z + rnd(-.02, .02)); } }
  function lamp(p, x, y, z){ add(p, cyl(.08, .1, .04, DK, 10), x, y + .02, z); const arm = add(p, box(.03, .38, .03, 0x8a9bb0, {edge:false}), x, y + .21, z); arm.rotation.z = .35; add(p, glow(new W3.SphereGeometry(.06, 8, 6), 0xffe2b8), x - .12, y + .38, z); }
  function chair(x, z, f, stool){ const g = new W3.Group(); g.position.set(x, 0, z); g.rotation.y = f; ship.add(g); add(g, cyl(.04, .04, .32, 0x8a9bb0, 8), 0, .16, 0); add(g, stool ? cyl(.22, .22, .07, DK, 12) : box(.5, .07, .5, DK, {eo:.3}), 0, .34, 0); if(!stool) add(g, box(.5, .45, .07, DK, {eo:.3}), 0, .6, -.24); return g; }
  function plant(x, z, s = 1){ const g = new W3.Group(); g.position.set(x, 0, z); g.scale.setScalar(s); ship.add(g); add(g, cyl(.28, .22, .42, DK, 12), 0, .21, 0);
    for(let i = 0; i < 6; i++){ const leaf = box(.09, .65, .26, i % 2 ? 0x5f9a78 : 0x7fb58f, {edge:false}); leaf.position.set(0, .7, 0); leaf.rotation.set(rnd(-.55, .55), i*1.05, rnd(-.45, .45)); g.add(leaf); } sways.push(g); return g; }
  function flask(p, x, y, z, color, s = 1){
    const g = new W3.Group(); g.position.set(x, y, z); g.scale.setScalar(s); p.add(g);
    add(g, new W3.Mesh(new W3.ConeGeometry(.16, .26, 14, 1, true), glassMat(.35)), 0, .13, 0);
    add(g, glow(new W3.ConeGeometry(.13, .15, 14), color, .85), 0, .075, 0);
    add(g, new W3.Mesh(new W3.CylinderGeometry(.04, .04, .16, 10, 1, true), glassMat(.4)), 0, .33, 0);
    return g;
  }

  /* ---------- workstations ---------- */
  const STATIONS = [];
  const ahead = (st, d) => [st.x + Math.sin(st.f)*d, st.z + Math.cos(st.f)*d];
  function deskBase(st, top = 0x2b3d57){ const g = new W3.Group(); const [x, z] = ahead(st, 1.05); g.position.set(x, 0, z); g.rotation.y = st.f; ship.add(g);
    add(g, box(1.9, .06, .8, top, {eo:.45}), 0, .55, 0); [-.85, .85].forEach(lx => add(g, box(.08, .52, .7, FURN, {eo:.3}), lx, .26, 0)); return g; }
  function seat(st, stool){ chair(st.x - Math.sin(st.f)*.15, st.z - Math.cos(st.f)*.15, st.f, stool); }
  function desk(st, kind, deco){
    const g = deskBase(st);
    add(g, box(.7, .03, .22, 0x31445e, {eo:.3}), 0, .6, -.18); add(g, box(.08, .35, .08, 0x31445e, {edge:false}), 0, .75, .22);
    const sc = screen(1.25, .75, kind); sc.position.set(0, 1.14, .22); sc.rotation.y = Math.PI; g.add(sc); st.screen = sc.userData.screen;
    if(deco === 'mug') mug(g, .7, .58, -.15);
    if(deco === 'books') stack(g, -.65, .58, -.1);
    if(deco === 'lamp') lamp(g, .72, .58, .15);
    if(deco === 'duck'){ add(g, box(.14, .12, .14, GOLD, {edge:false}), .7, .64, -.1); add(g, box(.08, .08, .08, GOLD, {edge:false}), .73, .74, -.06); }
    if(deco === 'side'){ const s2 = screen(.6, .5, 'graph'); s2.position.set(.75, .98, .1); s2.rotation.y = Math.PI + .5; g.add(s2); s2.userData.screen.always = true; }
    seat(st);
  }
  // research: lab benches with glassware, and paper desks
  const bubbles = [], sheets = [];
  function labBench(st, palette){
    const g = deskBase(st, 0xd9e2ec);
    add(g, box(1.7, .5, .12, 0x31445e, {eo:.3}), 0, .85, .35);
    flask(g, -.6, .58, .05, palette[0]); flask(g, -.25, .58, -.05, palette[1], .8); flask(g, .55, 1.12, .32, palette[2], .7); flask(g, .2, 1.12, .32, palette[0], .6);
    const rack = add(g, box(.42, .08, .14, FURN, {eo:.3}), .45, .62, -.12);
    [RED, GOLD, 0x9fd0ff, 0xc77dff].forEach((c, i) => add(rack, glow(new W3.CylinderGeometry(.03, .03, .22, 8), c, .8), -.15 + i*.1, .12, 0));
    add(g, new W3.Mesh(new W3.CylinderGeometry(.11, .11, .22, 14, 1, true), glassMat(.35)), .05, .69, .1);
    add(g, glow(new W3.CylinderGeometry(.1, .1, .14, 14), palette[1], .75), .05, .65, .1);
    for(let i = 0; i < 5; i++){ const b = add(g, glow(new W3.SphereGeometry(.025, 6, 5), WHITE, .7), .05, .7, .1); b.userData = {st, p:i/5, ox:rnd(-.06, .06), oz:rnd(-.06, .06)}; bubbles.push(b); }
    seat(st, true); st.kind = 'lab';
  }
  function paperDesk(st){
    const g = deskBase(st);
    papers(g, -.6, .58, -.05, 14); papers(g, -.15, .58, .2, 8); papers(g, .55, .58, -.05, 4); papers(g, .4, .58, .25, 10);
    lamp(g, .8, .58, .3);
    const sh = add(g, box(.36, .015, .27, 0xf2f4f7, {edge:false}), -.6, .9, -.05); sh.visible = false; sh.userData = {st}; sheets.push(sh);
    seat(st); st.kind = 'papers';
  }
  function easel(st){
    const g = new W3.Group(); const [x, z] = ahead(st, 1.1); g.position.set(x, 0, z); g.rotation.y = st.f + Math.PI; ship.add(g);
    [[-.4, -.05], [.4, -.05], [0, -.4]].forEach(([lx, lz]) => { const l = box(.06, 1.7, .06, 0x8a9bb0, {edge:false}); l.position.set(lx, .8, lz); l.rotation.x = lz < -.1 ? .25 : -.1; g.add(l); });
    add(g, box(1.0, .05, .12, 0x8a9bb0, {edge:false}), 0, .78, .05);
    const sc = screen(1.15, .8, 'paint'); sc.position.set(0, 1.2, .06); g.add(sc); st.screen = sc.userData.screen;
    const [px, pz] = ahead(st, .2); const side = [px + Math.cos(st.f)*.9, pz - Math.sin(st.f)*.9];
    add(ship, cyl(.32, .32, .05, FURN, 16), side[0], .55, side[1]); add(ship, cyl(.04, .04, .55, 0x8a9bb0, 8), side[0], .27, side[1]);
    [RED, WHITE, 0x7d8ea3, GOLD].forEach((c, i) => add(ship, cyl(.06, .06, .1, c, 8), side[0] + Math.cos(i*1.6)*.18, .63, side[1] + Math.sin(i*1.6)*.18));
  }
  const HOLO = [() => new W3.TorusKnotGeometry(.32, .1, 64, 8), () => new W3.IcosahedronGeometry(.45, 1)];
  function pedestal(st, i){
    const [x, z] = ahead(st, 1.15);
    add(ship, cyl(.6, .72, .4, FURN, 18), x, .2, z);
    const ring = glow(new W3.RingGeometry(.4, .5, 32), RED, .5); ring.rotation.x = -Math.PI/2; add(ship, ring, x, .41, z);
    add(ship, new W3.Mesh(new W3.CylinderGeometry(.45, .55, 1.4, 18, 1, true), new W3.MeshBasicMaterial({color:LINE, transparent:true, opacity:.06, side:W3.DoubleSide, depthWrite:false})), x, 1.1, z);
    const h = glow(HOLO[i % HOLO.length](), LINE, .55); h.material.wireframe = true; add(ship, h, x, 1.25, z);
    st.holo = h; spinners.push([h, .01]);
  }
  function bench(st, deco){
    desk(st, 'test', deco);
    const [x, z] = ahead(st, 1.05); const bot = new W3.Group(); bot.position.set(x, .58, z); bot.rotation.y = st.f; ship.add(bot);
    add(bot, box(.3, .18, .22, 0x9fb2c7, {eo:.3}), -.55, .09, -.05); add(bot, glow(new W3.BoxGeometry(.06, .04, .01), RED), -.5, .12, -.17);
  }
  const addSt = (room, role, x, z, f) => { const s = {room, role, x, z, f, busy:null}; STATIONS.push(s); return s; };
  labBench(addSt('research', 'Researcher', 4.8, -7.6, Math.PI/2), [0x9fd0ff, 0xc77dff, GOLD]);
  labBench(addSt('research', 'Researcher', 4.8, -4.4, Math.PI/2), [RED, 0x7fd3a8, 0x9fd0ff]);
  paperDesk(addSt('research', 'Researcher', 8.6, -7.6, Math.PI/2));
  paperDesk(addSt('research', 'Researcher', 8.6, -4.4, Math.PI/2));
  const CD = ['mug', 'duck', 'side', 'mug']; let k = 0;
  [4.8, 8.6].forEach(x => [4.0, 7.2].forEach(z => desk(addSt('code', 'Coder', x, z, Math.PI/2), 'code', CD[k++])));
  [-5.6, -2.0].forEach(x => easel(addSt('art', 'Artist', x, -7.7, Math.PI/2)));
  [-5.6, -2.0].forEach((x, i) => pedestal(addSt('art', '3D modeler', x, -4.3, Math.PI/2), i));
  const TD = ['mug', 'side', 'lamp', 'mug']; k = 0;
  [-5.2, -1.4].forEach(x => [4.0, 7.2].forEach(z => bench(addSt('test', 'Tester', x, z, Math.PI/2), TD[k++])));
  const capSt = {room:'bridge', x:16.2, z:0, f:Math.PI/2};

  /* ---------- room decor ---------- */
  // research: shelves of binders, a rug, a globe, a telescope, a fume hood
  for(let i = 0; i < 4; i++){ const s = box(1.8, 1.4, .45, 0x1c2a40, {eo:.35}); s.position.set(4.2 + i*2.05, .7, -10.1); ship.add(s);
    for(let r = 0; r < 3; r++) for(let b = 0; b < 7; b++){ if((b*3 + r + i) % 9 === 4) continue; const bk = box(.18, .26 + ((b*7 + r) % 3)*.05, .3, [WHITE, RED, 0x7d8ea3, 0x3b4d66][(b + r + i) % 4], {edge:false}); bk.position.set(-.66 + b*.22, -.45 + r*.42, .03); s.add(bk); } }
  ship.add(at(box(5.6, .02, 4.6, 0x1d3150, {op:.6, eo:.15}), 7.3, .07, -5.8));
  const globe = glow(new W3.SphereGeometry(.42, 12, 8), LINE, .5); globe.material.wireframe = true; add(ship, globe, 10.8, 1.1, -2.7); spinners.push([globe, .008]); add(ship, box(.1, .7, .1, FURN), 10.8, .35, -2.7);
  const scope = new W3.Group(); scope.position.set(11, 0, -9.4); ship.add(scope);
  [0, 2.1, 4.2].forEach(a => { const l = box(.04, .9, .04, 0x8a9bb0, {edge:false}); l.position.set(Math.cos(a)*.2, .42, Math.sin(a)*.2); l.rotation.set(Math.sin(a)*.25, 0, -Math.cos(a)*.25); scope.add(l); });
  add(scope, cyl(.1, .14, 1.1, WHITE, 12), 0, 1.0, 0).rotation.set(.9, 0, .4);
  const hood = box(1.4, 1.5, .8, 0x1c2a40, {eo:.4}); hood.position.set(3.6, .75, -2.7); ship.add(hood); add(hood, glow(new W3.PlaneGeometry(1.1, .7), 0x9fd0ff, .15), 0, .2, .41); flask(hood, -.2, -.25, .1, 0x7fd3a8, .8);
  // code bay: cables, coffee bar, beanbag, ball, whiteboard with sticky notes, plant
  [[3.6, 9.8, 10.6, 9.8], [3.6, 2.6, 3.6, 9.8]].forEach(([a, b, c, d]) => ship.add(at(box(Math.max(.06, Math.abs(c - a)), .03, Math.max(.06, Math.abs(d - b)), RED, {edge:false, em:0x3a0a0a}), (a + c)/2, .08, (b + d)/2)));
  const coffee = box(.6, 1, .5, DK, {eo:.4}); coffee.position.set(11, .5, 9.7); ship.add(coffee); add(coffee, glow(new W3.BoxGeometry(.18, .14, .06), RED), 0, .2, .26);
  const steam = []; for(let i = 0; i < 3; i++) steam.push(add(ship, glow(new W3.SphereGeometry(.05, 6, 5), WHITE, .4), 11, 1.05, 9.8));
  const bean = new W3.Mesh(new W3.SphereGeometry(.55, 14, 10), new W3.MeshLambertMaterial({color:RED})); bean.scale.y = .55; add(ship, bean, 10.6, .3, 2.6);
  const ball = add(ship, new W3.Mesh(new W3.SphereGeometry(.16, 10, 8), new W3.MeshLambertMaterial({color:WHITE})), 6.7, .16, 2.6);
  const wb = box(2.4, 1.2, .06, 0xd9e2ec, {eo:.4}); wb.position.set(3.1, 1.2, 5.6); wb.rotation.y = Math.PI/2; ship.add(wb);
  [[-.9, .35, GOLD], [-.55, .35, RED], [-.9, .05, WHITE], [.1, .35, GOLD], [.45, .05, WHITE], [.1, -.3, RED]].forEach(([x, y, c]) => add(wb, box(.24, .24, .01, c, {edge:false}), x, y, .05));
  plant(11, 6, 1);
  // art studio: splats, plant, framed art, sculpture, rug
  [[-6.4, -2.6, RED], [-.6, -9.4, WHITE], [-3.6, -6, 0x7d8ea3], [1.6, -3, RED], [-4.2, -9.2, GOLD]].forEach(([x, z, c]) => { const sp = glow(new W3.CircleGeometry(rnd(.2, .38), 14), c, .55); sp.rotation.x = -Math.PI/2; sp.position.set(x, .075, z); ship.add(sp); });
  plant(1.9, -9.4, 1.1);
  [[-6, RED, 1.0], [-4.5, 0x7d8ea3, .8], [-3.2, WHITE, 1.1]].forEach(([x, c, s]) => { const fr = box(s, s*.75, .05, FURN, {eo:.5}); fr.position.set(x, 1.5, -10.45); ship.add(fr); add(fr, box(s*.8, s*.55, .01, c, {edge:false}), 0, 0, .03); });
  add(ship, box(.6, .9, .6, 0xd9e2ec, {eo:.4}), -6.3, .45, -2.9); const bust = add(ship, new W3.Mesh(new W3.DodecahedronGeometry(.32, 0), new W3.MeshLambertMaterial({color:0xd9e2ec})), -6.3, 1.2, -2.9); spinners.push([bust, .004]);
  ship.add(at(box(3.6, .02, 2.2, 0x2a2f4a, {op:.7, eo:.12}), -3.8, .07, -6));
  // build and test: racks, rocket, crates, robot arm, conveyor
  for(let i = 0; i < 5; i++){ const rk = box(.6, 1.6, 1.3, 0x1c2a40, {eo:.4}); rk.position.set(-6.8, .8, 2.9 + i*1.5); ship.add(rk);
    for(let l = 0; l < 8; l++){ const led = glow(new W3.BoxGeometry(.02, .06, .1), l % 3 ? LINE : RED, 1); led.position.set(.31, .6 - Math.floor(l/2)*.32, -.3 + (l % 2)*.25); rk.add(led); blinkers.push(led); } }
  const rocket = new W3.Group(); rocket.position.set(1.6, 0, 9.4); ship.add(rocket);
  add(rocket, cyl(.3, .4, .2, FURN, 12), 0, .1, 0); add(rocket, cyl(.14, .14, .7, WHITE, 12), 0, .55, 0); add(rocket, new W3.Mesh(new W3.ConeGeometry(.14, .3, 12), new W3.MeshLambertMaterial({color:RED})), 0, 1.05, 0);
  [0, 2.1, 4.2].forEach(a => { const fin = box(.04, .22, .16, RED, {edge:false}); fin.position.set(Math.cos(a)*.15, .3, Math.sin(a)*.15); fin.rotation.y = -a; rocket.add(fin); });
  [[1.8, 2.6], [1.1, 2.6], [1.45, 2.6]].forEach(([x, z], i) => add(ship, box(.6, .5, .6, i === 2 ? DK : 0x31445e, {eo:.35}), x, i === 2 ? .75 : .25, z));
  const rarm = new W3.Group(); rarm.position.set(-3.3, 0, 9.4); ship.add(rarm);
  add(rarm, cyl(.35, .42, .25, DK, 16), 0, .12, 0);
  const rj1 = new W3.Group(); rj1.position.y = .25; rarm.add(rj1); add(rj1, box(.18, .9, .18, GOLD, {eo:.3}), 0, .45, 0);
  const rj2 = new W3.Group(); rj2.position.y = .9; rj1.add(rj2); add(rj2, box(.14, .7, .14, GOLD, {eo:.3}), 0, .35, 0);
  const claw = add(rj2, box(.26, .08, .12, DK, {eo:.3}), 0, .74, 0);
  const belt = box(4.4, .35, .7, 0x1c2a40, {eo:.35}); belt.position.set(-1.0, .18, 9.6); ship.add(belt);
  for(let i = 0; i < 11; i++) add(belt, box(.04, .02, .66, 0x31445e, {edge:false}), -2.1 + i*.42, .18, 0);
  const crates = [0, 1, 2].map(i => add(ship, box(.38, .3, .38, i === 1 ? RED : 0x7d8ea3, {eo:.4}), 0, .5, 9.6));
  // living room: TV and console, sofa, coffee table with snacks, fridge, rug, lamp
  ship.add(at(box(5.2, .02, 3.6, 0x2b2440, {op:.75, eo:.12}), -11.6, .07, -6.4));
  add(ship, box(3.6, .5, .6, DK, {eo:.4}), -11.6, .25, -9.9);
  add(ship, box(3.4, 2, .1, 0x0a0e14, {eo:.5}), -11.6, 1.55, -10.26);
  const tv = screen(3.2, 1.8, 'game', 160, 90); tv.position.set(-11.6, 1.55, -10.19); ship.add(tv); tv.userData.screen.always = true;
  const consoleBox = add(ship, box(.7, .14, .45, 0x0a0e14, {eo:.4}), -12.6, .57, -9.85); blinkers.push(add(consoleBox, glow(new W3.BoxGeometry(.06, .03, .02), RED), .25, 0, .23));
  add(ship, box(.3, .55, .3, 0x0a0e14, {eo:.4}), -10.2, .78, -9.9);
  const sofa = new W3.Group(); sofa.position.set(-11.6, 0, -5.2); ship.add(sofa);
  add(sofa, box(4.8, .4, 1.2, 0x3b2f52, {eo:.35}), 0, .2, 0); add(sofa, box(4.8, .55, .35, 0x3b2f52, {eo:.35}), 0, .5, .45);
  [-2.55, 2.55].forEach(x => add(sofa, box(.3, .55, 1.2, 0x3b2f52, {eo:.35}), x, .35, 0));
  [-1.6, 0, 1.6].forEach((x, i) => add(sofa, box(1.2, .1, .9, [0x4a3c66, 0x52436f, 0x4a3c66][i], {edge:false}), x, .45, -.1));
  add(sofa, box(.5, .35, .2, RED, {edge:false}), -2.1, .7, .2).rotation.z = .3;
  add(ship, box(1.6, .35, .7, FURN, {eo:.4}), -11.6, .18, -7.4);
  add(ship, cyl(.25, .16, .12, WHITE, 14), -11.9, .42, -7.4); for(let i = 0; i < 5; i++) add(ship, box(.08, .05, .08, GOLD, {edge:false}), -11.9 + rnd(-.12, .12), .5, -7.4 + rnd(-.12, .12));
  mug(ship, -11.2, .35, -7.3);
  const fridge = box(.9, 1.7, .8, 0xd9e2ec, {eo:.4}); fridge.position.set(-8.3, .85, -9.6); ship.add(fridge); add(fridge, box(.04, .5, .04, 0x8a9bb0, {edge:false}), -.35, .2, .42);
  plant(-15, -2.6, .9); lamp(ship, -14.9, 0, -9.6);
  // bunks: two bunk beds and a single bed, posters, a dresser, a rug
  const BLANKETS = [RED, 0x7d8ea3, DENIM, 0xc77dff, WHITE];
  function bed(x, z, y, color){ add(ship, box(2.2, .14, 1.1, FURN, {eo:.35}), x, y, z); add(ship, box(1.7, .1, 1.0, color, {edge:false}), x + .2, y + .11, z); add(ship, box(.45, .12, .8, WHITE, {edge:false}), x - .78, y + .13, z); }
  [3.4, 6.4].forEach((z, i) => { [[-14.6, -.5], [-12.4, -.5], [-14.6, .5], [-12.4, .5]].forEach(([px, pz]) => add(ship, box(.08, 2.9, .08, 0x8a9bb0, {edge:false}), px, 1.45, z + pz));
    bed(-13.5, z, .45, BLANKETS[i*2]); bed(-13.5, z, 2.15, BLANKETS[i*2 + 1]);
    for(let r = 0; r < 6; r++) add(ship, box(.05, .04, .5, 0x8a9bb0, {edge:false}), -12.35, .5 + r*.33, z - .35); });
  bed(-9.4, 9.2, .45, GOLD);
  add(ship, box(.5, .5, .5, FURN, {eo:.35}), -10.9, .25, 9.6); lamp(ship, -10.9, .5, 9.6);
  add(ship, box(1.6, .9, .55, DK, {eo:.35}), -8.6, .45, 3.0);
  [[-15.55, 3.9, RED], [-15.55, 6.9, 0x9fd0ff]].forEach(([x, z, c]) => add(ship, box(.04, .9, .65, c, {edge:false}), x, 1.4, z));
  ship.add(at(box(2.6, .02, 2.2, 0x2b2440, {op:.75, eo:.12}), -10, .07, 6));
  // bridge: consoles at the nose, crew seats along the edges, holo table, captain's chair
  for(let i = -1; i <= 1; i++){ const c = box(.8, .6, 1.9, FURN, {eo:.45}); c.position.set(20.2 - Math.abs(i)*.7, .3, i*2.1); c.rotation.y = -i*.57; ship.add(c);
    const sc = screen(1.6, .6, 'bridge'); sc.position.set(-.41, .5, 0); sc.rotation.set(-.5, -Math.PI/2, 0, 'YXZ'); c.add(sc);
    for(let b = 0; b < 4; b++){ const btn = glow(new W3.BoxGeometry(.08, .03, .08), b % 2 ? RED : LINE, 1); btn.position.set(.1, .31, -.6 + b*.4); c.add(btn); blinkers.push(btn); } }
  // crew seats face the angled windows on each side
  const SEATS = [[15.2, -6.2, 2.53], [17.8, -4.4, 2.53], [15.2, 6.2, .61], [17.8, 4.4, .61]];
  SEATS.forEach(([x, z, f]) => { chair(x, z, f).scale.setScalar(1.15); const cx = x + Math.sin(f)*1.1, cz = z + Math.cos(f)*1.1; const c = box(1.3, .55, .5, FURN, {eo:.4}); c.position.set(cx, .28, cz); c.rotation.y = f; ship.add(c);
    const sc = screen(1.0, .45, 'graph'); sc.position.set(cx - Math.sin(f)*.05, .8, cz - Math.cos(f)*.05); sc.rotation.y = f + Math.PI; ship.add(sc); sc.userData.screen.always = true; });
  add(ship, cyl(.65, .8, .5, FURN, 18), 14.2, .25, 0);
  const holo = glow(new W3.SphereGeometry(.55, 12, 8), RED, .8); holo.material.wireframe = true; add(ship, holo, 14.2, 1.35, 0); spinners.push([holo, .01]);
  const hring = glow(new W3.TorusGeometry(.95, .015, 4, 48), LINE, .5); hring.position.copy(holo.position); hring.rotation.x = 1.3; ship.add(hring); spinners.push([hring, .006, 'z']);
  chair(15.9, 0, Math.PI/2).scale.setScalar(1.3);
  plant(12.8, 3.6, .9); plant(12.8, -3.6, .9);
  // engine room: three power conduits in line with the engines show what is left of each quota,
  // and a commit wall of four racks sits in the corner
  const USAGE = [{k:'Session', used:.62}, {k:'Tokens', used:.47}, {k:'This week', used:.38}];
  const RING_ON = 0x8fd2ff, RING_OFF = 0x3a4b62;
  const conduits = USAGE.map((u, i) => {
    const z = -3.5 + i*3.5, g = new W3.Group(); g.position.set(-21.4, 1.05, z); ship.add(g);
    // one pair of end blocks, standing on the floor, with gold bands
    [-1.55, 1.55].forEach(x => { const c = add(g, box(.5, 1.65, 1.25, 0x24344c, {eo:.5}), x, -.22, 0);
      add(c, box(.52, .1, 1.27, GOLD, {edge:false}), 0, .6, 0); add(c, box(.52, .1, 1.27, GOLD, {edge:false}), 0, .25, 0); add(c, box(.02, .26, .26, GOLD, {edge:false}), x < 0 ? -.26 : .26, .1, 0); });
    const tube = new W3.Mesh(new W3.CylinderGeometry(.56, .56, 2.6, 24, 1, true), glassMat(.1)); tube.rotation.z = Math.PI/2; g.add(tube);
    const coreC = glow(new W3.CylinderGeometry(.14, .14, 2.6, 12), RING_ON, .35); coreC.rotation.z = Math.PI/2; g.add(coreC);
    // twelve thick rings stacked almost touching; used ones stay as dark metal
    const rings = []; for(let r = 0; r < 12; r++){ const ring = new W3.Mesh(new W3.TorusGeometry(.42, .095, 10, 28), new W3.MeshLambertMaterial({color:RING_OFF})); ring.rotation.y = Math.PI/2; ring.position.x = -1.1 + r*.2; g.add(ring); rings.push(ring); }
    // a pipe from the back block through the hull to the engine
    const big = i === 1 ? 1.12 : 1;
    const flare = cyl(1.15*big, .32, 1.9, 0x24344c, 24); flare.rotation.z = Math.PI/2; add(g, flare, -2.75, -.06, 0);
    flare.add(new W3.LineSegments(new W3.EdgesGeometry(flare.geometry, 30), edgeMat(.4)));
    const band = glow(new W3.TorusGeometry(.36, .04, 6, 24), GOLD, 1); band.rotation.y = Math.PI/2; add(g, band, -1.85, 0, 0);
    return {u, rings, coreC, z};
  });
  const commitLeds = [];
  for(let k = 0; k < 4; k++){ const rk = box(.78, 1.9, .6, 0x1c2a40, {eo:.45}); rk.position.set(-19.2 + k*.8, .95, -9.6); ship.add(rk);
    for(let c = 0; c < 6; c++) for(let r = 0; r < 7; r++){ const i = (k*6 + c)*7 + r, v = ((Math.sin(i*12.9898)*43758.5453) % 1 + 1) % 1, lvl = k > 1 ? Math.min(1, v*1.5) : v*v, today = i === 4*6*7 - 2;
      const led = glow(new W3.BoxGeometry(.085, .15, .02), today ? RED : LINE, today ? 1 : lvl < .15 ? .07 : .15 + lvl*.85); led.position.set(-.29 + c*.115, .66 - r*.2, .31); rk.add(led); if(today) commitLeds.push(led); } }

  // soft pools of light on each room floor
  const poolTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); return new W3.CanvasTexture(c); })();
  function pool(x, z, r, color, o){ const m = new W3.Mesh(new W3.PlaneGeometry(r*2, r*2), new W3.MeshBasicMaterial({map:poolTex, color, transparent:true, opacity:o, blending:W3.AdditiveBlending, depthWrite:false})); m.rotation.x = -Math.PI/2; m.position.set(x, .09, z); ship.add(m); return m; }
  pool(7.3, -6.1, 4, 0xffe2b8, .14); pool(7.3, 6.1, 4, 0x9fd0ff, .13); pool(-2.3, -6.1, 4, 0xffc2b0, .13); pool(-2.3, 6.1, 4, 0xbfd6ff, .12);
  pool(-11.6, -6.1, 3.8, 0xc7a0ff, .14); pool(-11.6, 6.1, 3.6, 0x9fb2ff, .1); pool(16.5, 0, 4.6, 0xff8a7a, .15);
  const reactorPool = pool(-21.2, 0, 4.6, 0x9fd0ff, .14);
  const sparks = [];
  [[14.2, 0], [-4.45, -4.3], [-.85, -4.3]].forEach(([x, z]) => { for(let i = 0; i < 6; i++){ const s = glow(new W3.BoxGeometry(.04, .04, .04), i % 2 ? RED : LINE, .8); s.userData = {x, z, p:Math.random(), a:Math.random()*6}; ship.add(s); sparks.push(s); } });
  const doorLights = {};
  for(const [key, r] of Object.entries(ROOMS)){ const m = glow(new W3.BoxGeometry(.5, .08, .08), LINE, .5); m.position.set(r.doorAt.x, .75, r.doorAt.z); if(r.door[0] === 'x') m.rotation.y = Math.PI/2; ship.add(m); doorLights[key] = m; }
  const drone = new W3.Group(); ship.add(drone);
  add(drone, cyl(.32, .36, .14, 0x9fb2c7, 18), 0, .1, 0); add(drone, cyl(.18, .2, .08, DK, 14), 0, .21, 0);
  const droneLed = add(drone, glow(new W3.SphereGeometry(.05, 8, 6), RED), 0, .28, 0);
  const pg = new W3.Group(); pg.position.set(6, -3, -21); ship.add(pg);
  const planetW = glow(new W3.SphereGeometry(2.6, 20, 14), RED, .5); planetW.material.wireframe = true; pg.add(planetW); spinners.push([planetW, .003]);
  const pring = glow(new W3.TorusGeometry(4, .03, 4, 80), LINE, .35); pring.rotation.x = 1.25; pg.add(pring);
  const moon = add(pg, glow(new W3.SphereGeometry(.35, 10, 8), LINE, .7), 4.6, 0, 0);
  const starGeo = new W3.BufferGeometry(), sp = [];
  for(let i = 0; i < 640; i++) sp.push(rnd(-120, 125), rnd(-10, -1), rnd(-90, 90));
  starGeo.setAttribute('position', new W3.Float32BufferAttribute(sp, 3));
  const stars = new W3.Points(starGeo, new W3.PointsMaterial({color:LINE, size:.08, transparent:true, opacity:.6})); scene.add(stars);

  /* ---------- 3D dust: soft specks drifting around the ship, in three depth layers ----------
     The camera is orthographic, so a pan would move every speck the same distance. Each layer is shifted
     with the camera by its own share (far layers trail behind, near layers run ahead), which brings the parallax back.
     Turning the ship moves the specks by their distance from the center, so that parallaxes too. Same pale blue as Home. */
  const DR = 85, DY = 30;
  const dustLayers = [[.5, 400, 3.2, .5], [.85, 340, 4.6, .65], [1.45, 240, 8.5, .5]].map(([f, n, size, alpha]) => {
    const g = new W3.BufferGeometry(), pos = new Float32Array(n*3), vel = new Float32Array(n*3), ph = new Float32Array(n*3);
    for(let i = 0; i < n; i++){ pos.set([rnd(-DR, DR), rnd(-DY, DY*.8), rnd(-DR, DR)], i*3); vel.set([rnd(-.45, .45), rnd(-.16, .1), rnd(-.45, .45)], i*3); ph.set([rnd(0, 6.28), rnd(.5, 1.6), .55 + Math.random()*.9], i*3); }
    g.setAttribute('position', new W3.BufferAttribute(pos, 3)); g.setAttribute('aVel', new W3.BufferAttribute(vel, 3)); g.setAttribute('aPh', new W3.BufferAttribute(ph, 3));
    const m = new W3.ShaderMaterial({transparent:true, depthWrite:false, uniforms:{uT:{value:0}, uSize:{value:matchMedia('(max-width:560px)').matches ? size*.5 : size}, uAlpha:{value:alpha}, uFade:{value:0}, uPR:{value:1}},
      vertexShader:`attribute vec3 aVel; attribute vec3 aPh; uniform float uT, uSize, uPR; varying float vA;
        void main(){ vec3 e = vec3(${DR.toFixed(1)}, ${DY.toFixed(1)}, ${DR.toFixed(1)}); vec3 p = mod(position + aVel*uT + e, e*2.) - e;
          gl_Position = projectionMatrix*modelViewMatrix*vec4(p, 1.); gl_PointSize = max(1.5, uSize*aPh.z*uPR);
          vA = .55 + .45*sin(uT*aPh.y + aPh.x); }`,
      fragmentShader:`uniform float uAlpha, uFade; varying float vA;
        void main(){ float d = length(gl_PointCoord - .5)*2.; float a = clamp(1. - d, 0., 1.); a = a*a*(3. - 2.*a); gl_FragColor = vec4(.784, .863, .961, a*vA*uAlpha*uFade); }`});
    const pts = new W3.Points(g, m); pts.frustumCulled = false; pts.visible = false; scene.add(pts);
    return {f, pts, m};
  });
  /* the page's BG switch decides: Dust or All (older switch) or the Dust toggle (newer switch) */
  const dustWanted = () => { try { if(MC.bg && typeof MC.bg.has === 'function') return !!MC.bg.has('dust'); const m = MC.bg && MC.bg.mode && MC.bg.mode(); return m === 2 || m === 4 || m === 'dust' || m === 'all'; } catch(e){ return false; } };
  let dustOn = dustWanted(), dustFade = 0;
  addEventListener('mc:bg', () => { dustOn = dustWanted(); });
  setInterval(() => { dustOn = dustWanted(); }, 1000);

  /* ---------- places to be when idle ---------- */
  const POI = [
    {room:'research', x:10.1, z:-2.7, act:'look', f:Math.PI/2, say:'Spinny globe.'},
    {room:'research', x:10.4, z:-8.6, act:'look', f:2.6, say:'Is that a star?'},
    {room:'code', x:10.6, z:2.6, act:'sit', f:-.4, y:.42, say:'So comfy...'},
    {room:'code', x:10.25, z:9.6, act:'coffee', f:Math.PI/2, say:'Coffee time!'},
    {room:'art', x:1.25, z:-8.75, act:'water', f:2.28, say:'Grow, little plant.'},
    {room:'art', x:-4.5, z:-9.3, act:'look', f:Math.PI, say:'Hmm, nice.'},
    {room:'test', x:.85, z:8.75, act:'look', f:.85, say:'One day, rocket...'},
    {room:'test', x:-5.9, z:6.1, act:'look', f:-Math.PI/2, say:'Fans sound happy.'},
    {room:'living', x:-13.2, z:-5.4, act:'game', f:Math.PI, y:.42, brk:true, say:'My turn!'},
    {room:'living', x:-11.6, z:-5.4, act:'game', f:Math.PI, y:.42, brk:true, say:'Watch this!'},
    {room:'living', x:-10.0, z:-5.4, act:'sit', f:Math.PI, y:.42, brk:true, say:'Go go go!'},
    {room:'living', x:-8.9, z:-8.7, act:'coffee', f:2.55, brk:true, say:'Snack break!'},
    {room:'bed', x:-13.0, z:3.4, act:'sleep', f:Math.PI/2, y:2.28, brk:true},
    {room:'bed', x:-13.0, z:6.4, act:'sleep', f:Math.PI/2, y:2.28, brk:true},
    {room:'bed', x:-13.0, z:6.4, act:'sleep', f:Math.PI/2, y:.58, brk:true},
    {room:'bed', x:-8.9, z:9.2, act:'sleep', f:Math.PI/2, y:.58, brk:true},
    {room:'bridge', x:SEATS[0][0], z:SEATS[0][1], act:'sit', f:SEATS[0][2], y:.42, brk:true, say:'Nice view.'},
    {room:'bridge', x:SEATS[2][0], z:SEATS[2][1], act:'sit', f:SEATS[2][2], y:.42, brk:true, say:'Stars, stars, stars.'},
    {room:'engine', x:-19.6, z:1.75, act:'look', f:Math.PI, brk:true, say:'Power looks good.'}
  ];

  /* ---------- the crew: little Clawds ---------- */
  const ROLE = {
    Orchestrator:{room:'bridge', acc:'captain', model:'Opus 5.5'},
    Researcher:{room:'research', acc:'coat', model:'Haiku 5.5', plural:'researchers'},
    Coder:{room:'code', acc:'phones', model:'Sonnet 5.5', plural:'coders'},
    Artist:{room:'art', acc:'beret', tool:'brush', model:'Sonnet 5.5', plural:'artists'},
    '3D modeler':{room:'art', acc:'visor', model:'Sonnet 5.5', plural:'3D modelers'},
    Tester:{room:'test', acc:'overalls', tool:'wrench', model:'Haiku 5.5', plural:'testers'}
  };
  const NAMES = {Researcher:['Atlas','Quill','Sage','Echo','Lumen'], Coder:['Patch','Bit','Lint','Stack','Hex'], Artist:['Hue','Ink','Dab'], '3D modeler':['Vertex','Voxel','Poly'], Tester:['Bolt','Gauge','Volt','Spark']};
  const DONE = ['Done!', 'All good!', 'Finished!', 'Ta-da!'];
  const FUN = ['la la la', 'hehe', '*stretch*', 'hmm...', 'wheee!'];
  const GAMER = ['gg!', 'No way!', 'One more round!', 'Combo!'];
  const CAP_IDLE = ['All quiet on the bridge.', 'Steady as she goes.', 'Nice view out there.', 'Waiting for orders.', 'Coffee, anyone?', 'The crew is happy today.'];
  // small talk for two idle crew members: lines alternate between the one who walked over (0) and the one who waited (1)
  const CHATS = [
    [[0, 'Did you see that sunrise?'], [1, 'Which one? We have three.'], [0, 'The pink one!'], [1, 'Oh, that was lovely.']],
    [[0, 'Coffee or tea?'], [1, 'Coffee. Always coffee.'], [0, 'Same!'], [1, 'High five!']],
    [[0, 'I found a tiny bug today.'], [1, 'Was it cute?'], [0, 'It had six legs.'], [1, 'Eww. But also cute.']],
    [[0, 'Want to play after this?'], [1, 'Only if I get the red ship.'], [0, 'Deal!']],
    [[0, 'Is the Captain asleep?'], [1, 'Never. Eyes open.'], [0, 'Both of them?'], [1, 'Both of them.']],
    [[0, 'The planet looks closer.'], [1, 'It is just wireframe.'], [0, 'A very pretty wireframe.']],
    [[0, 'What are you building?'], [1, 'A tiny rocket.'], [0, 'Can I paint it?'], [1, 'Only red!']],
    [[0, 'Race you to the sofa!'], [1, 'Walking is faster.'], [0, 'You have no spirit.']],
    [[0, 'I like our ship.'], [1, 'Me too.'], [0, 'It hums a nice tune.'], [1, 'Hmm hm hmmm...']],
    [[0, 'Did you hear a beep?'], [1, 'That was the plant.'], [0, 'The plant beeps?'], [1, 'It is a happy plant.']],
    [[0, 'Rock, paper...'], [1, '...scissors!'], [0, 'Rock!'], [1, 'Paper! I win!'], [0, 'Best of three?'], {rps:true}],
    [[0, 'Ready? Rock, paper...'], [1, '...scissors!'], [0, 'Scissors!'], [1, 'Scissors too! Again!'], {rps:true}]
  ];
  const S = 2, pickables = [], black = new W3.MeshBasicMaterial({color:0x0a0e14});
  const crew = [];
  let uid = 0, hover = null, mouse = null;

  function makeAgent(role, name, opt = {}){
    const R = ROLE[role], a = {id:opt.id || 'a' + (++uid), name, role, model:R.model, room:R.room, loc:R.room, acc:R.acc, tool:R.tool, extra:!!opt.extra};
    const g = new W3.Group(), body = new W3.Group(); g.add(body);
    const torso = box(.66, .4, .44, CLAWD, {eo:.3, ec:0x6a2a1a}); torso.position.y = .37; body.add(torso);
    torso.userData.agent = a; pickables.push(torso);
    a.eyes = [-.15, .15].map(x => at(new W3.Mesh(new W3.BoxGeometry(.085, .085, .02), black), x, .46, .225));
    a.eyes.forEach(e => body.add(e));
    const sleeve = a.acc === 'coat' ? WHITE : a.acc === 'overalls' ? DENIM : CLAWD;
    a.arms = [-1, 1].map(s => { const p = new W3.Group(); p.position.set(s*.33, .33, 0); p.add(at(box(.16, .13, .16, sleeve, {edge:false}), s*.08, 0, 0)); body.add(p); return p; });
    a.hips = new W3.Group(); g.add(a.hips);
    a.legs = [-.24, -.08, .08, .24].map(x => { const l = box(.08, .2, .16, CLAWD, {edge:false}); l.position.set(x, .1, 0); a.hips.add(l); return l; });
    const acc = new W3.Group(); acc.position.y = .57; body.add(acc);
    if(a.acc === 'captain'){ acc.add(at(box(.5, .13, .42, WHITE, {eo:.3, ec:0x0a0e14}), 0, .065, 0)); acc.add(at(box(.56, .03, .48, 0x0a0e14, {edge:false}), 0, 0, .03)); acc.add(at(box(.1, .06, .02, RED, {edge:false}), 0, .08, .22)); }
    if(a.acc === 'coat' || a.acc === 'overalls'){ // lab coat (white) or work coat (denim), with a low collar so the eyes stay clear
      const C = a.acc === 'coat' ? WHITE : DENIM, E = a.acc === 'coat' ? 0x8a9bb0 : 0x22355a;
      // coat: a plain back half, and a front half whose outline has a real V notch, so the skin shows through
      body.add(at(box(.7, .21, .24, C, {eo:.25, ec:E}), 0, .265, -.12));
      const VX = .07, VD = .09, TOP = .37, BOT = .16;
      const outline = new W3.Shape([[-.35, BOT], [.35, BOT], [.35, TOP], [VX, TOP], [0, TOP - VD], [-VX, TOP], [-.35, TOP]].map(p => new W3.Vector2(p[0], p[1])));
      const fgeo = new W3.ExtrudeGeometry(outline, {depth:.24, bevelEnabled:false});
      const front = new W3.Mesh(fgeo, new W3.MeshLambertMaterial({color:C})); front.add(new W3.LineSegments(new W3.EdgesGeometry(fgeo), edgeMat(.25, E))); body.add(front);
      // collar pieces lie flat along the two edges of the V, just outside the notch
      const VA = Math.atan2(VX, VD), ux = Math.sin(VA), uy = Math.cos(VA);
      [-1, 1].forEach(s => { const c = box(.12, .1, .02, C, {edge:false}); c.position.set(s*(VX/2 + uy*.06), TOP - VD/2 - ux*.06, .25); c.rotation.z = -s*VA; body.add(c); });
      body.add(at(box(.012, TOP - VD - BOT, .01, E, {edge:false}), 0, (TOP - VD + BOT)/2, .245));
      body.add(at(box(.1, .05, .01, a.acc === 'coat' ? 0xd9e2ec : 0x34507d, {edge:false}), .2, .29, .245)); body.add(at(box(.02, .07, .015, a.acc === 'coat' ? RED : GOLD, {edge:false}), .18, .32, .25));
    }
    if(a.acc === 'phones'){ acc.add(at(box(.72, .05, .08, DK, {edge:false}), 0, .02, 0)); [-1, 1].forEach(s => acc.add(at(box(.08, .18, .18, DK, {eo:.3}), s*.36, -.14, 0))); }
    if(a.acc === 'beret'){ const b = cyl(.26, .24, .08, DK); b.rotation.z = .25; b.position.set(.06, .03, 0); acc.add(b); acc.add(at(box(.03, .07, .03, DK, {edge:false}), .08, .09, 0)); }
    if(a.acc === 'visor'){ acc.add(at(box(.56, .13, .05, WHITE, {edge:false, em:0x6a7f99}), 0, -.12, .235)); a.eyes.forEach(e => e.visible = false); }
    a.tools = {};
    if(a.tool === 'brush'){ const t = box(.04, .04, .34, WHITE, {edge:false}); t.position.set(.16, 0, .15); t.add(at(box(.06, .06, .07, RED, {edge:false}), 0, 0, .17)); a.arms[1].add(t); a.tools.main = t; }
    if(a.tool === 'wrench'){ const t = box(.05, .05, .34, 0x9fb2c7, {edge:false}); t.position.set(.16, 0, .15); t.add(at(box(.12, .05, .07, 0x9fb2c7, {edge:false}), 0, 0, .18)); a.arms[1].add(t); a.tools.main = t; }
    if(role === 'Researcher'){ a.tools.tube = add(a.arms[1], glow(new W3.CylinderGeometry(.03, .03, .2, 8), 0x7fd3a8, .85), .16, .08, .1); a.tools.sheet = add(a.arms[0], box(.22, .01, .28, 0xf2f4f7, {edge:false}), -.14, .02, .18); }
    a.cup = add(a.arms[0], cyl(.07, .06, .13, WHITE, 10), -.18, 0, .12);
    a.pad = add(body, box(.3, .05, .14, 0x0a0e14, {edge:false}), 0, .3, .33); add(a.pad, glow(new W3.BoxGeometry(.04, .02, .04), RED), .08, .03, 0);
    a.ring = glow(new W3.RingGeometry(.4, .46, 32), RED, 0); a.ring.material.side = W3.DoubleSide; a.ring.rotation.x = -Math.PI/2; a.ring.position.y = .04; g.add(a.ring);
    g.scale.setScalar(S); a.g = g; a.body = body; ship.add(g);
    const rr = ROOMS[a.loc].rect;
    a.pos = opt.pos ? opt.pos.clone() : V(rnd(rr[0], rr[1]), rnd(rr[2], rr[3]));
    Object.assign(a, {face:Math.random()*6, state:'idle', act:null, actT:0, wait:false, phase:Math.random()*6, tokens:0, spent:0, total:0, task:null, station:null, appear:opt.hold !== undefined ? 0 : 1, hold:opt.hold || 0, path:[], lift:0, poi:null, chat:null, real:null});
    g.position.copy(a.pos); crew.push(a); return a;
  }
  function removeAgent(a){
    ship.remove(a.g);
    const i = pickables.findIndex(p => p.userData.agent === a); if(i >= 0) pickables.splice(i, 1);
    if(a.bub) a.bub.el.remove(); crew.splice(crew.indexOf(a), 1);
    if(hover === a){ hover = null; card.classList.remove('show'); }
  }
  // walk through doors and the corridor instead of through walls
  function goTo(a, room, p){
    const path = [];
    if(a.loc !== room){
      if(a.loc !== 'hall'){ const d = ROOMS[a.loc]; path.push({p:d.doorIn}, {p:d.doorOut, loc:'hall'}); }
      const d2 = ROOMS[room]; path.push({p:d2.doorOut}, {p:d2.doorIn, loc:room});
    }
    path.push({p:V(p.x, p.z)}); a.path = path;
  }

  const beams = [];
  function beam(p){ const m = new W3.Mesh(new W3.CylinderGeometry(.7, .7, 4, 18, 1, true), new W3.MeshBasicMaterial({color:RED, transparent:true, opacity:.6, side:W3.DoubleSide, depthWrite:false})); m.position.set(p.x, 2, p.z); ship.add(m); beams.push({m, t:0}); }

  /* ---------- overlays ---------- */
  const labels = Object.entries(ROOMS).map(([key, r]) => { const e = document.createElement('div'); e.className = 'room-l'; e.textContent = r.label; overlay.appendChild(e);
    const p = key === 'bridge' ? new W3.Vector3(14, .05, -8) : key === 'engine' ? new W3.Vector3(-17, .05, -3.2) : new W3.Vector3((r.x0 + r.x1)/2, .05, r.door === 'z1' ? r.z1 - .55 : r.z0 + .55); return {e, p}; });
  conduits.forEach(m => { const e = document.createElement('div'); e.className = 'room-l'; e.textContent = m.u.k; overlay.appendChild(e); labels.push({e, p:new W3.Vector3(-21.4, 2.05, m.z)}); });
  { const e = document.createElement('div'); e.className = 'room-l'; e.textContent = 'Commits'; overlay.appendChild(e); labels.push({e, p:new W3.Vector3(-18, 2.2, -9.6)}); }
  /* speech bubbles stay twice as long as they used to: ms is the old length */
  function bubble(a, text, ms = 3200){ if(a.bub) a.bub.el.remove(); const e = document.createElement('div'); e.className = 'bub'; e.textContent = text; overlay.appendChild(e); a.bub = {el:e, until:performance.now() + ms*2, ms:ms*2}; }

  /* ---------- real work: helpers are real subagents, found by the server ---------- */
  // Art takes a spare 3D spot when its own are full, and the other way round.
  function stationFor(role){
    const order = role === 'Artist' ? ['Artist', '3D modeler'] : role === '3D modeler' ? ['3D modeler', 'Artist'] : [role];
    for(const r of order){ const s = STATIONS.find(s => s.role === r && !s.busy); if(s) return s; }
    return null;
  }
  function startTask(a){
    const st = a.station || stationFor(a.role); if(!st) return false;
    a.nextSay = performance.now() + rnd(16000, 26000);
    a.poi = null; a.act = null; a.wait = false;
    st.busy = a; a.station = st; a.state = 'work'; a.task = a.real ? a.real.description : 'Working';
    goTo(a, a.room, V(st.x, st.z));
    if(a.real) bubble(a, shortWords(a.task), 4200);
    return true;
  }
  function finish(a){
    if(a.station){ a.station.busy = null; if(a.station.screen) a.station.screen.active = false; }
    a.station = null; a.task = null; a.act = null; a.real = null;
    if(a.extra){ a.state = 'leave'; goTo(a, a.room, ROOMS[a.room].doorIn); bubble(a, pick(DONE), 1800); }
    else { a.state = 'idle'; bubble(a, pick(DONE), 2200); }
  }
  function shortWords(t, n = 5){
    const w = String(t || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean); let k = Math.min(n, w.length);
    while(k > 2 && /^(the|a|an|to|for|of|and|in|on|at|with|by|from)$/i.test(w[k - 1])) k--;
    let s = w.slice(0, k).join(' ');
    if(s.length > 38) s = s.slice(0, 36).replace(/\s+\S*$/, '') + '...'; else if(w.length > k) s += '...';
    return s || 'Working on it';
  }
  function sendTo(a, poi, secs){ a.act = 'visit'; a.poi = poi; a.actT = secs; goTo(a, poi.room, poi); }

  /* ---------- starting crew: always aboard, one of every role at least ---------- */
  const cap = makeAgent('Orchestrator', 'Captain', {id:'cap', pos:V(capSt.x, capSt.z)});
  [['Researcher', 'Scout', 'scout'], ['Coder', 'Byte', 'byte'], ['Artist', 'Pixel', 'pixel'], ['3D modeler', 'Mesh', 'mesh'], ['Tester', 'Probe', 'probe'], ['Coder', 'Nova', 'nova'], ['Researcher', 'Dot', 'dot'], ['Tester', 'Rivet', 'rivet']].forEach(([r, n, id]) => makeAgent(r, n, {id}));
  const place = (id, i) => { const a = crew.find(c => c.id === id), p = POI[i]; a.act = 'at'; a.poi = p; a.actT = 14; a.loc = p.room; a.pos.set(p.x, 0, p.z); a.face = p.f; };
  place('pixel', 4); place('probe', 6); place('nova', 8); place('rivet', 9); place('dot', 12);

  /* ---------- the real crew: Claude sessions and subagents of this project ---------- */
  const qs = new URLSearchParams(location.search), PID = (qs.get('id') || qs.get('p') || '').trim();
  const live = {busy:false, text:null, model:null, waiting:0, sessions:[], runs:new Set(), keys:{}, nextCap:0, capHold:0, rot:0, idleT:rnd(10, 20), sse:null};
  const realMap = new Map(), sseAdd = new Map(), tombs = new Map(); // subagent tool use id -> crew member / overlay entries
  let serverSessions = [];

  // Which room a subagent works in: by its type first, then by the words of its description.
  const RE = {
    model3d: /\b(3d|blender|mesh|render|rendering|model(?:ing|ling)?|sculpt|rig|geometry|three\.?js)\b/i,
    art: /\b(image|images|icon|logo|art|design|draw|drawing|paint|illustrat\w*|sprite|texture|mockup|palette|animation|visual|ui|css|style|theme|layout|polish|cosmetic|shader|svg|font|screenshot art)\b/i,
    code: /\b(fix|edit|implement\w*|write|add|refactor|code|patch|change|update|create|wire|port|migrate|rename|remove|delete|move|rewrite|script|endpoint|server|api|function)\b/i,
    test: /\b(test|tests|testing|build|builds|compile|lint|audit|verify|validat\w*|qa|review|regression|benchmark|install|release|screenshots?)\b/i
  };
  function roleOf(g){
    const ty = String(g.type || '').toLowerCase(), ds = String(g.description || '');
    if(/^(explore|plan|claude-code-guide)$|research|scout/.test(ty)) return 'Researcher';
    if(/statusline|coder|developer|engineer|implement/.test(ty)) return 'Coder';
    if(/test|qa|review|audit|verif/.test(ty)) return 'Tester';
    if(/design|art|image|frontend|ui/.test(ty)) return RE.model3d.test(ds) ? '3D modeler' : 'Artist';
    if(RE.model3d.test(ds)) return '3D modeler';
    if(RE.art.test(ds)) return 'Artist';
    if(RE.code.test(ds)) return 'Coder';
    if(RE.test.test(ds)) return 'Tester';
    return 'Researcher';
  }
  const fmtModel = m => { const s = String(m || ''), k = s.match(/(?:claude-)?(opus|sonnet|haiku)(?:-(\d+)-(\d+))?/i); if(!k) return s || null; return k[1][0].toUpperCase() + k[1].slice(1).toLowerCase() + (k[2] ? ` ${k[2]}.${k[3]}` : ''); };
  const TOOLSAY = {Read:'Reading', Grep:'Searching', Glob:'Searching', Edit:'Editing', Write:'Writing', Bash:'Running', WebSearch:'Looking up', WebFetch:'Looking up', Agent:'Sending helpers', Task:'Sending helpers'};
  function trim(t, n){ t = String(t || '').replace(/\s+/g, ' ').trim(); if(t.length <= n) return t; return t.slice(0, n - 3).replace(/\s+\S*$/, '') + '...'; }
  function capLines(){
    const out = [];
    if(live.sse && live.sse.until > performance.now()) out.push(trim(live.sse.text, 72));
    live.sessions.forEach(s => { if(s.text) out.push(trim(s.text, 72)); else if(s.lastTool) out.push((TOOLSAY[s.lastTool.name] || 'Using ' + s.lastTool.name) + (s.lastTool.hint ? ' ' + trim(s.lastTool.hint, 28) : '') + '...'); else out.push('Thinking it over...'); });
    return out.filter((v, i) => v && out.indexOf(v) === i);
  }

  function spawnReal(g, st, i){
    const role = st.role, room = ROOMS[ROLE[role].room], names = NAMES[role].filter(nm => !crew.some(c => c.name === nm));
    const p = room.doorIn.clone(); p.x += rnd(-.5, .5);
    const a = makeAgent(role, names[0] || role + ' ' + (crew.filter(c => c.role === role).length + 1), {extra:true, hold:.9 + i*.45, pos:p});
    a.real = g; a.model = fmtModel(g.model) || 'Same as the Captain'; a.station = st; st.busy = a; a.state = 'beamin'; a.actT = .8;
    a.spent = Math.max(0, (Date.now() - Date.parse(g.startedAt || ''))/1000) || 0;
    realMap.set(g.id, a);
  }
  function releaseReal(a){
    if(a.state === 'beamin' && a.hold > 0){ if(a.station) a.station.busy = null; removeAgent(a); } else finish(a);
  }
  // Match the ship to the list of subagents that are running right now.
  function reconcile(){
    const now = performance.now(), want = new Map();
    serverSessions.forEach(s => (s.agents || []).forEach(g => want.set(g.id, g)));
    sseAdd.forEach((v, id) => { if(now - v.ts > 9000) sseAdd.delete(id); else if(!want.has(id)) want.set(id, v.g); });
    tombs.forEach((ts, id) => { if(now - ts > 9000) tombs.delete(id); else want.delete(id); });
    for(const [id, a] of [...realMap]) if(!want.has(id)){ realMap.delete(id); if(crew.includes(a) && a.real) releaseReal(a); }
    const sent = {}; let i = 0, total = 0; live.waiting = 0;
    for(const [id, g] of want){
      if(realMap.has(id)) continue;
      const st = stationFor(roleOf(g)); if(!st){ live.waiting++; continue; }
      spawnReal(g, st, i++); total++; const key = ROLE[st.role].room; sent[key] = (sent[key] || 0) + 1;
    }
    if(total){
      const rooms = Object.keys(sent), one = rooms.length === 1, label = ROOMS[rooms[0]].label;
      bubble(cap, one ? `Sending ${sent[rooms[0]] > 1 ? sent[rooms[0]] + ' helpers' : 'a helper'} to the ${label}!` : `Sending ${total} helpers out!`, 3000);
      live.capHold = now + 7000;
    }
  }
  function applyServer(sessions){
    serverSessions = sessions;
    live.sessions = sessions;
    sessions.forEach(s => { const k = (s.id || s.runId) + '|' + (s.textAt || s.lastTool && s.lastTool.at || ''); if(live.keys[s.id || s.runId] !== k){ live.keys[s.id || s.runId] = k; live.nextCap = 0; } });
    const first = sessions[0]; live.text = first ? (first.text || null) : null; live.model = first ? fmtModel(first.model) : null;
    updateBusy(); reconcile();
  }
  function updateBusy(){
    const was = live.busy; live.busy = serverSessions.length > 0 || live.runs.size > 0;
    if(was && !live.busy){ bubble(cap, 'All done for now.', 3000); live.capHold = performance.now() + 7000; live.text = null; }
  }

  // Every frame: the Captain's bubbles, and helpers who say what they are doing now and then.
  function liveTick(now, dt){
    if(live.busy){
      if(now > live.capHold && now > live.nextCap){ const ls = capLines(); if(ls.length) bubble(cap, ls[live.rot++ % ls.length], 4500); live.nextCap = now + 13000; }
    } else if(cap.vs === 'idle' || !cap.vs){
      live.idleT -= dt;
      if(live.idleT <= 0){ live.idleT = rnd(20, 36); if(Math.random() < .5) bubble(cap, pick(CAP_IDLE), 3000); else cap.sip = 4; }
    }
    for(const a of realMap.values()) if(a.state === 'work' && !a.path.length && !a.bub && now > (a.nextSay || 0)){ a.nextSay = now + rnd(16000, 26000); bubble(a, shortWords(a.task), 3500); }
  }

  // Two idle crew members talking: one line after the other.
  function chatTick(cv, dt){
    const a = cv.a, b = cv.b;
    if(!crew.includes(a) || !crew.includes(b) || a.state !== 'idle' || b.state !== 'idle'){ endChat(cv); return; }
    if(!cv.started){ cv.wait = (cv.wait || 0) + dt; if(cv.wait > 30){ a.path = []; endChat(cv); } return; }
    cv.t -= dt; if(cv.t > 0) return;
    if(cv.i < cv.lines.length){ const [who, text] = cv.lines[cv.i++], sp = who ? b : a; cv.speaker = sp; bubble(sp, text, 3000); cv.t = 3.4 + text.length*.04; }
    else if(!cv.end){ cv.end = 1; cv.speaker = null; cv.t = 2.5; }
    else endChat(cv);
  }

  // Poll the server every 3 s while the page is visible, and listen to the chat stream for instant news.
  let polling = false, failures = 0, pollTimer = 0;
  async function poll(){
    if(!PID || polling || document.hidden) return;
    polling = true;
    try {
      const url = `/api/projects/${encodeURIComponent(PID)}/crew`;
      const d = window.MC && MC.api ? await MC.api.get(url) : await (await fetch(url)).json();
      if(d && Array.isArray(d.sessions)){ applyServer(d.sessions); failures = 0; }
    } catch(e){ failures++; /* keep the last picture */ }
    polling = false;
  }
  function schedulePoll(){ clearTimeout(pollTimer); pollTimer = setTimeout(async () => { await poll(); schedulePoll(); }, Math.min(30000, 3000*Math.pow(2, Math.max(0, failures - 1)))); }
  if(PID){
    poll(); schedulePoll();
    document.addEventListener('visibilitychange', () => { if(!document.hidden) poll(); });
  }

  const runProj = new Map(); let runsP = null;
  function loadRuns(){
    if(!runsP && window.MC && MC.api) runsP = MC.api.get('/api/runs').then(l => { (Array.isArray(l) ? l : (l && l.runs) || []).forEach(r => runProj.set(r.runId, r.projectId)); }).catch(() => {}).then(() => { setTimeout(() => runsP = null, 1500); });
    return runsP || Promise.resolve();
  }
  async function onChat(d){
    if(!d || !d.runId || !PID) return;
    if(!runProj.has(d.runId)) await loadRuns();
    if(runProj.get(d.runId) !== PID) return;
    const now = performance.now();
    if(d.done){ live.runs.delete(d.runId); updateBusy(); setTimeout(poll, 700); return; }
    live.runs.add(d.runId); updateBusy();
    const ev = d.event; if(!ev || typeof ev !== 'object') return;
    const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
    if(ev.type === 'assistant'){
      for(const b of content){
        if(!b) continue;
        if(b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && !ev.parent_tool_use_id){
          const inp = b.input || {};
          sseAdd.set(b.id, {ts:now, g:{id:b.id, type:String(inp.subagent_type || 'general-purpose'), description:trim(inp.description || inp.prompt || 'Working', 80), model:inp.model || null, background:inp.run_in_background === true, startedAt:new Date().toISOString()}});
        } else if(b.type === 'text' && typeof b.text === 'string' && b.text.trim() && !ev.parent_tool_use_id){
          live.sse = {text:b.text.replace(/[`*_#>]/g, ''), until:now + 25000}; live.nextCap = 0;
        } else if(b.type === 'tool_use' && !ev.parent_tool_use_id){
          live.sse = {text:(TOOLSAY[b.name] || 'Using ' + b.name) + '...', until:now + 12000};
        }
      }
    } else if(ev.type === 'user'){
      for(const b of content){
        if(!b || b.type !== 'tool_result') continue;
        const g = (sseAdd.get(b.tool_use_id) || {}).g || (realMap.get(b.tool_use_id) || {}).real;
        if(g && !g.background){ sseAdd.delete(b.tool_use_id); tombs.set(b.tool_use_id, now); }
      }
    }
    reconcile();
  }
  if(PID && window.MC && MC.events) MC.events.on('chat', onChat);

  /* ---------- camera: left drag pans, right drag turns, wheel zooms ---------- */
  const Y0 = .95, C0 = [-3.5, 1.5], ELEV = Math.atan2(33, 40);
  /* fit: pixels per world unit at zoom 1, so the whole ship (about 47 by 34 units on screen) fills the free area. upp is its inverse. */
  const view = {yaw:Y0, zoom:1, cx:C0[0], cz:C0[1], tYaw:Y0, tZoom:1, tcx:C0[0], tcz:C0[1], fit:0, upp:.05};
  let drag = null;
  el.style.cursor = 'grab';
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('pointerdown', e => { if(e.button !== 0 && e.button !== 2) return; drag = {x:e.clientX, y:e.clientY, b:e.button, yaw:view.tYaw, cx:view.tcx, cz:view.tcz}; el.setPointerCapture(e.pointerId); el.style.cursor = e.button === 2 ? 'ew-resize' : 'grabbing'; document.body.classList.add('dragging'); card.classList.remove('show'); });
  el.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect(); mouse = {x:(e.clientX - r.left)/r.width*2 - 1, y:-(e.clientY - r.top)/r.height*2 + 1, cx:e.clientX, cy:e.clientY};
    if(!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if(drag.b === 2) view.tYaw = drag.yaw + dx*.006;
    else { const wpp = view.upp, c = Math.cos(view.yaw), s = Math.sin(view.yaw), k = wpp/Math.sin(ELEV);
      view.tcx = Math.max(-28, Math.min(24, drag.cx - s*dx*wpp - c*dy*k));
      view.tcz = Math.max(-18, Math.min(18, drag.cz + c*dx*wpp - s*dy*k)); }
  });
  const endDrag = () => { drag = null; el.style.cursor = 'grab'; document.body.classList.remove('dragging'); };
  el.addEventListener('pointerup', endDrag); el.addEventListener('pointercancel', endDrag);
  el.addEventListener('pointerleave', () => mouse = null);
  el.addEventListener('wheel', e => { e.preventDefault(); view.tZoom = Math.max(.6, Math.min(3.5, view.tZoom*(e.deltaY < 0 ? 1.12 : 1/1.12))); }, {passive:false});
  const reset = () => { view.tYaw = Y0; view.tZoom = 1; view.tcx = C0[0]; view.tcz = C0[1]; };
  el.addEventListener('dblclick', reset);
  host.querySelectorAll('[data-z]').forEach(b => b.onclick = () => { const z = b.dataset.z; if(z === 'in') view.tZoom = Math.min(3.5, view.tZoom*1.25); else if(z === 'out') view.tZoom = Math.max(.6, view.tZoom/1.25); else reset(); });

  const ray = new W3.Raycaster(), tmp = new W3.Vector3();
  const fmtT = s => `${Math.floor(s/60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function proj(v){ tmp.copy(v).project(cam); const r = el.getBoundingClientRect(); return [(tmp.x + 1)/2*r.width, (1 - tmp.y)/2*r.height]; }
  function showCard(a){
    const w = a.state === 'work', isCap = a.id === 'cap', real = !!a.real;
    const where = a.poi ? {game:'Playing a game', sleep:'Napping', coffee:'On a snack break', sit:'Taking a seat', look:'Looking around', water:'Watering the plant'}[a.poi.act] : a.chat ? 'Chatting' : null;
    const desc = isCap ? (live.busy ? (live.text || 'Leading the crew') : vsNow() === 'speaking' ? 'Talking with you' : 'Waiting for orders. Talk to me in the Com Link.')
      : w ? a.task : a.state === 'leave' ? 'Heading home' : (where || 'Taking a break') + '. Ready for a task.';
    const model = isCap ? (live.model || 'Not reported') : real ? a.model : a.model;
    card.innerHTML = `<div class="fr"><div class="ttl"><h3>${esc(a.name)}</h3><span class="cnt">${a.role}${a.extra ? ', helper' : ''}</span></div><div class="bodyc">
      <div class="desc">${esc(desc)}</div>
      <dl class="kv"><dt>Status</dt><dd>${w ? MC.chip('live', 'Working') : MC.chip('idle', 'Idle')}</dd><dt>Model</dt><dd>${esc(model)}</dd>
      ${real ? `<dt>Kind</dt><dd>${esc(a.real.type)}</dd>` : ''}
      ${w ? `<dt>Time spent</dt><dd>${fmtT(a.spent)}</dd>` : ''}</dl></div></div>`;
    card.classList.add('show'); MC.drawFrames();
    const cw = 280, ch = card.offsetHeight; let x = mouse.cx + 20, y = mouse.cy - 20;
    if(x + cw > innerWidth - 10) x = mouse.cx - cw - 20; if(y + ch > innerHeight - 10) y = innerHeight - ch - 10; x = Math.max(10, x); y = Math.max(10, y);
    card.style.left = x + 'px'; card.style.top = y + 'px';
  }
  const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const vsNow = () => MC.voice ? MC.voice.state : 'idle';

  /* ---------- idle life ---------- */
  const taken = p => crew.some(c => c.poi === p);
  /* two idle crew members stop for a chat (or a game of rock, paper, scissors) */
  const convos = [];
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function startChat(a){
    if(a.extra || a.chat || a.id === 'cap') return false;
    const ok = b => b !== a && !b.extra && !b.chat && b.state === 'idle' && b.appear >= 1 && b.loc !== 'hall' && !b.path.length && !(b.poi && b.poi.y);
    const cands = crew.filter(ok); if(!cands.length) return false;
    const near = cands.filter(b => b.loc === a.loc), b = pick(near.length && Math.random() < .7 ? near : cands);
    const rr = ROOMS[b.loc].rect, dir = b.pos.x + 1.5 > rr[1] ? -1 : 1;
    const spot = V(clampN(b.pos.x + dir*1.5, rr[0], rr[1]), clampN(b.pos.z, rr[2], rr[3]));
    const script = pick(CHATS), rps = script.some(l => !Array.isArray(l));
    const cv = {a, b, lines:script.filter(Array.isArray), i:0, t:0, rps, started:false, end:0};
    a.chat = b.chat = cv; a.act = 'chatgo'; a.poi = null; a.wait = false; b.act = 'listen'; b.wait = false; b.actT = 0;
    goTo(a, b.loc, spot); convos.push(cv); return true;
  }
  function endChat(cv){
    [cv.a, cv.b].forEach(x => { if(x.chat !== cv) return; x.chat = null; if(x.id === 'cap') return; x.act = null; x.poi = null; x.wait = true; x.actT = rnd(.5, 2); });
    convos.splice(convos.indexOf(cv), 1);
  }
  function nextIdle(a){
    if(Math.random() < .22 && startChat(a)) return;
    const r = Math.random();
    if(!a.extra && r < .3){ const spots = POI.filter(p => p.brk && !taken(p)); if(spots.length){ sendTo(a, pick(spots), rnd(9, 16)); return; } }
    const rr = ROOMS[a.room].rect;
    if(a.loc !== a.room){ a.act = 'walk'; goTo(a, a.room, V(rnd(rr[0], rr[1]), rnd(rr[2], rr[3]))); return; }
    const own = POI.filter(p => p.room === a.room && !p.brk && !taken(p));
    if(own.length && r < .55){ sendTo(a, pick(own), rnd(4, 8)); return; }
    if(r < .72){ a.act = 'walk'; goTo(a, a.room, V(rnd(rr[0], rr[1]), rnd(rr[2], rr[3]))); }
    else if(r < .82){ a.act = 'hop'; a.actT = 1.6; }
    else if(r < .92){ a.act = 'dance'; a.actT = 3; if(Math.random() < .5) bubble(a, pick(FUN), 1800); }
    else if(a.room === 'code'){ a.act = 'ball'; a.actT = 3; goTo(a, 'code', V(ball.position.x - .9, ball.position.z)); }
    else { a.act = 'hop'; a.actT = 1.2; }
  }
  const setArm = (a, i, lift) => { a.arms[i].rotation.z = (i ? 1 : -1)*lift; };
  const turn = (a, f) => { a.face += (((f - a.face + Math.PI*3) % (Math.PI*2)) - Math.PI)*.15; };

  /* ---------- main loop ---------- */
  let last = performance.now(), scrAcc = 0, lsNow = '', tinyNow = null;
  function frame(now){
    const dt = Math.min(.05, (now - last)/1000); last = now; const t = now/1000;
    const r = stage.getBoundingClientRect(), w = r.width, h = r.height;
    if(w < 2 || h < 2){ requestAnimationFrame(frame); return; }
    /* a big window at a high pixel ratio is capped at about 4 million pixels */
    const pr = Math.max(1, Math.min(devicePixelRatio || 1, 2, Math.sqrt(4.2e6/(w*h))));
    if(Math.abs(pr - renderer.getPixelRatio()) > .01){ renderer.setPixelRatio(pr); dustLayers.forEach(l => l.m.uniforms.uPR.value = pr); el.width = 0; }
    if(el.width !== Math.round(w*renderer.getPixelRatio()) || el.height !== Math.round(h*renderer.getPixelRatio())) renderer.setSize(w, h, false);
    el.style.width = w + 'px'; el.style.height = h + 'px';
    view.yaw += (view.tYaw - view.yaw)*.14; view.zoom += (view.tZoom - view.zoom)*.14; view.cx += (view.tcx - view.cx)*.25; view.cz += (view.tcz - view.cz)*.25;
    /* the ship is centered in the free area and scaled to fit it; both follow the area as it resizes or slides */
    const fr = freeEl.getBoundingClientRect(), ok = fr.width > 40 && fr.height > 40;
    const fw = ok ? fr.width : w, fh = ok ? fr.height : h, fcx = ok ? fr.left + fr.width/2 - r.left : w/2, fcy = ok ? fr.top + fr.height/2 - r.top : h/2;
    const wantFit = 1.02*Math.min(fw/47, fh/34);
    view.fit = view.fit ? view.fit + (wantFit - view.fit)*.25 : wantFit;
    const upp = view.upp = 1/(view.fit*view.zoom);
    /* room labels shrink with the ship and hide when it is too small to read them */
    const ls = Math.max(.6, Math.min(1.15, view.fit*view.zoom/16)).toFixed(2); if(ls !== lsNow){ lsNow = ls; overlay.style.setProperty('--ls', ls); }
    const tiny = view.fit < 10.5; if(tiny !== tinyNow){ tinyNow = tiny; overlay.classList.toggle('tiny', tiny); }
    cam.left = -fcx*upp; cam.right = (w - fcx)*upp; cam.top = fcy*upp; cam.bottom = -(h - fcy)*upp; cam.updateProjectionMatrix();
    cam.position.set(view.cx + Math.cos(view.yaw)*40, 33, view.cz + Math.sin(view.yaw)*40); cam.lookAt(view.cx, 0, view.cz);
    dustFade += ((dustOn ? 1 : 0) - dustFade)*.06;
    dustLayers.forEach(l => { const u = l.m.uniforms; l.pts.visible = dustFade > .01; if(!l.pts.visible) return; u.uFade.value = dustFade; u.uPR.value = renderer.getPixelRatio(); u.uT.value = MC.reduce ? 0 : t; l.pts.position.set(view.cx*(1 - l.f), 0, view.cz*(1 - l.f)); });

    const vs = MC.voice ? MC.voice.state : 'idle', L = MC.voice ? MC.voice.level : .3;
    if(vs !== cap.vs){ cap.vs = vs; const say = {listening:'I am listening.', speaking:'Here is what I found.'}[vs]; if(say) bubble(cap, say, 2200); }
    // the Captain works while a Claude session of this project is active (or BlitzVoice is speaking)
    const capBusy = live.busy;
    cap.state = capBusy || vs === 'speaking' ? 'work' : 'idle';
    cap.task = live.text || (vs === 'speaking' ? 'Talking with you' : 'Looking after the crew');
    if(cap.state === 'work') cap.spent += dt; else cap.spent = 0;
    liveTick(now, dt);
    STATIONS.forEach(st => st.active = false);
    for(let i = convos.length - 1; i >= 0; i--) chatTick(convos[i], dt);

    for(const a of crew.slice()){
      let moving = false, workAnim = false;
      if(a.state === 'beamin'){
        if(a.hold > 0){ a.hold -= dt; if(a.hold <= 0) beam(a.pos); }
        else { a.actT -= dt; a.appear = Math.min(1, a.appear + dt*1.6); if(a.actT <= 0 && !startTask(a)){ a.state = 'leave'; goTo(a, a.room, ROOMS[a.room].doorIn); } }
      }
      if(a.state === 'leave' && a.appear < 1) a.appear = Math.min(1, a.appear + dt*1.6);
      if(a.state === 'beamout'){ a.actT -= dt; a.appear = Math.max(0, a.actT/.8); if(a.actT <= 0){ removeAgent(a); continue; } }
      if(a.state === 'work' && a.id !== 'cap') a.spent += dt;
      if(a.path.length && a.id !== 'cap'){
        const goal = a.path[0].p, dx = goal.x - a.pos.x, dz = goal.z - a.pos.z, dist = Math.hypot(dx, dz);
        const sp = (a.state === 'idle' ? 1.9 : 3.2)*dt;
        if(dist > .06){ a.pos.x += dx/dist*Math.min(sp, dist); a.pos.z += dz/dist*Math.min(sp, dist); a.face = Math.atan2(dx, dz); moving = true; }
        else { const n = a.path.shift(); if(n.loc) a.loc = n.loc;
          if(!a.path.length){
            if(a.state === 'leave'){ a.state = 'beamout'; a.actT = .8; beam(a.pos); }
            else if(a.state === 'idle' && a.act === 'walk'){ a.act = null; a.wait = true; a.actT = rnd(.5, 2.5); }
            else if(a.state === 'idle' && a.act === 'chatgo' && a.chat){ a.act = 'chat'; a.chat.started = true; a.chat.t = .5; }
            else if(a.state === 'idle' && a.act === 'visit'){ a.act = 'at'; if(a.poi.say && Math.random() < .7) bubble(a, a.poi.say, 2200); if(a.poi.act === 'sleep') bubble(a, 'zzz', 3000); }
          } }
      }
      if(a.id === 'cap' && !a.chat) turn(a, vs === 'listening' ? .62 : capSt.f);
      if(a.state === 'work' && !a.path.length && a.station){ turn(a, a.station.f); workAnim = true; a.station.active = true; }
      if(a.state === 'idle' && a.id !== 'cap' && !a.path.length && !a.chat){
        if(a.wait){ a.actT -= dt; if(a.actT <= 0){ a.wait = false; nextIdle(a); } }
        else if(!a.act) nextIdle(a);
        else if(a.act !== 'walk' && a.act !== 'visit'){ a.actT -= dt; if(a.actT <= 0){ a.act = null; a.poi = null; a.wait = true; a.actT = rnd(.5, 2); } }
      }
      // pose
      a.phase += dt*(moving ? 12 : 3);
      let by = 0, rot = 0, sq = 1, lift = 0, tip = 0, legsOn = true;
      Object.values(a.tools).forEach(tl => tl.visible = false);
      a.cup.visible = false; a.pad.visible = false;
      a.legs.forEach((l, i) => l.position.y = .1 + (moving ? Math.max(0, Math.sin(a.phase + i*Math.PI))*.06 : 0));
      a.arms.forEach(p => p.rotation.y = 0);
      if(moving){ by = Math.abs(Math.sin(a.phase))*.05; a.arms.forEach((p, i) => setArm(a, i, .15 + Math.sin(a.phase + i*Math.PI)*.2)); }
      else a.arms.forEach((p, i) => setArm(a, i, 0));
      a.eyes.forEach(e => e.scale.y = Math.sin(t*.7 + a.phase*.1) > .985 ? .15 : 1);
      if(a.state === 'idle' && !moving && a.id !== 'cap'){
        if(a.act === 'hop'){ by = Math.abs(Math.sin(t*6))*.35; sq = 1 + Math.sin(t*12)*.05; a.arms.forEach((p, i) => setArm(a, i, .6)); }
        if(a.act === 'dance'){ rot = Math.sin(t*5)*.6; by = Math.abs(Math.sin(t*10))*.08; a.arms.forEach((p, i) => setArm(a, i, .9 + Math.sin(t*10 + i*3)*.6)); }
        if(a.act === 'ball'){ ball.position.y = .16 + Math.abs(Math.sin(t*4))*.9; a.arms.forEach((p, i) => setArm(a, i, 1 + Math.sin(t*8)*.3)); }
        if((a.act === 'chat' || a.act === 'listen') && a.chat){
          const cv = a.chat, o = cv.a === a ? cv.b : cv.a, talking = cv.speaker === a;
          turn(a, Math.atan2(o.pos.x - a.pos.x, o.pos.z - a.pos.z));
          if(cv.rps && cv.i <= 2){ a.arms.forEach((p, i) => setArm(a, i, .9 + Math.sin(t*9)*.7)); by = Math.abs(Math.sin(t*9))*.05; }
          else if(talking){ setArm(a, 1, .5 + Math.sin(t*7)*.35); setArm(a, 0, .15); by = Math.abs(Math.sin(t*6))*.03; rot = Math.sin(t*3)*.1; }
          else { rot = Math.sin(t*2)*.05; by = Math.abs(Math.sin(t*2.5))*.015; }
        }
        if(a.act === 'at' && a.poi){
          const p = a.poi; turn(a, p.f);
          if(p.y) lift = p.y;
          if(p.act === 'sit'){ sq = .92; a.legs.forEach(l => l.position.y = .16); }
          if(p.act === 'game'){ sq = .92; a.pad.visible = true; a.arms.forEach((pp, i) => setArm(a, i, .35 + Math.sin(t*22 + i*2)*.12)); by = Math.abs(Math.sin(t*3))*.03; rot = Math.sin(t*2.3)*.12; if(!a.bub && Math.random() < .003) bubble(a, pick(GAMER), 1600); }
          if(p.act === 'sleep'){ tip = -1.35; legsOn = false; a.eyes.forEach(e => e.scale.y = .15); by = .22 + Math.sin(t*1.5)*.012; if(!a.bub && Math.random() < .004) bubble(a, 'zzz', 2500); }
          if(p.act === 'coffee'){ a.cup.visible = true; setArm(a, 0, .9 + Math.sin(t*1.3)*.25); }
          if(p.act === 'water'){ setArm(a, 1, .9); setArm(a, 0, .4); rot = Math.sin(t*1.5)*.1; }
          if(p.act === 'look'){ rot = Math.sin(t*.9)*.25; by = Math.abs(Math.sin(t*1.2))*.02; }
        }
      }
      if(workAnim){
        const st = a.station;
        if(a.tools.main) a.tools.main.visible = true;
        if(st.screen){ st.screen.active = true; st.screen.prog = (a.spent/20) % 1; }
        if(a.role === 'Coder'){ a.arms.forEach((p, i) => setArm(a, i, .25 + Math.sin(t*28 + i*2)*.15)); by = Math.abs(Math.sin(t*14))*.015; }
        if(st.kind === 'lab'){ a.tools.tube.visible = true; setArm(a, 1, .7 + Math.sin(t*2.4)*.35); a.arms[1].rotation.y = Math.sin(t*4)*.3; setArm(a, 0, .3); }
        if(st.kind === 'papers'){ a.tools.sheet.visible = true; setArm(a, 0, .5 + Math.sin(t*3)*.2); setArm(a, 1, .3 + Math.abs(Math.sin(t*1.6))*.6); by = Math.sin(t*2)*.01; }
        if(a.role === 'Artist'){ setArm(a, 1, .6 + Math.sin(t*3)*.5); a.arms[1].rotation.y = Math.sin(t*2.1)*.5; }
        if(a.role === '3D modeler'){ a.arms.forEach((p, i) => setArm(a, i, 1.2 + Math.sin(t*2 + i)*.3)); if(st.holo) st.holo.rotation.y += dt*1.6; }
        if(a.role === 'Tester'){ setArm(a, 1, .4 + Math.sin(t*9)*.4); by = Math.abs(Math.sin(t*9))*.02; }
      }
      if(a.id === 'cap'){ const talk = vs === 'speaking'; by = talk ? L*.12 : vs === 'listening' ? Math.sin(t*2)*.02 : 0; a.arms.forEach((p, i) => setArm(a, i, talk ? .2 + L*(i ? 1.3 : .8) : 0));
        if(!talk && capBusy){ a.pad.visible = true; a.arms.forEach((p, i) => setArm(a, i, .3 + Math.sin(t*24 + i*2)*.15)); by = Math.abs(Math.sin(t*12))*.015; rot = Math.sin(t*1.3)*.08; workAnim = true; }
        else if(a.chat){ const cv = a.chat, o = cv.a === a ? cv.b : cv.a; turn(a, Math.atan2(o.pos.x - a.pos.x, o.pos.z - a.pos.z)); if(cv.speaker === a){ setArm(a, 1, .5 + Math.sin(t*7)*.35); by = Math.abs(Math.sin(t*6))*.03; } else rot = Math.sin(t*2)*.05; }
        else if(a.sip > 0){ a.sip -= dt; a.cup.visible = true; setArm(a, 0, .9 + Math.sin(t*1.3)*.25); }
        else rot = Math.sin(t*.5)*.1; }
      a.lift += (lift - a.lift)*.2;
      a.hips.rotation.x = tip; a.hips.position.y = tip ? by : 0;
      a.g.position.set(a.pos.x, a.lift, a.pos.z); a.g.rotation.y = a.face;
      a.body.position.y = by; a.body.rotation.set(tip, rot, 0); a.body.scale.set(1/Math.sqrt(sq), sq, 1/Math.sqrt(sq));
      a.g.scale.setScalar(S*Math.max(.01, a.appear));
      a.ring.material.opacity = hover === a ? .9 : workAnim ? .45 + Math.sin(t*4)*.25 : 0;
    }

    // little things that move
    spinners.forEach(([m, s, ax]) => m.rotation[ax || 'y'] += s);
    if(capBusy) holo.rotation.y += .04;
    flames.forEach(f => { const kk = 1 + Math.sin(t*9 + f.i)*.08 + Math.random()*.05; f.plume.scale.set(1, kk, 1); f.plume.material.opacity = .28 + Math.sin(t*7 + f.i)*.07; f.disk.material.opacity = .7 + Math.random()*.2; });
    if(Math.random() < .35) blinkers[Math.floor(Math.random()*blinkers.length)].visible ^= true;
    steam.forEach((s, i) => { const p = (t*.5 + i/3) % 1; s.position.y = 1.05 + p*.8; s.position.x = 11 + Math.sin(t*2 + i)*.06; s.material.opacity = .4*(1 - p); });
    bubbles.forEach(b => { const u = b.userData; b.visible = !!u.st.active; if(!b.visible) return; u.p = (u.p + dt*.7) % 1; b.position.set(.05 + u.ox, .62 + u.p*.4, .1 + u.oz); b.material.opacity = .8*(1 - u.p); });
    sheets.forEach(s => { s.visible = !!s.userData.st.active; if(!s.visible) return; const p = (t*.6) % 1; s.position.set(-.6 + p*1.15, .88 + Math.sin(p*Math.PI)*.35, -.05); s.rotation.set(Math.sin(p*Math.PI)*.4, p*1.5, 0); });
    sparks.forEach(s => { const u = s.userData; u.p = (u.p + dt*.35) % 1; s.position.set(u.x + Math.cos(u.a + u.p*4)*.5, .6 + u.p*1.8, u.z + Math.sin(u.a + u.p*4)*.5); s.material.opacity = .8*Math.sin(u.p*Math.PI); });
    for(const [key, m] of Object.entries(doorLights)){ const busy = crew.some(a => a.loc === key && a.state === 'work'); m.material.color.setHex(busy ? RED : LINE); m.material.opacity = busy ? .7 + Math.sin(t*4)*.3 : .35; }
    drone.position.set(Math.sin(t*.1)*13 - 2, Math.sin(t*3)*.03, Math.sin(t*.37)*.6); drone.rotation.y = t*.8; droneLed.visible = Math.sin(t*6) > 0;
    rj1.rotation.z = Math.sin(t*.9)*.6; rj2.rotation.z = -.8 + Math.sin(t*1.3)*.5; rarm.rotation.y = Math.sin(t*.5)*.8; claw.scale.x = 1 + Math.sin(t*3)*.25;
    crates.forEach((c, i) => { const p = (t*.25 + i/3) % 1; c.position.x = -3.1 + p*4.2; c.visible = p < .97; });
    moon.position.set(Math.cos(t*.2)*4.6, Math.sin(t*.2)*1.2, Math.sin(t*.2)*4.6);
    sways.forEach((g, i) => g.rotation.z = Math.sin(t*.8 + i)*.03);
    reactorPool.material.opacity = .1 + Math.sin(t*2.2)*.03;
    commitLeds.forEach(l => l.material.opacity = Math.sin(t*4) > 0 ? 1 : .35);
    conduits.forEach((c, i) => { const left = 1 - c.u.used, lit = Math.round(left*12);
      c.rings.forEach((rg, r) => { const on = r < lit; rg.material.color.setHex(on ? RING_ON : RING_OFF); rg.material.emissive.setHex(on ? 0x3aa2ff : 0x000000); rg.material.emissiveIntensity = on ? .7 + .3*Math.sin(t*6 + r*.8) : 0; });
      c.coreC.material.opacity = .08 + left*.45 + Math.sin(t*3 + i)*.04;
      const f = flames[i]; if(f){ f.plume.scale.x = f.plume.scale.z = .45 + left*.75; f.disk.material.opacity *= .5 + left*.5; } });
    const sa = stars.geometry.attributes.position; for(let i = 0; i < sa.count; i++){ let x = sa.getX(i) - dt*.8; if(x < -120) x = 125; sa.setX(i, x); } sa.needsUpdate = true;
    for(const b of beams.slice()){ b.t += dt; b.m.material.opacity = .6*(1 - b.t/1.1); b.m.scale.set(1 - b.t*.5, 1, 1 - b.t*.5); if(b.t > 1.1){ ship.remove(b.m); beams.splice(beams.indexOf(b), 1); } }
    scrAcc += dt; if(scrAcc > .12){ scrAcc = 0; screens.forEach(s => { const live = s.active || s.kind === 'bridge' || s.always; if(live){ s.t += s.kind === 'bridge' ? .4 : 1; drawScreen(s); } else if(s.wasActive) drawScreen(s); s.wasActive = s.active; }); }

    renderer.render(scene, cam);

    labels.forEach(l => { const [x, y] = proj(l.p); l.e.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`; });
    const placed = [];
    crew.forEach(a => { if(!a.bub) return; if(now > a.bub.until){ a.bub.el.remove(); a.bub = null; return; } const [x, y0] = proj(new W3.Vector3(a.pos.x, a.lift + (1.05 + a.body.position.y)*S, a.pos.z));
      /* keep bubbles apart: lift a bubble above any earlier one it would overlap */
      const el = a.bub.el, bw = el.offsetWidth, bh = el.offsetHeight; let y = y0, moved = true, n = 0;
      while(moved && n++ < 12){ moved = false; for(const r of placed){ if(Math.abs(x - r.x) < (bw + r.w)/2 + 6 && y > r.y - r.h - 8 && y - bh < r.y + 8){ y = r.y - r.h - 8; moved = true; } } }
      placed.push({x, y, w:bw, h:bh}); el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`; });
    if(mouse && !drag){ ray.setFromCamera(mouse, cam); const hit = ray.intersectObjects(pickables, false)[0], a = hit ? hit.object.userData.agent : null;
      if(a){ hover = a; el.style.cursor = 'pointer'; showCard(a); } else if(hover){ hover = null; el.style.cursor = 'grab'; card.classList.remove('show'); } }
    else if(hover && !mouse){ hover = null; card.classList.remove('show'); }
    const cnt = host.querySelector('[data-crew-count]'); if(cnt) cnt.textContent = `${crew.length} aboard, ${crew.filter(a => a.state === 'work').length} working${live.waiting ? ', ' + live.waiting + ' waiting' : ''}`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // screenshot hooks: #crew=<id> hovers an agent, #zoom=2 zooms, #at=x,z centers the view
  const fh = (location.hash.match(/crew=(\w+)/) || [])[1];
  if(fh) setTimeout(() => { const a = crew.find(c => c.id === fh); if(!a) return; const [x, y] = proj(new W3.Vector3(a.pos.x, a.lift + .4*S, a.pos.z)), r = el.getBoundingClientRect(); mouse = {x:x/r.width*2 - 1, y:-y/r.height*2 + 1, cx:r.left + x, cy:r.top + y}; }, 1500);
  const fz = (location.hash.match(/zoom=([\d.]+)/) || [])[1]; if(fz) view.zoom = view.tZoom = +fz;
  const fa = location.hash.match(/at=(-?[\d.]+),(-?[\d.]+)/); if(fa){ view.cx = view.tcx = +fa[1]; view.cz = view.tcz = +fa[2]; }
};
