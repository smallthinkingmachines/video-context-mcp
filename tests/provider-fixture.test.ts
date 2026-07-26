/**
 * Deterministic provider-boundary integration test. The production pipeline is
 * exercised with synthetic yt-dlp-shaped metadata and captions, but no process
 * is spawned and no network request is made.
 */
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheManager } from '../src/cache.js';
import { type Config, loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { IngestManager } from '../src/pipeline/ingest.js';
import { parseYoutubeMetadata } from '../src/pipeline/ytdlp.js';
import * as getTimeline from '../src/tools/get-video-timeline.js';
import * as searchVideos from '../src/tools/search-videos.js';

const VIDEO_ID = 'fixtureVid1';
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/youtube-provider/', import.meta.url));
const METADATA_JSON = readFileSync(join(FIXTURE_DIR, 'metadata.json'), 'utf8');
const CAPTIONS_VTT = readFileSync(join(FIXTURE_DIR, 'captions.vtt'), 'utf8');

describe('fixture-backed YouTube ingestion', () => {
  let dir: string;
  let db: Database.Database;
  let config: Config;

  beforeEach(() => {
    dir = join(tmpdir(), `vcm-provider-${process.pid}-${Math.random().toString(16).slice(2)}`);
    config = loadConfig({ VCM_CACHE_DIR: dir });
    db = openDb(dir);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('covers metadata, captions, search, embedding repair, and cleanup without network access', async () => {
    const removeVideoDir = vi.fn(async (path: string) => {
      rmSync(path, { recursive: true, force: true });
    });
    const deleteVectors = vi.fn(async () => undefined);
    const optimizeVectors = vi.fn(async () => undefined);
    const cache = new CacheManager(db, config, {
      removeVideoDir,
      deleteVectors,
      optimizeVectors,
    });
    const ensureTools = vi.fn(async () => ({
      ytdlp: undefined,
      ffmpeg: undefined,
      ffprobe: undefined,
    }));
    const fetchYoutubeMetadata = vi.fn(async () => parseYoutubeMetadata(METADATA_JSON, VIDEO_ID));
    const downloadCaptions = vi.fn(async () => CAPTIONS_VTT);
    const embedVideo = vi.fn(async (database: Database.Database, videoId: string) => {
      const count = (
        database.prepare('SELECT COUNT(*) AS n FROM segments WHERE video_id = ?').get(videoId) as {
          n: number;
        }
      ).n;
      return { count, vectorBytes: count * 16 };
    });
    const ingest = new IngestManager(db, config, cache, {
      ensureTools,
      fetchYoutubeMetadata,
      downloadCaptions,
      embedVideo,
    });

    expect(ingest.start(VIDEO_ID, { visual: false, embed: true })).toMatchObject({
      videoId: VIDEO_ID,
      cached: false,
    });
    await ingest.drain();

    expect(ensureTools).toHaveBeenCalledWith(['ytdlp'], expect.any(Function));
    expect(fetchYoutubeMetadata).toHaveBeenCalledOnce();
    expect(downloadCaptions).toHaveBeenCalledWith(
      expect.objectContaining({ id: VIDEO_ID, kind: 'youtube' }),
      { lang: 'en', auto: false },
      expect.any(String),
      config,
    );
    expect(embedVideo).toHaveBeenCalledOnce();

    const row = db
      .prepare(
        'SELECT stage, title, channel, upload_date, duration_s, captions_lang, embedded_count, error_detail FROM videos WHERE id = ?',
      )
      .get(VIDEO_ID) as Record<string, unknown>;
    expect(row).toMatchObject({
      stage: 'done',
      title: 'Deterministic Provider Fixture',
      channel: 'Fixture Channel',
      upload_date: '2026-07-26',
      duration_s: 19,
      captions_lang: 'en',
      embedded_count: 2,
      error_detail: null,
    });

    const timeline = await getTimeline.handler({ db, config, ingest, cache })({
      video_id: VIDEO_ID,
    });
    expect(timeline.structuredContent).toMatchObject({
      video_id: VIDEO_ID,
      title: 'Deterministic Provider Fixture',
      stage: 'done',
      transcript: { source: 'captions', segment_count: 2 },
    });

    const searched = await searchVideos.handler({ db, config, ingest, cache })({
      query: 'elephants',
      video_id: VIDEO_ID,
    });
    expect(searched.structuredContent?.hits).toEqual([
      expect.objectContaining({ video_id: VIDEO_ID, kind: 'speech' }),
    ]);

    expect(ingest.repairEmbeddings(VIDEO_ID, true)).toMatchObject({ stage: 'embed' });
    await ingest.drain();
    expect(embedVideo).toHaveBeenCalledTimes(2);

    await expect(cache.releaseVideo(VIDEO_ID)).resolves.toMatchObject({
      deleted: VIDEO_ID,
      cleanupPending: false,
    });
    expect(db.prepare('SELECT id FROM videos WHERE id = ?').get(VIDEO_ID)).toBeUndefined();
    expect(deleteVectors).toHaveBeenCalledWith(VIDEO_ID, config);
    expect(optimizeVectors).toHaveBeenCalledWith(config);
  });
});
