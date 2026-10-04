// The site-wide stylesheet. Served once from /styles.css (fingerprinted and
// cached for a year) instead of being inlined into every page; page modules add
// their own small `extraStyles` on top. Colour comes from tokens only, so the
// light and dark themes are the same rules with a different root.

const tokens = `
:root{
  color-scheme:dark;
  --bg:#0e0f12;--surface:#16181d;--surface-raised:#1e2127;--surface-hover:#22262d;
  --line:#262a31;--line-strong:#383d47;
  --text:#f3f4f6;--muted:#aab1bb;--quiet:#7d8591;
  --accent:#a9c1e6;--accent-strong:#c5d6f1;--accent-soft:rgba(169,193,230,.14);
  --gold:#cfae78;--brand-blue:#7086a5;--brand-gold:#be9b65;--blue:var(--accent);--violet:#b8b8bd;--green:#1ed760;
  --ok:#5fd38a;--warn:#f0b35a;
  --shadow:0 1px 2px rgba(0,0,0,.35),0 10px 30px -18px rgba(0,0,0,.7);
  --radius:16px;--radius-sm:11px;
  --font:Figtree,"Figtree Fallback",ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang TC","Noto Sans TC",sans-serif;
  --display:"Instrument Serif",Georgia,"Times New Roman",serif;
  --header-bg:rgba(14,15,18,.78);
}
:root[data-theme=light]{
  color-scheme:light;
  --bg:#f4f3ef;--surface:#ffffff;--surface-raised:#edece7;--surface-hover:#f6f5f1;
  --line:rgba(21,23,28,.09);--line-strong:rgba(21,23,28,.2);
  --text:#15171c;--muted:#565d67;--quiet:#7f8791;
  --accent:#3d5f8f;--accent-strong:#2b4a76;--accent-soft:rgba(61,95,143,.1);
  --gold:#8a6a35;--brand-blue:#5e7599;--brand-gold:#a07f4a;--violet:#5e6168;--green:#179f46;
  --ok:#1e8f4d;--warn:#b7791f;
  --shadow:0 1px 2px rgba(21,23,28,.05),0 10px 30px -20px rgba(21,23,28,.25);
  --header-bg:rgba(244,243,239,.8);
}
@media(prefers-color-scheme:light){:root:not([data-theme=dark]){
  color-scheme:light;
  --bg:#f4f3ef;--surface:#ffffff;--surface-raised:#edece7;--surface-hover:#f6f5f1;
  --line:rgba(21,23,28,.09);--line-strong:rgba(21,23,28,.2);
  --text:#15171c;--muted:#565d67;--quiet:#7f8791;
  --accent:#3d5f8f;--accent-strong:#2b4a76;--accent-soft:rgba(61,95,143,.1);
  --gold:#8a6a35;--brand-blue:#5e7599;--brand-gold:#a07f4a;--violet:#5e6168;--green:#179f46;
  --ok:#1e8f4d;--warn:#b7791f;
  --shadow:0 1px 2px rgba(21,23,28,.05),0 10px 30px -20px rgba(21,23,28,.25);
  --header-bg:rgba(244,243,239,.8);
}}
@font-face{font-family:Figtree;font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/Figtree-Regular.ttf) format("truetype")}
@font-face{font-family:Figtree;font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/Figtree-Bold.ttf) format("truetype")}
@font-face{font-family:"Instrument Serif";font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/InstrumentSerif-Regular.ttf) format("truetype")}
`;

const base = `
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:110px}
body{background:var(--bg);color:var(--text);font:15px/1.55 var(--font);margin:0;min-height:100vh;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--accent)}a:hover{color:var(--accent-strong)}a:focus-visible{border-radius:5px;outline:2px solid var(--accent);outline-offset:3px}
h1,h2,h3,p{overflow-wrap:anywhere}h1,h2,h3{font-weight:700;letter-spacing:-.01em}
img{max-width:100%}
.muted{color:var(--muted)}
.eyebrow{color:var(--gold);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.button{border:1px solid var(--line-strong);border-radius:999px;color:var(--text);display:inline-flex;font-size:13px;font-weight:600;padding:9px 15px;text-decoration:none;transition:border-color .15s,background .15s}
.button:hover{background:var(--surface-raised);border-color:var(--quiet);color:var(--text)}
.button.primary{background:var(--text);border-color:var(--text);color:var(--bg)}.button.primary:hover{opacity:.9;color:var(--bg)}
.hero-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:24px}
`;

