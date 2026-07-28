import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { Repository } from '../src/data/database.js';
import {
  classifyYoutubeVideosWithClient,
  ensureYoutubeTaxonomyWithClient,
  youtubePublicMetadata,
  type YoutubeAiClient,
} from '../src/youtube/ai.js';
import { decryptPrivateValue, encryptPrivateValue } from '../src/youtube/crypto.js';
import { fetchYoutubeMetadata } from '../src/youtube/metadata.js';
import { extractYoutubeKeywords } from '../src/youtube/keywords.js';
import { normalizeYoutubeCapture } from '../src/youtube/capture.js';
import { runYoutubePortabilityStep } from '../src/youtube/portability.js';
import { parseYoutubeArchive } from '../src/youtube/takeout.js';
import type { YoutubeParsedArchive, YoutubeVideoMetadata } from '../src/youtube/types.js';

const SECRET = 'test-private-data-key-with-at-least-32-characters';

function fixtureZip(): Uint8Array {
  const watch = [
    {
      header: 'YouTube', title: 'Watched Long Technical Talk',
      titleUrl: 'https://www.youtube.com/watch?v=video-one',
      subtitles: [{ name: 'Channel One', url: 'https://www.youtube.com/channel/channel-one' }],
      time: '2026-07-28T01:00:00Z', products: ['YouTube'],
      activityControls: ['YouTube watch history'],
    },
    {
      header: 'YouTube', title: 'Watched Long Technical Talk',
      titleUrl: 'https://www.youtube.com/watch?v=video-one',
      subtitles: [{ name: 'Channel One', url: 'https://www.youtube.com/channel/channel-one' }],
      time: '2026-07-28T02:00:00Z', products: ['YouTube'],
      activityControls: ['YouTube watch history'],
    },
    {
      header: 'YouTube', title: 'Watched 已移除的影片',
      time: '2026-07-28T03:00:00Z', products: ['YouTube'],
      activityControls: ['YouTube watch history'],
    },
    {
      header: 'YouTube', title: 'Viewed a post',
      titleUrl: 'https://www.youtube.com/post/Ugkx-private-community-post',
      time: '2026-07-28T04:00:00Z', products: ['YouTube'],
      activityControls: ['YouTube watch history'],
    },
  ];
  const search = [
    {
      header: 'YouTube', title: 'Searched for private search term',
      titleUrl: 'https://www.youtube.com/results?search_query=private+search+term',
      time: '2026-07-28T00:30:00Z', products: ['YouTube'],
      activityControls: ['YouTube search history'],
    },
    {
      header: 'YouTube', title: 'Visited https://www.youtube.com/',
      titleUrl: 'https://www.youtube.com/',
      time: '2026-07-28T00:45:00Z', products: ['YouTube'],
      activityControls: ['YouTube search history'],
    },
  ];
  return zipSync({
    'Takeout/YouTube and YouTube Music/history/watch-history.json': strToU8(JSON.stringify(watch)),
    'Takeout/YouTube and YouTube Music/history/search-history.json': strToU8(JSON.stringify(search)),
  });
}

