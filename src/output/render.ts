import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import encodeWebp, { init as initWebp } from '@jsquash/webp/encode.js';
import { simd } from 'wasm-feature-detect';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const assetDir = fileURLToPath(new URL('../../assets/', import.meta.url));

function font(file: string): Buffer {
  return readFileSync(assetDir + 'fonts/' + file);
}

const fonts = [
  { name: 'Inter', data: font('Inter-Regular.ttf'), weight: 400 as const, style: 'normal' as const },
  { name: 'Inter', data: font('Inter-Bold.ttf'), weight: 700 as const, style: 'normal' as const },
  { name: 'Roboto', data: font('Roboto-Regular.ttf'), weight: 400 as const, style: 'normal' as const },
  { name: 'Roboto', data: font('Roboto-Bold.ttf'), weight: 700 as const, style: 'normal' as const },
  { name: 'Open Sans', data: font('OpenSans-Regular.ttf'), weight: 400 as const, style: 'normal' as const },
  { name: 'Open Sans', data: font('OpenSans-Bold.ttf'), weight: 700 as const, style: 'normal' as const },
  { name: 'Statsfm Sans', data: font('StatsfmSans-Regular.ttf'), weight: 400 as const, style: 'normal' as const },
  { name: 'Statsfm Sans', data: font('StatsfmSans-Bold.ttf'), weight: 700 as const, style: 'normal' as const },
  { name: 'Merriweather', data: font('Merriweather-Regular.woff'), weight: 400 as const, style: 'normal' as const },
  { name: 'Merriweather', data: font('Merriweather-Bold.woff'), weight: 700 as const, style: 'normal' as const },
  // CJK fallback for Japanese/Chinese titles.
  { name: 'Noto Sans JP', data: font('NotoSansJP-Regular.otf'), weight: 400 as const, style: 'normal' as const },
  { name: 'Noto Sans JP', data: font('NotoSansJP-Bold.otf'), weight: 700 as const, style: 'normal' as const },
  { name: 'Noto Sans TC', data: font('NotoSansTC-Regular.otf'), weight: 400 as const, style: 'normal' as const },
  { name: 'Noto Sans TC', data: font('NotoSansTC-Bold.otf'), weight: 700 as const, style: 'normal' as const },
];

// Platform logos shipped in-repo, inlined as data URIs.
const logoCache = new Map<string, string>();
export function logo(name: 'backloggd' | 'kitsu' | 'statsfm' | 'simkl' | 'goodreads' | 'urtube' | 'healthconnect' | 'dayflow'): string {
  let uri = logoCache.get(name);
  if (!uri) {
    const buf = readFileSync(`${assetDir}logos/${name}.png`);
    uri = `data:image/png;base64,${buf.toString('base64')}`;
    logoCache.set(name, uri);
  }
  return uri;
}

// Minimal element helper — satori accepts React-shaped plain objects,
// so we skip JSX entirely.
export function h(
  type: string,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): Record<string, unknown> {
  return {
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  };
}

// Covers/posters are inlined at full CDN resolution but only displayed at
// ~84px, bloating each card SVG to megabytes. Rewrite known CDN URLs to a
// modestly-sized variant (~256-300px, crisp at 2× on the tile) before fetching.
export function shrinkImage(url: string): string {
  return url
    // Apple Music artwork: .../768x768bb.jpg → 256px
    .replace(/\/\d+x\d+bb\.jpg/, '/256x256bb.jpg')
    // Spotify artwork: ab67616d0000b273 (640px) → ab67616d00001e02 (300px)
    .replace(/(i\.scdn\.co\/image\/ab67616d)0000b273/, '$100001e02')
    // IGDB game covers: t_cover_big / t_cover_big_2x → t_cover_med (264px)
    .replace(/\/t_cover_big(_2x)?\//, '/t_cover_med/')
    // Goodreads/Amazon covers: ._SX318_ / ._SY475_ → 160px wide
    .replace(/\._S[XY]\d+_\.jpg/, '._SX160_.jpg');
}

// Remote images inlined as data URIs so each SVG is self-contained.
// Called once per refresh cycle, not per request.
export async function toDataUri(rawUrl: string, attempt = 0): Promise<string> {
  if (!rawUrl) return '';
  const url = shrinkImage(rawUrl);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return attempt < 1 ? toDataUri(url, attempt + 1) : '';
    const buf = Buffer.from(await res.arrayBuffer());
    // Sniff the real type — some CDNs answer with binary/octet-stream,
    // which satori refuses to size.
    let type = 'image/jpeg';
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      type = 'image/png';
    } else if (buf.subarray(0, 4).toString('ascii') === 'GIF8') {
      type = 'image/gif';
    } else if (buf.subarray(8, 12).toString('ascii') === 'WEBP') {
      return ''; // satori can't render webp
    }
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    if (attempt < 1) return toDataUri(url, attempt + 1);
    return '';
  }
}