const shell = `
.site-header{position:sticky;top:0;z-index:20;background:var(--header-bg);backdrop-filter:saturate(160%) blur(14px);-webkit-backdrop-filter:saturate(160%) blur(14px);border-bottom:1px solid var(--line)}
.site-header-inner{align-items:center;display:flex;gap:20px;justify-content:space-between;margin:0 auto;max-width:1200px;min-height:64px;padding:10px 24px}
.site-brand{align-items:center;color:var(--text);display:flex;gap:11px;text-decoration:none}.site-brand:hover{color:var(--text)}
.brand-mark{border-radius:9px;display:block;flex:0 0 36px;height:36px;object-fit:contain;width:36px}
.site-brand strong,.site-brand small{display:block;line-height:1.2}.site-brand strong{font-size:16px;letter-spacing:.01em}.site-brand small{color:var(--quiet);font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase}
.site-nav{display:flex;gap:2px}
.site-nav a{border-radius:999px;color:var(--muted);font-size:13.5px;font-weight:500;padding:7px 12px;text-decoration:none;transition:background .15s,color .15s}
.site-nav a:hover{background:var(--surface-raised);color:var(--text)}.site-nav a[aria-current=page]{background:var(--surface-raised);color:var(--text);font-weight:700}
.site-tools{align-items:center;display:flex;gap:8px}
.theme-toggle{align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:10px;color:var(--muted);cursor:pointer;display:inline-flex;height:34px;justify-content:center;padding:0;width:34px;transition:background .15s,color .15s}
.theme-toggle:hover{background:var(--surface-raised);color:var(--text)}.theme-toggle svg{fill:none;height:16px;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.8;width:16px}
.theme-toggle .icon-moon{display:none}:root[data-theme=dark] .theme-toggle .icon-moon{display:block}:root[data-theme=dark] .theme-toggle .icon-sun{display:none}
.site-main{margin:0 auto;max-width:1200px;padding:40px 24px 84px}
.site-footer{border-top:1px solid var(--line);display:grid;gap:30px;grid-template-columns:minmax(220px,1fr) repeat(3,minmax(110px,auto));margin:0 auto;max-width:1200px;padding:36px 24px 56px}
.site-footer .site-brand strong{font-size:15px}.site-footer p{color:var(--quiet);font-size:12.5px;margin:10px 0 0;max-width:320px}
.footer-group span{color:var(--quiet);display:block;font-size:10px;font-weight:700;letter-spacing:.1em;margin-bottom:8px;text-transform:uppercase}
.footer-group a{color:var(--muted);display:block;font-size:13px;margin:5px 0;text-decoration:none}.footer-group a:hover{color:var(--text)}
`;

const layout = `
.page-intro{align-items:end;display:flex;gap:30px;justify-content:space-between;margin-bottom:30px}
.page-intro h1,.board-head h1{font-family:var(--display);font-size:clamp(44px,6vw,72px);font-weight:400;letter-spacing:-.02em;line-height:.98;margin:8px 0 14px}
.page-intro p,.board-head p{color:var(--muted);font-size:16px;margin:0;max-width:640px}
.page-intro-aside,.board-status{color:var(--quiet);font-size:12.5px;max-width:240px;text-align:right}.board-status strong{color:var(--text);display:block;font-size:13px}
.context-line{align-items:center;color:var(--quiet);display:flex;flex-wrap:wrap;font-size:12.5px;gap:8px;margin:-12px 0 32px}
.context-line a{color:var(--muted);text-decoration:none}.context-line a:hover{color:var(--text)}.context-line strong{color:var(--text);font-weight:600}
.board-head{align-items:end;display:flex;gap:30px;justify-content:space-between;margin-bottom:28px}
.section-heading{align-items:end;display:flex;gap:20px;justify-content:space-between;margin:0 0 16px}
.section-heading h2{font-size:22px;margin:0}.section-heading p,.section-heading span{color:var(--quiet);font-size:12.5px;margin:2px 0 0}
.section-heading a{color:var(--muted);font-size:13px;text-decoration:none;white-space:nowrap}.section-heading a:hover{color:var(--text)}
.content-section{margin-top:52px}
img[data-adaptive-media]{aspect-ratio:var(--media-ratio,.75);display:block;max-width:100%;object-fit:cover;width:auto}
.source-pulse{display:grid;gap:10px;grid-template-columns:repeat(3,minmax(0,1fr))}.source-pulse .entry{min-height:104px}
`;

