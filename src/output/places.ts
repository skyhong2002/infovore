import { PUBLIC_MAX_ZOOM, type PlacesExtra, type PlacesMap, type PlacesRegion } from '../location/public.js';
import { BAND_COLORS, BAND_DAYS, RECENT_MAX_ZOOM, type RecentBand } from '../location/recent.js';
import { EXPLORED_COLOR } from '../fog/tiles.js';
import { dateFormat } from '../data/time.js';
import { html } from './pages.js';
import { flagOf } from '../location/regions.js';
import { placesMapVersion } from './places-map.js';

// The public Places platform: see src/location/public.ts for what is (and is
// never) published. The map is one canvas (src/output/places-map.ts) over a
// self-hosted Natural Earth basemap, so no third-party tile service is used.

const dayLabel = dateFormat('en', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const longDay = dateFormat('en', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const show = (day: string, format = dayLabel) => format.format(new Date(`${day}T00:00:00Z`));
const kmText = (value: number) => `${value.toLocaleString('en', { maximumFractionDigits: value < 10 ? 1 : 0 })} km`;

const STYLE = `<style>
.places-atlas{--atlas-sea:#0d1015;--atlas-land:#1c2028;--atlas-border:#3a414d;--atlas-glow:.85;position:relative;height:min(70vh,560px);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--atlas-sea)}
:root[data-theme=light] .places-atlas{--atlas-sea:#dfe5ea;--atlas-land:#f7f6f2;--atlas-border:#c4c9cf;--atlas-glow:.3}
@media(prefers-color-scheme:light){:root:not([data-theme=dark]) .places-atlas{--atlas-sea:#dfe5ea;--atlas-land:#f7f6f2;--atlas-border:#c4c9cf;--atlas-glow:.3}}
.places-atlas canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}
.places-atlas canvas.dragging{cursor:grabbing}
.atlas-zoom{position:absolute;right:12px;top:12px;display:flex;flex-direction:column;gap:6px}
.atlas-zoom button{width:36px;height:36px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface);color:var(--text);font-size:18px;cursor:pointer}
.atlas-credit{position:absolute;left:10px;bottom:8px;color:var(--quiet);font-size:11px;pointer-events:none}
.atlas-noscript{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted)}
.atlas-views{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.atlas-legend{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.atlas-legend button{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--text);padding:5px 11px;font:inherit;font-size:12px;cursor:pointer}
.atlas-legend button i{width:10px;height:10px;border-radius:50%;box-shadow:0 0 8px currentColor}
.atlas-legend button[aria-pressed=false]{opacity:.45}
.atlas-legend button[aria-pressed=false] i{box-shadow:none;filter:grayscale(1)}
.places-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:1px}
.recent-week .places-dot{background:rgb(${BAND_COLORS.week.join(',')});box-shadow:0 0 8px rgb(${BAND_COLORS.week.join(',')})}
.recent-month .places-dot{background:rgb(${BAND_COLORS.month.join(',')});box-shadow:0 0 6px rgb(${BAND_COLORS.month.join(',')})}
.recent-year .places-dot{background:rgb(${BAND_COLORS.year.join(',')})}
.places-regions article.recent-week{border-color:rgba(${BAND_COLORS.week.join(',')},.55);box-shadow:0 0 0 1px rgba(${BAND_COLORS.week.join(',')},.25),0 0 18px -6px rgba(${BAND_COLORS.week.join(',')},.6)}
.places-regions article.recent-month{border-color:rgba(${BAND_COLORS.month.join(',')},.45)}
.atlas-views button{display:inline-flex;align-items:baseline;gap:6px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--text);padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}
.atlas-views button span{color:var(--muted);font-size:12px}
.atlas-views button[aria-pressed=true]{border-color:var(--accent);background:var(--accent-soft)}
.places-regions{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.places-regions article{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px}
.places-regions strong{display:block;font-size:14px}
.places-regions strong>.places-local{display:inline;color:var(--muted);font-weight:400;font-size:13px}
.places-regions article>span{color:var(--muted);font-size:12px}
.places-country{margin-bottom:16px}
.places-country h3{align-items:baseline;display:flex;flex-wrap:wrap;font-size:15px;gap:8px;margin:0 0 8px}
.places-country h3 span{color:var(--muted);font-size:12px;font-weight:400}
</style>`;

// One interactive map (src/output/places-map.ts); without script, a note.
function atlas(extra: PlacesExtra, landVersion: string): string {
  const views = extra.maps.map((entry: PlacesMap) => {
    const n = 2 ** entry.z;
    return { label: entry.label, bounds: [entry.x / n, entry.y / n, (entry.x + entry.cols) / n, (entry.y + entry.rows) / n] };
  });
  const buttons = extra.maps.map((entry, index) =>
    `<button type="button" data-view="${index}" aria-pressed="${index === 0}">${flagOf(entry.code)} ${html(entry.label)}<span>${kmText(entry.km2).replace(' km', ' km²')}</span></button>`).join('');
  // Drawn in this order: all-time ground under the year, 28 days and 7 days.
  const recent = (band: RecentBand) => ({ key: band, url: `/api/places/recent/${band}/{z}/{x}/{y}.png?v=${extra.recentVersion}`, max: RECENT_MAX_ZOOM, glow: 1.4 });
  const layers = [
    { key: 'fog', url: `/api/places/fog/{z}/{x}/{y}.png?v=${extra.layerVersion}`, max: PUBLIC_MAX_ZOOM, glow: 0.8 },
    recent('year'), recent('month'), recent('week'),
  ];
  const swatch = (rgb: readonly number[]) => `<i style="background:rgb(${rgb.join(',')})"></i>`;
  const legend = [
    ['week', 'Last 7 days', BAND_COLORS.week], ['month', '28 days', BAND_COLORS.month], ['year', '1 year', BAND_COLORS.year],
    ['fog', 'All time · Fog of World', EXPLORED_COLOR],
  ].map(([key, label, rgb]) => `<button type="button" data-layer="${key}" aria-pressed="true">${swatch(rgb as readonly number[])}${html(label as string)}</button>`).join('');
  return `<div class="atlas-legend" role="group" aria-label="Layers">${legend}</div>
    <div class="places-atlas" data-layers="${html(JSON.stringify(layers))}" data-land="/places/land.json?v=${html(landVersion)}" data-views="${html(JSON.stringify(views))}">
      <canvas role="img" aria-label="Map of the ground explored in Fog of World"></canvas>
      <div class="atlas-zoom"><button type="button" data-zoom="1" aria-label="Zoom in">+</button><button type="button" data-zoom="-1" aria-label="Zoom out">−</button></div>
      <div class="atlas-credit">Land: Natural Earth</div>
      <noscript><div class="atlas-noscript">The map needs JavaScript.</div></noscript>
    </div>
    <div class="atlas-views" role="group" aria-label="Fly to">${buttons}<button type="button" data-view="all" aria-pressed="false">🌏 All<span>${kmText(extra.explored.km2).replace(' km', ' km²')}</span></button></div>
    <script src="/places.js?v=${html(landVersion)}" defer></script>`;
}

// Lets browsers pick the right CJK glyphs for the local names.
const LOCAL_LANG: Record<string, string> = { TW: 'zh-Hant-TW', HK: 'zh-Hant-HK', CN: 'zh-Hans', JP: 'ja', KR: 'ko' };

// How recently a region had a recorded stay, against the public cutoff.
function recency(region: PlacesRegion, asOfDay: string): RecentBand | null {
  if (!region.lastDay) return null;
  const age = (Date.parse(`${asOfDay}T00:00:00Z`) - Date.parse(`${region.lastDay}T00:00:00Z`)) / 86_400_000;
  return age < BAND_DAYS.week ? 'week' : age < BAND_DAYS.month ? 'month' : age < BAND_DAYS.year ? 'year' : null;
}

function regionCard(region: PlacesRegion, asOfDay: string): string {
  const band = recency(region, asOfDay);
  const facts: string[] = [];
  if (region.days && region.firstDay && region.lastDay) {
    facts.push(`${region.days} ${region.days === 1 ? 'day' : 'days'} · ${html(region.firstDay === region.lastDay ? show(region.lastDay, longDay) : `${show(region.firstDay)} – ${show(region.lastDay, longDay)}`)}`);
  }
  if (region.exploredKm2 !== null) facts.push(`${region.exploredKm2.toLocaleString('en', { maximumFractionDigits: region.exploredKm2 < 1 ? 2 : 1 })} km² explored`);
  return `<article${band ? ` class="recent-${band}"` : ''}><strong>${band ? `<i class="places-dot" title="${band === 'week' ? 'Last 7 days' : band === 'month' ? 'Last 28 days' : 'This year'}"></i>` : ''}${html(region.region)}${region.local ? ` <span${LOCAL_LANG[region.code] ? ` lang="${LOCAL_LANG[region.code]}"` : ''} class="places-local">${html(region.local)}</span>` : ''}</strong><span>${facts.join(' · ')}</span></article>`;
}

export function placesDetails(extra: PlacesExtra, landVersion = placesMapVersion): string {
  const asOf = longDay.format(new Date(+new Date(extra.asOf) - 1 + 8 * 3_600_000));
  const asOfDay = new Date(+new Date(extra.asOf) - 1 + 8 * 3_600_000).toISOString().slice(0, 10);
  const growth = extra.explored.last30DaysKm2 === null ? '' : ` · +${extra.explored.last30DaysKm2.toLocaleString('en')} km² in 30 days`;
  const explored = `<section><div class="platform-section-heading"><h2>Explored</h2><span>Fog of World · as of ${html(asOf)}${html(growth)}</span></div>
    ${extra.maps.length
      ? atlas(extra, landVersion)
      : '<div class="empty">The map appears once the fog is a few days old (it is shown with the same delay as everything here).</div>'}</section>`;
  const peak = Math.max(1, ...extra.travel.days.map((day) => day.km));
  const travel = `<section><div class="platform-section-heading"><h2>Distance per day</h2><span>Last 30 days · ${kmText(extra.travel.last30Km)}</span></div>
    <div class="health-days">${[...extra.travel.days].reverse().filter((day) => day.km > 0).map((day) =>
      `<article class="health-day"><time datetime="${day.day}">${html(show(day.day))}</time><div class="health-step-track"><span style="width:${Math.max(2, day.km / peak * 100)}%"></span></div><strong>${kmText(day.km)}</strong><p>travelled</p></article>`).join('')
      || '<div class="empty">No movement recorded in these 30 days.</div>'}</div></section>`;
  const modes = extra.travel.modes.length
    ? `<section><div class="platform-section-heading"><h2>How</h2><span>Trips as Google Maps Timeline classified them · all time</span></div>
      <div class="platform-tags">${extra.travel.modes.map((mode) => `<span>${html(mode.label)} · ${kmText(mode.km)} · ${mode.trips} ${mode.trips === 1 ? 'trip' : 'trips'}</span>`).join('')}</div></section>`
    : '';
  const total = extra.regions.length;
  const regions = `<section><div class="platform-section-heading"><h2>Regions</h2><span>${total} in ${extra.countries.length} ${extra.countries.length === 1 ? 'country' : 'countries'}</span></div>
    ${extra.countries.map((country) => {
      const list = extra.regions.filter((region) => region.country === country.country);
      return `<div class="places-country"><h3>${flagOf(country.code)} ${html(country.country)}<span>${list.length} ${list.length === 1 ? 'region' : 'regions'}${country.days ? ` · ${country.days} ${country.days === 1 ? 'day' : 'days'} recorded` : ''}</span></h3>
        <div class="places-regions">${list.map((region) => regionCard(region, asOfDay)).join('')}</div></div>`;
    }).join('') || '<div class="empty">No regions yet.</div>'}
    </section>`;
  return STYLE + explored + regions + travel + modes;
}