function htmlFixtureZip(): Uint8Array {
  const activity = (
    action: string,
    title: string,
    url: string,
    channel: string,
    channelUrl: string,
    time: string,
    control: string,
  ) => `<div class="outer-cell"><div class="content-cell">${action}
    ${url ? `<a href="${url}">${title}</a>` : title}<br>
    ${channelUrl ? `<a href="${channelUrl}">${channel}</a><br>` : ''}
    ${time}<br><b>Products:</b><br>YouTube<br><b>Activity controls:</b><br>
    This activity was saved because ${control} was on.
    <a href="https://myaccount.google.com/activitycontrols">settings</a>.
  </div></div>`;
  const watch = [
    activity(
      'Watched', 'Long Technical Talk', 'https://www.youtube.com/watch?v=video-one',
      'Channel One', 'https://www.youtube.com/channel/channel-one',
      'Jul 28, 2026, 9:00:00 AM CST', 'YouTube watch history',
    ),
    activity(
      'Viewed', 'a post', 'https://www.youtube.com/post/post-one',
      'Channel One', 'https://www.youtube.com/channel/channel-one',
      'Jul 28, 2026, 10:00:00 AM CST', 'YouTube watch history',
    ),
  ].join('');
  const search = [
    activity(
      'Searched for', 'private search term',
      'https://www.youtube.com/results?search_query=private+search+term',
      '', '', 'Jul 28, 2026, 8:30:00 AM CST', 'YouTube search history',
    ),
    activity(
      'Visited', 'Google', 'https://www.google.com/',
      '', '', 'Jul 28, 2026, 8:45:00 AM CST', 'YouTube search history',
    ),
  ].join('');
  return zipSync({
    'Takeout/YouTube and YouTube Music/history/watch-history.html': strToU8(watch),
    'Takeout/YouTube and YouTube Music/history/search-history.html': strToU8(search),
  });
}

test('private-value encryption is randomized and authenticated', () => {
  const first = encryptPrivateValue('sensitive', SECRET);
  const second = encryptPrivateValue('sensitive', SECRET);
  assert.notEqual(first, second);
  assert.equal(decryptPrivateValue(first, SECRET), 'sensitive');
  assert.throws(() => decryptPrivateValue(`${first.slice(0, -1)}x`, SECRET));
});

test('Takeout parser normalizes watch/search records and rejects unsafe archives', () => {
  const parsed = parseYoutubeArchive(fixtureZip(), SECRET);
  assert.equal(parsed.watches.length, 4);
  assert.equal(parsed.searches.length, 2);
  assert.equal(parsed.watches[0].videoId, 'video-one');
  assert.equal(parsed.watches[0].channelId, 'channel-one');
  assert.equal(parsed.watches[2].videoId, null);
  assert.equal(parsed.watches[3].activityType, 'post');
  assert.equal(parsed.watches[3].videoId, null);
  assert.equal(decryptPrivateValue(parsed.searches[0].queryCiphertext, SECRET), 'private search term');
  assert.equal(parsed.searches[1].activityType, 'visit');
  assert.equal(decryptPrivateValue(parsed.searches[1].queryCiphertext, SECRET), 'Visited https://www.youtube.com/');
  const unsafe = zipSync({ '../history/watch-history.json': strToU8('[]') });
  assert.throws(() => parseYoutubeArchive(unsafe, SECRET), /Unsafe archive entry/);
  assert.throws(
    () => parseYoutubeArchive(fixtureZip(), SECRET, 'takeout', { maxArchiveBytes: 1 }),
    /compressed size limit/,
  );
  assert.throws(
    () => parseYoutubeArchive(fixtureZip(), SECRET, 'takeout', { maxUncompressedBytes: 1 }),
    /uncompressed size limit/,
  );
  assert.throws(() => parseYoutubeArchive(fixtureZip(), 'too-short'), /at least 32 characters/);
});

test('Takeout parser accepts HTML history and preserves Taipei timestamps', () => {
  const parsed = parseYoutubeArchive(htmlFixtureZip(), SECRET);
  assert.equal(parsed.watches.length, 2);
  assert.equal(parsed.searches.length, 2);
  assert.equal(parsed.watches[0].videoId, 'video-one');
  assert.equal(parsed.watches[0].channelId, 'channel-one');
  assert.equal(parsed.watches[0].watchedAt, '2026-07-28T01:00:00.000Z');
  assert.equal(parsed.watches[1].activityType, 'post');
  assert.equal(parsed.searches[0].searchedAt, '2026-07-28T00:30:00.000Z');
  assert.equal(decryptPrivateValue(parsed.searches[0].queryCiphertext, SECRET), 'private search term');
  assert.equal(parsed.searches[1].activityType, 'visit');
});

