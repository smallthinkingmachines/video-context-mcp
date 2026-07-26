/**
 * Local ASR fallback via whisper.cpp (`whisper-cli`). Only invoked when a
 * video has no captions AND the ingest asked for whisper_fallback. Emits VTT
 * so the transcript flows through the same parser as YouTube captions.
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type * as transformersT from '@huggingface/transformers';
import type { Config } from '../config.js';
import { VcmError } from '../errors.js';

const execFileAsync = promisify(execFile);
type AutomaticSpeechRecognitionOutput = transformersT.AutomaticSpeechRecognitionOutput;
type AutomaticSpeechRecognitionPipelineType = transformersT.AutomaticSpeechRecognitionPipelineType;
type Chunk = transformersT.Chunk;
const TRANSFORMERS_RUNTIME = '../../vendor/transformers.node.min.mjs';

const DEFAULT_MODEL = 'ggml-base.en.bin';
const NATIVE_MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${NATIVE_MODEL_REVISION}/${DEFAULT_MODEL}`;
const MODEL_SHA256 = 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002';
const MODEL_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/** base.en is ~148 MB; anything tiny is an error page, not a model. */
const MODEL_MIN_BYTES = 10 * 1024 * 1024;
const WAV_TIMEOUT_MS = 10 * 60_000;
const WHISPER_TIMEOUT_MS = 4 * 60 * 60_000;
let downloadCounter = 0;
const verifiedNativeModels = new Set<string>();
let asrPipeline: Promise<AutomaticSpeechRecognitionPipelineType> | null = null;
let asrPipelineKey = '';
let transformerQueue: Promise<void> = Promise.resolve();
const nativeAvailability = new Map<string, Promise<boolean>>();

const ASR_WINDOW_S = 30;
const ASR_OVERLAP_S = 5;
const PCM_BYTES_PER_SECOND = 16_000 * 4;

export type ProgressFn = (pct: number, note?: string) => void;

/** whisper-cli `-pp` lines look like: "... progress =  15%". */
export function parseWhisperProgress(line: string): number | null {
  const m = line.match(/progress\s*=\s*(\d+)%/);
  return m ? Number(m[1]) : null;
}

