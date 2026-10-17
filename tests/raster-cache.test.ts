import test from 'node:test';
import assert from 'node:assert/strict';
import { RasterCache } from '../src/output/raster-cache.js';

test('hot cards survive entry eviction and a miss does not change recency', () => {
  const cache = new RasterCache(100, 2);
  const a = Buffer.from('a');
  cache.set('a', a); cache.set('b', Buffer.from('b'));
  assert.equal(cache.get('a'), a);
  assert.equal(cache.get('missing'), undefined);
  cache.set('c', Buffer.from('c'));
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), a);
  assert.equal(cache.size, 2);
});

test('byte budget evicts enough entries and accounts for replacement', () => {
  const cache = new RasterCache(8, 10);
  cache.set('a', Buffer.alloc(3)); cache.set('b', Buffer.alloc(3));
  cache.set('c', Buffer.alloc(6));
  assert.equal(cache.get('a'), undefined); assert.equal(cache.get('b'), undefined);
  assert.equal(cache.byteLength, 6);
  cache.set('c', Buffer.alloc(2)); cache.set('d', Buffer.alloc(6));
  assert.equal(cache.byteLength, 8); assert.equal(cache.size, 2);
  cache.set('c', Buffer.alloc(3));
  assert.equal(cache.get('d'), undefined); assert.equal(cache.byteLength, 3);
});

test('oversized replacement is not retained and leaves other cached cards intact', () => {
  const cache = new RasterCache(4, 4);
  cache.set('a', Buffer.from('a')); cache.set('b', Buffer.from('b'));
  cache.set('a', Buffer.alloc(5));
  assert.equal(cache.get('a'), undefined);
  assert.deepEqual(cache.get('b'), Buffer.from('b'));
  assert.equal(cache.byteLength, 1);
});

test('content hash churn stays bounded, including empty encodings', () => {
  const cache = new RasterCache(32, 8);
  for (let i = 0; i < 10000; i++) {
    cache.set('content-' + i, Buffer.alloc(i % 10));
    assert.ok(cache.byteLength <= 32); assert.ok(cache.size <= 8);
  }
  for (let i = 0; i < 20; i++) cache.set('empty-' + i, Buffer.alloc(0));
  assert.equal(cache.size, 8); assert.equal(cache.byteLength, 0);
});