test('HTML imports do not duplicate second-precision JSON events', () => {
  const repository = new Repository(':memory:');
  try {
    const json = parseYoutubeArchive(fixtureZip(), SECRET);
    const html = parseYoutubeArchive(htmlFixtureZip(), SECRET);
    repository.ingestYoutubeArchive(json);
    const result = repository.ingestYoutubeArchive(html);
    assert.equal(result.watchesInserted, 1);
    assert.equal(result.searchesInserted, 0);
    assert.equal(repository.youtubeCounts().videoWatches, 3);
  } finally {
    repository.close();
  }
});

test('YouTube imports are idempotent, aggregate-only, and preserve duration semantics', () => {
  const repository = new Repository(':memory:');
  try {
    const parsed = parseYoutubeArchive(fixtureZip(), SECRET);
    assert.deepEqual(repository.ingestYoutubeArchive(parsed), {
      archiveHash: parsed.archiveHash,
      watchesSeen: 4,
      watchesInserted: 4,
      searchesSeen: 2,
      searchesInserted: 2,
    });
    assert.deepEqual(repository.ingestYoutubeArchive(parsed), {
      archiveHash: parsed.archiveHash,
      watchesSeen: 4,
      watchesInserted: 0,
      searchesSeen: 2,
      searchesInserted: 0,
    });
    assert.deepEqual(repository.youtubeCounts(), {
      watches: 4,
      videoWatches: 3,
      videos: 1,
      searches: 2,
      searchQueries: 1,
      channels: 1,
    });
    assert.equal(repository.queryActivities({ source: 'youtube' }).total, 0);

    const metadata: YoutubeVideoMetadata = {
      videoId: 'video-one', title: 'Long Technical Talk', channelId: 'channel-one',
      channelTitle: 'Channel One', description: 'TypeScript systems engineering',
      tags: ['TypeScript', 'systems'], thumbnailUrl: 'https://i.ytimg.com/vi/video-one/hqdefault.jpg',
      durationSeconds: 600, publishedAt: '2026-07-20T00:00:00Z', categoryId: '28',
      availability: 'available', metadataHash: 'metadata-v1',
    };
    repository.upsertYoutubeVideoMetadata([metadata]);
    const dashboard = repository.youtubeDashboard('all', new Date('2026-07-29T00:00:00Z'));
    assert.equal(dashboard.stats.watchEvents, 3);
    assert.equal(dashboard.stats.uniqueVideos, 2);
    assert.equal(dashboard.stats.openedDurationSeconds, 1200);
    assert.equal(dashboard.stats.actualWatchedSeconds, null);
    assert.equal(dashboard.topChannels[0].name, 'Channel One');
    assert.equal(dashboard.recent.length, 2);
    assert.ok(dashboard.keywords.some((keyword) => keyword.term === 'typescript'));
    const wrapped = repository.wrapped(2026);
    assert.equal(wrapped.bySource.youtube, 3);
    assert.ok(!wrapped.topTitles.some((item) => item.title.includes('Technical Talk')));
  } finally {
    repository.close();
  }
});

