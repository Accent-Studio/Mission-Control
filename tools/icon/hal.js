// The Mission Control icon: HAL 9000's eye. A brushed metal ring, black glass, and a red lens that fades slowly into the
// black. Draws into a 2D canvas context, centered, filling `size` pixels. Used by make-icons.mjs (desktop .ico, phone app).
function drawHal(x, size) {
  const S = size, c = S / 2, R = S * 0.48, gr = R * 0.9;
  const metal = x.createLinearGradient(c - R, c - R, c + R, c + R);
  metal.addColorStop(0, '#f2f4f7'); metal.addColorStop(0.3, '#8d939c'); metal.addColorStop(0.55, '#d7dbe1'); metal.addColorStop(0.8, '#5d636c'); metal.addColorStop(1, '#c4c9d0');
  x.beginPath(); x.arc(c, c, R, 0, 7); x.fillStyle = metal; x.fill();
  x.beginPath(); x.arc(c, c, gr, 0, 7); x.fillStyle = '#0a0b0e'; x.fill();
  // one long gradient across the glass: hot core, red, then a slow fall through dark red into black at the rim
  const g = x.createRadialGradient(c, c, 0, c, c, gr);
  g.addColorStop(0, '#fff6c8'); g.addColorStop(0.06, '#ffd04a'); g.addColorStop(0.15, '#ff3b1a'); g.addColorStop(0.32, '#c8140f');
  g.addColorStop(0.46, '#8e0b0a'); g.addColorStop(0.58, '#5a0607'); g.addColorStop(0.7, '#320405'); g.addColorStop(0.82, '#1a0506');
  g.addColorStop(0.92, '#0f0607'); g.addColorStop(1, '#0a0b0e');
  x.beginPath(); x.arc(c, c, gr, 0, 7); x.fillStyle = g; x.fill();
  // two reflections on the glass
  x.beginPath(); x.ellipse(c - R * 0.36, c - R * 0.42, R * 0.3, R * 0.12, -0.6, 0, 7); x.fillStyle = 'rgba(255,255,255,.16)'; x.fill();
  x.beginPath(); x.ellipse(c + R * 0.42, c + R * 0.38, R * 0.12, R * 0.05, -0.6, 0, 7); x.fillStyle = 'rgba(255,255,255,.08)'; x.fill();
}

// Only the lens: no metal ring, the red glow runs out to the edge of the square it is drawn in (radius = size / 2) and
// fades into black there, so it sits on a black background with no visible edge. The bright core and the highlight stay
// within the middle 60% of the square.
function drawHalLens(x, size) {
  const S = size, c = S / 2, R = S * 0.5;
  const g = x.createRadialGradient(c, c, 0, c, c, R);
  g.addColorStop(0, '#fff6c8'); g.addColorStop(0.07, '#ffd04a'); g.addColorStop(0.18, '#ff3b1a'); g.addColorStop(0.4, '#c8140f');
  g.addColorStop(0.6, '#8e0b0a'); g.addColorStop(0.76, '#5a0607'); g.addColorStop(0.88, '#2a0405'); g.addColorStop(1, '#000');
  x.beginPath(); x.arc(c, c, R, 0, 2 * Math.PI); x.fillStyle = g; x.fill();
  x.beginPath(); x.ellipse(c - R * 0.3, c - R * 0.36, R * 0.22, R * 0.08, -0.6, 0, 7); x.fillStyle = 'rgba(255,255,255,.18)'; x.fill();
  x.beginPath(); x.ellipse(c + R * 0.34, c + R * 0.3, R * 0.09, R * 0.035, -0.6, 0, 7); x.fillStyle = 'rgba(255,255,255,.09)'; x.fill();
}

// The lens as a flat white disc, for Android's themed icons.
function drawHalLensMono(x, size) {
  x.fillStyle = '#fff'; x.beginPath(); x.arc(size / 2, size / 2, size * 0.42, 0, 2 * Math.PI); x.fill();
}

// The same eye as a flat white silhouette (the ring and the lens, glass left empty), for Android's themed icons, which
// only read the shape and tint it themselves.
function drawHalMono(x, size) {
  const S = size, c = S / 2, R = S * 0.48, gr = R * 0.9;
  x.fillStyle = '#fff';
  x.beginPath(); x.arc(c, c, R, 0, 2 * Math.PI); x.moveTo(c + gr, c); x.arc(c, c, gr, 0, 2 * Math.PI, true); x.fill();
  x.beginPath(); x.arc(c, c, gr * 0.5, 0, 7); x.fill();
}