const components = `
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px}
.card p.muted{font-size:13.5px;line-height:1.6;margin:8px 0 0}
.entry{align-items:center;display:grid;gap:14px;grid-template-columns:auto minmax(0,1fr)}
.entry img{background:var(--surface-raised);border-radius:9px;height:72px}.entry h3{font-size:15px;line-height:1.3;margin:0 0 4px}.entry .muted{font-size:12.5px}
.pill{color:var(--quiet);font-size:10.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}
.count{font-size:30px;font-variant-numeric:tabular-nums;font-weight:700;letter-spacing:-.03em;line-height:1.1}
.bar{background:var(--surface-raised);border-radius:9px;height:8px;overflow:hidden}.bar span{background:var(--accent);border-radius:9px;display:block;height:100%}
.empty{border:1px dashed var(--line-strong);border-radius:var(--radius-sm);color:var(--quiet);padding:30px;text-align:center}
.metric-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.metric-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);box-shadow:var(--shadow);color:inherit;display:flex;flex-direction:column;gap:10px;padding:16px;text-decoration:none;transition:border-color .15s,transform .15s}
a.metric-card:hover{border-color:var(--line-strong);color:inherit;transform:translateY(-1px)}
.metric-card .count{display:block;font-size:26px}.metric-card .pill{display:block}
.archive-actions{display:grid;gap:12px;grid-template-columns:repeat(2,1fr);margin:28px 0 46px}
.archive-action{background:linear-gradient(145deg,var(--accent-soft),var(--surface) 60%);border:1px solid var(--line);border-radius:var(--radius);color:inherit;padding:22px;text-decoration:none;transition:border-color .15s}
.archive-action:hover{border-color:var(--line-strong);color:inherit}.archive-action strong{display:block;font-size:18px}.archive-action span{color:var(--muted);display:block;font-size:13px;margin-top:4px}
.activity-list{border-top:1px solid var(--line);display:flex;flex-direction:column}
.activity-row{align-items:center;border-bottom:1px solid var(--line);display:grid;gap:18px;grid-template-columns:112px auto minmax(0,1fr);padding:18px 4px}
.activity-row time{align-self:start;color:var(--muted);font-size:13px;line-height:1.4}.activity-row time span{color:var(--quiet);display:block;font-size:12px}
.activity-cover{background:var(--surface-raised);border-radius:8px;height:78px}.activity-cover.placeholder{display:block;width:58px}
.activity-main{min-width:0}.activity-labels{align-items:center;display:flex;gap:8px;margin-bottom:5px}
.source-label{color:var(--accent);font-size:10.5px;font-weight:700;letter-spacing:.1em;text-decoration:none;text-transform:uppercase}.source-label:hover{text-decoration:underline}
.kind-label{color:var(--quiet);font-size:10.5px;text-transform:uppercase}
.activity-main h2{color:var(--text);font-size:17px;line-height:1.35;margin:0 0 5px}.activity-meta{color:var(--muted);font-size:13px}
.activity-tag{border:1px solid var(--line-strong);border-radius:999px;color:var(--muted);display:inline-block;font-size:11px;line-height:1.4;padding:1px 7px}
.rating{color:var(--gold)}.feed-note{color:var(--quiet);font-size:12.5px;margin-top:18px}
.health-activity{min-width:0}.health-activity>div{min-width:0}.entry.health-activity img{background:#fff;padding:6px;object-fit:contain;width:48px;height:48px}
.health-activity h3 a{color:inherit;text-decoration:none}.health-activity .health-activity-summary{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;line-height:1.5}
.health-activity time{display:block;color:var(--quiet);font-size:11px;margin-top:4px}
`;