test('Chrome captures validate YouTube URLs and idempotently increase measured watch time', () => {
  const repository = new Repository(':memory:');
  const now = new Date('2026-07-28T12:30:00Z');
  try {
    const first = normalizeYoutubeCapture({
      sessionId: '12345678-1234-4123-8123-123456789abc',
      videoId: 'dQw4w9WgXcQ',
      title: 'Captured YouTube Video',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
      channelTitle: 'Captured Channel',
      watchedAt: '2026-07-28T12:00:00Z',
      actualWatchedSeconds: 12,
      durationSeconds: 213,
    }, now);
    const inserted = repository.upsertYoutubeCapture(first, now.toISOString());
    assert.equal(inserted.inserted, true);
    assert.equal(inserted.updated, false);
    assert.equal(inserted.actualWatchedSeconds, 12);

    const duplicate = repository.upsertYoutubeCapture(first, now.toISOString());
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.updated, false);
    assert.equal(repository.youtubeCounts().videoWatches, 1);

    const increased = repository.upsertYoutubeCapture({
      ...first,
      actualWatchedSeconds: 47,
    }, now.toISOString());
    assert.equal(increased.inserted, false);
    assert.equal(increased.updated, true);
    assert.equal(increased.actualWatchedSeconds, 47);
    const dashboard = repository.youtubeDashboard('all', now);
    assert.equal(dashboard.stats.watchEvents, 1);
    assert.equal(dashboard.stats.actualWatchedSeconds, 47);
    assert.equal(dashboard.stats.openedDurationSeconds, 213);
    assert.equal(repository.queryActivities({ source: 'youtube' }).total, 0);

    assert.throws(() => normalizeYoutubeCapture({
      sessionId: '12345678-1234-4123-8123-123456789abc',
      videoId: 'dQw4w9WgXcQ',
      title: 'Wrong host',
      url: 'https://example.test/watch?v=dQw4w9WgXcQ',
      watchedAt: '2026-07-28T12:00:00Z',
      actualWatchedSeconds: 5,
    }, now), /youtube\.com/);
    assert.throws(() => normalizeYoutubeCapture({
      sessionId: '12345678-1234-4123-8123-123456789abc',
      videoId: 'dQw4w9WgXcQ',
      title: 'Wrong video',
      url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      watchedAt: '2026-07-28T12:00:00Z',
      actualWatchedSeconds: 5,
    }, now), /does not match/);
  } finally {
    repository.close();
  }
});

test('Data Portability combined activity JSON uses the same parser', () => {
  const combined = [
    {
      header: 'YouTube', title: 'Watched Combined Export',
      titleUrl: 'https://www.youtube.com/watch?v=combined-id',
      time: '2026-07-27T12:00:00Z',
    },
    {
      header: 'YouTube', title: 'Searched for combined private query',
      time: '2026-07-27T11:00:00Z',
    },
  ];
  const archive = zipSync({
    'My Activity/YouTube/MyActivity.json': strToU8(JSON.stringify(combined)),
  });
  const parsed: YoutubeParsedArchive = parseYoutubeArchive(archive, SECRET, 'dataportability');
  assert.equal(parsed.source, 'dataportability');
  assert.equal(parsed.watches[0].videoId, 'combined-id');
  assert.equal(parsed.searches.length, 1);
});