/** English-only ggml models ("…base.en.bin") must not get `-l auto`. */
export function isEnglishOnlyModel(modelPath: string): boolean {
  return /\.en\b/.test(basename(modelPath));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Resolve the model path, auto-downloading the default model on first use. */
export async function ensureWhisperModel(config: Config, onProgress?: ProgressFn): Promise<string> {
  if (config.whisperModel) {
    if (!existsSync(config.whisperModel)) {
      throw new VcmError(
        'ASR_FAILED',
        `VCM_WHISPER_MODEL points to a missing file: ${config.whisperModel}. Download a ggml model (e.g. from huggingface.co/ggerganov/whisper.cpp) or unset the variable to auto-download base.en.`,
      );
    }
    return config.whisperModel;
  }
  const dest = join(config.cacheDir, 'models', DEFAULT_MODEL);
  if (existsSync(dest)) {
    if (!verifiedNativeModels.has(dest)) {
      if ((await sha256File(dest)) !== MODEL_SHA256) {
        throw new VcmError(
          'ASR_FAILED',
          `The cached native ASR model failed checksum verification: ${dest}. Remove that disposable cache file and retry, or use VCM_ASR_BACKEND=transformers.`,
        );
      }
      verifiedNativeModels.add(dest);
    }
    return dest;
  }

  onProgress?.(0, `downloading whisper model ${DEFAULT_MODEL} (~148 MB, one-time)`);
  mkdirSync(dirname(dest), { recursive: true });
  // Unique temp name: two concurrent first-use jobs must not race on one file.
  const tmp = `${dest}.download.${process.pid}.${++downloadCounter}`;
  try {
    const res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(MODEL_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(tmp),
    );
    if (statSync(tmp).size < MODEL_MIN_BYTES) {
      throw new Error('downloaded file is far too small to be a whisper model');
    }
    if ((await sha256File(tmp)) !== MODEL_SHA256) {
      throw new Error('downloaded whisper model failed checksum verification');
    }
    if (existsSync(dest)) {
      // Another concurrent job won the race; use its copy.
      rmSync(tmp, { force: true });
      return ensureWhisperModel(config, onProgress);
    }
    renameSync(tmp, dest);
    verifiedNativeModels.add(dest);
    return dest;
  } catch (err) {
    rmSync(tmp, { force: true });
    if (existsSync(dest)) return ensureWhisperModel(config, onProgress);
    throw new VcmError(
      'NETWORK',
      `Failed to download the whisper model (${err instanceof Error ? err.message : err}). ` +
        `Download it manually to ${dest} (source: ${MODEL_URL}) or set VCM_WHISPER_MODEL.`,
    );
  }
}

/** Extract/convert any media file to the 16 kHz mono WAV whisper.cpp needs. */
export async function toWav16k(mediaPath: string, wavPath: string, config: Config): Promise<void> {
  try {
    await execFileAsync(
      config.ffmpegBin,
      [
        '-hide_banner',
        '-nostats',
        '-y',
        '-i',
        mediaPath,
        '-vn',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        wavPath,
      ],
      { maxBuffer: 16 * 1024 * 1024, timeout: WAV_TIMEOUT_MS, killSignal: 'SIGKILL' },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === 'ENOENT') {
      throw new VcmError(
        'BINARY_MISSING',
        'ffmpeg was not found on PATH. Install ffmpeg or set VCM_FFMPEG_BIN.',
      );
    }
    if (e.killed) {
      throw new VcmError('ASR_FAILED', 'ffmpeg audio extraction timed out and was killed.');
    }
    throw new VcmError(
      'ASR_FAILED',
      'FFmpeg could not decode this media for native ASR. Verify the file and run video-context-mcp doctor.',
    );
  }
}

function runWhisperCli(
  modelPath: string,
  wavPath: string,
  outBase: string,
  config: Config,
  onProgress?: ProgressFn,
): Promise<void> {
  const args = ['-m', modelPath, '-f', wavPath, '-ovtt', '-of', outBase, '-pp', '-np'];
  if (!isEnglishOnlyModel(modelPath)) args.push('-l', 'auto');

  return new Promise((resolve, reject) => {
    const child = spawn(config.whisperBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, WHISPER_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      for (const line of s.split('\n')) {
        const pct = parseWhisperProgress(line);
        if (pct !== null) onProgress?.(pct);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(killTimer);
      reject(
        err.code === 'ENOENT'
          ? new VcmError(
              'BINARY_MISSING',
              'whisper-cli was not found on PATH. Install whisper.cpp or set VCM_WHISPER_BIN.',
            )
          : new VcmError('ASR_FAILED', `whisper-cli failed to start: ${err.message}`),
      );
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (timedOut) {
        reject(
          new VcmError(
            'ASR_FAILED',
            `whisper-cli exceeded the ${WHISPER_TIMEOUT_MS / 3_600_000}h limit and was killed.`,
          ),
        );
      } else if (code === 0) resolve();
      else {
        reject(
          new VcmError(
            'ASR_FAILED',
            `whisper-cli exited with code ${code}. Verify VCM_WHISPER_BIN/VCM_WHISPER_MODEL or use VCM_ASR_BACKEND=transformers.`,
          ),
        );
      }
    });
  });
}

async function nativeWhisperAvailable(binary: string): Promise<boolean> {
  let probe = nativeAvailability.get(binary);
  if (!probe) {
    probe = execFileAsync(binary, ['--help'], { timeout: 10_000, windowsHide: true })
      .then(() => true)
      .catch(() => false);
    nativeAvailability.set(binary, probe);
  }
  return probe;
}

async function loadAsrPipeline(
  config: Config,
  onProgress?: ProgressFn,
): Promise<AutomaticSpeechRecognitionPipelineType> {
  const key = `${config.asrModel}@${config.asrRevision}:${config.cacheDir}`;
  if (asrPipeline && asrPipelineKey === key) return asrPipeline;
  const { pipeline, env } = (await import(TRANSFORMERS_RUNTIME)) as typeof transformersT;
  env.cacheDir = join(config.cacheDir, 'transformers');
  asrPipelineKey = key;
  asrPipeline = pipeline('automatic-speech-recognition', config.asrModel, {
    dtype: 'q8',
    revision: config.asrRevision,
    progress_callback: (progress) => {
      if ('progress' in progress && typeof progress.progress === 'number') {
        onProgress?.(Math.min(10, Math.round(progress.progress / 10)), 'loading ASR model');
      }
    },
  }).catch((err) => {
    asrPipeline = null;
    throw new VcmError(
      'ASR_FAILED',
      `Could not load the self-contained ASR model ${config.asrModel} (${err instanceof Error ? err.message.slice(0, 200) : err}). Check network access or run video-context-mcp setup --all.`,
    );
  });
  return asrPipeline;
}

export async function warmAsr(config: Config, onProgress?: ProgressFn): Promise<void> {
  await loadAsrPipeline(config, onProgress);
}

async function readPcmWindow(
  mediaPath: string,
  startS: number,
  config: Config,
): Promise<Float32Array> {
  try {
    const { stdout } = await execFileAsync(
      config.ffmpegBin,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(startS),
        '-i',
        mediaPath,
        '-t',
        String(ASR_WINDOW_S),
        '-vn',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_f32le',
        '-f',
        'f32le',
        'pipe:1',
      ],
      {
        encoding: 'buffer',
        maxBuffer: ASR_WINDOW_S * PCM_BYTES_PER_SECOND + 1024 * 1024,
        timeout: WAV_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
    );
    const bytes = stdout.subarray(0, stdout.length - (stdout.length % 4));
    const copy = Uint8Array.from(bytes);
    return new Float32Array(copy.buffer);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer; killed?: boolean };
    if (e.code === 'ENOENT') {
      throw new VcmError(
        'BINARY_MISSING',
        'ffmpeg is unavailable for ASR. Run video-context-mcp setup or set VCM_FFMPEG_BIN.',
      );
    }
    if (e.killed) throw new VcmError('ASR_FAILED', 'FFmpeg audio decoding timed out.');
    throw new VcmError(
      'ASR_FAILED',
      'FFmpeg could not decode audio for ASR. The media may be corrupt or use an unsupported codec; run video-context-mcp doctor.',
    );
  }
}

