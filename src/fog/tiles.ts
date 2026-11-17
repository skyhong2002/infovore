import { deflateSync, inflateSync } from 'node:zlib';

// Fog of World's sync format, as documented by fog-machine
// (github.com/CaviarChen/fog-machine, editor/src/utils/FowTile.ts):
//
// - The world (Web Mercator) is 512 × 512 tiles; one file per tile with any
//   exploration. The tile id (y * 512 + x) is in the file name: 4 hash
//   characters, the id's digits through FILENAME_MASK, and 2 more characters.
// - A file is zlib data: a header of 128 × 128 little-endian u16 (0 = empty,
//   n = the n-th block record), then 515-byte block records.
// - A block is 64 × 64 pixels: a 512-byte bitmap (row-major, 8 bytes a row,
//   most significant bit first) and 3 bytes whose last 14 bits hold
//   (explored count << 1) + 1, a checksum of the bitmap.
//
// So the world is 2^22 pixels wide; one pixel is about 9.6 m at the equator.

const FILENAME_MASK = 'olhwjsktri';
export const MAP_TILES = 512;
export const TILE_BLOCKS = 128;
export const BLOCK_PIXELS = 64;
const HEADER_SIZE = TILE_BLOCKS * TILE_BLOCKS * 2;
const BITMAP_SIZE = 512;
const BLOCK_SIZE = BITMAP_SIZE + 3;
export const WORLD_PIXELS = MAP_TILES * TILE_BLOCKS * BLOCK_PIXELS; // 2^22
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

export interface FogBlock {
  /** Block position inside its tile, 0–127. */
  x: number;
  y: number;
  bitmap: Uint8Array;
  explored: number;
}

export interface FogTile {
  x: number;
  y: number;
  blocks: FogBlock[];
}

/** The tile a sync file describes, or null for a name that is not a tile file. */
export function tileOfFilename(name: string): { id: number; x: number; y: number } | null {
  const digits = name.slice(4, -2);
  if (name.length < 7 || !digits || [...digits].some((c) => !FILENAME_MASK.includes(c))) return null;
  const id = Number([...digits].map((c) => FILENAME_MASK.indexOf(c)).join(''));
  if (!Number.isSafeInteger(id) || id >= MAP_TILES * MAP_TILES) return null;
  return { id, x: id % MAP_TILES, y: Math.floor(id / MAP_TILES) };
}

const popcount = (byte: number) => {
  let n = byte;
  n -= (n >> 1) & 0x55;
  n = (n & 0x33) + ((n >> 2) & 0x33);
  return (n + (n >> 4)) & 0x0f;
};

/**
 * Decodes one sync file. Throws on data that is not a Fog of World tile:
 * a header pointing past the data, or a block whose bitmap disagrees with its checksum.
 */
export function parseTile(name: string, compressed: Uint8Array): FogTile {
  const tile = tileOfFilename(name);
  if (!tile) throw new Error(`not a Fog of World tile file: ${name}`);
  const data = inflateSync(compressed);
  if (data.length < HEADER_SIZE) throw new Error(`tile ${name} is too short`);
  const blocks: FogBlock[] = [];
  for (let i = 0; i < TILE_BLOCKS * TILE_BLOCKS; i++) {
    const index = data.readUInt16LE(i * 2);
    if (index === 0) continue;
    const start = HEADER_SIZE + (index - 1) * BLOCK_SIZE;
    if (start + BLOCK_SIZE > data.length) throw new Error(`tile ${name} block ${i} is out of range`);
    const bitmap = new Uint8Array(data.subarray(start, start + BITMAP_SIZE));
    let explored = 0;
    for (const byte of bitmap) explored += popcount(byte);
    const checksum = (data.readUInt16BE(start + BITMAP_SIZE + 1) & 0x3fff) >> 1;
    if (checksum !== explored) throw new Error(`tile ${name} block ${i} fails its checksum`);
    blocks.push({ x: i % TILE_BLOCKS, y: Math.floor(i / TILE_BLOCKS), bitmap, explored });
  }
  return { x: tile.x, y: tile.y, blocks };
}

/** The inverse of [parseTile], for tests: a tile file with the given explored global pixels. */
export function encodeTile(tileX: number, tileY: number, pixels: Array<[number, number]>): { name: string; data: Buffer } {
  const id = tileY * MAP_TILES + tileX;
  const name = 'test' + [...String(id)].map((d) => FILENAME_MASK[Number(d)]).join('') + 'zz';
  const blocks = new Map<number, Uint8Array>();
  for (const [gx, gy] of pixels) {
    const lx = gx - tileX * TILE_BLOCKS * BLOCK_PIXELS;
    const ly = gy - tileY * TILE_BLOCKS * BLOCK_PIXELS;
    const key = Math.floor(ly / BLOCK_PIXELS) * TILE_BLOCKS + Math.floor(lx / BLOCK_PIXELS);
    const bitmap = blocks.get(key) ?? new Uint8Array(BITMAP_SIZE);
    const px = lx % BLOCK_PIXELS;
    const py = ly % BLOCK_PIXELS;
    bitmap[Math.floor(px / 8) + py * 8] |= 1 << (7 - (px % 8));
    blocks.set(key, bitmap);
  }
  const keys = [...blocks.keys()].sort((a, b) => a - b);
  const out = Buffer.alloc(HEADER_SIZE + keys.length * BLOCK_SIZE);
  keys.forEach((key, n) => {
    out.writeUInt16LE(n + 1, key * 2);
    const bitmap = blocks.get(key)!;
    const start = HEADER_SIZE + n * BLOCK_SIZE;
    out.set(bitmap, start);
    let explored = 0;
    for (const byte of bitmap) explored += popcount(byte);
    out.writeUInt16BE(((explored << 1) + 1) & 0x3fff, start + BITMAP_SIZE + 1);
  });
  return { name, data: deflateSync(out) };
}