// Width-aware truncation: CJK glyphs are roughly twice as wide as Latin
// ones, so they count double against the budget.
export function truncate(s: string, max: number): string {
  let width = 0;
  for (let i = 0; i < s.length; i++) {
    width += /[⺀-鿿豈-﫿＀-￯　-〿]/.test(s[i]) ? 2 : 1;
    if (width > max) return s.slice(0, i).trimEnd() + '…';
  }
  return s;
}

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

// Max lines a wrapped tile title may occupy before it's clamped with an
// ellipsis. Pair with `display: 'block'` + `lineClamp: MAX_TITLE_LINES` on the
// title span (satori's line-clamp path).
export const MAX_TITLE_LINES = 5;

// CJK-weighted display length (CJK glyphs count as 2, matching `truncate`).
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += CJK.test(ch) ? 2 : 1;
  return w;
}

// Scale a tile title's font size down as it gets longer so most titles stay
// ~2-3 lines and only genuinely long ones shrink. Height is absorbed by the
// auto-trim in renderCard; a line clamp caps the pathological cases.
export function titleFontSize(text: string, base = 11, min = 8): number {
  const w = displayWidth(text);
  if (w <= 26) return base;
  if (w <= 40) return base - 1;
  if (w <= 58) return base - 2;
  return min;
}

// Satori assigns a font per whitespace-delimited word based on its first
// character, so a Latin-prefixed word like "TVアニメ" gets the brand font
// (which lacks kana) and the CJK tofus out. When a string contains any CJK,
// put the Noto CJK fonts first — Noto also covers Latin, so the whole run
// renders. Pure-Latin strings keep the brand font.
export function textFont(text: string, brand: string): string {
  return CJK.test(text) ? `"Noto Sans JP", "Noto Sans TC", ${brand}` : brand;
}

export function timeAgo(iso: string): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// Bottom padding (px) left below the last rendered content when auto-trimming.
const BOTTOM_PAD = 22;

// Find the last row (from the top) that contains non-background content,
// ignoring the card's rounded border frame. Cards are laid out top-anchored,
// so everything below this row is empty background we can trim away.
function contentBottom(pixels: Buffer, width: number, height: number): number {
  const at = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2]] as const;
  };
  const bg = at(width >> 1, height - 4); // empty background near the bottom
  const frame = 16; // skip the border band on every edge
  const differs = (x: number, y: number) => {
    const [r, g, b] = at(x, y);
    return Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 30;
  };
  for (let y = height - frame; y >= frame; y--) {
    for (let x = frame; x < width - frame; x += 2) {
      if (differs(x, y)) return y;
    }
  }
  return height;
}

// Render the card, then trim any empty space below the content so every card
// ends a consistent BOTTOM_PAD below its last row regardless of how many
// lines the data produced. `height` is treated as a generous upper bound.
export async function renderCard(
  node: Record<string, unknown>,
  width: number,
  height: number
): Promise<string> {
  const draftHeight = height + 240; // headroom so nothing is clipped pre-trim (wrapped titles can add several lines)
  const draft = await satori(node as never, { width, height: draftHeight, fonts });
  const img = new Resvg(draft).render();
  const bottom = contentBottom(Buffer.from(img.pixels), img.width, img.height);
  const trimmed = Math.min(draftHeight, bottom + BOTTOM_PAD);
  return satori(node as never, { width, height: trimmed, fonts });
}

// Lazily compile the WebP encoder's wasm once (its default fetch()-based
// loader doesn't work under Node).
let webpReady: Promise<unknown> | null = null;
function ensureWebp(): Promise<unknown> {
  if (!webpReady) {
    webpReady = simd().then(async (useSimd) => {
      const file = useSimd ? 'webp_enc_simd.wasm' : 'webp_enc.wasm';
      const path = fileURLToPath(new URL(`../../node_modules/@jsquash/webp/codec/enc/${file}`, import.meta.url));
      return initWebp(await WebAssembly.compile(readFileSync(path)));
    });
  }
  return webpReady;
}

// WebAssembly is a Node/V8 global but isn't in the ES2022 lib types.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<unknown> };

export type RasterFormat = 'png' | 'webp';

// Rasterize a card SVG to PNG or WebP at `scale`× the card's native width.
export async function rasterize(svg: string, format: RasterFormat, scale = 2): Promise<Buffer> {
  const width = 520 * scale;
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
  if (format === 'png') return Buffer.from(img.asPng());
  await ensureWebp();
  const data = new Uint8ClampedArray(img.pixels.buffer, img.pixels.byteOffset, img.pixels.byteLength);
  const webp = await encodeWebp({ data, width: img.width, height: img.height }, { quality: 82 });
  return Buffer.from(webp);
}
