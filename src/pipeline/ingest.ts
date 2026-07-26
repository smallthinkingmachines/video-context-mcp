import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import { CacheManager } from '../cache.js';
import type { Config } from '../config.js';
import { VcmError } from '../errors.js';
import type { VideoRef } from '../ids.js';
import { resolveRef } from '../ids.js';
import { RuntimeManager, type RuntimeProgress } from '../runtime/manager.js';
import type { ManagedTool } from '../runtime/manifest.js';
import { extractFrames } from './frames.js';
import { classifyFrame, ocrFrame } from './ocr.js';
import { mergeCues, parseVtt } from './vtt.js';
import { transcribeToVtt } from './whisper.js';
import {
  downloadAudio,
  downloadCaptions,
  downloadVideo,
  fetchYoutubeMetadata,
  pickCaptionTrack,
  probeLocalFile,
} from './ytdlp.js';

export interface IngestOptions {
  whisperFallback?: boolean;
  force?: boolean;
  /** Download the video and index keyframes+OCR (default true). */
  visual?: boolean;
  /** Embed transcript+screen text for semantic search (default true). */
  embed?: boolean;
}

export interface StartResult {
  videoId: string;
  stage: string;
  cached: boolean;
  alreadyRunning: boolean;
}

export interface EmbedStats {
  count: number;
  vectorBytes: number;
}

export interface IngestManagerOps {
  ensureTools?: (
    tools: ManagedTool[],
    onProgress?: RuntimeProgress,
  ) => Promise<Record<ManagedTool, string | undefined>>;
  fetchYoutubeMetadata?: typeof fetchYoutubeMetadata;
  downloadCaptions?: typeof downloadCaptions;
  embedVideo?: (db: Database.Database, videoId: string, config: Config) => Promise<EmbedStats>;
}

const MAX_CONCURRENT = 2;
const INGEST_LEASE_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;

interface StoredWarning {
  code: string;
  message: string;
}

function storedWarnings(code: string | null, detail: string | null): StoredWarning[] {
  if (!code || !detail) return [];
  const matches = [...detail.matchAll(/\[([A-Z_]+)\]\s+(.+?)(?=\s+\|\s+\[[A-Z_]+\]\s+|$)/g)];
  if (matches.length === 0) return [{ code, message: detail }];
  return matches.map((match) => ({ code: match[1]!, message: match[2]! }));
}

function warningColumns(warnings: StoredWarning[]): {
  errorCode: string | null;
  errorDetail: string | null;
} {
  return {
    errorCode: warnings[0]?.code ?? null,
    errorDetail:
      warnings.length === 0
        ? null
        : warnings.map((warning) => `[${warning.code}] ${warning.message}`).join(' | '),
  };
}

/** Best-effort removal that never throws (cache cleanup must not crash jobs). */
function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.error(`[video-context-mcp] cleanup of ${path} failed:`, err);
  }
}

export class IngestManager {
  private running = new Map<string, Promise<void>>();
  private active = 0;
  private waiters: (() => void)[] = [];
  private runtime: RuntimeManager;
  private readonly ownerId = `${process.pid}-${randomUUID()}`;

  constructor(
    private db: Database.Database,
    private config: Config,
    private cache = new CacheManager(db, config),
    private ops: IngestManagerOps = {},
  ) {
    this.runtime = new RuntimeManager(config);
  }

