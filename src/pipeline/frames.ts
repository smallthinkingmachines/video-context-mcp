/**
 * Keyframe extraction: ffmpeg scene-change detection with showinfo timestamp
 * parsing, a dedicated opening-frame pass (scene detection only fires on
 * *changes*, so t=0 needs its own capture), a minimum-gap rate cap, and
 * ≤1280px JPEG storage named by millisecond timestamp.
 *
 * Extraction is generational: frames are written to `frames.staging/` and the
 * live `frames/` directory is swapped in only after extraction succeeds, so a
 * failed re-ingest never destroys the previous keyframes.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { VcmError } from '../errors.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const STORE_WIDTH = 1280;
const EXTRACT_TIMEOUT_MS = 30 * 60_000;
const IMAGE_OP_TIMEOUT_MS = 60_000;

export interface ExtractedFrame {
  tsMs: number;
  path: string;
  width: number;
  height: number;
}

export interface ShowinfoFrame {
  index: number;
  tsMs: number;
  width: number;
  height: number;
}

const SHOWINFO_RE = /Parsed_showinfo.*?\sn:\s*(\d+)\s.*?pts_time:([\d.]+).*?\ss:(\d+)x(\d+)/;

/** Parse ffmpeg showinfo stderr lines into per-frame index/timestamp/dims. */
export function parseShowinfo(stderr: string): ShowinfoFrame[] {
  const frames: ShowinfoFrame[] = [];
  for (const line of stderr.split('\n')) {
    const m = line.match(SHOWINFO_RE);
    if (m) {
      frames.push({
        index: Number(m[1]),
        tsMs: Math.round(Number(m[2]) * 1000),
        width: Number(m[3]),
        height: Number(m[4]),
      });
    }
  }
  return frames;
}

/**
 * Enforce the minimum gap between kept frames and the total cap.
 * Returns the kept subset (input order preserved).
 */
export function filterByGap<T extends { tsMs: number }>(
  frames: T[],
  minGapMs: number,
  maxFrames: number,
): T[] {
  const kept: T[] = [];
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const f of frames) {
    if (f.tsMs - lastMs >= minGapMs) {
      kept.push(f);
      lastMs = f.tsMs;
      if (kept.length >= maxFrames) break;
    }
  }
  return kept;
}

/** Consecutive scene candidates closer than this are treated as one burst. */
const BURST_GAP_MS = 1000;
/** A burst is cut once it spans this long, so continuous motion still yields frames. */
const MAX_BURST_MS = 5000;

/**
 * Collapse bursts of consecutive scene-change candidates into one frame each.
 * A fade, zoom or wipe fires scene detection on many consecutive frames, and the
 * first of them is mid-transition. Within a burst (candidates no more than
 * `burstGapMs` apart) keep the last frame, where the picture has settled. A burst
 * is cut once it spans `maxBurstMs`. Input must be sorted by time.
 */
export function collapseBursts<T extends { tsMs: number }>(
  frames: T[],
  burstGapMs: number,
  maxBurstMs: number,
): T[] {
  const kept: T[] = [];
  let burstStartMs = 0;
  let lastMs = 0;
  let pending: T | undefined;
  for (const f of frames) {
    const continuesBurst =
      pending !== undefined && f.tsMs - lastMs <= burstGapMs && f.tsMs - burstStartMs <= maxBurstMs;
    if (!continuesBurst) {
      if (pending) kept.push(pending);
      burstStartMs = f.tsMs;
    }
    pending = f;
    lastMs = f.tsMs;
  }
  if (pending) kept.push(pending);
  return kept;
}

