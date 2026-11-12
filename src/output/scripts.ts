// Every inline <script> the site serves, as fixed strings. Nothing here may
// depend on the request or the data: security-headers.ts hashes each body at
// startup into the CSP's script-src (no 'unsafe-inline'), so a script that
// changes per page would be blocked. Pages pass data through the DOM (ids,
// data-* attributes), never by interpolating it into a script.

// Sets the colour theme before first paint (in <head>).
export const THEME_INIT_SCRIPT = `(()=>{let t=null;try{t=localStorage.getItem('infovore-theme')}catch{}if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t})()`;

export const THEME_TOGGLE_SCRIPT = `document.getElementById('theme-toggle').addEventListener('click',()=>{const r=document.documentElement;const n=r.dataset.theme==='dark'?'light':'dark';r.dataset.theme=n;try{localStorage.setItem('infovore-theme',n)}catch{}})`;

export const ADAPTIVE_MEDIA_SCRIPT = `
  (() => {
    const applyRatio = (image) => {
      if (!image.naturalWidth || !image.naturalHeight) return;
      const naturalRatio = image.naturalWidth / image.naturalHeight;
      const displayedRatio = Math.min(2, Math.max(0.5, naturalRatio));
      image.style.setProperty('--media-ratio', String(displayedRatio));
    };
    // A cover that fails to load becomes a neutral placeholder instead of a broken-image icon.
    const placeholder = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const fail = (image) => { if (image.dataset.failed) return; image.dataset.failed = '1'; image.classList.add('img-failed'); image.alt = ''; image.src = placeholder; };
    document.addEventListener('error', (event) => { if (event.target instanceof HTMLImageElement) fail(event.target); }, true);
    document.querySelectorAll('img').forEach((image) => { if (image.complete && image.naturalWidth === 0 && image.getAttribute('src')) fail(image); });
    document.querySelectorAll('img[data-adaptive-media]').forEach((image) => {
      if (image.complete) applyRatio(image);
      else image.addEventListener('load', () => applyRatio(image), { once: true });
    });
  })();
`;

// Positions tooltips inside the viewport (so they never widen the page),
// toggles them on tap/click for touch screens and closes them on Escape or an
// outside tap.
export const INFO_SCRIPT = `
(() => {
  let pinned = null;
  const tipFor = (button) => document.getElementById(button.getAttribute('aria-controls'));
  const place = (button, tip) => {
    const rect = button.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 24);
    tip.style.maxWidth = width + 'px';
    tip.classList.add('open');
    const tipRect = tip.getBoundingClientRect();
    const left = Math.max(12, Math.min(rect.left - 8, window.innerWidth - tipRect.width - 12));
    const below = rect.bottom + 8;
    const top = below + tipRect.height > window.innerHeight - 8 && rect.top - tipRect.height - 8 > 8 ? rect.top - tipRect.height - 8 : below;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  };
  const show = (button) => { const tip = tipFor(button); if (tip) place(button, tip); };
  const hide = (button) => { const tip = tipFor(button); if (tip) tip.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); };
  const unpin = () => { if (pinned) { hide(pinned); pinned = null; } };
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('button.info');
    if (!button) { unpin(); return; }
    event.preventDefault();
    event.stopPropagation();
    if (pinned === button) { unpin(); return; }
    unpin();
    pinned = button;
    button.setAttribute('aria-expanded', 'true');
    show(button);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const focused = document.activeElement;
    document.querySelectorAll('.info-tip.open').forEach((tip) => tip.classList.remove('open'));
    if (pinned) { pinned.setAttribute('aria-expanded', 'false'); pinned = null; }
    if (focused && focused.matches && focused.matches('button.info')) focused.dataset.dismissed = '1';
  });
  // Hover content stays open while the pointer moves from the button onto the
  // tooltip (WCAG 1.4.13); it closes shortly after the pointer leaves both.
  let hideTimer = 0;
  const ownerOf = (node) => {
    if (!node || !node.closest) return null;
    const button = node.closest('button.info');
    if (button) return button;
    const tip = node.closest('.info-tip');
    return tip ? document.querySelector('button.info[aria-controls="' + tip.id + '"]') : null;
  };
  document.addEventListener('mouseover', (event) => {
    const button = ownerOf(event.target);
    if (!button) return;
    clearTimeout(hideTimer);
    if (button !== pinned) { delete button.dataset.dismissed; show(button); }
  });
  document.addEventListener('mouseout', (event) => {
    const button = ownerOf(event.target);
    if (!button || button === pinned || ownerOf(event.relatedTarget) === button) return;
    if (button === document.activeElement && !button.dataset.dismissed) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hide(button), 250);
  });
  document.addEventListener('focusin', (event) => {
    const button = event.target.closest && event.target.closest('button.info');
    if (button && button !== pinned) { delete button.dataset.dismissed; show(button); }
  });
  document.addEventListener('focusout', (event) => {
    const button = event.target.closest && event.target.closest('button.info');
    if (button && button !== pinned) hide(button);
  });
  window.addEventListener('scroll', unpin, { passive: true });
  window.addEventListener('resize', unpin);
})();
`;

