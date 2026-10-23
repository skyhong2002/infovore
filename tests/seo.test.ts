import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { load } from 'cheerio';
import { app } from '../src/index.js';
import { startGateway } from '../src/gateway.js';
import { publicBaseUrl, robotsTxt } from '../src/seo.js';

const base = 'http://localhost:3000';

async function head(path: string) {
  const response = await app.request(path);
  assert.equal(response.status, 200, path);
  const $ = load(await response.text());
  return { canonical: $('link[rel=canonical]').attr('href'), robots: $('meta[name=robots]').attr('content'), ogUrl: $('meta[property="og:url"]').attr('content') };
}

test('stable public pages name themselves canonical on the public base URL, without query strings', async () => {
  const year = new Date().getUTCFullYear();
  for (const path of ['/', '/now', '/stats', '/platforms', '/platforms/events', '/profile', '/cards', `/wrapped/${year}`, '/api']) {
    const meta = await head(path);
    assert.equal(meta.canonical, `${base}${path}`, path);
    assert.equal(meta.ogUrl, `${base}${path}`, path);
    assert.equal(meta.robots, undefined, path);
  }
  assert.equal((await head('/now?utm_source=x')).canonical, `${base}/now`);
});

test('search result pages are not indexed and claim no canonical', async () => {
  const meta = await head('/search?q=anything');
  assert.equal(meta.canonical, undefined);
  assert.equal(meta.robots, 'noindex, follow');
});

test('sitemap lists only stable public pages, each serving 200 with a matching canonical', async () => {
  const response = await app.request('/sitemap.xml');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/xml/);
  const body = await response.text();
  assert.match(body, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  const urls = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
  assert.equal(new Set(urls).size, urls.length);
  for (const path of ['/', '/now', '/stats', '/platforms', '/profile', '/cards']) assert.ok(urls.includes(`${base}${path}`), path);
  for (const url of urls) {
    assert.ok(url.startsWith(`${base}/`), url);
    const path = url.slice(base.length);
    assert.doesNotMatch(path, /^\/(api|mcp|search|card\/|feed|status|healthz)|\?/, path);
    assert.equal((await head(path)).canonical, url);
  }
});

test('robots.txt comes from gateway memory, even before the backend is ready, and points at the sitemap', async (t) => {
  const robots = robotsTxt(publicBaseUrl({ DOMAIN: 'infovore.example' }));
  assert.equal(robots, 'User-agent: *\nDisallow: /api/\nDisallow: /mcp\n\nSitemap: https://infovore.example/sitemap.xml\n');
  assert.equal(publicBaseUrl({ PUBLIC_BASE_URL: 'https://a.example/', DOMAIN: 'b.example' }), 'https://a.example');
  const gateway = startGateway({ port: 0, hostname: '127.0.0.1', robotsTxt: robots, backendFile: new URL('./fixtures/health-peer.mjs', import.meta.url) });
  t.after(() => gateway.close());
  await once(gateway.server, 'listening');
  const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  // No health observation yet: proxied routes fail closed, robots.txt does not.
  assert.equal((await fetch(`${origin}/now`)).status, 503);
  const response = await fetch(`${origin}/robots.txt`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(await response.text(), robots);
  const headResponse = await fetch(`${origin}/robots.txt`, { method: 'HEAD' });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('content-length'), String(robots.length));
});
