// Makes every Mission Control icon from tools/icon/hal.js:
//   assets/mission-control.ico (16 to 256) and assets/mission-control-256.png (the desktop shortcut)
//   phone/src-tauri/icons (the phone app's icon set)
//   phone/src-tauri/gen/android/.../res (the Android launcher icons, in one of three styles)
//     --style lens   (default) adaptive icon: opaque black background and only the red lens (no metal ring), its glow
//                    filling the visible 72 of 108dp, a themed (monochrome) layer, and legacy PNGs that are a full black
//                    square with the lens big
//     --style black  adaptive icon: opaque black background, the eye with its ring at 67% of the canvas, a
//                    themed (monochrome) layer, and legacy PNGs with the eye on a black circle
//     --style free   no adaptive icon: legacy PNGs only, the round eye on transparent corners, so the launcher shows the
//                    eye's own shape (a launcher that insists on a shape will still put its own square behind it)
//   --preview <folder>  also writes preview PNGs of the Android icons into that folder
// The repo has no npm packages: give it a folder where puppeteer-core is installed, and it uses the installed Chrome.
//   node tools/icon/make-icons.mjs <folder with puppeteer-core> [--style free|black] [--preview <folder>]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const STYLE = flag('--style') || 'lens';
const PREVIEW = flag('--preview');
if (!['free', 'black', 'lens'].includes(STYLE)) { console.error('--style must be lens, black or free.'); process.exit(1); }
const mods = args[0];
if (!mods) { console.error('Give the folder that holds node_modules/puppeteer-core.'); process.exit(1); }
const { default: puppeteer } = await import(pathToFileURL(path.join(mods, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href);
const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';

// size in pixels. The eye in hal.js fills 96% of the square it is drawn in (a 2% margin all round).
const want = { desk: [16, 20, 24, 32, 40, 48, 64, 96, 128, 256], app: [30, 32, 44, 50, 64, 71, 89, 107, 128, 142, 150, 256, 284, 310, 512] };
// density, legacy icon size, adaptive canvas size (108dp)
const DENS = [['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216], ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432]];
// adaptive layers: the eye ring is 67% of the canvas (72 of 108dp), so the drawing is 0.6667 / 0.96 of it
const FG = 0.6667 / 0.96;
// legacy "eye on black circle": black circle 96% of the icon, eye ring 78%
const DISC = 0.78 / 0.96;
// the lens alone: its glow runs out to the edge of the visible 72 of 108dp
const LENS_FG = 72 / 108;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
let png;
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'tools', 'icon', 'hal.js'), 'utf8') });
  // [key, canvas size, drawing fraction of the canvas, source ('eye', 'mono', 'lens' or 'lensmono'), what is behind it]
  const jobs = [];
  for (const s of new Set([...want.desk, ...want.app, ...DENS.map((d) => d[1])])) jobs.push(['e' + s, s, 1, 'eye', false]);
  for (const [, legacy, fg] of DENS) {
    jobs.push(['fg' + fg, fg, FG, 'eye', false]);
    jobs.push(['mono' + fg, fg, FG, 'mono', false]);
    jobs.push(['blk' + legacy, legacy, DISC, 'eye', 'disc']);
    jobs.push(['lfg' + fg, fg, LENS_FG, 'lens', false]);
    jobs.push(['lmono' + fg, fg, LENS_FG, 'lensmono', false]);
    jobs.push(['ln' + legacy, legacy, 1, 'lens', 'square']);
  }
  png = await page.evaluate((jobs) => {
    const mk = (draw) => { const b = document.createElement('canvas'); b.width = b.height = 2048; draw(b.getContext('2d'), 2048); return b; };
    const srcs = { eye: mk(drawHal), mono: mk(drawHalMono), lens: mk(drawHalLens), lensmono: mk(drawHalLensMono) };
    const out = {};
    for (const [key, size, frac, kind, disc] of jobs) {
      // halve step by step for clean small sizes
      let src = srcs[kind], s = 2048;
      while (s / 2 >= size / frac) { const h = document.createElement('canvas'); h.width = h.height = s / 2; const g = h.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, s / 2, s / 2); src = h; s /= 2; }
      const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      if (disc === 'disc') { g.beginPath(); g.arc(size / 2, size / 2, size * 0.48, 0, 7); g.fillStyle = '#000'; g.fill(); }
      if (disc === 'square') { g.fillStyle = '#000'; g.fillRect(0, 0, size, size); }
      const d = size * frac, o = (size - d) / 2; g.drawImage(src, o, o, d, d);
      out[key] = c.toDataURL('image/png').split(',')[1];
    }
    return out;
  }, jobs);

  if (PREVIEW) {
    fs.mkdirSync(PREVIEW, { recursive: true });
    const pv = await page.evaluate(async (png, grey) => {
      const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b64; });
      const squircle = (g, cx, cy, half) => { g.beginPath(); for (let i = 0; i <= 360; i++) { const t = i / 360 * 2 * Math.PI, ct = Math.cos(t), st = Math.sin(t); const x = Math.sign(ct) * Math.pow(Math.abs(ct), 2 / 5), y = Math.sign(st) * Math.pow(Math.abs(st), 2 / 5); i ? g.lineTo(cx + x * half, cy + y * half) : g.moveTo(cx + x * half, cy + y * half); } g.closePath(); };
      const sheet = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = grey; g.fillRect(0, 0, w, h); return [c, g]; };
      const out = {};
      // the legacy icons on grey, so the transparent corners (free) or the black circle (black) show
      for (const [name, key] of [['legacy-free-192', 'e192'], ['legacy-black-192', 'blk192'], ['legacy-lens-192', 'ln192']]) {
        const [c, g] = sheet(240, 240); g.drawImage(await load(png[key]), 24, 24); out[name] = c.toDataURL('image/png').split(',')[1];
      }
      // the adaptive layers as a launcher shows them: the middle 72 of 108dp, cut to a squircle, on a grey wallpaper
      const fg = await load(png.fg432), mono = await load(png.mono432);
      const view = 288, off = (432 - view) / 2, W = 340;
      const adapt = async (name, back, layer) => {
        const [c, g] = sheet(W, W); g.save(); squircle(g, W / 2, W / 2, view / 2); g.clip();
        g.fillStyle = back; g.fillRect(0, 0, W, W); g.drawImage(layer, (W - 432) / 2, (W - 432) / 2); g.restore();
        out[name] = c.toDataURL('image/png').split(',')[1];
      };
      await adapt('adaptive-black-foreground', '#000', fg);
      await adapt('adaptive-lens-foreground', '#000', await load(png.lfg432));
      // the themed icon: white shape tinted dark on a light tile
      const themed = async (name, shape) => {
        const tint = document.createElement('canvas'); tint.width = tint.height = 432; const tg = tint.getContext('2d');
        tg.drawImage(shape, 0, 0); tg.globalCompositeOperation = 'source-in'; tg.fillStyle = '#1b1b1f'; tg.fillRect(0, 0, 432, 432);
        await adapt(name, '#d6e3ff', tint);
      };
      await themed('adaptive-black-themed', mono);
      await themed('adaptive-lens-themed', await load(png.lmono432));
      return out;
    }, png, '#8a8f98');
    for (const [name, b64] of Object.entries(pv)) { const f = path.join(PREVIEW, name + '.png'); fs.writeFileSync(f, Buffer.from(b64, 'base64')); console.log('preview', f); }
  }
} finally {
  await browser.close();
}
const get = (k) => Buffer.from(png[k], 'base64');