export interface TimestampedText {
  startS: number;
  endS: number;
  text: string;
}

/** Assign overlapped ASR chunks to one window by their timestamp midpoint. */
export function ownWindowChunks(
  chunks: Chunk[],
  windowStartS: number,
  isLast: boolean,
): TimestampedText[] {
  const left = windowStartS === 0 ? Number.NEGATIVE_INFINITY : windowStartS + ASR_OVERLAP_S / 2;
  const right = isLast ? Number.POSITIVE_INFINITY : windowStartS + ASR_WINDOW_S - ASR_OVERLAP_S / 2;
  return chunks
    .map((chunk) => ({
      startS: windowStartS + chunk.timestamp[0],
      endS: windowStartS + chunk.timestamp[1],
      text: chunk.text.trim(),
    }))
    .filter((chunk) => {
      const midpoint = (chunk.startS + chunk.endS) / 2;
      return chunk.text.length > 0 && midpoint >= left && midpoint < right;
    });
}

function vttTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function chunksToVtt(chunks: TimestampedText[]): string {
  const cues = chunks.map(
    (chunk, index) =>
      `${index + 1}\n${vttTime(chunk.startS)} --> ${vttTime(Math.max(chunk.endS, chunk.startS + 0.1))}\n${chunk.text}`,
  );
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

async function transcribeTransformers(
  mediaPath: string,
  config: Config,
  onProgress?: ProgressFn,
  durationS?: number | null,
): Promise<string> {
  let releaseTurn: (() => void) | undefined;
  const previous = transformerQueue;
  transformerQueue = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  await previous;
  try {
    const transcriber = await loadAsrPipeline(config, onProgress);
    const kept: TimestampedText[] = [];
    const step = ASR_WINDOW_S - ASR_OVERLAP_S;
    for (let startS = 0, window = 0; ; startS += step, window++) {
      if (durationS && startS >= durationS) break;
      const audio = await readPcmWindow(mediaPath, startS, config);
      if (audio.length === 0) break;
      const decodedS = audio.length / 16_000;
      const isLast = durationS
        ? startS + ASR_WINDOW_S >= durationS
        : decodedS < ASR_WINDOW_S - 0.05;
      const raw = await transcriber(audio, { return_timestamps: true });
      const output = (Array.isArray(raw) ? raw[0] : raw) as AutomaticSpeechRecognitionOutput;
      const chunks = output.chunks?.length
        ? output.chunks
        : [{ timestamp: [0, decodedS] as [number, number], text: output.text }];
      kept.push(...ownWindowChunks(chunks, startS, isLast));
      const pct = durationS
        ? Math.min(100, Math.round(((startS + decodedS) / durationS) * 100))
        : Math.min(99, 10 + window);
      onProgress?.(pct, `transcribing audio ${vttTime(startS)}`);
      if (isLast) break;
    }
    onProgress?.(100, 'transcription complete');
    return chunksToVtt(kept);
  } finally {
    releaseTurn?.();
  }
}

/**
 * Full ASR path: model → 16k WAV → whisper-cli → VTT text.
 * onProgress receives 0..100 within the transcription.
 */
export async function transcribeToVtt(
  mediaPath: string,
  workDir: string,
  config: Config,
  onProgress?: ProgressFn,
  durationS?: number | null,
): Promise<string> {
  const useNative =
    config.asrBackend === 'native' ||
    (config.asrBackend === 'auto' &&
      (Boolean(config.binaryOverrides.whisper) ||
        Boolean(config.whisperModel) ||
        (await nativeWhisperAvailable(config.whisperBin))));
  if (!useNative) return transcribeTransformers(mediaPath, config, onProgress, durationS);

  const modelPath = await ensureWhisperModel(config, onProgress);
  const wavPath = join(workDir, 'audio16k.wav');
  await toWav16k(mediaPath, wavPath, config);
  const outBase = join(workDir, 'whisper-out');
  await runWhisperCli(modelPath, wavPath, outBase, config, onProgress);
  try {
    return readFileSync(`${outBase}.vtt`, 'utf-8');
  } catch {
    throw new VcmError('ASR_FAILED', 'whisper-cli finished but produced no VTT output.');
  }
}