async function runFfmpeg(args: string[], config: Config, timeoutMs: number): Promise<string> {
  try {
    const { stderr } = await execFileAsync(config.ffmpegBin, args, {
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    return stderr;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === 'ENOENT') {
      throw new VcmError(
        'BINARY_MISSING',
        'ffmpeg was not found on PATH. Install ffmpeg or set VCM_FFMPEG_BIN.',
      );
    }
    if (e.killed) {
      throw new VcmError(
        'VISUAL_FAILED',
        `ffmpeg timed out after ${Math.round(timeoutMs / 60000)} min and was killed.`,
      );
    }
    if (
      /nothing was (encoded|written)|received no packets|Output file is empty/i.test(e.stderr ?? '')
    ) {
      throw new VcmError('VISUAL_FAILED', 'FFmpeg produced no frames from this selection.');
    }
    throw new VcmError(
      'VISUAL_FAILED',
      'FFmpeg could not extract frames from this media. The file may be corrupt or use an unsupported codec; run video-context-mcp doctor and retry.',
    );
  }
}

interface RawFrame {
  tsMs: number;
  width: number;
  height: number;
  rawPath: string;
}

async function extractPass(
  videoPath: string,
  outDir: string,
  vf: string,
  prefix: string,
  maxOutputFrames: number,
  config: Config,
): Promise<RawFrame[]> {
  const args = [
    '-hide_banner',
    '-nostats',
    '-i',
    videoPath,
    '-vf',
    vf,
    '-fps_mode',
    'vfr',
    // Bound ffmpeg itself: without this, a fast-cut long video can write an
    // unbounded number of JPEGs before the post-hoc gap filter ever runs.
    '-frames:v',
    String(maxOutputFrames),
    '-q:v',
    '4',
    join(outDir, `${prefix}-%06d.jpg`),
  ];
  let stderr: string;
  try {
    stderr = await runFfmpeg(args, config, EXTRACT_TIMEOUT_MS);
  } catch (err) {
    // ffmpeg exits non-zero when a select filter matches no frames at all —
    // "Output file is empty, nothing was encoded" (≤v7) or "Nothing was
    // written into output file … received no packets" (v8+). That is a valid
    // outcome (static video) — signal zero frames so the caller can fall back.
    if (err instanceof VcmError && /produced no frames/i.test(err.message)) {
      return [];
    }
    throw err;
  }
  // Output files <prefix>-000001.jpg… are 1-indexed in showinfo order (n: 0-based).
  return parseShowinfo(stderr).map((f) => ({
    tsMs: f.tsMs,
    width: f.width,
    height: f.height,
    rawPath: join(outDir, `${prefix}-${String(f.index + 1).padStart(6, '0')}.jpg`),
  }));
}

/**
 * Extract keyframes from a video file into `<videoDir>/frames/` (via a staging
 * dir swapped in on success). Always captures the opening frame; scene-change
 * detection covers the rest; falls back to interval sampling for static video.
 */
export async function extractFrames(
  videoPath: string,
  videoDir: string,
  config: Config,
  durationS?: number | null,
): Promise<ExtractedFrame[]> {
  const framesDir = join(videoDir, 'frames');
  const stagingDir = join(videoDir, 'frames.staging');
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  const scale = `scale='min(${STORE_WIDTH},iw)':-2`;

  // Opening frame: scene detection only fires on changes, so t=0 is captured
  // explicitly — otherwise peek_frame(0) would return the first *cut* instead.
  const first = await extractPass(videoPath, stagingDir, `${scale},showinfo`, 'zero', 1, config);

  let scene = await extractPass(
    videoPath,
    stagingDir,
    `select='gt(scene,${config.sceneThreshold})',${scale},showinfo`,
    'scene',
    config.maxFrames * 3,
    config,
  );

  // Fades and zooms fire scene detection on many consecutive frames; keep only
  // the settled (last) frame of each burst. Skipped for the interval fallback.
  scene = collapseBursts(scene, BURST_GAP_MS, MAX_BURST_MS);

  if (scene.length === 0) {
    // Static video (single slide, fixed camera): sample on an interval instead.
    // ffmpeg 8's fps filter emits nothing for videos shorter than the period,
    // so clamp the interval to half the duration when we know it.
    const interval =
      durationS && durationS > 0 ? Math.max(1, Math.min(60, Math.floor(durationS / 2))) : 60;
    scene = await extractPass(
      videoPath,
      stagingDir,
      `fps=1/${interval},${scale},showinfo`,
      'iv',
      config.maxFrames * 3,
      config,
    );
  }

  const all = [...first, ...scene].sort((a, b) => a.tsMs - b.tsMs);
  const kept = filterByGap(all, config.minFrameGapS * 1000, config.maxFrames);
  const keptPaths = new Set<string>();

  const results: ExtractedFrame[] = [];
  for (const f of kept) {
    const finalName = `${String(f.tsMs).padStart(9, '0')}.jpg`;
    renameSync(f.rawPath, join(stagingDir, finalName));
    keptPaths.add(finalName);
    results.push({
      tsMs: f.tsMs,
      width: f.width,
      height: f.height,
      path: join(framesDir, finalName),
    });
  }
  for (const file of readdirSync(stagingDir)) {
    if (!keptPaths.has(file)) rmSync(join(stagingDir, file), { force: true });
  }

  // Swap the new generation in only now that it is complete.
  rmSync(framesDir, { recursive: true, force: true });
  renameSync(stagingDir, framesDir);
  return results;
}

/** Re-encode a stored frame to ≤maxWidth for compact MCP image payloads. */
export async function reencodeFrame(
  srcPath: string,
  destPath: string,
  maxWidth: number,
  config: Config,
): Promise<void> {
  await runFfmpeg(
    [
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      srcPath,
      '-vf',
      `scale='min(${maxWidth},iw)':-2`,
      '-q:v',
      '5',
      destPath,
    ],
    config,
    IMAGE_OP_TIMEOUT_MS,
  );
}

/** Crop a normalized bbox out of a stored frame, upscaling small crops ≤2×. */
export async function cropFrame(
  srcPath: string,
  destPath: string,
  frameW: number,
  frameH: number,
  bbox: [number, number, number, number],
  config: Config,
): Promise<void> {
  const [x0, y0, x1, y1] = bbox;
  const x = Math.round(x0 * frameW);
  const y = Math.round(y0 * frameH);
  const w = Math.max(8, Math.round((x1 - x0) * frameW));
  const h = Math.max(8, Math.round((y1 - y0) * frameH));
  await runFfmpeg(
    [
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      srcPath,
      '-vf',
      `crop=${w}:${h}:${x}:${y},scale='min(1024,iw*2)':-2`,
      '-q:v',
      '4',
      destPath,
    ],
    config,
    IMAGE_OP_TIMEOUT_MS,
  );
}
