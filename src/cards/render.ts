import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
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
export function logo(name: 'backloggd' | 'kitsu' | 'statsfm' | 'simkl' | 'goodreads'): string {
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

// Remote images inlined as data URIs so each SVG is self-contained.
// Called once per refresh cycle, not per request.
export async function toDataUri(url: string, attempt = 0): Promise<string> {
  if (!url) return '';
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
