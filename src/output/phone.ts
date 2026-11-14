// A data-free shell. The token and the returned private cards only live in browser memory.
export function phonePage(): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>手機足跡 · Infovore</title><style>
:root{color-scheme:light dark;--bg:#f3f4f6;--card:#ffffff;--ink:#20252d;--muted:#596273;--line:#dce0e7;--accent:#4f6584}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,sans-serif}a{color:var(--accent)}header{border-bottom:1px solid var(--line);padding:18px 5vw;display:flex;justify-content:space-between;gap:24px}header a{text-decoration:none}main{max-width:1080px;margin:auto;padding:40px 24px}h1{font-size:clamp(30px,5vw,46px);letter-spacing:-1px;margin:4px 0}h2{font-size:20px;margin:0 0 12px}p{margin:8px 0}.eyebrow,.meta{color:var(--muted);font-size:14px}.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin:24px 0}button,input{font:inherit;min-height:48px;border:1px solid var(--line);border-radius:12px;padding:10px 16px;background:var(--card);color:var(--ink)}button{cursor:pointer}button:disabled{opacity:.55;cursor:wait}.primary{background:var(--accent);color:var(--bg);border-color:var(--accent)}input[type=password]{width:min(100%,440px)}.layout{display:grid;grid-template-columns:1fr 280px;gap:24px}.panel,.activity{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:22px;margin-bottom:16px}.activity{border-left:4px solid var(--accent)}.activity h2{margin:6px 0;font-size:19px}.time{font-variant-numeric:tabular-nums;font-size:14px;color:var(--accent)}.chip{display:inline-block;padding:3px 10px;border-radius:20px;background:var(--bg);margin:3px;font-size:13px}.empty{padding:40px 20px;text-align:center}.number{font-size:36px;line-height:1.25;font-weight:650}.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin:6px 0 14px}.fill{height:100%;background:var(--accent)}#message{white-space:pre-line}#logout{margin-left:auto}[hidden]{display:none!important}@media(max-width:720px){main{padding:24px 16px}.layout{grid-template-columns:1fr}.layout aside{grid-row:1}.panel,.activity{padding:18px}.toolbar{gap:8px}header{padding:16px}}@media(prefers-color-scheme:dark){:root{--bg:#121418;--card:#1c1f25;--ink:#f2f4f8;--muted:#b8bfca;--line:#323844;--accent:#a9bcd8}}
</style><script src="/phone.js" defer></script></head><body><header><a href="/">◈ Infovore</a><nav><a href="/platforms/dayflow">電腦活動</a> · <a href="/">瀏覽 Infovore</a></nav></header><main><div class="eyebrow">Infovore · 私人活動紀錄</div><h1>手機足跡</h1><p class="meta">回看手機上的一天。活動摘要與使用的 app，只在解鎖後顯示。</p><form id="unlock" class="panel"><h2>開啟私人時間軸</h2><p>輸入 app 連線設定中的手機活動金鑰（DAYFLOW_PHONE_TOKEN）。</p><label for="token">手機活動金鑰</label><div class="toolbar"><input id="token" type="password" autocomplete="off" required minlength="32"><button class="primary">解鎖</button></div><p class="meta">金鑰只保留在此分頁記憶體，重新整理或鎖定後需重新輸入。</p></form><div id="workspace" hidden><div class="toolbar"><button id="previous" aria-label="前一天">←</button><label for="day">日期</label><input id="day" type="date"><button id="next" aria-label="後一天">→</button><button id="refresh">重新整理</button><button id="logout">鎖定</button></div><div class="layout"><section aria-label="活動時間軸"><div id="message" class="panel" role="status" aria-live="polite"></div><div id="timeline"></div></section><aside><div class="panel"><h2>這一天</h2><div id="total" class="number">—</div><p class="meta">已整理的活動時間</p><div id="categories"></div></div><div class="panel"><h2>整理狀態</h2><p id="processing"></p><p id="last" class="meta"></p><p class="meta">上傳後約 12–20 分鐘形成活動卡片；暫時失敗會重試。未啟用 AI 時會依 app 使用時段整理。</p></div></aside></div><p class="meta">所有已連接的手機 · Asia/Taipei · 每天 04:00 起算。這是抽樣記錄，可能有空白，並非系統的螢幕使用時間。</p></div><p id="error" role="alert"></p></main></body></html>`;
}

export const phoneScript = `(() => {
const $ = id => document.getElementById(id);
let token = '', request = 0, controller;
const today = () => new Date(Date.now() + 4 * 3600000).toISOString().slice(0,10);
$('day').value = today(); $('day').max = today();
const time = value => new Date(value).toLocaleTimeString('zh-TW', {timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false});
const node = (tag, value, cls) => { const el = document.createElement(tag); el.textContent = value; if(cls) el.className = cls; return el; };
const duration = mins => mins >= 60 ? Math.floor(mins/60)+' 小時 '+(mins%60)+' 分' : mins+' 分鐘';
function clear() { $('timeline').replaceChildren(); $('categories').replaceChildren(); $('total').textContent='—'; $('processing').textContent=''; $('last').textContent=''; }
function lock() { request++; controller?.abort(); token=''; $('token').value=''; clear(); $('workspace').hidden=true; $('unlock').hidden=false; $('error').textContent=''; }
async function load() {
  const id = ++request; controller?.abort(); controller = new AbortController(); clear();
  $('message').textContent='正在讀取活動…'; $('error').textContent=''; $('refresh').disabled=true;
  try {
    const response = await fetch('/api/phone/activity?day='+encodeURIComponent($('day').value), {headers:{Authorization:'Bearer '+token},cache:'no-store',signal:controller.signal});
    if (id !== request) return;
    if(response.status===401) { lock(); $('error').textContent='金鑰無效，請確認與手機活動上傳使用相同的金鑰。'; return; }
    if(!response.ok) throw new Error('HTTP '+response.status);
    const data = await response.json(); if(id !== request) return;
    $('unlock').hidden=true; $('workspace').hidden=false; $('token').value='';
    $('message').textContent=data.cards.length ? data.cards.length+' 段活動'+(data.truncated?'（只顯示最新 1,000 段）':'') : '這一天還沒有活動卡片。若已開始記錄，請查看右側整理狀態；也可以切換日期。';
    const total = data.categories.reduce((n,c)=>n+c.minutes,0); $('total').textContent=duration(total);
    for(const c of data.categories.filter(c=>c.minutes>0)) { const row=node('div',c.name+' · '+duration(c.minutes),'meta'); const bar=node('div','','bar'); const fill=node('div','','fill'); fill.style.width=(c.minutes/Math.max(1,total)*100)+'%'; fill.style.backgroundColor=c.color; bar.append(fill); $('categories').append(row,bar); }
    $('processing').textContent=data.status.pending+' 筆等待整理'+(data.status.retrying?' · '+data.status.retrying+' 筆重試中':'');
    $('last').textContent=data.status.lastObservationAt?'最近收到記錄：'+new Date(data.status.lastObservationAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}):'伺服器尚未收到記錄。請在 app 的設定啟用手機足跡，並確認無障礙服務與上傳連線。';
    for(const card of data.cards) { const el=node('article','','activity'); el.append(node('div',time(card.startAt)+' – '+time(card.endAt)+' · '+duration(Math.round((Date.parse(card.endAt)-Date.parse(card.startAt))/60000)),'time'),node('h2',card.title),node('p',card.summary)); const tags=node('div',''); tags.append(node('span',card.category,'chip')); for(const app of card.apps) tags.append(node('span',app,'chip')); tags.append(node('span',card.summarized?'AI 摘要':'依 app 整理','meta')); el.append(tags); $('timeline').append(el); }
  } catch(e) { if(id!==request || e.name==='AbortError') return; $('message').textContent='暫時無法讀取活動，請按重新整理。'; $('error').textContent='連線失敗，請稍後重試。'; }
  finally { if(id===request) $('refresh').disabled=false; }
}
$('unlock').addEventListener('submit',event=>{event.preventDefault(); token=$('token').value.trim(); $('workspace').hidden=false; load();});
$('logout').onclick=lock; $('refresh').onclick=load; $('day').onchange=load;
function move(n) { const date=new Date($('day').value+'T12:00:00Z'); date.setUTCDate(date.getUTCDate()+n); const day=date.toISOString().slice(0,10); if(day>today()) return; $('day').value=day; load(); }
$('previous').onclick=()=>move(-1); $('next').onclick=()=>move(1);
window.addEventListener('pagehide',lock);
})();`;
