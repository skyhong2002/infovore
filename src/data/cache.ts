export interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
  error?: string;
}

const store = new Map<string, CacheEntry<unknown>>();

export function setCache<T>(key: string, data: T): void {
  store.set(key, { data, fetchedAt: Date.now() });
}

export function restoreCache<T>(key: string, data: T, fetchedAt: number, error?: string): void {
  store.set(key, { data, fetchedAt, ...(error ? { error } : {}) });
}

export function setCacheError(key: string, error: string): void {
  const prev = store.get(key);
  // Keep stale data if we have it; only record the error.
  store.set(key, {
    data: prev?.data ?? null,
    fetchedAt: prev?.fetchedAt ?? Date.now(),
    error,
  });
}

export function getCache<T>(key: string): CacheEntry<T> | undefined {
  return store.get(key) as CacheEntry<T> | undefined;
}
