import { dateFormat } from '../data/time.js';
import type { KitsuLibrary, KitsuLibraryEntry } from '../sources/kitsu.js';
import { html } from './pages.js';

const CURRENT_PREVIEW = 7;
const date = dateFormat('en', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'short', day: 'numeric' });
type ProgressUnit = 'episode' | 'chapter';

function heading(title: string, count: number, unit: string): string {
  return `<div class="platform-section-heading"><h2>${html(title)}</h2><span>${count} ${html(unit)}</span></div>`;
}

function progress(entry: KitsuLibraryEntry, unit: ProgressUnit): string {
  const count = entry.total || entry.progress;
  const amount = entry.total ? `${entry.progress}/${entry.total}` : entry.progress;
  return `${amount} ${unit}${count === 1 ? '' : 's'}`;
}

function rating(entry: KitsuLibraryEntry): string {
  return entry.rating ? `★ ${entry.rating.value}/${entry.rating.scale}` : '';
}

function recentFirst(entries: KitsuLibraryEntry[], planned = false): KitsuLibraryEntry[] {
  const timestamp = (entry: KitsuLibraryEntry) => Date.parse((planned ? entry.addedAt : entry.progressedAt ?? entry.addedAt) ?? '') || 0;
  return [...entries].sort((a, b) => timestamp(b) - timestamp(a));
}

function tiles(entries: KitsuLibraryEntry[], unit: ProgressUnit): string {
  return `<div class="library-tiles">${entries.map((entry) => {
    const poster = entry.image
      ? `<img src="${html(entry.image)}" alt="" loading="lazy">`
      : '<span class="library-nocover" aria-hidden="true"></span>';
    const meta = [progress(entry, unit), rating(entry)].filter(Boolean).join(' · ');
    const content = `${poster}<strong>${html(entry.title)}</strong><span class="kitsu-tile-meta">${html(meta)}</span>`;
    return entry.url
      ? `<a class="library-tile" href="${html(entry.url)}">${content}</a>`
      : `<div class="library-tile">${content}</div>`;
  }).join('')}</div>`;
}

function current(entries: KitsuLibraryEntry[], title: string, kind: keyof KitsuLibrary, unit: ProgressUnit): string {
  const items = recentFirst(entries.filter((entry) => entry.status === 'current'));
  if (!items.length) return '';
  const more = items.slice(CURRENT_PREVIEW);
  return `<section>${heading(title, items.length, kind)}${tiles(items.slice(0, CURRENT_PREVIEW), unit)}
    ${more.length ? `<details class="library-fold"><summary>Show ${more.length} more ${kind}</summary>${tiles(more, unit)}</details>` : ''}</section>`;
}

function archive(entries: KitsuLibraryEntry[], kind: keyof KitsuLibrary, unit: ProgressUnit): string {
  if (!entries.length) return '';
  const groups = [
    { status: 'planned', label: kind === 'anime' ? 'Plan to watch' : 'Plan to read' },
    { status: 'completed', label: 'Completed' },
    { status: 'on_hold', label: 'On hold' },
    { status: 'dropped', label: 'Dropped' },
  ];
  const title = kind === 'anime' ? 'Anime' : 'Manga';
  return `<section id="${kind}-library">${heading(`${title} library`, entries.length, kind)}
    ${groups.map(({ status, label }) => {
      const planned = status === 'planned';
      const items = recentFirst(entries.filter((entry) => entry.status === status), planned);
      if (!items.length) return '';
      const rows = items.map((entry) => {
        const cover = entry.thumbnail
          ? `<img class="library-thumb" src="${html(entry.thumbnail)}" alt="" loading="lazy">`
          : '<span class="library-thumb" aria-hidden="true"></span>';
        const name = entry.url ? `<a href="${html(entry.url)}">${html(entry.title)}</a>` : html(entry.title);
        const at = Date.parse((planned ? entry.addedAt : entry.progressedAt) ?? '');
        return `<tr><td class="library-title">${cover}${name}</td>
          <td class="num">${html(entry.progress || entry.total ? progress(entry, unit) : '—')}</td>
          <td class="num">${html(rating(entry) || '—')}</td><td class="num">${Number.isNaN(at) ? '—' : html(date.format(at))}</td></tr>`;
      }).join('');
      return `<details class="library-fold"><summary>${html(label)} · ${items.length}</summary><div class="time-table-wrap">
        <table class="library-table" aria-label="${html(label)} · ${kind}"><thead><tr><th scope="col">Title</th><th scope="col">Progress</th>
        <th scope="col">Rating</th><th scope="col">${planned ? 'Added' : 'Last progress'}</th></tr></thead><tbody>${rows}</tbody></table>
        </div></details>`;
    }).join('')}</section>`;
}

export function kitsuShowboard(library: KitsuLibrary, recent: string): string {
  if (!library.anime.length && !library.manga.length) {
    return '<div class="empty">No public anime or manga entries yet.</div>';
  }
  return `${current(library.anime, 'Watching', 'anime', 'episode')}${current(library.manga, 'Reading', 'manga', 'chapter')}
    ${archive(library.anime, 'anime', 'episode')}${archive(library.manga, 'manga', 'chapter')}
    <div class="platform-note"><a href="/api/kitsu.json">Kitsu library JSON</a></div>${recent}`;
}
