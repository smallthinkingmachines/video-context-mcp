import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { VcmError, classifyYtdlpFailure } from '../errors.js';
import type { VideoRef } from '../ids.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 3 * 60_000;
const AUDIO_TIMEOUT_MS = 15 * 60_000;
const VIDEO_TIMEOUT_MS = 30 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;

export interface ChapterInfo {
  startMs: number;
  title: string;
}

export interface CaptionTrack {
  lang: string;
  auto: boolean;
}

export interface VideoMetadata {
  title: string;
  channel: string | null;
  uploadDate: string | null;
  durationS: number | null;
  chapters: ChapterInfo[];
  manualCaptionLangs: string[];
  autoCaptionLangs: string[];
}

/** Parse the stable subset of yt-dlp metadata consumed by the ingest pipeline. */
export function parseYoutubeMetadata(stdout: string, fallbackId: string): VideoMetadata {
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new VcmError('YTDLP_FAILED', 'yt-dlp returned unparseable metadata JSON.');
  }
  const chaptersRaw = Array.isArray(info.chapters)
    ? (info.chapters as { start_time?: number; title?: string }[])
    : [];
  return {
    title: typeof info.title === 'string' ? info.title : fallbackId,
    channel: typeof info.channel === 'string' ? info.channel : null,
    uploadDate: normalizeUploadDate(info.upload_date),
    durationS: typeof info.duration === 'number' ? info.duration : null,
    chapters: chaptersRaw
      .filter((c) => typeof c.start_time === 'number' && typeof c.title === 'string')
      .map((c) => ({
        startMs: Math.round((c.start_time as number) * 1000),
        title: c.title as string,
      })),
    manualCaptionLangs: Object.keys((info.subtitles as object) ?? {}),
    autoCaptionLangs: Object.keys((info.automatic_captions as object) ?? {}),
  };
}

/** Normalize yt-dlp's YYYYMMDD value; reject impossible calendar dates. */
export function normalizeUploadDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export function buildYtdlpArgs(args: string[], config: Config): string[] {
  return [
    '--ignore-config',
    '--js-runtimes',
    `node:${process.execPath}`,
    ...(config.cookiesFile ? ['--cookies', config.cookiesFile] : []),
    ...args,
  ];
}

