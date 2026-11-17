import type { PlacesExtra, PlacesMap, PlacesRegion } from '../location/public.js';
import { dateFormat } from '../data/time.js';
import { html } from './pages.js';
import { flagOf } from '../location/regions.js';

// The public Places platform: see src/location/public.ts for what is (and is
// never) published. The maps are plain <img> grids of OpenStreetMap tiles with
// the delayed, zone-cleared fog on top, so no script is needed.

const dayLabel = dateFormat('en', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const longDay = dateFormat('en', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const show = (day: string, format = dayLabel) => format.format(new Date(`${day}T00:00:00Z`));
const kmText = (value: number) => `${value.toLocaleString('en', { maximumFractionDigits: value < 10 ? 1 : 0 })} km`;

const STYLE = `<style>
.places-map{display:grid;gap:0;max-width:100%;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius-sm);background:#aad3df}
.places-map div{position:relative;aspect-ratio:1}
.places-map img{position:absolute;inset:0;width:100%;height:100%;display:block}
.places-maps{display:grid;gap:18px}
.places-maps figure{margin:0}
.places-maps figcaption{color:var(--muted);font-size:12px;margin-top:6px}
.places-regions{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.places-regions article{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px}
.places-regions strong{display:block;font-size:14px}
.places-regions strong>.places-local{display:inline;color:var(--muted);font-weight:400;font-size:13px}
.places-regions article>span{color:var(--muted);font-size:12px}
.places-country{margin-bottom:16px}
.places-country h3{align-items:baseline;display:flex;flex-wrap:wrap;font-size:15px;gap:8px;margin:0 0 8px}
.places-country h3 span{color:var(--muted);font-size:12px;font-weight:400}
</style>`;

function map(entry: PlacesMap): string {
  const cells: string[] = [];
  for (let row = 0; row < entry.rows; row++) {
    for (let col = 0; col < entry.cols; col++) {
      const x = entry.x + col;
      const y = entry.y + row;
      cells.push(`<div><img src="https://tile.openstreetmap.org/${entry.z}/${x}/${y}.png" alt="" loading="lazy" referrerpolicy="no-referrer"><img src="/api/places/fog/${entry.z}/${x}/${y}.png" alt="" loading="lazy"></div>`);
    }
  }
  return `<figure><div class="places-map" style="grid-template-columns:repeat(${entry.cols},minmax(0,1fr));width:${entry.cols * 256}px" role="img" aria-label="Fog of World explored ground in ${html(entry.label)}">${cells.join('')}</div>
    <figcaption>${flagOf(entry.code)} ${html(entry.label)} · ${kmText(entry.km2).replace(' km', ' km²')} explored · map © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors</figcaption></figure>`;
}

// Lets browsers pick the right CJK glyphs for the local names.
const LOCAL_LANG: Record<string, string> = { TW: 'zh-Hant-TW', HK: 'zh-Hant-HK', CN: 'zh-Hans', JP: 'ja', KR: 'ko' };

function regionCard(region: PlacesRegion): string {
  const facts: string[] = [];
  if (region.days && region.firstDay && region.lastDay) {
    facts.push(`${region.days} ${region.days === 1 ? 'day' : 'days'} · ${html(region.firstDay === region.lastDay ? show(region.lastDay, longDay) : `${show(region.firstDay)} – ${show(region.lastDay, longDay)}`)}`);
  }
  if (region.exploredKm2 !== null) facts.push(`${region.exploredKm2.toLocaleString('en', { maximumFractionDigits: region.exploredKm2 < 1 ? 2 : 1 })} km² explored`);
  if (!facts.length && region.manual) facts.push('Visited before recording');
  return `<article><strong>${html(region.region)}${region.local ? ` <span${LOCAL_LANG[region.code] ? ` lang="${LOCAL_LANG[region.code]}"` : ''} class="places-local">${html(region.local)}</span>` : ''}</strong><span>${facts.join(' · ')}</span></article>`;
}

export function placesDetails(extra: PlacesExtra): string {
  const asOf = longDay.format(new Date(+new Date(extra.asOf) - 1 + 8 * 3_600_000));
  const growth = extra.explored.last30DaysKm2 === null ? '' : ` · +${extra.explored.last30DaysKm2.toLocaleString('en')} km² in 30 days`;
  const explored = `<section><div class="platform-section-heading"><h2>Explored</h2><span>Fog of World · as of ${html(asOf)}${html(growth)}</span></div>
    ${extra.maps.length
      ? `<div class="places-maps">${extra.maps.map(map).join('')}</div>`
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
        <div class="places-regions">${list.map(regionCard).join('')}</div></div>`;
    }).join('') || '<div class="empty">No regions yet.</div>'}
    <div class="platform-note">Everything here is ${Math.round(extra.delayHours / 24)} days behind and stops at whole days. A region counts on a recorded day after a stay of an hour or more (passing through does not count); Fog of World adds the regions its history explored, which carry no dates; a few older trips are added by hand. Regions are counties, cities or first-level divisions, named offline from GeoNames. Nothing recorded inside private areas counts towards them, and the map shows those areas as plain explored ground. Coordinates, places, visits and times of day stay private.</div></section>`;
  return STYLE + explored + regions + travel + modes;
}
