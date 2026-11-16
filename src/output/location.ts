// The private location page: a data-free shell. The token and everything it
// unlocks live only in this tab's memory; the map tiles come from
// OpenStreetMap (allowed by the CSP's img-src https:), the track is drawn here.
export function locationPage(): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>位置足跡 · Infovore</title><style>
:root{color-scheme:light dark;--bg:#f3f4f6;--card:#ffffff;--ink:#20252d;--muted:#596273;--line:#dce0e7;--accent:#2f6f9f;--track:#d9480f;--visit:#2f6f9f}
@media(prefers-color-scheme:dark){:root{--bg:#121418;--card:#1c1f25;--ink:#f2f4f8;--muted:#b8bfca;--line:#323844;--accent:#8ec5ec;--track:#ff8a4c;--visit:#8ec5ec}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif}a{color:var(--accent)}
header{border-bottom:1px solid var(--line);padding:18px 5vw;display:flex;justify-content:space-between;gap:24px}header a{text-decoration:none}
main{max-width:1080px;margin:auto;padding:32px 24px}h1{font-size:clamp(30px,5vw,44px);letter-spacing:-1px;margin:4px 0}h2{font-size:19px;margin:0 0 10px}p{margin:8px 0}
.eyebrow,.meta{color:var(--muted);font-size:14px}.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:20px 0}
button,input{font:inherit;min-height:44px;border:1px solid var(--line);border-radius:12px;padding:8px 14px;background:var(--card);color:var(--ink)}button{cursor:pointer}button:disabled{opacity:.55;cursor:wait}
.primary{background:var(--accent);color:var(--bg);border-color:var(--accent)}input[type=password]{width:min(100%,440px)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;margin-bottom:16px}
.layout{display:grid;grid-template-columns:1fr 300px;gap:20px;align-items:start}
.map{position:relative;height:min(62vh,520px);overflow:hidden;border-radius:16px;border:1px solid var(--line);background:var(--line);touch-action:none;cursor:grab}
.map img{position:absolute;width:256px;height:256px;user-select:none;-webkit-user-drag:none;pointer-events:none}
.map #fog img{opacity:1}.map svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.zoom{position:absolute;right:10px;top:10px;display:flex;flex-direction:column;gap:6px;z-index:2}.zoom button{min-height:40px;width:40px;padding:0;font-size:20px}
.credit{position:absolute;right:0;bottom:0;background:var(--card);opacity:.85;font-size:12px;padding:2px 8px;border-top-left-radius:8px;z-index:2}
.number{font-size:32px;line-height:1.25;font-weight:650}.now{font-size:18px;font-weight:600}
.entry{display:grid;grid-template-columns:92px 1fr;gap:12px;padding:12px 0;border-top:1px solid var(--line)}.entry:first-child{border-top:0}
.time{font-variant-numeric:tabular-nums;font-size:14px;color:var(--muted)}.kind{font-size:13px;color:var(--accent);font-weight:600}
.empty{padding:28px 8px;text-align:center;color:var(--muted)}#logout{margin-left:auto}[hidden]{display:none!important}
@media(max-width:760px){main{padding:20px 16px}.layout{grid-template-columns:1fr}header{padding:16px}.toolbar{gap:8px}}
</style><script src="/location.js" defer></script></head><body><header><a href="/">◈ Infovore</a><nav><a href="/">瀏覽 Infovore</a></nav></header><main>
<div class="eyebrow">Infovore · 私人位置紀錄</div><h1>位置足跡</h1><p class="meta">手機記錄的位置與匯入的 Google 地圖時間軸，只在解鎖後顯示。</p>
<form id="unlock" class="panel"><h2>開啟私人位置紀錄</h2><p>輸入 app 連線設定中的 HEALTH_CONNECT_TOKEN（或伺服器另設的 LOCATION_TOKEN）。</p><label for="token">位置金鑰</label><div class="toolbar"><input id="token" type="password" autocomplete="off" required minlength="32"><button class="primary">解鎖</button></div><p class="meta">金鑰只保留在此分頁記憶體，重新整理或鎖定後需重新輸入。</p></form>
<div id="workspace" hidden>
<div class="toolbar"><button id="previous" aria-label="前一天">←</button><label for="day">日期</label><input id="day" type="date"><button id="next" aria-label="後一天">→</button><button id="today">今天</button><button id="refresh">重新整理</button><button id="logout">鎖定</button></div>
<div class="layout"><section aria-label="地圖與時間軸">
<div class="map" id="map" role="img" aria-label="當天軌跡地圖"><div class="zoom"><button id="zoomIn" type="button" aria-label="放大">+</button><button id="zoomOut" type="button" aria-label="縮小">−</button></div><div id="tiles"></div><div id="fog"></div><svg id="overlay" aria-hidden="true"></svg><div class="credit">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></div></div>
<div class="panel" style="margin-top:16px"><h2>這一天</h2><div id="message" class="meta" role="status" aria-live="polite"></div><div id="timeline"></div></div>
</section><aside>
<div class="panel"><h2>目前位置</h2><p id="now" class="now">—</p><p id="nowMeta" class="meta"></p><p><a id="nowLink" href="#" target="_blank" rel="noopener" hidden>在 Google 地圖開啟</a></p></div>
<div class="panel"><h2>當天移動</h2><div id="distance" class="number">—</div><p id="counts" class="meta"></p></div>
<div class="panel" id="fogPanel" hidden><h2>Fog of World</h2><div id="fogArea" class="number">—</div><p id="fogMeta" class="meta"></p><label class="meta"><input id="fogToggle" type="checkbox" checked style="min-height:0;width:auto;margin-right:6px">在地圖上顯示迷霧</label></div>
<div class="panel"><h2>資料狀態</h2><p id="status" class="meta"></p></div>
</aside></div>
<p class="meta">Asia/Taipei · 每天 00:00 起算。手機定位是抽樣記錄，室內或關閉定位時會有空白。</p></div>
<p id="error" role="alert"></p></main></body></html>`;
}

export const locationScript = `(() => {
const $ = id => document.getElementById(id);
let token = '', request = 0, controller, data = null, view = null, drag = null, fogReady = false;
// Fog tiles need the token, so they are fetched here and shown from blob URLs (kept per tab, freed on lock).
const fogTiles = new Map();
function fogTile(z, x, y) {
  const key = z+'/'+x+'/'+y;
  if (!fogTiles.has(key)) {
    if (fogTiles.size > 300) { const [old, url] = fogTiles.entries().next().value; url.then(u => u && URL.revokeObjectURL(u)); fogTiles.delete(old); }
    fogTiles.set(key, fetch('/api/location/fog/'+key+'.png', {headers: {Authorization: 'Bearer '+token}, cache: 'no-store'})
      .then(r => r.ok ? r.blob() : null).then(b => b ? URL.createObjectURL(b) : null).catch(() => null));
  }
  return fogTiles.get(key);
}
function clearFog() { for (const url of fogTiles.values()) url.then(u => u && URL.revokeObjectURL(u)); fogTiles.clear(); $('fog').replaceChildren(); }
const TZ = 'Asia/Taipei';
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10);
$('day').value = today(); $('day').max = today();
const time = v => new Date(v).toLocaleTimeString('zh-TW',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hour12:false});
const stamp = v => new Date(v).toLocaleString('zh-TW',{timeZone:TZ,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
const minutes = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
const duration = m => m >= 60 ? Math.floor(m/60)+' 小時'+(m%60 ? ' '+(m%60)+' 分' : '') : m+' 分鐘';
const km = m => m >= 1000 ? (m/1000).toFixed(m >= 10000 ? 0 : 1)+' 公里' : Math.round(m)+' 公尺';
const ago = v => { const m = Math.round((Date.now() - Date.parse(v)) / 60000); return m < 1 ? '剛剛' : m < 60 ? m+' 分鐘前' : m < 1440 ? Math.round(m/60)+' 小時前' : Math.round(m/1440)+' 天前'; };
const coords = (lat, lng) => lat.toFixed(5)+', '+lng.toFixed(5);
const mapsLink = (lat, lng, placeId) => 'https://www.google.com/maps/search/?api=1&query='+lat+','+lng+(placeId ? '&query_place_id='+encodeURIComponent(placeId) : '');
const PLACE = {HOME:'住家',INFERRED_HOME:'住家',WORK:'工作地點',INFERRED_WORK:'工作地點',SEARCHED_ADDRESS:'搜尋過的地址',ALIASED_LOCATION:'已命名地點'};
const MODE = {WALKING:'步行',ON_FOOT:'步行',RUNNING:'跑步',CYCLING:'騎自行車',ON_BICYCLE:'騎自行車',IN_PASSENGER_VEHICLE:'開車',IN_VEHICLE:'搭車',DRIVING:'開車',IN_TAXI:'計程車',IN_BUS:'公車',IN_TRAIN:'火車',IN_SUBWAY:'捷運',IN_TRAM:'電車',IN_FERRY:'渡輪',FLYING:'飛行',MOTORCYCLING:'騎機車',SAILING:'航行',SKIING:'滑雪',STILL:'停留'};
const modeName = m => { if (!m) return '移動'; const k = m.toUpperCase().replace(/[^A-Z]+/g,'_').replace(/^_|_$/g,''); return MODE[k] || m.toLowerCase().replace(/_/g,' '); };
const placeName = v => v.name || PLACE[(v.semanticType||'').toUpperCase()] || '停留地點';

// Web Mercator tile maths (256 px tiles).
const project = (lat, lng, z) => { const s = 256 * 2 ** z, r = Math.PI / 180, y = Math.log(Math.tan(Math.PI/4 + Math.max(-85.05, Math.min(85.05, lat)) * r / 2)); return [(lng + 180) / 360 * s, (1 - y / Math.PI) / 2 * s]; };
function fit(points) {
  const box = $('map').getBoundingClientRect();
  if (!points.length) return {z: 12, center: project(25.04, 121.56, 12), w: box.width, h: box.height};
  for (let z = 17; z >= 2; z--) {
    const xy = points.map(p => project(p[0], p[1], z));
    const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
    if (Math.max(...xs) - Math.min(...xs) <= box.width - 60 && Math.max(...ys) - Math.min(...ys) <= box.height - 60)
      return {z, center: [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2], w: box.width, h: box.height};
  }
  return {z: 2, center: project(0, 0, 2), w: box.width, h: box.height};
}
function draw() {
  if (!view) return;
  const {z, center} = view, box = $('map').getBoundingClientRect(); view.w = box.width; view.h = box.height;
  const left = center[0] - view.w / 2, top = center[1] - view.h / 2, n = 2 ** z, tiles = [];
  for (let ty = Math.floor(top / 256); ty <= Math.floor((top + view.h) / 256); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / 256); tx <= Math.floor((left + view.w) / 256); tx++) {
      const img = document.createElement('img'); img.alt = ''; img.decoding = 'async'; img.loading = 'lazy';
      img.src = 'https://tile.openstreetmap.org/'+z+'/'+(((tx % n) + n) % n)+'/'+ty+'.png';
      img.style.left = (tx * 256 - left)+'px'; img.style.top = (ty * 256 - top)+'px'; tiles.push(img);
    }
  }
  $('tiles').replaceChildren(...tiles);
  const fog = [];
  if (fogReady && $('fogToggle').checked && token) {
    for (const tile of tiles) {
      const [, fz, fx, fy] = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(tile.src);
      const img = document.createElement('img'); img.alt = ''; img.style.left = tile.style.left; img.style.top = tile.style.top;
      fogTile(fz, fx, fy).then(url => { if (url) img.src = url; });
      fog.push(img);
    }
  }
  $('fog').replaceChildren(...fog);
  const svg = $('overlay'), NS = 'http://www.w3.org/2000/svg', parts = [];
  const at = (lat, lng) => { const p = project(lat, lng, z); return [p[0] - left, p[1] - top]; };
  const el = (name, attrs) => { const e = document.createElementNS(NS, name); for (const k in attrs) { const v = String(attrs[k]); if (v.startsWith('var(')) e.style.setProperty(k, v); else e.setAttribute(k, v); } return e; };
  if (data) {
    const track = data.points.map(p => at(p.lat, p.lng).map(v => v.toFixed(1)).join(',')).join(' ');
    if (data.points.length > 1) {
      parts.push(el('polyline', {points: track, fill: 'none', stroke: 'var(--card)', 'stroke-width': 7, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: .8}));
      parts.push(el('polyline', {points: track, fill: 'none', stroke: 'var(--track)', 'stroke-width': 4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'}));
    }
    for (const v of data.visits) { const p = at(v.lat, v.lng); parts.push(el('circle', {cx: p[0], cy: p[1], r: 8, fill: 'var(--visit)', stroke: 'var(--card)', 'stroke-width': 3})); }
    const last = data.day === today() && data.latest ? data.latest : data.points[data.points.length - 1];
    if (last) { const p = at(last.lat, last.lng); parts.push(el('circle', {cx: p[0], cy: p[1], r: 13, fill: 'var(--track)', opacity: .25}), el('circle', {cx: p[0], cy: p[1], r: 6, fill: 'var(--track)', stroke: 'var(--card)', 'stroke-width': 2})); }
  }
  svg.replaceChildren(...parts);
}
function zoom(delta) {
  if (!view) return; const nz = Math.max(2, Math.min(19, view.z + delta)); const f = 2 ** (nz - view.z);
  view = {...view, z: nz, center: [view.center[0] * f, view.center[1] * f]}; draw();
}
$('zoomIn').onclick = () => zoom(1); $('zoomOut').onclick = () => zoom(-1);
$('map').addEventListener('pointerdown', e => { if (e.target.closest('button,a') || !view) return; drag = {x: e.clientX, y: e.clientY, c: view.center}; $('map').setPointerCapture(e.pointerId); });
$('map').addEventListener('pointermove', e => { if (!drag) return; view.center = [drag.c[0] - (e.clientX - drag.x), drag.c[1] - (e.clientY - drag.y)]; draw(); });
const stop = () => { drag = null; }; $('map').addEventListener('pointerup', stop); $('map').addEventListener('pointercancel', stop);
$('map').addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); }, {passive: false});
window.addEventListener('resize', draw);

function timeline() {
  const items = [...data.visits.map(v => ({at: v.start, v})), ...data.activities.map(a => ({at: a.start, a}))].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const list = $('timeline'); list.replaceChildren();
  for (const item of items) {
    const row = node('div', null, 'entry'), body = node('div');
    if (item.v) {
      const v = item.v; row.append(node('div', time(v.start)+'–'+time(v.end), 'time'));
      const link = node('a', placeName(v)); link.href = mapsLink(v.lat, v.lng, v.placeId); link.target = '_blank'; link.rel = 'noopener';
      body.append(node('div', '停留', 'kind'), link, node('div', duration(minutes(v.start, v.end))+' · '+coords(v.lat, v.lng), 'meta'));
    } else {
      const a = item.a; row.append(node('div', time(a.start)+'–'+time(a.end), 'time'));
      body.append(node('div', '移動', 'kind'), node('div', modeName(a.mode)), node('div', duration(minutes(a.start, a.end))+(a.distanceMeters ? ' · '+km(a.distanceMeters) : ''), 'meta'));
    }
    row.append(body); list.append(row);
  }
  return items.length;
}
function clear() { data = null; view = null; $('timeline').replaceChildren(); $('tiles').replaceChildren(); $('overlay').replaceChildren(); $('distance').textContent = '—'; $('counts').textContent = ''; }
function lock() { request++; controller?.abort(); token = ''; clearFog(); fogReady = false; $('fogPanel').hidden = true; $('token').value = ''; clear(); $('now').textContent = '—'; $('nowMeta').textContent = ''; $('nowLink').hidden = true; $('status').textContent = ''; $('workspace').hidden = true; $('unlock').hidden = false; $('error').textContent = ''; }
async function get(path, signal) {
  const response = await fetch(path, {headers: {Authorization: 'Bearer '+token}, cache: 'no-store', signal});
  if (response.status === 401) { const e = new Error('unauthorized'); e.unauthorized = true; throw e; }
  if (!response.ok) throw new Error('HTTP '+response.status);
  return response.json();
}
async function load() {
  const id = ++request; controller?.abort(); controller = new AbortController(); clear();
  $('message').textContent = '正在讀取位置紀錄…'; $('error').textContent = ''; $('refresh').disabled = true;
  try {
    const [day, status, fog] = await Promise.all([get('/api/location/day?day='+encodeURIComponent($('day').value), controller.signal), get('/api/location/status', controller.signal), get('/api/location/fog/status', controller.signal).catch(() => null)]);
    if (id !== request) return;
    fogReady = Boolean(fog && fog.configured && fog.tiles > 0);
    $('fogPanel').hidden = !(fog && fog.configured);
    if (fog && fog.configured) {
      $('fogArea').textContent = fog.exploredKm2.toLocaleString('zh-TW', {maximumFractionDigits: 1})+' km²';
      $('fogMeta').textContent = '已探索 · '+fog.tiles+' 個圖格'+(fog.lastSuccessAt ? ' · 同步於 '+stamp(fog.lastSuccessAt) : ' · 尚未同步')+(fog.lastError ? '\n最近一次同步失敗：'+fog.lastError : '');
      $('fogMeta').style.whiteSpace = 'pre-line';
    }
    if (id !== request) return;
    $('unlock').hidden = true; $('workspace').hidden = false; $('token').value = '';
    data = day;
    const latest = status.latest;
    if (latest) {
      $('now').textContent = coords(latest.lat, latest.lng); $('nowMeta').textContent = stamp(latest.time)+'（'+ago(latest.time)+'）'+(latest.accuracy ? ' · 誤差約 '+Math.round(latest.accuracy)+' 公尺' : '')+(latest.source === 'timeline' ? ' · 來自時間軸匯入' : '');
      $('nowLink').href = mapsLink(latest.lat, latest.lng); $('nowLink').hidden = false;
    } else { $('now').textContent = '尚無位置'; $('nowMeta').textContent = '在 app 的「位置紀錄」開啟持續記錄。'; }
    $('status').textContent = status.points.toLocaleString()+' 個定位點 · '+status.visits.toLocaleString()+' 次停留 · '+status.activities.toLocaleString()+' 段移動'
      + (status.lastLiveAt ? '\\n手機最近定位：'+stamp(status.lastLiveAt) : '\\n手機尚未上傳定位')
      + (status.timelineRange ? '\\n時間軸匯入範圍：'+status.timelineRange.from.slice(0,10)+' – '+status.timelineRange.to.slice(0,10) : '');
    $('status').style.whiteSpace = 'pre-line';
    $('distance').textContent = km(day.distanceMeters);
    $('counts').textContent = day.points.length+' 個定位點'+(day.thinned ? '（已抽樣）' : '')+' · '+day.visits.length+' 次停留 · '+day.activities.length+' 段移動';
    const count = timeline();
    $('message').textContent = count ? '' : day.points.length ? '這一天只有定位點，沒有整理好的停留或移動。' : '這一天沒有位置紀錄。';
    const focus = day.points.map(p => [p.lat, p.lng]).concat(day.visits.map(v => [v.lat, v.lng]));
    if (!focus.length && latest && day.day === today()) focus.push([latest.lat, latest.lng]);
    view = fit(focus); draw();
  } catch (e) {
    if (id !== request || e.name === 'AbortError') return;
    if (e.unauthorized) { lock(); $('error').textContent = '金鑰無效，請確認與 app 上傳使用相同的金鑰。'; return; }
    $('message').textContent = '暫時無法讀取位置紀錄，請按重新整理。'; $('error').textContent = '連線失敗，請稍後重試。';
  } finally { if (id === request) $('refresh').disabled = false; }
}
$('unlock').addEventListener('submit', e => { e.preventDefault(); token = $('token').value.trim(); $('workspace').hidden = false; load(); });
$('fogToggle').onchange = draw; $('logout').onclick = lock; $('refresh').onclick = load; $('day').onchange = load; $('today').onclick = () => { $('day').value = today(); load(); };
function move(n) { const d = new Date($('day').value+'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); const day = d.toISOString().slice(0,10); if (day > today()) return; $('day').value = day; load(); }
$('previous').onclick = () => move(-1); $('next').onclick = () => move(1);
window.addEventListener('pagehide', lock);
})();`;
