/** Bounds retained encoded card bytes; active encoders and other app memory are separate. */
export class RasterCache {
  private readonly entries = new Map<string, Buffer>();
  private retainedBytes = 0;

  constructor(private readonly maxBytes = 32 * 1024 * 1024, private readonly maxEntries = 64) {
    for (const limit of [maxBytes, maxEntries]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Invalid raster cache limit');
    }
  }

  get size(): number { return this.entries.size; }
  get byteLength(): number { return this.retainedBytes; }

  get(key: string): Buffer | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: Buffer): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.retainedBytes -= previous.byteLength;
    }
    // Serve an oversized encoding normally without retaining it or evicting other cards.
    if (value.byteLength > this.maxBytes) return;
    while (this.entries.size >= this.maxEntries || this.retainedBytes + value.byteLength > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.retainedBytes -= this.entries.get(oldest)!.byteLength;
      this.entries.delete(oldest);
    }
    this.entries.set(key, value);
    this.retainedBytes += value.byteLength;
  }
}