const platforms = `
.platform-nav{display:flex;gap:6px;margin:-10px 0 30px;overflow-x:auto;padding:4px 0;scrollbar-width:none}.platform-nav::-webkit-scrollbar{display:none}
.platform-nav a{border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:13px;font-weight:500;padding:6px 12px;text-decoration:none;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.platform-nav a:hover,.platform-nav a[aria-current=page]{background:var(--surface-raised);border-color:var(--line-strong);color:var(--text)}
.platform-intro{margin-bottom:20px}
.platform-index{display:grid;gap:14px;grid-template-columns:repeat(2,minmax(0,1fr))}
.platform-tile{--platform-accent:var(--accent);background:linear-gradient(145deg,color-mix(in srgb,var(--platform-accent) 11%,var(--surface)),var(--surface) 55%);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);color:inherit;padding:22px;text-decoration:none;transition:border-color .15s,transform .15s}
.platform-tile:hover{border-color:color-mix(in srgb,var(--platform-accent) 60%,var(--line));color:inherit;transform:translateY(-2px)}
.platform-tile-top{align-items:center;display:flex;gap:14px}
.platform-tile-top img,.platform-monogram{border-radius:14px;height:54px;object-fit:cover;width:54px}
.platform-monogram{align-items:center;background:var(--platform-accent);color:#0d0e11;display:inline-flex;font-size:23px;font-weight:700;justify-content:center}
.platform-eyebrow{color:var(--platform-accent);font-size:10.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase}
.platform-tile h2,.platform-hero h2{color:var(--text);font-size:22px;margin:2px 0 0}.platform-tile p{color:var(--muted);margin:0}
.platform-description{font-size:13.5px;min-height:40px;padding-top:15px}
.platform-tile-stats{border-top:1px solid var(--line);color:var(--quiet);font-size:12.5px;margin-top:14px;padding-top:12px}.platform-tile-stats strong{color:var(--text);font-size:18px}
.platform-tile-footer{color:var(--quiet);display:flex;font-size:12px;justify-content:space-between;margin-top:10px}.platform-tile-footer span{color:var(--platform-accent);font-weight:600}
.platform-hero{--platform-accent:var(--accent);align-items:center;background:linear-gradient(135deg,color-mix(in srgb,var(--platform-accent) 14%,var(--surface)),var(--surface) 58%);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);display:grid;gap:20px;grid-template-columns:auto minmax(0,1fr) auto;padding:26px}
.platform-avatar{border-radius:20px;height:80px;object-fit:cover;width:80px}.platform-avatar.platform-monogram{font-size:30px}
.platform-hero p{color:var(--muted);margin:4px 0 10px}.platform-actions{display:flex;gap:14px}.platform-actions a{font-size:13px;font-weight:600}
.platform-freshness{align-self:start;color:var(--quiet);font-size:12px;white-space:nowrap}
.platform-section-heading{align-items:baseline;display:flex;justify-content:space-between;margin:40px 0 14px}
.platform-section-heading h2{font-size:19px;margin:0}.platform-section-heading span{color:var(--quiet);font-size:12.5px}
.platform-card-grid{align-items:flex-start;display:flex;flex-wrap:wrap;gap:16px}
.platform-card-grid a,.card-gallery-row a{border-radius:12px;display:block;flex:0 1 520px;line-height:0;max-width:100%;overflow:hidden;width:520px;transition:box-shadow .15s}
.platform-card-grid a:hover,.card-gallery-row a:hover{box-shadow:0 0 0 2px var(--line-strong)}
.platform-card-grid img,.card-gallery-row img{display:block;height:auto;max-width:100%;width:520px}
.platform-stats{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.platform-stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);padding:14px}
.platform-stat span{color:var(--quiet);display:block;font-size:11.5px;text-transform:capitalize}
.platform-stat strong{display:block;font-size:24px;font-variant-numeric:tabular-nums;letter-spacing:-.02em;margin-top:3px}.platform-stat small{color:var(--quiet);display:block;font-size:11px;margin-top:3px}
.platform-note{background:var(--surface);border-left:3px solid var(--accent);border-radius:8px;color:var(--muted);font-size:13.5px;margin-top:18px;padding:12px 14px}
.platform-entry-grid{display:grid;gap:10px;grid-template-columns:repeat(2,minmax(0,1fr))}
.platform-entry{align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);display:grid;gap:12px;grid-template-columns:auto minmax(0,1fr);min-height:92px;padding:10px}
.platform-entry img,.platform-entry-placeholder{background:var(--surface-raised);border-radius:7px;height:76px}.platform-entry-placeholder{width:58px}
.platform-entry-copy{min-width:0}.platform-entry h3{font-size:14px;line-height:1.3;margin:3px 0 5px}.platform-entry-meta{color:var(--quiet);font-size:12px;line-height:1.45}
.platform-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.platform-tags span{border:1px solid var(--line-strong);border-radius:999px;color:var(--muted);font-size:10.5px;padding:1px 7px}
.platform-leaderboard{display:grid;gap:9px;grid-template-columns:repeat(2,minmax(0,1fr))}
.platform-leaderboard article{align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);display:grid;gap:10px;grid-template-columns:22px auto minmax(0,1fr);padding:8px}
.platform-leaderboard img{border-radius:7px;height:46px}.platform-rank{color:var(--quiet);font-size:12px;font-variant-numeric:tabular-nums;text-align:center}
.platform-leaderboard h3{font-size:13px;line-height:1.25;margin:0}.platform-leaderboard p{color:var(--quiet);font-size:11.5px;margin:2px 0 0}
.health-days{display:grid;gap:8px}
.health-day{align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);display:grid;gap:12px;grid-template-columns:110px minmax(100px,1fr) 110px minmax(220px,1.5fr);padding:11px 13px}
.health-day time{color:var(--muted);font-size:12px}.health-day strong{font-size:13px;text-align:right}.health-day p{color:var(--quiet);font-size:11.5px;margin:0}
.health-step-track{background:var(--surface-raised);border-radius:8px;height:7px;overflow:hidden}.health-step-track span{background:#4ade80;border-radius:8px;display:block;height:100%}
.health-platform{--accent:#a8c7fa;--accent-strong:#c6daff;--blue:#a8c7fa;font-family:Roboto,var(--font)}
:root[data-theme=light] .health-platform{--accent:#1a5fb4;--accent-strong:#0f4a92;--blue:#1a5fb4}
@media(prefers-color-scheme:light){:root:not([data-theme=dark]) .health-platform{--accent:#1a5fb4;--accent-strong:#0f4a92;--blue:#1a5fb4}}
.health-platform .platform-hero{border-radius:22px}.health-platform .platform-nav a[aria-current=page]{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-strong)}
.health-platform .platform-stat{border-radius:16px}.health-platform .platform-note{border-left-color:var(--accent)}.health-platform .health-step-track span{background:var(--accent)}
.platform-avatar[src="/logos/healthconnect.png"],.platform-tile img[src="/logos/healthconnect.png"]{background:#fff;padding:8px;object-fit:contain}
`;