  /**
   * Resolve the ref, register the job, and kick the pipeline (not awaited).
   * Re-ingest is GENERATIONAL: existing derived rows (segments, chapters,
   * frames) are never deleted here — each pipeline stage atomically swaps in
   * its replacement only once the new data is ready, so a failed re-ingest
   * cannot destroy the last good index.
   */
  start(input: string, opts: IngestOptions = {}): StartResult {
    const ref = resolveRef(input);
    if (this.running.has(ref.id)) {
      const row = this.db.prepare('SELECT stage FROM videos WHERE id = ?').get(ref.id) as
        | { stage: string }
        | undefined;
      return {
        videoId: ref.id,
        stage: row?.stage ?? 'pending',
        cached: false,
        alreadyRunning: true,
      };
    }

    const now = new Date().toISOString();
    const existing = this.db
      .transaction((): StartResult | null => {
        if (this.cache.hasPendingGc(ref.id)) {
          throw new VcmError(
            'STAGE_NOT_READY',
            `Cleanup is still finishing for ${ref.id}. Retry ingest_video after prune_cache reports cleanup_pending=0.`,
          );
        }
        const row = this.db
          .prepare(
            `SELECT v.stage, j.lease_until_ms
             FROM videos v LEFT JOIN jobs j ON j.video_id = v.id
             WHERE v.id = ?`,
          )
          .get(ref.id) as { stage: string; lease_until_ms: number | null } | undefined;
        if (row?.stage === 'done' && !opts.force) {
          return { videoId: ref.id, stage: 'done', cached: true, alreadyRunning: false };
        }
        if (
          row &&
          !['done', 'error'].includes(row.stage) &&
          (row.lease_until_ms ?? 0) > Date.now()
        ) {
          return {
            videoId: ref.id,
            stage: row.stage,
            cached: false,
            alreadyRunning: true,
          };
        }
        this.db
          .prepare(
            `INSERT INTO videos (id, kind, source_url, stage, opts_json)
             VALUES (?, ?, ?, 'pending', ?)
             ON CONFLICT(id) DO UPDATE SET
               stage = 'pending', error_code = NULL, error_detail = NULL,
               kind = excluded.kind, source_url = excluded.source_url,
               opts_json = excluded.opts_json`,
          )
          .run(ref.id, ref.kind, ref.source, JSON.stringify(opts));
        this.db
          .prepare(
            `INSERT INTO jobs
               (video_id, stage, progress_pct, progress_detail, updated_at, owner_id, lease_until_ms)
             VALUES (?, 'pending', 0, NULL, ?, ?, ?)
             ON CONFLICT(video_id) DO UPDATE SET
               stage = 'pending', progress_pct = 0, progress_detail = NULL,
               updated_at = excluded.updated_at, owner_id = excluded.owner_id,
               lease_until_ms = excluded.lease_until_ms`,
          )
          .run(ref.id, now, this.ownerId, Date.now() + INGEST_LEASE_MS);
        return null;
      })
      .immediate();
    if (existing) {
      if (existing.cached) this.cache.touchVideo(ref.id);
      return existing;
    }

    const heartbeat = setInterval(() => this.heartbeat(ref.id), HEARTBEAT_MS);
    heartbeat.unref();
    const job = this.withSlot(() => this.run(ref, opts))
      .catch((err) => {
        // run() handles its own errors; this guards cleanup/reporting crashes
        // so a long-lived MCP process never sees an unhandled rejection.
        console.error(`[video-context-mcp] ingest job ${ref.id} crashed:`, err);
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.running.delete(ref.id);
      });
    this.running.set(ref.id, job);
    return { videoId: ref.id, stage: 'pending', cached: false, alreadyRunning: false };
  }

  /**
   * Rebuild only the semantic index from already-stored transcript/OCR rows.
   * No source media, metadata, captions, frames, or OCR are fetched again.
   */
  repairEmbeddings(videoId: string, force = false): StartResult {
    if (!/^[\w-]+$/.test(videoId)) {
      throw new VcmError(
        'NOT_INGESTED',
        `No video with id "${videoId}" in the index. Call list_videos to find a repairable video.`,
      );
    }
    if (this.running.has(videoId)) {
      const row = this.db.prepare('SELECT stage FROM videos WHERE id = ?').get(videoId) as
        | { stage: string }
        | undefined;
      return {
        videoId,
        stage: row?.stage ?? 'embed',
        cached: false,
        alreadyRunning: true,
      };
    }

    const now = new Date().toISOString();
    const existing = this.db
      .transaction((): StartResult | null => {
        if (this.cache.hasPendingGc(videoId)) {
          throw new VcmError(
            'STAGE_NOT_READY',
            `Cleanup is still finishing for ${videoId}. Retry repair_embeddings after prune_cache reports cleanup_pending=0.`,
          );
        }
        const row = this.db
          .prepare(
            'SELECT stage, embedded_count, error_code, error_detail FROM videos WHERE id = ?',
          )
          .get(videoId) as
          | {
              stage: string;
              embedded_count: number | null;
              error_code: string | null;
              error_detail: string | null;
            }
          | undefined;
        if (!row) {
          throw new VcmError(
            'NOT_INGESTED',
            `No video with id "${videoId}" in the index. Call ingest_video first, or list_videos to see what is available.`,
          );
        }
        if (row.stage !== 'done') {
          throw new VcmError(
            'STAGE_NOT_READY',
            `Cannot repair embeddings for ${videoId} while ingestion is at stage=${row.stage}. Wait for stage=done, or re-run a stalled ingest_video with force=true.`,
          );
        }
        const hasEmbeddingWarning = storedWarnings(row.error_code, row.error_detail).some(
          (warning) => warning.code === 'EMBED_FAILED',
        );
        if (row.embedded_count !== null && !hasEmbeddingWarning && !force) {
          return {
            videoId,
            stage: 'done',
            cached: true,
            alreadyRunning: false,
          };
        }

        this.db.prepare("UPDATE videos SET stage = 'embed' WHERE id = ?").run(videoId);
        this.db
          .prepare(
            `INSERT INTO jobs
               (video_id, stage, progress_pct, progress_detail, updated_at, owner_id, lease_until_ms)
             VALUES (?, 'embed', 96, 'Rebuilding semantic index', ?, ?, ?)
             ON CONFLICT(video_id) DO UPDATE SET
               stage = 'embed', progress_pct = 96,
               progress_detail = 'Rebuilding semantic index', updated_at = excluded.updated_at,
               owner_id = excluded.owner_id, lease_until_ms = excluded.lease_until_ms`,
          )
          .run(videoId, now, this.ownerId, Date.now() + INGEST_LEASE_MS);
        return null;
      })
      .immediate();
    if (existing) {
      if (existing.cached) this.cache.touchVideo(videoId);
      return existing;
    }

    const heartbeat = setInterval(() => this.heartbeat(videoId), HEARTBEAT_MS);
    heartbeat.unref();
    const job = this.withSlot(() => this.runEmbeddingRepair(videoId))
      .catch((err) => {
        console.error(`[video-context-mcp] embedding repair ${videoId} crashed:`, err);
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.running.delete(videoId);
      });
    this.running.set(videoId, job);
    return { videoId, stage: 'embed', cached: false, alreadyRunning: false };
  }

