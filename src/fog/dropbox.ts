import type { FogStore } from './store.js';
import { tileOfFilename } from './tiles.js';

// Mirrors Fog of World's Dropbox sync folder into the fog_tiles table. Uses a
// Dropbox app with read-only scopes (files.metadata.read, files.content.read)
// and an offline refresh token; nothing is ever written to Dropbox. Each run
// lists the folder (a few hundred small files at most), downloads the files
// whose revision changed and forgets the ones Fog of World removed.

export interface FogDropboxConfig {
  appKey: string;
  appSecret: string;
  refreshToken: string;
  path: string;
  intervalMinutes: number;
}

type Fetch = typeof fetch;

interface Entry { '.tag': string; name: string; rev?: string; path_lower?: string }

export class DropboxError extends Error {}

async function dropboxJson<T>(fetcher: Fetch, url: string, token: string, body: unknown): Promise<T> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new DropboxError(`Dropbox ${new URL(url).pathname} HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

export async function accessToken(config: FogDropboxConfig, fetcher: Fetch = fetch): Promise<string> {
  const response = await fetcher('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.appKey}:${config.appSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: config.refreshToken }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (!response.ok || !body.access_token) throw new DropboxError(`Dropbox token refresh failed (HTTP ${response.status}${body.error ? `, ${body.error}` : ''})`);
  return body.access_token;
}

/** One sync run. Returns what changed; throws (after recording the error) on failure. */
export async function syncFog(store: FogStore, config: FogDropboxConfig, fetcher: Fetch = fetch, now = () => new Date().toISOString()):
  Promise<{ downloaded: number; removed: number; tiles: number }> {
  try {
    const token = await accessToken(config, fetcher);
    const entries: Entry[] = [];
    let page = await dropboxJson<{ entries: Entry[]; cursor: string; has_more: boolean }>(fetcher,
      'https://api.dropboxapi.com/2/files/list_folder', token, { path: config.path, limit: 2000 });
    entries.push(...page.entries);
    while (page.has_more) {
      page = await dropboxJson(fetcher, 'https://api.dropboxapi.com/2/files/list_folder/continue', token, { cursor: page.cursor });
      entries.push(...page.entries);
    }
    const files = entries.filter((entry) => entry['.tag'] === 'file' && entry.rev && tileOfFilename(entry.name));
    const known = store.revisions();
    let downloaded = 0;
    for (const file of files) {
      if (known.get(file.name) === file.rev) continue;
      const response = await fetcher('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          // By revision: header values must be ASCII, and the folder name may not be (應用程式).
          'Dropbox-API-Arg': JSON.stringify({ path: `rev:${file.rev}` }),
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new DropboxError(`Dropbox download of ${file.name} HTTP ${response.status}`);
      store.put(file.name, file.rev!, new Uint8Array(await response.arrayBuffer()), now());
      downloaded++;
    }
    const present = new Set(files.map((file) => file.name));
    let removed = 0;
    for (const name of known.keys()) {
      if (!present.has(name)) {
        store.remove(name);
        removed++;
      }
    }
    store.recordSync({ at: now(), changed: downloaded + removed > 0 });
    return { downloaded, removed, tiles: files.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.recordSync({ at: now(), changed: false, error: message.slice(0, 300) });
    throw error;
  }
}

/** Syncs now and then every [FogDropboxConfig.intervalMinutes]. Failures are logged and retried next time. */
export function startFogSync(store: FogStore, config: FogDropboxConfig): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await syncFog(store, config);
      if (result.downloaded || result.removed) console.log(`fog sync: ${result.downloaded} downloaded, ${result.removed} removed, ${result.tiles} tiles`);
    } catch (error) {
      console.error(`fog sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, config.intervalMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