const time = `
.board-time{color:var(--muted);font-size:13px;margin:10px 0 0}.board-time strong{color:var(--text);font-size:14px}
.time-strip{align-items:center;display:flex;flex-wrap:wrap;gap:8px;margin:-26px 0 40px}.time-strip .pill{margin-right:2px}
.time-chip{border:1px solid var(--line-strong);border-radius:999px;color:var(--muted);font-size:12px;padding:5px 11px;text-decoration:none}.time-chip:hover{border-color:var(--quiet);color:var(--text)}.time-chip strong{color:var(--text);margin-left:4px}
.time-strip-more{color:var(--quiet);font-size:12px;margin-left:auto;text-decoration:none}.time-strip-more:hover{color:var(--text)}
.time-table-wrap{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow-x:auto}
.time-table{border-collapse:collapse;width:100%}
.time-table th{background:var(--surface-raised);color:var(--quiet);font-size:10.5px;font-weight:700;letter-spacing:.08em;padding:11px 14px;text-align:right;text-transform:uppercase;white-space:nowrap}
.time-table td{border-top:1px solid var(--line);font-size:14px;font-variant-numeric:tabular-nums;padding:12px 14px;text-align:right;white-space:nowrap}
.time-table th:first-child,.time-table td:first-child{padding-left:18px;text-align:left}.time-table th:last-child,.time-table td:last-child{padding-right:18px}
.time-table td:first-child a{color:var(--text);font-weight:700;text-decoration:none}.time-table td:first-child a:hover{color:var(--accent)}
.time-table tbody tr:hover td{background:var(--surface-hover)}
.time-table tfoot td{background:var(--surface-raised);border-top:1px solid var(--line-strong);font-weight:700}
.time-method{border:1px solid var(--line-strong);border-radius:999px;color:var(--muted);font-size:10px;font-weight:600;letter-spacing:.06em;padding:2px 8px;text-transform:uppercase}
.time-share{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);display:flex;flex-direction:column;gap:14px;padding:20px}
.time-share-row{align-items:center;display:grid;gap:14px;grid-template-columns:130px minmax(0,1fr) 60px}
.time-share-row .pill{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.time-share-row strong{font-size:13px;font-variant-numeric:tabular-nums;text-align:right}
.card-gallery{margin-top:42px}.card-gallery-section{margin-bottom:42px}
.card-gallery-title{align-items:baseline;display:flex;gap:12px;margin-bottom:12px}.card-gallery-title h2{font-size:18px;margin:0}.card-gallery-title a{color:inherit;text-decoration:none}.card-gallery-title .profile-link{color:var(--quiet);font-size:12px}
.card-gallery-row{align-items:flex-start;display:flex;flex-wrap:wrap;gap:16px}
`;

