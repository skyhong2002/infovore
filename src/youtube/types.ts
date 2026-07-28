export type YoutubeRange = '7d' | '28d' | '90d' | 'all';

export interface YoutubeWatchInput {
  eventId: string;
  videoId: string | null;
  title: string;
  url: string;
  channelId: string | null;
  channelTitle: string | null;
  channelUrl: string | null;
  watchedAt: string;
  actualWatchedSeconds: number | null;
  activityType: 'video' | 'post' | 'other';
}

export interface YoutubeSearchInput {
  eventId: string;
  searchedAt: string;
  queryCiphertext: string;
  activityType: 'search' | 'visit' | 'other';
}

export interface YoutubeParsedArchive {
  archiveHash: string;
  source: 'takeout' | 'dataportability';
  watches: YoutubeWatchInput[];
  searches: YoutubeSearchInput[];
}

export interface YoutubeImportResult {
  archiveHash: string;
  watchesSeen: number;
  watchesInserted: number;
  searchesSeen: number;
  searchesInserted: number;
}

export interface YoutubeVideoMetadata {
  videoId: string;
  title: string;
  channelId: string | null;
  channelTitle: string | null;
  description: string;
  tags: string[];
  thumbnailUrl: string;
  durationSeconds: number | null;
  publishedAt: string | null;
  categoryId: string | null;
  availability: 'available' | 'unavailable';
  metadataHash: string;
}

export interface YoutubeRecentVideo {
  videoId: string | null;
  title: string;
  url: string;
  channelId: string | null;
  channelTitle: string;
  thumbnailUrl: string;
  durationSeconds: number | null;
  actualWatchedSeconds: number | null;
  watchedAt: string;
  watchCount: number;
}

export interface YoutubeChannelSummary {
  channelId: string | null;
  name: string;
  watches: number;
  durationSeconds: number;
}

export interface YoutubeTopicSummary {
  slug: string;
  name: string;
  watches: number;
  durationSeconds: number;
}

export interface YoutubeDailySummary {
  day: string;
  watches: number;
  durationSeconds: number;
}

export interface YoutubeLengthBucket {
  label: string;
  videos: number;
}

export interface YoutubeKeyword {
  term: string;
  videos: number;
  score: number;
}

export interface YoutubeDashboardData {
  range: YoutubeRange;
  generatedAt: string;
  stats: {
    watchEvents: number;
    uniqueVideos: number;
    uniqueChannels: number;
    openedDurationSeconds: number;
    actualWatchedSeconds: number | null;
    metadataCoverage: number;
  };
  daily: YoutubeDailySummary[];
  lengthBuckets: YoutubeLengthBucket[];
  topChannels: YoutubeChannelSummary[];
  topics: YoutubeTopicSummary[];
  keywords: YoutubeKeyword[];
  recent: YoutubeRecentVideo[];
}

export interface YoutubeTopic {
  id: number;
  version: number;
  slug: string;
  name: string;
  description: string;
}

export interface YoutubeOAuthCredential {
  encryptedRefreshToken: string;
  expiresAt: string | null;
  scope: string;
  updatedAt: string;
}