// The Time table: window picker on narrow screens, sortable headings, scroll hint.
export const TIME_TABLE_SCRIPT = `(() => {
  const t = document.querySelector('.time-table');
  if (!t) return;
  const w = t.closest('.time-table-wrap'), hint = document.querySelector('.time-table-hint');
  const pick = document.getElementById('time-window'), narrow = matchMedia('(max-width:1024px)');
  const body = t.tBodies[0];
  const heads = [...t.querySelectorAll('th[data-sort]')];
  const live = document.getElementById('sort-status');
  const sortBy = (i, asc, announce) => {
    const h = heads[i];
    heads.forEach((o) => o.removeAttribute('aria-sort'));
    h.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
    if (announce && live) live.textContent = 'Sorted by ' + h.textContent.trim() + ', ' + (asc ? 'ascending' : 'descending');
    const v = (r) => r.cells[i].dataset.value ?? '';
    const num = h.dataset.sort === 'number';
    [...body.rows].sort((a, c) => { const x = v(a), y = v(c); const d = num ? Number(x) - Number(y) : x.localeCompare(y); return asc ? d : -d; })
      .forEach((r) => body.appendChild(r));
  };
  // On narrow screens only the chosen window's column shows. If the column the rows are sorted
  // by is hidden, sort by the visible one instead (largest first), so the order and aria-sort
  // always describe a column the reader can see.
  const followWindow = (announce) => {
    const sorted = heads.findIndex((h) => h.hasAttribute('aria-sort'));
    if (sorted !== -1 && !heads[sorted].classList.contains('tw-hide')) return;
    const visible = heads.findIndex((h, i) => i >= 3 && !h.classList.contains('tw-hide'));
    if (visible !== -1) sortBy(visible, false, announce);
  };
  const showWindow = () => {
    const value = pick.value, delta = value === 'delta', chosen = narrow.matches ? (delta ? -2 : Number(value)) : -1;
    for (const row of t.rows) [...row.cells].forEach((cell, i) => cell.classList.toggle('tw-hide', chosen !== -1 && ((i === 3 && !delta) || (i >= 4 && (delta || i - 4 !== chosen)))));
  };
  const fit = () => {
    const more = w.scrollWidth - w.clientWidth - w.scrollLeft > 2;
    w.classList.toggle('has-more', more);
    if (hint) hint.hidden = w.scrollWidth <= w.clientWidth + 2;
  };
  if (pick) {
    pick.closest('label').hidden = false;
    const update = (announce) => { showWindow(); followWindow(announce); fit(); };
    pick.addEventListener('change', () => update(true));
    narrow.addEventListener('change', () => update(false));
    showWindow();
    followWindow(false);
  }
  fit();
  w.addEventListener('scroll', fit, { passive: true });
  addEventListener('resize', fit);
  heads.forEach((h) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'th-sort'; b.append(...h.childNodes); h.append(b); });
  heads.forEach((h, i) => h.addEventListener('click', () => sortBy(i, h.getAttribute('aria-sort') === 'descending', true)));
})()`;

// Every inline script body, in the order pages may include them.
export const INLINE_SCRIPTS: readonly string[] = [
  THEME_INIT_SCRIPT, THEME_TOGGLE_SCRIPT, ADAPTIVE_MEDIA_SCRIPT, INFO_SCRIPT, TIME_TABLE_SCRIPT,
];

export function inlineScript(body: string): string {
  if (!INLINE_SCRIPTS.includes(body)) throw new Error('inline scripts must be listed in INLINE_SCRIPTS (they are hashed into the CSP)');
  return `<script>${body}</script>`;
}