// The sleep timeline keeps Google Fit's stage palette (data colours) but takes
// its chrome from the theme tokens.
const sleep = `
.sleep-latest-label{color:var(--accent);font-size:12px;margin:0 0 10px}
.sleep-stats{grid-template-columns:repeat(4,minmax(0,1fr))!important}.sleep-stats .platform-stat{border-top:2px solid var(--accent)}.sleep-stats .platform-stat strong{font-variant-numeric:tabular-nums;font-size:30px}.sleep-stats .platform-stat span{color:var(--muted)}.sleep-stats .platform-stat small{color:var(--quiet);font-size:11px}
.sleep-chart-heading{align-items:center;display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin:18px 0 10px}.sleep-chart-heading h3{font-size:16px;margin:0 0 2px}.sleep-chart-heading p,.sleep-chart-heading>span{color:var(--quiet);font-size:12px;margin:0}
.sleep-legend{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--muted);font-size:11.5px;margin-bottom:10px}.sleep-legend>span{align-items:center;display:flex;gap:5px}.sleep-color{display:inline-block;width:9px;height:9px;border-radius:2px;flex-shrink:0}
.sleep-color.deep,.sleep-segment.deep{background:#4285f4}.sleep-color.light,.sleep-segment.light{background:#a8c7fa}.sleep-color.rem,.sleep-segment.rem{background:#67d5c3}.sleep-color.awake,.sleep-segment.awake{background:#f6b26b}.sleep-color.asleep,.sleep-segment.asleep{background:#7893b2}.sleep-color.unknown,.sleep-segment.unknown{background:repeating-linear-gradient(135deg,var(--line-strong) 0px,var(--line-strong) 3px,var(--surface-raised) 3px,var(--surface-raised) 6px)}
.sleep-scroll{border:1px solid var(--line);border-radius:var(--radius-sm);overflow-x:auto;scrollbar-color:var(--line-strong) var(--surface)}.sleep-scroll:focus-visible,.sleep-row-summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.sleep-timeline{min-width:720px;background:var(--surface)}
.sleep-axis,.sleep-row-summary{display:grid;grid-template-columns:186px minmax(0,1fr) 138px;column-gap:12px;padding:0 12px;align-items:center}.sleep-axis{height:42px;background:var(--surface-raised);border-bottom:1px solid var(--line);color:var(--quiet);font-size:10px}.sleep-axis>div{height:100%;position:relative}.sleep-tick{position:absolute;top:6px;transform:translateX(-50%);white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--text);font-size:11px}.sleep-tick.first{transform:none}.sleep-tick.last{transform:translateX(-100%)}.sleep-tick small{color:var(--quiet);display:block;font-size:9px;text-align:center}
.sleep-row{border-bottom:1px solid var(--line)}.sleep-row:last-child{border-bottom:0}.sleep-row-summary{min-height:32px;cursor:pointer;list-style:none}.sleep-row-summary::-webkit-details-marker{display:none}.sleep-row-summary:hover,.sleep-row[open]>.sleep-row-summary{background:var(--surface-hover)}
.sleep-date{display:flex;align-items:center;gap:8px;white-space:nowrap;font-variant-numeric:tabular-nums;line-height:1.2}.sleep-date time{min-width:34px;font-size:12px;font-weight:700;color:var(--text)}.sleep-date>span{color:var(--muted);font-size:11px}.sleep-date small{color:var(--quiet);font-size:9px}
.sleep-track{position:relative;display:block;align-self:stretch;min-height:32px}.sleep-gridline{position:absolute;top:0;bottom:0;width:0;border-left:1px solid var(--line);opacity:.5;pointer-events:none}.sleep-gridline.major{opacity:1}.sleep-gridline.midnight{border-left-style:dashed;border-color:var(--accent);opacity:.6}.sleep-segment{position:absolute;top:8px;height:16px;min-width:1px;box-shadow:inset 0 0 0 .5px #00000018}.sleep-segment:hover{filter:brightness(1.2);outline:1px solid var(--text);z-index:2}
.sleep-quality{display:flex;align-items:center;gap:8px;white-space:nowrap;font-variant-numeric:tabular-nums;line-height:1.2}.sleep-quality>strong{font-size:12px;color:var(--text)}.sleep-quality>span{font-size:10px;color:var(--muted)}.sleep-quality .sleep-expand{margin-left:auto;transition:transform .15s}.sleep-row[open] .sleep-expand{transform:rotate(90deg)}
.sleep-expanded{border-top:1px solid var(--line);padding:10px 12px;background:var(--surface-raised)}.sleep-expanded>p{color:var(--muted);font-size:11.5px;margin:0 0 8px}.sleep-breakdown{display:flex;flex-wrap:wrap;gap:6px 16px}.sleep-breakdown>span{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted)}.sleep-breakdown strong{color:var(--text);font-size:11.5px}.sleep-segment-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:3px 12px;list-style:none;padding:0;margin:10px 0 0;font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums}.sleep-history{color:var(--quiet);font-size:12px}
`;

