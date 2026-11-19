import type { BackloggdLibrary, LibraryGame } from '../backloggd/library.js';
import { html } from './pages.js';

const REVIEW_PREVIEW = 280;

const stars = (rating: number | null) => (rating === null ? '' : `★ ${rating}`);
const gameUrl = (slug: string) => `https://backloggd.com/games/${encodeURIComponent(slug)}/`;
const link = (slug: string, title: string) => `<a href="${html(gameUrl(slug))}">${html(title)}</a>`;

function playtime(minutes: number): string {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  return h ? `${h}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
}

function heading(title: string, note: string): string {
  return `<div class="platform-section-heading"><h2>${html(title)}</h2><span>${html(note)}</span></div>`;
}

// Covers are hotlinked from IGDB (never stored here). Thumbnails use IGDB's
// small size; other hosts are left as they are.
const thumb = (cover: string) => cover.replace('/t_cover_big/', '/t_cover_small/');

function tiles(games: LibraryGame[]): string {
  return `<div class="library-tiles">${games.map((g) => `<a class="library-tile" href="${html(gameUrl(g.slug))}" title="${html(g.title)}">${
    g.cover ? `<img src="${html(g.cover)}" alt="" loading="lazy">` : '<span class="library-nocover" aria-hidden="true"></span>'}<span>${html(g.title)}</span></a>`).join('')}</div>`;
}

function reviewBlock(review: BackloggdLibrary['reviews'][number], cover: string): string {
  const meta = [stars(review.rating), review.status, review.platform, review.date, review.likes ? `${review.likes} likes` : '']
    .filter(Boolean).map(html).join(' · ');
  const body = review.text.length > REVIEW_PREVIEW
    ? `<details><summary>${html(review.text.slice(0, REVIEW_PREVIEW).trimEnd())}…</summary><p>${html(review.text.slice(REVIEW_PREVIEW))}</p></details>`
    : `<p>${html(review.text)}</p>`;
  return `<article class="bl-review">${cover ? `<img class="bl-review-cover" src="${html(thumb(cover))}" alt="" loading="lazy">` : ''}<div><h3>${link(review.slug, review.title)}</h3><div class="bl-meta">${meta}</div>${body}</div></article>`;
}

// Everything Backloggd holds for the account, below the recent-games grid.
// Long sections collapse so the page stays scannable.
export function backloggdLibrarySection(library: BackloggdLibrary | null): string {
  if (!library) return '';
  const { games, reviews, lists } = library;
  const covers = new Map([...games.played, ...games.playing, ...games.backlog, ...games.wishlist].map((g) => [g.slug, g.cover]));
  const played = games.played.map((g) => `<tr>
      <td class="library-title">${g.cover ? `<img class="library-thumb" src="${html(thumb(g.cover))}" alt="" loading="lazy">` : '<span class="library-thumb"></span>'}${link(g.slug, g.title)}</td><td>${html(stars(g.rating))}</td><td>${html(g.status)}</td>
      <td class="num">${html(playtime(g.timeMinutes))}</td><td class="num">${html(g.lastPlayed)}</td><td>${html(g.platforms.join(', '))}</td></tr>`).join('');
  return `${games.playing.length ? `<section>${heading('Playing', `${games.playing.length} games`)}${tiles(games.playing)}</section>` : ''}
    ${reviews.length ? `<section>${heading('Reviews', `${reviews.length} written`)}<details class="library-fold" open><summary>Show all ${reviews.length}</summary>${reviews.map((r) => reviewBlock(r, covers.get(r.slug) ?? '')).join('')}</details></section>` : ''}
    ${games.backlog.length ? `<section>${heading('Backlog', `${games.backlog.length} games`)}<details class="library-fold"><summary>Show all ${games.backlog.length}</summary>${tiles(games.backlog)}</details></section>` : ''}
    ${games.wishlist.length ? `<section>${heading('Wishlist', `${games.wishlist.length} games`)}<details class="library-fold"><summary>Show all ${games.wishlist.length}</summary>${tiles(games.wishlist)}</details></section>` : ''}
    ${lists.length ? `<section>${heading('Lists', `${lists.length} lists`)}${lists.map((l) => `<details class="library-fold"><summary>${html(l.name)} · ${l.games.length} games</summary><ol class="bl-list">${l.games.map((g) => `<li>${link(g.slug, g.title)}</li>`).join('')}</ol></details>`).join('')}</section>` : ''}
    ${games.played.length ? `<section>${heading('Played library', `${games.played.length} games · includes DLC and updates`)}<details class="library-fold"><summary>Show all ${games.played.length}</summary>
      <div class="time-table-wrap"><table class="library-table"><thead><tr><th>Game</th><th>Rating</th><th>Status</th><th>Time</th><th>Last played</th><th>Platform</th></tr></thead><tbody>${played}</tbody></table></div></details></section>` : ''}
    <div class="platform-note">Synced ${html(library.syncedAt?.slice(0, 10) ?? '')} from Backloggd's public profile. The full data is at <a href="/api/backloggd/library.json">/api/backloggd/library.json</a>.</div>`;
}