/** Explored area in km²: each pixel's ground size shrinks with cos(latitude). */
export function exploredKm2(tiles: Iterable<FogTile>): number {
  let m2 = 0;
  for (const tile of tiles) {
    for (const block of tile.blocks) {
      const gy = ((tile.y * TILE_BLOCKS) + block.y) * BLOCK_PIXELS + BLOCK_PIXELS / 2;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / WORLD_PIXELS)));
      const side = (EARTH_CIRCUMFERENCE_M * Math.cos(lat)) / WORLD_PIXELS;
      m2 += block.explored * side * side;
    }
  }
  return m2 / 1e6;
}

export const FOG_COLOR = [17, 24, 39, 150] as const;

/**
 * One 256 × 256 slippy-map tile (z/x/y) of the fog: covered where unexplored,
 * transparent where explored. Below zoom 14 a map pixel spans several fog
 * pixels and counts as explored when any of them is.
 */
export function renderFogRgba(tiles: ReadonlyMap<string, FogTile>, z: number, tx: number, ty: number): Uint8Array {
  const size = 256;
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set(FOG_COLOR, i);
  // Fog pixels per map pixel (a power of two; below 1 past zoom 14).
  const scale = WORLD_PIXELS / (size * 2 ** z);
  const x0 = tx * size * scale;
  const y0 = ty * size * scale;
  const span = size * scale;
  const tilePixels = TILE_BLOCKS * BLOCK_PIXELS;
  const clear = (px: number, py: number, w: number, h: number) => {
    const left = Math.max(0, Math.floor(px));
    const top = Math.max(0, Math.floor(py));
    const right = Math.min(size, Math.ceil(px + w));
    const bottom = Math.min(size, Math.ceil(py + h));
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) rgba[(y * size + x) * 4 + 3] = 0;
  };
  const firstTileX = Math.floor(x0 / tilePixels);
  const lastTileX = Math.floor((x0 + span - 1) / tilePixels);
  const firstTileY = Math.floor(y0 / tilePixels);
  const lastTileY = Math.floor((y0 + span - 1) / tilePixels);
  for (let fy = firstTileY; fy <= lastTileY; fy++) {
    for (let fx = firstTileX; fx <= lastTileX; fx++) {
      const tile = tiles.get(`${fx},${fy}`);
      if (!tile) continue;
      for (const block of tile.blocks) {
        const bx = fx * tilePixels + block.x * BLOCK_PIXELS;
        const by = fy * tilePixels + block.y * BLOCK_PIXELS;
        if (bx + BLOCK_PIXELS <= x0 || bx >= x0 + span || by + BLOCK_PIXELS <= y0 || by >= y0 + span) continue;
        const bitmap = block.bitmap;
        for (let row = 0; row < BLOCK_PIXELS; row++) {
          for (let col8 = 0; col8 < 8; col8++) {
            const byte = bitmap[col8 + row * 8];
            if (byte === 0) continue;
            for (let bit = 0; bit < 8; bit++) {
              if ((byte & (0x80 >> bit)) === 0) continue;
              const gx = bx + col8 * 8 + bit;
              const gy = by + row;
              if (scale >= 1) {
                const px = Math.floor((gx - x0) / scale);
                const py = Math.floor((gy - y0) / scale);
                if (px >= 0 && px < size && py >= 0 && py < size) rgba[(py * size + px) * 4 + 3] = 0;
              } else {
                clear((gx - x0) / scale, (gy - y0) / scale, 1 / scale, 1 / scale);
              }
            }
          }
        }
      }
    }
  }
  return rgba;
}

/**
 * Clears (shows as explored) every map pixel within the given circles, so the
 * public map draws no detail there: a privacy zone reads like the rest of a
 * well-walked city instead of outlining the paths to a door.
 */
export function clearZonesRgba(rgba: Uint8Array, z: number, tx: number, ty: number,
  zones: ReadonlyArray<{ lat: number; lng: number; radiusM: number }>): void {
  const size = 256;
  const world = size * 2 ** z;
  for (const zone of zones) {
    const cx = ((zone.lng + 180) / 360) * world - tx * size;
    const latRad = (zone.lat * Math.PI) / 180;
    const cy = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * world - ty * size;
    const r = zone.radiusM / ((EARTH_CIRCUMFERENCE_M * Math.cos(latRad)) / world);
    const top = Math.max(0, Math.floor(cy - r));
    const bottom = Math.min(size - 1, Math.ceil(cy + r));
    const left = Math.max(0, Math.floor(cx - r));
    const right = Math.min(size - 1, Math.ceil(cx + r));
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) rgba[(y * size + x) * 4 + 3] = 0;
      }
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A minimal RGBA PNG encoder (filter 0 rows), enough for the fog tiles. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