const responsive = `
@media(max-width:900px){.site-header-inner{flex-wrap:wrap;gap:8px 16px;min-height:58px;padding-block:10px}.site-nav{flex:1 1 100%;order:3;overflow-x:auto;padding-bottom:2px;scrollbar-width:none}.site-nav::-webkit-scrollbar{display:none}.site-nav a{white-space:nowrap}}
@media(max-width:760px){.site-main{padding:30px 18px 64px}.site-footer{grid-template-columns:repeat(3,1fr);padding-inline:18px}.footer-about{grid-column:1/-1}.source-pulse{grid-template-columns:repeat(2,minmax(0,1fr))}.platform-index,.platform-entry-grid,.platform-leaderboard{grid-template-columns:1fr}.platform-hero{grid-template-columns:auto minmax(0,1fr)}.platform-freshness{grid-column:1/-1}.platform-description{min-height:0}.health-day{grid-template-columns:92px minmax(90px,1fr) 90px}.health-day p{grid-column:1/-1}.sleep-stats{grid-template-columns:repeat(2,minmax(0,1fr))!important}.sleep-stats .platform-stat strong{font-size:25px}.sleep-axis,.sleep-row-summary{grid-template-columns:174px minmax(0,1fr) 130px;column-gap:8px;padding-inline:8px}}
@media(max-width:560px){.site-header-inner{padding-inline:16px}.site-brand small{display:none}.site-main{padding-inline:14px}.page-intro,.board-head{align-items:flex-start;flex-direction:column;gap:12px}.page-intro h1,.board-head h1{font-size:44px}.page-intro-aside,.board-status{max-width:none;text-align:left}.source-pulse{grid-template-columns:1fr}.activity-row{gap:13px;grid-template-columns:auto minmax(0,1fr)}.activity-row time{grid-column:1/-1}.activity-cover{height:66px}.activity-cover.placeholder{width:48px}.activity-main h2{font-size:16px}.grid,.archive-actions{grid-template-columns:1fr}.site-footer{grid-template-columns:repeat(2,1fr)}.footer-about{grid-column:1/-1}.platform-hero{align-items:start;grid-template-columns:58px minmax(0,1fr);padding:18px}.platform-avatar{border-radius:13px;height:58px;width:58px}.platform-actions{flex-wrap:wrap}.time-share-row{grid-template-columns:96px minmax(0,1fr) 52px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
`;

export const baseStyles = [tokens, base, shell, layout, components, platforms, time, sleep, responsive].join('\n');