  isRunning(videoId: string): boolean {
    return this.running.has(videoId);
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  /** Await all in-flight jobs (used by tests). */
  async drain(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()]);
    }
  }

  /**
   * Atomically replace the transcript and reconcile caption metadata.
   * A whisper transcript clears stale caption fields from a previous ingest.
   * Public for tests.
   */
  applyTranscript(
    videoId: string,
    vtt: string,
    source: 'captions' | 'whisper',
    captionTrack: { lang: string; auto: boolean } | null,
  ): number {
    const segments = mergeCues(parseVtt(vtt));
    const insert = this.db.prepare(
      'INSERT INTO segments (video_id, start_ms, end_ms, text, source) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM segments WHERE video_id = ?').run(videoId);
      for (const s of segments) insert.run(videoId, s.startMs, s.endMs, s.text, source);
      this.db
        .prepare('UPDATE videos SET captions_lang = ?, captions_auto = ? WHERE id = ?')
        .run(
          captionTrack?.lang ?? null,
          captionTrack ? (captionTrack.auto ? 1 : 0) : null,
          videoId,
        );
    })();
    return segments.length;
  }

  private applyChapters(videoId: string, chapters: { startMs: number; title: string }[]): void {
    const insert = this.db.prepare(
      'INSERT INTO chapters (video_id, start_ms, title) VALUES (?, ?, ?)',
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM chapters WHERE video_id = ?').run(videoId);
      for (const ch of chapters) insert.run(videoId, ch.startMs, ch.title);
    })();
  }

  private async withSlot(fn: () => Promise<void>): Promise<void> {
    if (this.active >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private setStage(
    videoId: string,
    stage: string,
    pct: number,
    detail: string | null = null,
  ): void {
    this.db
      .transaction(() => {
        this.setProgress(videoId, stage, pct, detail);
        this.db.prepare('UPDATE videos SET stage = ? WHERE id = ?').run(stage, videoId);
      })
      .immediate();
  }

  private setProgress(
    videoId: string,
    stage: string,
    pct: number,
    detail: string | null = null,
  ): void {
    const terminal = stage === 'done' || stage === 'error';
    const updated = this.db
      .prepare(
        `UPDATE jobs
         SET stage = ?, progress_pct = ?, progress_detail = ?, updated_at = ?,
             owner_id = ?, lease_until_ms = ?
         WHERE video_id = ? AND owner_id = ?`,
      )
      .run(
        stage,
        pct,
        detail,
        new Date().toISOString(),
        terminal ? null : this.ownerId,
        terminal ? null : Date.now() + INGEST_LEASE_MS,
        videoId,
        this.ownerId,
      );
    if (updated.changes !== 1) {
      throw new VcmError(
        'INGEST_INTERRUPTED',
        `Ingest lease for ${videoId} was lost to another process; this worker stopped without changing the new owner's state.`,
      );
    }
  }

  private ownsJob(videoId: string): boolean {
    const row = this.db.prepare('SELECT owner_id FROM jobs WHERE video_id = ?').get(videoId) as
      | { owner_id: string | null }
      | undefined;
    return row?.owner_id === this.ownerId;
  }

  private assertOwnsJob(videoId: string): void {
    if (!this.ownsJob(videoId)) {
      throw new VcmError(
        'INGEST_INTERRUPTED',
        `Ingest lease for ${videoId} was lost to another process; this worker stopped without changing the new owner's state.`,
      );
    }
  }

  private heartbeat(videoId: string): void {
    try {
      this.db
        .prepare(
          `UPDATE jobs SET updated_at = ?, lease_until_ms = ?
           WHERE video_id = ? AND owner_id = ? AND stage NOT IN ('done', 'error')`,
        )
        .run(new Date().toISOString(), Date.now() + INGEST_LEASE_MS, videoId, this.ownerId);
    } catch (err) {
      console.error(
        `[video-context-mcp] ingest lease heartbeat failed for ${videoId}: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
      );
    }
  }

  private async maintainCache(
    reason: 'pre_ingest' | 'post_ingest',
    protectIds: Iterable<string>,
  ): Promise<void> {
    try {
      await this.cache.maintain({ reason, protectIds });
    } catch (err) {
      console.error(
        `[video-context-mcp] ${reason} cache maintenance failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)}`,
      );
    }
  }

  private async embedStoredVideo(videoId: string): Promise<EmbedStats> {
    if (this.ops.embedVideo) return this.ops.embedVideo(this.db, videoId, this.config);
    const { embedVideo } = await import('./embed.js');
    return embedVideo(this.db, videoId, this.config);
  }

  private updateEmbeddingWarning(videoId: string, replacement: VcmError | null): void {
    const row = this.db
      .prepare('SELECT error_code, error_detail FROM videos WHERE id = ?')
      .get(videoId) as { error_code: string | null; error_detail: string | null };
    const warnings = storedWarnings(row.error_code, row.error_detail).filter(
      (warning) => warning.code !== 'EMBED_FAILED',
    );
    if (replacement) warnings.push({ code: replacement.code, message: replacement.message });
    const columns = warningColumns(warnings);
    this.db
      .prepare('UPDATE videos SET error_code = ?, error_detail = ? WHERE id = ?')
      .run(columns.errorCode, columns.errorDetail, videoId);
  }

  private async runEmbeddingRepair(videoId: string): Promise<void> {
    try {
      await this.maintainCache('pre_ingest', this.runningIds());
      this.setProgress(videoId, 'embed', 96, 'Rebuilding semantic index');
      const stats = await this.embedStoredVideo(videoId);
      this.assertOwnsJob(videoId);
      this.db
        .transaction(() => {
          this.updateEmbeddingWarning(videoId, null);
          this.setProgress(videoId, 'done', 100);
          this.db
            .prepare(
              "UPDATE videos SET stage = 'done', embedded_count = ?, vector_bytes = ?, last_accessed_at = ? WHERE id = ?",
            )
            .run(stats.count, stats.vectorBytes, new Date().toISOString(), videoId);
        })
        .immediate();
    } catch (err) {
      if (this.ownsJob(videoId)) {
        const warning =
          err instanceof VcmError
            ? err
            : new VcmError(
                'EMBED_FAILED',
                `Embedding repair failed (${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}). Run video-context-mcp doctor and setup --all, then retry repair_embeddings; full-text search remains available.`,
              );
        this.db
          .transaction(() => {
            this.updateEmbeddingWarning(videoId, warning);
            this.setProgress(videoId, 'done', 100, 'Semantic indexing failed; full-text remains');
            this.db.prepare("UPDATE videos SET stage = 'done' WHERE id = ?").run(videoId);
          })
          .immediate();
      } else {
        console.error(`[video-context-mcp] stopped stale embedding repair worker for ${videoId}`);
      }
    } finally {
      try {
        this.cache.refreshVideoUsage(videoId);
      } catch (err) {
        console.error(
          `[video-context-mcp] cache accounting after embedding repair for ${videoId} failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)}`,
        );
      }
      await this.maintainCache('post_ingest', new Set([...this.runningIds(), videoId]));
    }
  }

  private async run(ref: VideoRef, opts: IngestOptions): Promise<void> {
    const videoDir = join(this.config.cacheDir, ref.id);
    const workDir = join(videoDir, 'tmp');
    try {
      await this.maintainCache('pre_ingest', this.runningIds());
      this.setStage(ref.id, 'setup', 1, 'Resolving the managed runtime');
      const needed = new Set<'ytdlp' | 'ffmpeg' | 'ffprobe'>();
      if (ref.kind === 'youtube') needed.add('ytdlp');
      else needed.add('ffprobe');
      if (opts.visual !== false || opts.whisperFallback) needed.add('ffmpeg');
      const onRuntimeProgress = (pct: number, detail: string) =>
        this.setProgress(ref.id, 'setup', 1 + Math.round(pct * 0.04), detail);
      const paths = this.ops.ensureTools
        ? await this.ops.ensureTools([...needed], onRuntimeProgress)
        : await this.runtime.ensureTools([...needed], onRuntimeProgress);
      this.runtime.applyResolved(paths);

      this.setStage(ref.id, 'metadata', 5);
      let captionsVtt: string | null = null;
      let captionTrack: { lang: string; auto: boolean } | null = null;

      if (ref.kind === 'youtube') {
        const meta = await (this.ops.fetchYoutubeMetadata ?? fetchYoutubeMetadata)(
          ref,
          this.config,
        );
        this.assertOwnsJob(ref.id);
        this.db
          .prepare(
            'UPDATE videos SET title = ?, channel = ?, upload_date = ?, duration_s = ? WHERE id = ?',
          )
          .run(meta.title, meta.channel, meta.uploadDate, meta.durationS, ref.id);
        this.applyChapters(ref.id, meta.chapters);

        this.setStage(ref.id, 'transcript', 25);
        captionTrack = pickCaptionTrack(meta);
        if (captionTrack) {
          mkdirSync(workDir, { recursive: true });
          captionsVtt = await (this.ops.downloadCaptions ?? downloadCaptions)(
            ref,
            captionTrack,
            workDir,
            this.config,
          );
          this.assertOwnsJob(ref.id);
        }
      } else {
        const probe = await probeLocalFile(ref.source, this.config);
        this.assertOwnsJob(ref.id);
        this.db
          .prepare('UPDATE videos SET title = ?, duration_s = ? WHERE id = ?')
          .run(basename(ref.source), probe.durationS, ref.id);
        this.setStage(ref.id, 'transcript', 25);
      }

      if (captionsVtt) {
        this.applyTranscript(ref.id, captionsVtt, 'captions', captionTrack);
      }

      // Sub-stage failures downgrade to warnings: whatever succeeded stays usable.
      const warnings: VcmError[] = [];
      const warn = (err: unknown, fallback: 'ASR_FAILED' | 'VISUAL_FAILED' | 'EMBED_FAILED') => {
        warnings.push(
          err instanceof VcmError
            ? err
            : new VcmError(fallback, err instanceof Error ? err.message : String(err)),
        );
      };

      if (!captionsVtt && opts.whisperFallback) {
        this.setStage(ref.id, 'whisper', 30);
        try {
          mkdirSync(workDir, { recursive: true });
          let mediaPath: string;
          if (ref.kind === 'youtube') {
            mediaPath = await downloadAudio(ref, workDir, this.config);
          } else {
            mediaPath = ref.source; // never deleted — the user's own file
          }
          const durationS = (
            this.db.prepare('SELECT duration_s AS d FROM videos WHERE id = ?').get(ref.id) as {
              d: number | null;
            }
          ).d;
          const vtt = await transcribeToVtt(
            mediaPath,
            workDir,
            this.config,
            (pct, note) =>
              this.setProgress(ref.id, 'whisper', 30 + Math.round(pct * 0.15), note ?? null),
            durationS,
          );
          this.assertOwnsJob(ref.id);
          this.applyTranscript(ref.id, vtt, 'whisper', null);
        } catch (err) {
          warn(err, 'ASR_FAILED');
        }
      }
      // If no new transcript was derived, any previous transcript is
      // intentionally left in place (the content did not change).

      if (opts.visual !== false) {
        try {
          await this.runVisual(ref, videoDir, workDir);
        } catch (err) {
          warn(err, 'VISUAL_FAILED');
        }
      }

      if (opts.embed !== false) {
        this.setStage(ref.id, 'embed', 96);
        try {
          // Dynamic import: the ONNX runtime stays unloaded unless needed.
          const stats = await this.embedStoredVideo(ref.id);
          this.assertOwnsJob(ref.id);
          this.db
            .prepare('UPDATE videos SET embedded_count = ?, vector_bytes = ? WHERE id = ?')
            .run(stats.count, stats.vectorBytes, ref.id);
        } catch (err) {
          warn(
            err instanceof VcmError
              ? err
              : new VcmError('EMBED_FAILED', err instanceof Error ? err.message : String(err)),
            'EMBED_FAILED',
          );
        }
      }

      const now = new Date().toISOString();
      this.db
        .transaction(() => {
          this.setProgress(ref.id, 'done', 100);
          this.db
            .prepare(
              "UPDATE videos SET stage = 'done', ingested_at = ?, last_accessed_at = ?, error_code = ?, error_detail = ? WHERE id = ?",
            )
            .run(
              now,
              now,
              warnings[0]?.code ?? null,
              warnings.length > 0
                ? warnings.map((w) => `[${w.code}] ${w.message}`).join(' | ')
                : null,
              ref.id,
            );
        })
        .immediate();
    } catch (err) {
      // Hard failure: mark the error but leave all previously derived data
      // (from this run's completed swaps or an earlier ingest) untouched.
      if (this.ownsJob(ref.id)) {
        const code = err instanceof VcmError ? err.code : 'YTDLP_FAILED';
        const detail = err instanceof Error ? err.message : String(err);
        this.db
          .transaction(() => {
            this.setProgress(ref.id, 'error', 0);
            this.db
              .prepare(
                "UPDATE videos SET stage = 'error', error_code = ?, error_detail = ? WHERE id = ?",
              )
              .run(code, detail, ref.id);
          })
          .immediate();
      } else {
        console.error(`[video-context-mcp] stopped stale ingest worker for ${ref.id}`);
      }
    } finally {
      safeRm(workDir);
      try {
        this.cache.refreshVideoUsage(ref.id);
      } catch (err) {
        console.error(
          `[video-context-mcp] cache accounting for ${ref.id} failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)}`,
        );
      }
      await this.maintainCache('post_ingest', new Set([...this.runningIds(), ref.id]));
    }
  }

  /**
   * frames stage (download + scene-detect keyframes) then ocr stage.
   * Frame rows are committed as soon as extraction succeeds — OCR failure
   * (e.g. tesseract missing) degrades to unclassified frames, not zero frames.
   */
  private async runVisual(ref: VideoRef, videoDir: string, workDir: string): Promise<void> {
    this.setStage(ref.id, 'frames', 45);
    let videoPath: string;
    if (ref.kind === 'youtube') {
      mkdirSync(workDir, { recursive: true });
      videoPath = await downloadVideo(ref, workDir, this.config);
    } else {
      videoPath = ref.source; // never deleted — the user's own file
    }

    const duration = (
      this.db.prepare('SELECT duration_s AS d FROM videos WHERE id = ?').get(ref.id) as {
        d: number | null;
      }
    ).d;
    const frames = await extractFrames(videoPath, videoDir, this.config, duration);
    this.assertOwnsJob(ref.id);
    if (ref.kind === 'youtube') safeRm(videoPath); // source media gone ASAP

    // Swap in the new frame generation (files are already in place on disk).
    const insertFrame = this.db.prepare(
      'INSERT INTO frames (video_id, ts_ms, path, width, height, class) VALUES (?, ?, ?, ?, ?, NULL)',
    );
    const frameIds: number[] = [];
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM frames WHERE video_id = ?').run(ref.id);
      for (const f of frames) {
        const res = insertFrame.run(ref.id, f.tsMs, f.path, f.width, f.height);
        frameIds.push(Number(res.lastInsertRowid));
      }
    })();

    this.setStage(ref.id, 'ocr', 65);
    const updateClass = this.db.prepare('UPDATE frames SET class = ? WHERE id = ?');
    const insertBlock = this.db.prepare(
      'INSERT INTO ocr_blocks (frame_id, text, bbox_json, conf) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const blocks = await ocrFrame(frame.path, this.config); // throws only on missing binary
      this.assertOwnsJob(ref.id);
      const cls = classifyFrame(blocks);
      this.db.transaction(() => {
        updateClass.run(cls, frameIds[i]!);
        for (const b of blocks) {
          insertBlock.run(frameIds[i]!, b.text, JSON.stringify(b.bbox), b.conf);
        }
      })();
      if (i % 5 === 4) {
        this.setProgress(ref.id, 'ocr', 65 + Math.round((30 * (i + 1)) / frames.length));
      }
    }
  }
}