async function runYtdlp(args: string[], config: Config, timeoutMs: number): Promise<string> {
  const fullArgs = buildYtdlpArgs(args, config);
  try {
    const { stdout } = await execFileAsync(config.ytdlpBin, fullArgs, {
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.killed) {
      throw new VcmError(
        'NETWORK',
        `yt-dlp timed out after ${Math.round(timeoutMs / 60000)} min and was killed. Check connectivity and retry.`,
      );
    }
    throw classifyYtdlpFailure(e.stderr ?? e.message ?? '', Boolean(config.cookiesFile), e);
  }
}

export async function fetchYoutubeMetadata(ref: VideoRef, config: Config): Promise<VideoMetadata> {
  const stdout = await runYtdlp(
    ['-J', '--no-warnings', '--skip-download', ref.source],
    config,
    METADATA_TIMEOUT_MS,
  );
  return parseYoutubeMetadata(stdout, ref.id);
}

/** Prefer manual English > any manual > auto English > any auto. */
export function pickCaptionTrack(meta: VideoMetadata): CaptionTrack | null {
  const pickLang = (langs: string[]): string | undefined =>
    langs.find((l) => l === 'en') ?? langs.find((l) => l.startsWith('en')) ?? langs[0];

  // yt-dlp lists non-downloadable "live_chat" as a subtitle track; exclude it.
  const manual = meta.manualCaptionLangs.filter((l) => l !== 'live_chat');
  const manualLang = pickLang(manual);
  if (manualLang) return { lang: manualLang, auto: false };
  const autoLang = pickLang(meta.autoCaptionLangs);
  if (autoLang) return { lang: autoLang, auto: true };
  return null;
}

/** Download one caption track as VTT text. */
export async function downloadCaptions(
  ref: VideoRef,
  track: CaptionTrack,
  workDir: string,
  config: Config,
): Promise<string> {
  await runYtdlp(
    [
      '--skip-download',
      '--no-warnings',
      track.auto ? '--write-auto-subs' : '--write-subs',
      '--sub-langs',
      track.lang,
      '--sub-format',
      'vtt/best',
      '--convert-subs',
      'vtt',
      '-P',
      workDir,
      '-o',
      '%(id)s.%(ext)s',
      ref.source,
    ],
    config,
    METADATA_TIMEOUT_MS,
  );
  const expected = join(workDir, `${ref.id}.${track.lang}.vtt`);
  try {
    return readFileSync(expected, 'utf-8');
  } catch {
    // Fall back to any .vtt yt-dlp produced (lang tag variants like en-orig).
    const vtt = readdirSync(workDir).find((f) => f.endsWith('.vtt'));
    if (vtt) return readFileSync(join(workDir, vtt), 'utf-8');
    throw new VcmError(
      'NO_CAPTIONS',
      `Caption track "${track.lang}" was advertised but could not be downloaded.`,
    );
  }
}

/**
 * Download the video stream (capped height, no audio needed) for frame
 * extraction. Returns the downloaded file path inside workDir; the caller
 * deletes it as soon as frames are extracted.
 */
export async function downloadVideo(
  ref: VideoRef,
  workDir: string,
  config: Config,
): Promise<string> {
  const h = config.maxVideoHeight;
  await runYtdlp(
    [
      '-f',
      `bestvideo[height<=${h}]/best[height<=${h}]/best`,
      '--no-warnings',
      '--no-playlist',
      '-P',
      workDir,
      '-o',
      'video.%(ext)s',
      ref.source,
    ],
    config,
    VIDEO_TIMEOUT_MS,
  );
  const file = readdirSync(workDir).find((f) => f.startsWith('video.'));
  if (!file) {
    throw new VcmError('VISUAL_FAILED', 'yt-dlp reported success but produced no video file.');
  }
  return join(workDir, file);
}

/** Download only the audio stream (for whisper ASR). Caller deletes after use. */
export async function downloadAudio(
  ref: VideoRef,
  workDir: string,
  config: Config,
): Promise<string> {
  await runYtdlp(
    [
      '-f',
      'bestaudio/best',
      '--no-warnings',
      '--no-playlist',
      '-P',
      workDir,
      '-o',
      'audio.%(ext)s',
      ref.source,
    ],
    config,
    AUDIO_TIMEOUT_MS,
  );
  const file = readdirSync(workDir).find((f) => f.startsWith('audio.'));
  if (!file) {
    throw new VcmError('ASR_FAILED', 'yt-dlp reported success but produced no audio file.');
  }
  return join(workDir, file);
}

/** Duration (and little else) for local files, via ffprobe. */
export async function probeLocalFile(
  absPath: string,
  config: Config,
): Promise<{ durationS: number | null }> {
  try {
    const { stdout } = await execFileAsync(
      config.ffprobeBin,
      ['-v', 'error', '-print_format', 'json', '-show_format', absPath],
      { maxBuffer: MAX_BUFFER, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
    );
    const info = JSON.parse(stdout) as { format?: { duration?: string } };
    const d = info.format?.duration ? Number(info.format.duration) : null;
    return { durationS: d && Number.isFinite(d) ? d : null };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      throw new VcmError(
        'BINARY_MISSING',
        'ffprobe was not found on PATH. Install ffmpeg or set VCM_FFPROBE_BIN.',
      );
    }
    throw new VcmError(
      'YTDLP_FAILED',
      'ffprobe could not read this file. The media may be corrupt or use an unsupported container; run video-context-mcp doctor and verify the file plays locally.',
    );
  }
}
