import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGoodreads, parseGoodreadsRss } from '../src/sources/goodreads.js';

const profile = `<h1>Reader</h1>
<a href="/review/list/123?shelf=read">read (6)</a>
<a href="/review/list/123?shelf=currently-reading">currently-reading (1)</a>
<a href="/review/list/123?shelf=to-read">to-read (9)</a>`;
const emptyRss = '<?xml version="1.0"?><rss version="2.0"><channel><title>Books</title></channel></rss>';

test('Goodreads rejects an HTML or incomplete response instead of treating it as an empty shelf', () => {
  for (const body of ['', '<html><title>Page not found</title></html>', '<html><title>Sign in</title></html>', '<rss><channel>']) {
    assert.throws(() => parseGoodreadsRss(body, 20, 'read'), /goodreads: read RSS unavailable: expected RSS channel/);
  }
  assert.deepEqual(parseGoodreadsRss(emptyRss, 20, 'read'), [], 'a genuine empty shelf is valid');
});

test('Goodreads does not publish unknown profile shelf counts as zero', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) =>
    new Response(String(input).includes('/user/show/') ? '<h1>Sign in</h1>' : emptyRss));
  await assert.rejects(fetchGoodreads(), /goodreads: profile unavailable: missing read shelf count/);
});

test('Goodreads keeps the configured identifier and all three shelf URLs unchanged', async (t) => {
  const { config } = await import('../src/config.js');
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    return new Response(url.includes('/user/show/') ? profile : emptyRss);
  });
  const result = await fetchGoodreads();
  assert.deepEqual(result.stats, { readCount: 6, currentlyReadingCount: 1, toReadCount: 9 });
  assert.deepEqual(result.entries, []);
  assert.deepEqual(requested, [
    `https://www.goodreads.com/user/show/${config.goodreads.userId}`,
    ...['read', 'currently-reading', 'to-read'].map((shelf) =>
      `https://www.goodreads.com/review/list_rss/${config.goodreads.userId}?shelf=${shelf}`),
  ]);
});

test('Goodreads accepts explicit zero counts, but rejects each missing shelf count', async (t) => {
  for (const shelf of ['read', 'currently-reading', 'to-read', null]) {
    await t.test(shelf ? `missing ${shelf}` : 'explicit zeros', async (t) => {
      const html = shelf
        ? profile.replace(new RegExp(`<a[^>]*shelf=${shelf}[^>]*>[\\s\\S]*?</a>`), '')
        : profile.replace(/\(\d+\)/g, '(0)');
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) =>
        new Response(String(input).includes('/user/show/') ? html : emptyRss));
      if (shelf) await assert.rejects(fetchGoodreads(), new RegExp(`missing ${shelf} shelf count`));
      else assert.deepEqual((await fetchGoodreads()).stats, { readCount: 0, currentlyReadingCount: 0, toReadCount: 0 });
    });
  }
});

test('Goodreads does not borrow a count from the next shelf link', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) =>
    new Response(String(input).includes('/user/show/') ? profile.replace('read (6)', 'read') : emptyRss));
  await assert.rejects(fetchGoodreads(), /missing read shelf count/);
});
