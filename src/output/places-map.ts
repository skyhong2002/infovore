import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// The interactive map on /platforms/places, served as /places.js (the CSP
// allows scripts from 'self' only). One canvas, Web Mercator:
// - land and country borders from assets/land.json (Natural Earth), drawn as
//   Path2D in its 0…2^20 coordinates under a transform, coloured from CSS
//   variables so it follows the light and dark themes;
// - the public explored-ground tiles (/api/places/fog, zoom ≤ data-max-zoom,
//   scaled past that) on top, with a soft glow;
// - drag, wheel, pinch, double-click and +/− to move; buttons in
//   .atlas-views fly to a country's explored area, or to all of them.
// Data comes from data-* attributes on .places-atlas.
export const placesMapScript = String.raw`(() => {
  const root = document.querySelector('.places-atlas');
  if (!root) return;
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const tileUrl = root.dataset.tiles;
  const maxTile = Number(root.dataset.maxZoom);
  const views = JSON.parse(root.dataset.views || '[]');
  const MIN_Z = 1, MAX_Z = maxTile + 1.5;
  let width = 0, height = 0, dpr = 1;
  let cx = 0.5, cy = 0.5, z = 2;
  let land = null, borders = null, scale = 1;
  let frame = 0;
  const tiles = new Map();

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const world = () => 256 * 2 ** z;
  const request = () => { if (!frame) frame = requestAnimationFrame(draw); };

  function colors() {
    const style = getComputedStyle(root);
    const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return { sea: read('--atlas-sea', '#0e1116'), land: read('--atlas-land', '#1d222a'), border: read('--atlas-border', '#39404c') };
  }

  function path(lists) {
    const p = new Path2D();
    for (const list of lists) {
      let x = 0, y = 0;
      for (let i = 0; i < list.length; i += 2) {
        x += list[i]; y += list[i + 1];
        if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
      }
    }
    return p;
  }

  fetch(root.dataset.land).then((r) => r.json()).then((data) => {
    scale = data.scale;
    land = path(data.land);
    borders = path(data.borders);
    request();
  }).catch(() => {});

  function tile(tz, x, y) {
    const key = tz + '/' + x + '/' + y;
    let entry = tiles.get(key);
    if (!entry) {
      const img = new Image();
      entry = { img, ready: false };
      img.onload = () => { entry.ready = true; request(); };
      img.src = tileUrl.replace('{z}', tz).replace('{x}', x).replace('{y}', y);
      tiles.set(key, entry);
      if (tiles.size > 400) tiles.delete(tiles.keys().next().value);
    }
    return entry;
  }

  // A loaded tile covering (tz, x, y): itself, else the nearest loaded ancestor and the part of it to draw.
  function covering(tz, x, y) {
    for (let up = 0; up <= tz; up++) {
      const pz = tz - up, f = 2 ** up;
      const px = Math.floor(x / f), py = Math.floor(y / f);
      const entry = up === 0 ? tile(pz, px, py) : tiles.get(pz + '/' + px + '/' + py);
      if (entry && entry.ready) {
        const s = 256 / f;
        return { img: entry.img, sx: (x - px * f) * s, sy: (y - py * f) * s, s };
      }
    }
    return null;
  }

  function draw() {
    frame = 0;
    const c = colors();
    const W = world();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.sea;
    ctx.fillRect(0, 0, width, height);
    const left = width / 2 - cx * W, top = height / 2 - cy * W;
    // The world repeats east and west.
    const copies = [];
    for (let k = Math.floor(-left / W) - 1; k <= Math.ceil((width - left) / W); k++) copies.push(k);
    if (land) {
      for (const k of copies) {
        const s = W / scale;
        ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (left + k * W), dpr * top);
        ctx.fillStyle = c.land;
        ctx.fill(land, 'evenodd');
        ctx.strokeStyle = c.border;
        ctx.lineWidth = 0.8 / s;
        ctx.stroke(borders);
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const tz = clamp(Math.round(z), 0, maxTile);
    const n = 2 ** tz;
    const size = W / n;
    const x0 = Math.floor(-left / size), x1 = Math.floor((width - left) / size);
    const y0 = Math.max(0, Math.floor(-top / size)), y1 = Math.min(n - 1, Math.floor((height - top) / size));
    const pieces = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const piece = covering(tz, ((x % n) + n) % n, y);
        if (piece) pieces.push([piece, left + x * size, top + y * size]);
      }
    }
    ctx.imageSmoothingEnabled = size <= 256;
    const paint = () => { for (const [p, dx, dy] of pieces) ctx.drawImage(p.img, p.sx, p.sy, p.s, p.s, dx, dy, size + 0.5, size + 0.5); };
    if ('filter' in ctx) {
      ctx.save();
      ctx.filter = 'blur(' + Math.round(3 + Math.min(4, z / 2)) + 'px)';
      ctx.globalAlpha = 0.85;
      paint();
      ctx.restore();
    }
    paint();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width; height = rect.height;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    request();
  }

  // Zoom by dz keeping the point under (sx, sy) in place.
  function zoomAt(dz, sx, sy) {
    const next = clamp(z + dz, MIN_Z, MAX_Z);
    const W = world();
    const wx = cx + (sx - width / 2) / W, wy = cy + (sy - height / 2) / W;
    z = next;
    const W2 = world();
    cx = wx - (sx - width / 2) / W2;
    cy = clamp(wy - (sy - height / 2) / W2, 0, 1);
    request();
  }

  let animation = 0;
  function fit(bounds, animate = true) {
    const [bx0, by0, bx1, by1] = bounds;
    const pad = 0.12;
    const target = clamp(Math.log2(Math.min(width / ((bx1 - bx0) * (1 + pad * 2) * 256), height / ((by1 - by0) * (1 + pad * 2) * 256))), MIN_Z, maxTile);
    const tx = (bx0 + bx1) / 2, ty = (by0 + by1) / 2;
    cancelAnimationFrame(animation);
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { cx = tx; cy = ty; z = target; request(); return; }
    const from = { cx, cy, z }, start = performance.now(), duration = 700;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration), e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      // Pull out a little in the middle of long moves.
      const dist = Math.hypot(tx - from.cx, ty - from.cy) * 256 * 2 ** Math.min(from.z, target) / Math.max(width, 1);
      const lift = Math.min(3, Math.log2(1 + dist)) * Math.sin(Math.PI * e);
      cx = from.cx + (tx - from.cx) * e; cy = from.cy + (ty - from.cy) * e;
      z = from.z + (target - from.z) * e - lift;
      draw();
      if (t < 1) animation = requestAnimationFrame(step);
    };
    animation = requestAnimationFrame(step);
  }

  const pointers = new Map();
  let pinch = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelAnimationFrame(animation);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    const previous = pointers.get(e.pointerId);
    if (!previous) return;
    const rect = canvas.getBoundingClientRect();
    if (pointers.size === 2) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoomAt(Math.log2(d / pinch), (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
      pinch = d;
      return;
    }
    const W = world();
    cx -= (e.clientX - previous.x) / W;
    cy = clamp(cy - (e.clientY - previous.y) / W, 0, 1);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    request();
  });
  const release = (e) => { pointers.delete(e.pointerId); pinch = null; if (!pointers.size) canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.shiftKey ? -1 : 1, e.clientX - rect.left, e.clientY - rect.top);
  });
  root.querySelectorAll('[data-zoom]').forEach((button) => button.addEventListener('click', () => zoomAt(Number(button.dataset.zoom), width / 2, height / 2)));
  document.querySelectorAll('.atlas-views [data-view]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.atlas-views [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    const index = button.dataset.view;
    if (index === 'all') {
      const xs = views.flatMap((v) => [v.bounds[0], v.bounds[2]]), ys = views.flatMap((v) => [v.bounds[1], v.bounds[3]]);
      fit([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    } else fit(views[Number(index)].bounds);
  }));

  new ResizeObserver(resize).observe(canvas);
  resize();
  if (views.length) fit(views[0].bounds, false);
  // Repaint when the theme changes.
  new MutationObserver(request).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', request);
})();
`;

/** assets/land.json, served at /places/land.json. */
export const landJson = readFileSync(new URL('../../assets/land.json', import.meta.url));
/** Changes with the basemap or the script, for cache-safe URLs. */
export const placesMapVersion = createHash('sha1').update(landJson).update(placesMapScript).digest('hex').slice(0, 10);