test('YouTube metadata fetches in batches of 50 and retains unavailable videos', async () => {
  const ids = Array.from({ length: 51 }, (_, index) => `video-${index + 1}`);
  const requests: string[][] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const requested = new URL(String(input)).searchParams.get('id')!.split(',');
    requests.push(requested);
    const foundId = requested[0];
    return new Response(JSON.stringify({
      items: [{
        id: foundId,
        snippet: {
          title: `Title ${foundId}`,
          channelId: 'channel-id',
          channelTitle: 'Channel',
          description: 'Public description',
          tags: ['tag'],
          thumbnails: { high: { url: `https://i.ytimg.com/vi/${foundId}/hqdefault.jpg` } },
          publishedAt: '2026-07-01T00:00:00Z',
          categoryId: '28',
        },
        contentDetails: { duration: 'PT1H2M3S' },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const metadata = await fetchYoutubeMetadata(ids, 'test-api-key', fetchImpl);
  assert.deepEqual(requests.map((batch) => batch.length), [50, 1]);
  assert.equal(metadata.length, 51);
  assert.equal(metadata.find((video) => video.videoId === 'video-1')?.durationSeconds, 3723);
  assert.equal(metadata.find((video) => video.videoId === 'video-2')?.availability, 'unavailable');
  assert.equal(metadata.find((video) => video.videoId === 'video-51')?.availability, 'available');

  const failingFetch = (async () => new Response('quota exhausted', { status: 403 })) as typeof fetch;
  await assert.rejects(
    fetchYoutubeMetadata(['video-1'], 'test-api-key', failingFetch),
    /YouTube Data API: HTTP 403: quota exhausted/,
  );
});

test('YouTube keywords segment Unicode, ignore URLs, and count each video once', () => {
  const keywords = extractYoutubeKeywords([
    {
      title: 'TypeScript 系統設計 システム設計',
      description: 'See https://www.youtube.com/watch?v=private and build reliable systems',
      tags_json: '["TypeScript patterns","系統 設計"]',
    },
    {
      title: 'TypeScript 系統設計',
      description: 'Reliable systems in production',
      tags_json: '["TypeScript patterns"]',
    },
    {
      title: 'https://www.youtube.com/watch?v=deleted',
      description: null,
      tags_json: '[]',
    },
  ], 30);
  assert.ok(keywords.some((keyword) => keyword.term === 'typescript'));
  assert.ok(keywords.some((keyword) => keyword.term === 'typescript patterns'));
  assert.ok(keywords.some((keyword) => keyword.term.includes('系統')));
  assert.ok(!keywords.some((keyword) => /https|youtube|watch|private/.test(keyword.term)));
  assert.equal(keywords.find((keyword) => keyword.term === 'typescript')?.videos, 2);

  const stopWords = extractYoutubeKeywords([
    { title: 'My full video', description: 'Get more of that here. Follow my Twitter and Discord link.', tags_json: '[]' },
    { title: 'My full video', description: 'Get more of that here. Follow my Twitter and Discord link.', tags_json: '[]' },
  ]);
  assert.deepEqual(stopWords, []);
});

test('AI taxonomy is versioned, validated, cached, and receives only public metadata', async () => {
  const repository = new Repository(':memory:');
  try {
    const metadata = Array.from({ length: 12 }, (_, index): YoutubeVideoMetadata => ({
      videoId: `ai-video-${index + 1}`,
      title: `Technical Video ${index + 1}`,
      channelId: `channel-${index + 1}`,
      channelTitle: `Channel ${index + 1}`,
      description: 'A public description about software and culture.',
      tags: ['software', 'culture'],
      thumbnailUrl: `https://i.ytimg.com/vi/ai-video-${index + 1}/hqdefault.jpg`,
      durationSeconds: 1200,
      publishedAt: '2026-07-01T00:00:00Z',
      categoryId: '28',
      availability: 'available',
      metadataHash: `hash-${index + 1}`,
    }));
    repository.upsertYoutubeVideoMetadata(metadata, '2026-07-28T00:00:00Z');

    const payloads: unknown[] = [];
    let taxonomyGeneration = 1;
    let classificationCalls = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const payload = JSON.parse(request.messages.find((message) => message.role === 'user')!.content) as any;
      payloads.push(payload);
      const content = payload.topics
        ? (() => {
            classificationCalls++;
            return {
              videos: payload.videos.map((video: { videoId: string }) => ({
                videoId: video.videoId,
                topics: [{ slug: payload.topics[0].slug, confidence: 0.9 }],
              })),
            };
          })()
        : {
            topics: Array.from({ length: 12 }, (_, index) => ({
              slug: `topic-${taxonomyGeneration}-${index + 1}`,
              name: `Topic ${taxonomyGeneration}.${index + 1}`,
              description: `Stable topic ${taxonomyGeneration}.${index + 1}`,
            })),
          };
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client: YoutubeAiClient = {
      baseUrl: 'https://ai.example.test/v1',
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl,
    };

    const firstTopics = await ensureYoutubeTaxonomyWithClient(repository, false, client);
    assert.equal(firstTopics.length, 12);
    assert.equal(firstTopics[0].version, 1);
    assert.equal(await classifyYoutubeVideosWithClient(repository, 100, client), 12);
    assert.equal(classificationCalls, 1);
    assert.equal(await classifyYoutubeVideosWithClient(repository, 100, client), 0);
    assert.equal(classificationCalls, 1);

    taxonomyGeneration = 2;
    const rebuilt = await ensureYoutubeTaxonomyWithClient(repository, true, client);
    assert.equal(rebuilt[0].version, 2);
    assert.equal(await classifyYoutubeVideosWithClient(repository, 100, client), 12);
    assert.equal(classificationCalls, 2);

    const serializedPayloads = JSON.stringify(payloads);
    assert.doesNotMatch(serializedPayloads, /watchedAt|searchedAt|queryCiphertext|actualWatchedSeconds/);
    assert.deepEqual(Object.keys(youtubePublicMetadata(metadata[0])).sort(), [
      'channel', 'description', 'tags', 'title', 'videoId',
    ]);

    repository.upsertYoutubeVideoMetadata([
      { ...metadata[0], metadataHash: 'changed-metadata-hash' },
    ], '2026-07-29T00:00:00Z');
    const invalidClient: YoutubeAiClient = {
      ...client,
      fetchImpl: (async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"videos":[{"videoId":"ai-video-1","topics":[]}]}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    };
    await assert.rejects(
      classifyYoutubeVideosWithClient(repository, 100, invalidClient),
      /requires one to three topics/,
    );

    let retryCalls = 0;
    const retryClient: YoutubeAiClient = {
      ...client,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        retryCalls++;
        const request = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        const payload = JSON.parse(
          request.messages.find((message) => message.role === 'user')!.content
        ) as any;
        const videos = retryCalls === 1 ? [] : payload.videos.map((video: { videoId: string }) => ({
          videoId: video.videoId,
          topics: [{ slug: payload.topics[0].slug, confidence: 0.9 }],
        }));
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ videos }) } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    };
    assert.equal(await classifyYoutubeVideosWithClient(repository, 100, retryClient), 1);
    assert.equal(retryCalls, 2);
  } finally {
    repository.close();
  }
});

function portabilityZip(videoId: string, title: string, time: string): Uint8Array {
  return zipSync({
    'My Activity/YouTube/MyActivity.json': strToU8(JSON.stringify([
      {
        header: 'YouTube',
        title: `Watched ${title}`,
        titleUrl: `https://www.youtube.com/watch?v=${videoId}`,
        time,
      },
      {
        header: 'YouTube',
        title: `Searched for query-${videoId}`,
        time,
      },
    ])),
  });
}

test('Data Portability enforces daily starts, polls jobs, and advances checkpoint after import', async () => {
  const repository = new Repository(':memory:');
  try {
    const startAt = new Date('2026-07-28T20:00:00.000Z');
    let initiateBody: Record<string, unknown> | null = null;
    const initiateFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.match(String(input), /portabilityArchive:initiate$/);
      initiateBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{"archiveJobId":"job-1"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    assert.equal(await runYoutubePortabilityStep(repository, {
      now: startAt,
      fetchImpl: initiateFetch,
      accessToken: 'access-token',
    }), 'started');
    assert.deepEqual(initiateBody, {
      resources: ['myactivity.youtube'],
      end_time: startAt.toISOString(),
    });

    const inProgressFetch = (async () => new Response('{"state":"IN_PROGRESS"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    assert.equal(await runYoutubePortabilityStep(repository, {
      now: new Date(startAt.getTime() + 30 * 60_000),
      fetchImpl: inProgressFetch,
      accessToken: 'access-token',
    }), 'in_progress');

    const archive = portabilityZip('portable-video', 'Portable Video', '2026-07-28T19:30:00Z');
    const completeFetch = (async (input: string | URL | Request) => {
      if (String(input).includes('portabilityArchiveState')) {
        return new Response('{"state":"COMPLETE","urls":["https://download.example/archive.zip"]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(Buffer.from(archive), { status: 200 });
    }) as typeof fetch;
    const completedAt = new Date(startAt.getTime() + 60 * 60_000);
    assert.equal(await runYoutubePortabilityStep(repository, {
      now: completedAt,
      fetchImpl: completeFetch,
      accessToken: 'access-token',
    }), 'imported');
    assert.equal(repository.youtubeSyncState('checkpoint'), startAt.toISOString());
    assert.deepEqual(repository.youtubeCounts(), {
      watches: 1,
      videoWatches: 1,
      videos: 1,
      searches: 1,
      searchQueries: 1,
      channels: 0,
    });

    const unexpectedFetch = (async () => {
      throw new Error('daily limit should avoid a network request');
    }) as typeof fetch;
    assert.equal(await runYoutubePortabilityStep(repository, {
      now: new Date(startAt.getTime() + 2 * 60 * 60_000),
      fetchImpl: unexpectedFetch,
      accessToken: 'access-token',
    }), 'idle');
  } finally {
    repository.close();
  }
});

test('Data Portability overlaps one day and retries failed downloads without moving checkpoint', async () => {
  const overlapRepository = new Repository(':memory:');
  try {
    overlapRepository.setYoutubeSyncState('checkpoint', '2026-07-20T00:00:00.000Z');
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{"archiveJobId":"overlap-job"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    assert.equal(await runYoutubePortabilityStep(overlapRepository, {
      now: new Date('2026-07-28T20:00:00.000Z'),
      fetchImpl,
      accessToken: 'access-token',
    }), 'started');
    assert.equal(body.start_time, '2026-07-19T00:00:00.000Z');
  } finally {
    overlapRepository.close();
  }

  const retryRepository = new Repository(':memory:');
  try {
    const endTime = '2026-07-28T20:00:00.000Z';
    retryRepository.setYoutubeSyncState('checkpoint', '2026-07-20T00:00:00.000Z');
    retryRepository.setYoutubeSyncState('active_job', JSON.stringify({ id: 'retry-job', endTime }));
    const firstArchive = portabilityZip('retry-video-1', 'First Download', '2026-07-28T18:00:00Z');
    const secondArchive = portabilityZip('retry-video-2', 'Second Download', '2026-07-28T19:00:00Z');
    let failSecond = true;
    const retryFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('portabilityArchiveState')) {
        return new Response('{"state":"COMPLETE","urls":["https://download.example/one.zip","https://download.example/two.zip"]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/one.zip')) return new Response(Buffer.from(firstArchive), { status: 200 });
      if (failSecond) return new Response('temporary failure', { status: 503 });
      return new Response(Buffer.from(secondArchive), { status: 200 });
    }) as typeof fetch;

    await assert.rejects(
      runYoutubePortabilityStep(retryRepository, {
        now: new Date('2026-07-28T21:00:00.000Z'),
        fetchImpl: retryFetch,
        accessToken: 'access-token',
      }),
      /Data Portability download: HTTP 503/,
    );
    assert.equal(retryRepository.youtubeCounts().watches, 1);
    assert.equal(retryRepository.youtubeSyncState('checkpoint'), '2026-07-20T00:00:00.000Z');
    assert.match(retryRepository.youtubeSyncState('active_job') ?? '', /retry-job/);

    failSecond = false;
    assert.equal(await runYoutubePortabilityStep(retryRepository, {
      now: new Date('2026-07-28T22:00:00.000Z'),
      fetchImpl: retryFetch,
      accessToken: 'access-token',
    }), 'imported');
    assert.equal(retryRepository.youtubeCounts().watches, 2);
    assert.equal(retryRepository.youtubeCounts().searches, 2);
    assert.equal(retryRepository.youtubeSyncState('checkpoint'), endTime);
    assert.equal(repositoryStateJson(retryRepository, 'last_result').watchesInserted, 1);
  } finally {
    retryRepository.close();
  }
});

function repositoryStateJson(repository: Repository, key: string): Record<string, any> {
  return JSON.parse(repository.youtubeSyncState(key) ?? '{}') as Record<string, any>;
}

test('OAuth state is single-use and expires', () => {
  const repository = new Repository(':memory:');
  try {
    repository.createYoutubeOAuthState('valid-state', '2026-07-28T00:10:00.000Z');
    assert.equal(repository.consumeYoutubeOAuthState('valid-state', '2026-07-28T00:05:00.000Z'), true);
    assert.equal(repository.consumeYoutubeOAuthState('valid-state', '2026-07-28T00:06:00.000Z'), false);
    repository.createYoutubeOAuthState('expired-state', '2026-07-28T00:01:00.000Z');
    assert.equal(repository.consumeYoutubeOAuthState('expired-state', '2026-07-28T00:02:00.000Z'), false);
  } finally {
    repository.close();
  }
});
