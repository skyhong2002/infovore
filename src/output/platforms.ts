import type { MediaEntry, SourceSnapshot } from '../data/types.js';
import { html, shell } from './pages.js';

export interface PlatformDefinition {
  source: string;
  title: string;
  description: string;
  accent: string;
  url?: string;
  cards?: string[];
}

export interface PlatformSummary {
  definition: PlatformDefinition;
  snapshot: SourceSnapshot<unknown> | null;
  fetchedAt: string | null;
}

const kindLabels: Record<string, string> = {
  game: 'Games',
  anime: 'Anime',
  manga: 'Manga',
  movie: 'Movies',
  show: 'Shows',
  book: 'Books',
  music: 'Recent tracks',
  event: 'Events',
};

function number(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

function label(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase();
}

function date(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: 'short', day: 'numeric',
  }).format(parsed);
}

function entryMeta(entry: MediaEntry): string {
  const details: string[] = [];
  if (entry.status) details.push(entry.status.replaceAll('_', ' '));
  if (entry.extra.artist) details.push(String(entry.extra.artist));
  else if (entry.extra.author) details.push(`by ${entry.extra.author}`);
  if (entry.extra.album) details.push(String(entry.extra.album));
  if (entry.extra.progress) details.push(`progress ${entry.extra.progress}`);
  if (entry.extra.watchedEpisodes != null && entry.extra.totalEpisodes != null) {
    details.push(`${entry.extra.watchedEpisodes}/${entry.extra.totalEpisodes} episodes`);
  }
  if (entry.extra.platform) details.push(String(entry.extra.platform));
  if (entry.extra.playtime) details.push(String(entry.extra.playtime));
  if (entry.extra.venue) details.push(String(entry.extra.venue));
  if (entry.extra.year) details.push(String(entry.extra.year));
  if (entry.rating) details.push(`★ ${entry.rating.value}/${entry.rating.scale}`);
  if (entry.activityAt) details.push(date(entry.activityAt));
  return details.map(html).join(' · ');
}

function entryCard(entry: MediaEntry): string {
  const tags = Array.isArray(entry.extra.tags)
    ? `<div class="platform-tags">${entry.extra.tags.map((tag) => `<span>${html(tag)}</span>`).join('')}</div>`
    : '';
  return `<article class="platform-entry">
    ${entry.image ? `<img src="${html(entry.image)}" alt="" loading="lazy">` : '<div class="platform-entry-placeholder" aria-hidden="true"></div>'}
    <div class="platform-entry-copy"><div class="pill">${html(entry.kind)}</div><h3>${html(entry.title)}</h3>
    <div class="platform-entry-meta">${entryMeta(entry)}</div>${tags}</div>
  </article>`;
}

function leaderboard(title: string, value: unknown): string {
  if (!Array.isArray(value) || !value.length) return '';
  const items = value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  if (!items.length) return '';
  return `<section><div class="platform-section-heading"><h2>${html(title)}</h2><span>${items.length} ranked</span></div>
    <div class="platform-leaderboard">${items.map((item, index) => `<article>
      <span class="platform-rank">${index + 1}</span>
      ${item.image ? `<img src="${html(item.image)}" alt="" loading="lazy">` : ''}
      <div><h3>${html(item.name)}</h3><p>${item.artist ? `${html(item.artist)} · ` : ''}${html(item.streams)} streams</p></div>
    </article>`).join('')}</div></section>`;
}

function platformNav(active?: string): string {
  const sources = [
    ['backloggd', 'Backloggd'],
    ['kitsu', 'Kitsu'],
    ['statsfm', 'stats.fm'],
    ['simkl', 'Simkl'],
    ['goodreads', 'Goodreads'],
    ['events', 'Manual'],
  ];
  return `<nav class="platform-nav" aria-label="Platforms"><a href="/platforms"${active ? '' : ' aria-current="page"'}>All</a>${sources.map(([source, title]) =>
    `<a href="/platforms/${source}"${active === source ? ' aria-current="page"' : ''}>${title}</a>`
  ).join('')}</nav>`;
}