// an .ico holding PNG images (Windows Vista and later read these)
function ico(sizes) {
  const imgs = sizes.map((s) => get('e' + s));
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => { const e = Buffer.alloc(16); e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(off, 12); off += imgs[i].length; return e; });
  return Buffer.concat([head, ...dir, ...imgs]);
}
const put = (rel, buf) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); console.log('wrote', rel); };
const drop = (rel) => { const f = path.join(ROOT, rel); if (fs.existsSync(f)) { fs.rmSync(f, { recursive: true, force: true }); console.log('removed', rel); } };

put('assets/mission-control.ico', ico(want.desk));
put('assets/mission-control-256.png', get('e256'));

const I = 'phone/src-tauri/icons';
put(`${I}/icon.ico`, ico(want.desk));
put(`${I}/icon.png`, get('e512'));
put(`${I}/32x32.png`, get('e32'));
put(`${I}/64x64.png`, get('e64'));
put(`${I}/128x128.png`, get('e128'));
put(`${I}/128x128@2x.png`, get('e256'));
put(`${I}/StoreLogo.png`, get('e50'));
for (const s of [30, 44, 71, 89, 107, 142, 150, 284, 310]) put(`${I}/Square${s}x${s}Logo.png`, get('e' + s));

const ADAPTIVE = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@color/ic_launcher_background"/>\n  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n  <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n</adaptive-icon>\n';
const BACKGROUND = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">#000000</color>\n</resources>\n';
for (const base of [`${I}/android`, 'phone/src-tauri/gen/android/app/src/main/res']) {
  for (const [d, legacy, fg] of DENS) {
    const legacyPng = STYLE === 'black' ? get('blk' + legacy) : STYLE === 'lens' ? get('ln' + legacy) : get('e' + legacy);
    put(`${base}/mipmap-${d}/ic_launcher.png`, legacyPng);
    put(`${base}/mipmap-${d}/ic_launcher_round.png`, legacyPng);
    if (STYLE !== 'free') {
      const p = STYLE === 'lens' ? ['lfg', 'lmono'] : ['fg', 'mono'];
      put(`${base}/mipmap-${d}/ic_launcher_foreground.png`, get(p[0] + fg));
      put(`${base}/mipmap-${d}/ic_launcher_monochrome.png`, get(p[1] + fg));
    } else {
      drop(`${base}/mipmap-${d}/ic_launcher_foreground.png`);
      drop(`${base}/mipmap-${d}/ic_launcher_monochrome.png`);
    }
  }
  if (STYLE !== 'free') {
    put(`${base}/mipmap-anydpi-v26/ic_launcher.xml`, Buffer.from(ADAPTIVE));
    put(`${base}/mipmap-anydpi-v26/ic_launcher_round.xml`, Buffer.from(ADAPTIVE));
    put(`${base}/values/ic_launcher_background.xml`, Buffer.from(BACKGROUND));
  } else {
    drop(`${base}/mipmap-anydpi-v26`);
    drop(`${base}/values/ic_launcher_background.xml`);
  }
}