export function platformIndexPage(ownerName: string, platforms: PlatformSummary[]): string {
  const cards = platforms.map(({ definition, snapshot, fetchedAt }) => {
    const profile = snapshot?.profile;
    const entryCount = snapshot?.entries.length ?? 0;
    const stats = Object.entries(snapshot?.stats ?? {}).slice(0, 3);
    return `<a class="platform-tile" href="/platforms/${html(definition.source)}" style="--platform-accent:${html(definition.accent)}">
      <div class="platform-tile-top">${profile?.avatar
        ? `<img src="${html(profile.avatar)}" alt="" loading="lazy">`
        : `<span class="platform-monogram">${html(definition.title.slice(0, 1))}</span>`}
        <div><div class="platform-eyebrow">Platform mirror</div><h2>${html(definition.title)}</h2>
        <p>${html(profile?.name ?? 'Waiting for first sync')}</p></div></div>
      <p class="platform-description">${html(definition.description)}</p>
      <div class="platform-tile-stats"><strong>${number(entryCount)}</strong> synced entries${stats.length
        ? ` · ${stats.map(([key, value]) => `${html(label(key))} ${number(value)}`).join(' · ')}`
        : ''}</div>
      <div class="platform-tile-footer">${fetchedAt ? `Synced ${html(date(fetchedAt))}` : 'Live from the infovore archive'} <span>Open →</span></div>
    </a>`;
  }).join('');
  return shell(`${ownerName} · platforms`, `${platformNav()}<section class="platform-intro"><p class="muted">A local, read-only copy of the content infovore already collects from each connected account.</p></section><main class="platform-index">${cards}</main>`);
}

export function platformPage(
  ownerName: string,
  definition: PlatformDefinition,
  snapshot: SourceSnapshot<unknown>,
  fetchedAt: string | null,
  cardVersions: Record<string, string> = {},
): string {
  const profileUrl = snapshot.profile.url || definition.url;
  const stats = Object.entries(snapshot.stats).map(([key, value]) =>
    `<div class="platform-stat"><span>${html(label(key))}</span><strong>${number(value)}</strong></div>`
  ).join('');
  const groups = [...new Set(snapshot.entries.map((entry) => entry.kind))];
  const entries = groups.map((kind) => {
    const items = snapshot.entries.filter((entry) => entry.kind === kind);
    return `<section><div class="platform-section-heading"><h2>${html(kindLabels[kind] ?? kind)}</h2><span>${items.length} entries</span></div>
      <div class="platform-entry-grid">${items.map(entryCard).join('')}</div></section>`;
  }).join('');
  const extra = (snapshot.extra && typeof snapshot.extra === 'object' ? snapshot.extra : {}) as Record<string, unknown>;
  const extras = [
    typeof extra.yearExtras === 'string' && extra.yearExtras
      ? `<div class="platform-note">${html(extra.yearExtras)}</div>`
      : '',
    leaderboard('Top albums this week', extra.topAlbums),
    leaderboard('Top artists this week', extra.topArtists),
  ].join('');
  const cards = definition.cards?.length
    ? `<section><div class="platform-section-heading"><h2>Cards</h2><span>${definition.cards.length} available</span></div>
      <div class="platform-card-grid">${definition.cards.map((name) => {
        const suffix = cardVersions[name] ? `?v=${html(cardVersions[name])}` : '';
        return `<a href="/card/${html(name)}.svg${suffix}"><img src="/card/${html(name)}.webp${suffix}" alt="${html(definition.title)} ${html(name)} card" loading="lazy"></a>`;
      }).join('')}</div></section>`
    : '';
  const body = `${platformNav(definition.source)}
    <section class="platform-hero" style="--platform-accent:${html(definition.accent)}">
      ${snapshot.profile.avatar
        ? `<img class="platform-avatar" src="${html(snapshot.profile.avatar)}" alt="" loading="eager">`
        : `<span class="platform-avatar platform-monogram">${html(definition.title.slice(0, 1))}</span>`}
      <div><div class="platform-eyebrow">infovore mirror · ${html(definition.title)}</div>
      <h2>${html(snapshot.profile.name || ownerName)}</h2><p>${html(definition.description)}</p>
      <div class="platform-actions">${profileUrl ? `<a href="${html(profileUrl)}">View original ↗</a>` : ''}
      <a href="/api/activities.json?source=${html(definition.source)}">JSON</a></div></div>
      <div class="platform-freshness">${fetchedAt ? `Last synced ${html(date(fetchedAt))}` : 'Stored manually'}</div>
    </section>${cards}
    <section><div class="platform-section-heading"><h2>Overview</h2><span>${snapshot.entries.length} synced entries</span></div>
    <div class="platform-stats">${stats}</div></section>${extras}${entries || '<div class="empty">Nothing has been collected from this platform yet.</div>'}`;
  return shell(`${definition.title} · ${snapshot.profile.name}`, body);
}
