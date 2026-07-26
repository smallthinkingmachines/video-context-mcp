/**
 * Dense embeddings for hybrid search: Transformers.js (ONNX, local CPU) into
 * LanceDB beside the SQLite index. All imports of this module are dynamic —
 * the model runtime never loads unless embedding or semantic search is used.
 *
 * Storage is generational like everything else: a video's vectors are
 * replaced atomically per ingest, keyed by stable row ids (seg-N / frame-N).
 */
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type * as transformersT from '@huggingface/transformers';
import type * as lancedbT from '@lancedb/lancedb';
import type Database from 'better-sqlite3';
import { type Config, DEFAULT_EMBED_MODEL, DEFAULT_EMBED_REVISION } from '../config.js';
import { VcmError } from '../errors.js';
import { type RuntimeLock, acquireRuntimeLock } from '../runtime/lock.js';

const TABLE = 'chunks';
type FeatureExtractionPipeline = transformersT.FeatureExtractionPipeline;
const TRANSFORMERS_RUNTIME = '../../vendor/transformers.node.min.mjs';
const BATCH_SIZE = 16;
const MAX_DOC_CHARS = 1000;
const MIN_SCREEN_CHARS = 20;

export const DEFAULT_EMBED_ARTIFACT = {
  model: DEFAULT_EMBED_MODEL,
  revision: DEFAULT_EMBED_REVISION,
  relativePath: 'onnx/model_quantized.onnx',
  size: 22_972_370,
  sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
} as const;

export type EmbeddingCacheState = 'not_cached' | 'verified' | 'invalid' | 'custom_unverified';

export interface EmbeddingCacheHealth {
  state: EmbeddingCacheState;
  model: string;
  revision: string;
  path: string | null;
  expectedSize: number | null;
  actualSize: number | null;
  sha256: string | null;
  remediation: string | null;
}

export interface EmbeddingLoadOps {
  initialize(config: Config): Promise<FeatureExtractionPipeline>;
  inspect(config: Config): Promise<EmbeddingCacheHealth>;
  removeInvalid(config: Config): Promise<void>;
  acquire(config: Config): Promise<Pick<RuntimeLock, 'release'>>;
}

export interface EmbedDoc {
  id: string;
  kind: 'speech' | 'screen';
  ts_ms: number;
  text: string;
}

export interface VectorHit {
  id: string;
  video_id: string;
  kind: 'speech' | 'screen';
  ts_ms: number;
  text: string;
}

export interface EmbedStats {
  count: number;
  vectorBytes: number;
}

interface EmbedFrame {
  id: number;
  ts_ms: number;
  ocrText: string | null;
}

/** Pure doc builder (unit-tested): what gets embedded for a video. */
export function buildEmbedDocs(
  segments: { id: number; start_ms: number; text: string }[],
  frames: { id: number; ts_ms: number; ocrText: string | null }[],
): EmbedDoc[] {
  const docs: EmbedDoc[] = [];
  for (const s of segments) {
    const text = s.text.trim().slice(0, MAX_DOC_CHARS);
    if (text) docs.push({ id: `seg-${s.id}`, kind: 'speech', ts_ms: s.start_ms, text });
  }
  for (const f of frames) {
    const text = (f.ocrText ?? '').trim().slice(0, MAX_DOC_CHARS);
    if (text.length >= MIN_SCREEN_CHARS) {
      docs.push({ id: `frame-${f.id}`, kind: 'screen', ts_ms: f.ts_ms, text });
    }
  }
  return docs;
}

/** Load OCR in stable provider/insertion order before constructing screen documents. */
export function loadEmbedFrames(db: Database.Database, videoId: string): EmbedFrame[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.ts_ms, b.text AS ocr_text
       FROM frames f
       LEFT JOIN ocr_blocks b ON b.frame_id = f.id
       WHERE f.video_id = ?
       ORDER BY f.ts_ms, f.id, b.id`,
    )
    .all(videoId) as { id: number; ts_ms: number; ocr_text: string | null }[];
  const frames = new Map<number, { id: number; ts_ms: number; texts: string[] }>();
  for (const row of rows) {
    let frame = frames.get(row.id);
    if (!frame) {
      frame = { id: row.id, ts_ms: row.ts_ms, texts: [] };
      frames.set(row.id, frame);
    }
    if (row.ocr_text) frame.texts.push(row.ocr_text);
  }
  return [...frames.values()].map((frame) => ({
    id: frame.id,
    ts_ms: frame.ts_ms,
    ocrText: frame.texts.length > 0 ? frame.texts.join(' ') : null,
  }));
}

let vectorMutationTail: Promise<void> = Promise.resolve();

function serializeVectorMutation<T>(fn: () => Promise<T>): Promise<T> {
  const result = vectorMutationTail.then(fn, fn);
  vectorMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function embedKey(config: Config): string {
  return `${config.cacheDir}\0${config.embedModel}\0${config.embedRevision}`;
}

function defaultArtifactPath(config: Config): string | null {
  if (
    config.embedModel !== DEFAULT_EMBED_ARTIFACT.model ||
    config.embedRevision !== DEFAULT_EMBED_ARTIFACT.revision
  ) {
    return null;
  }
  return join(
    config.cacheDir,
    'transformers',
    DEFAULT_EMBED_ARTIFACT.model,
    DEFAULT_EMBED_ARTIFACT.revision,
    DEFAULT_EMBED_ARTIFACT.relativePath,
  );
}

function assertSafeArtifactPath(config: Config, path: string): void {
  const root = resolve(config.cacheDir);
  const candidate = resolve(path);
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new VcmError(
      'EMBED_FAILED',
      'Refusing to modify an embedding artifact outside the cache.',
    );
  }
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new VcmError(
          'EMBED_FAILED',
          `Refusing to modify an embedding cache path containing a symbolic link: ${current}`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Read-only integrity status used by model loading and `doctor`. */
export async function inspectEmbeddingCache(config: Config): Promise<EmbeddingCacheHealth> {
  const path = defaultArtifactPath(config);
  if (path === null) {
    return {
      state: 'custom_unverified',
      model: config.embedModel,
      revision: config.embedRevision,
      path: null,
      expectedSize: null,
      actualSize: null,
      sha256: null,
      remediation:
        'Custom embedding artifacts have no packaged checksum; run video-context-mcp setup --all to load-test this model.',
    };
  }

  try {
    assertSafeArtifactPath(config, path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {
        state: 'invalid',
        model: config.embedModel,
        revision: config.embedRevision,
        path,
        expectedSize: DEFAULT_EMBED_ARTIFACT.size,
        actualSize: stat.size,
        sha256: null,
        remediation: 'Run video-context-mcp setup --all to replace the invalid cached artifact.',
      };
    }
    const sha256 = await sha256File(path);
    const verified =
      stat.size === DEFAULT_EMBED_ARTIFACT.size && sha256 === DEFAULT_EMBED_ARTIFACT.sha256;
    return {
      state: verified ? 'verified' : 'invalid',
      model: config.embedModel,
      revision: config.embedRevision,
      path,
      expectedSize: DEFAULT_EMBED_ARTIFACT.size,
      actualSize: stat.size,
      sha256,
      remediation: verified
        ? null
        : 'Run video-context-mcp setup --all to replace the corrupt or incomplete cached artifact.',
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        state: 'not_cached',
        model: config.embedModel,
        revision: config.embedRevision,
        path,
        expectedSize: DEFAULT_EMBED_ARTIFACT.size,
        actualSize: null,
        sha256: null,
        remediation: 'Run video-context-mcp setup --all to download and verify the model.',
      };
    }
    return {
      state: 'invalid',
      model: config.embedModel,
      revision: config.embedRevision,
      path,
      expectedSize: DEFAULT_EMBED_ARTIFACT.size,
      actualSize: null,
      sha256: null,
      remediation: `Could not inspect the cached artifact (${boundedDetail(err)}). Check cache permissions and run video-context-mcp setup --all.`,
    };
  }
}

function boundedDetail(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replaceAll(/\s+/g, ' ').slice(0, 200);
}

export function isEmbeddingParseFailure(err: unknown): boolean {
  return /protobuf parsing failed|invalid protobuf|could not parse.*onnx|load model .* failed/i.test(
    err instanceof Error ? err.message : String(err),
  );
}

export async function removeInvalidEmbeddingArtifact(config: Config): Promise<void> {
  const path = defaultArtifactPath(config);
  if (path === null) return;
  assertSafeArtifactPath(config, path);
  await rm(path, { force: true });
}

async function initializePipeline(config: Config): Promise<FeatureExtractionPipeline> {
  const { pipeline, env } = (await import(TRANSFORMERS_RUNTIME)) as typeof transformersT;
  env.cacheDir = join(config.cacheDir, 'transformers');
  return (await pipeline('feature-extraction', config.embedModel, {
    dtype: 'q8',
    revision: config.embedRevision,
  })) as FeatureExtractionPipeline;
}

async function acquireEmbeddingLock(config: Config): Promise<Pick<RuntimeLock, 'release'>> {
  const id = `embed-${createHash('sha256').update(embedKey(config)).digest('hex').slice(0, 20)}`;
  return acquireRuntimeLock(join(config.cacheDir, 'transformers'), id, {
    subject: `embedding model ${config.embedModel}@${config.embedRevision}`,
    errorCode: 'EMBED_FAILED',
  });
}

const defaultLoadOps: EmbeddingLoadOps = {
  initialize: initializePipeline,
  inspect: inspectEmbeddingCache,
  removeInvalid: removeInvalidEmbeddingArtifact,
  acquire: acquireEmbeddingLock,
};

/**
 * Build a memoized loader. Exported so concurrency and recovery can be tested
 * without downloading a real model; production uses the default operations.
 */
export function createEmbeddingModelLoader(ops: EmbeddingLoadOps = defaultLoadOps) {
  let loaded: { key: string; pipeline: FeatureExtractionPipeline } | null = null;
  let pending: { key: string; promise: Promise<FeatureExtractionPipeline> } | null = null;

  const initialize = async (config: Config): Promise<FeatureExtractionPipeline> => {
    const lock = await ops.acquire(config);
    let recoveryAttempted = false;
    let lastError: unknown;
    try {
      const before = await ops.inspect(config);
      if (before.state === 'invalid') {
        await ops.removeInvalid(config);
        recoveryAttempted = true;
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const pipeline = await ops.initialize(config);
          const after = await ops.inspect(config);
          if (after.state === 'invalid' || after.state === 'not_cached') {
            lastError = new Error('the downloaded embedding artifact failed integrity validation');
            if (attempt === 0) {
              await ops.removeInvalid(config);
              recoveryAttempted = true;
              continue;
            }
            break;
          }
          return pipeline;
        } catch (err) {
          lastError = err;
          if (attempt > 0 || !isEmbeddingParseFailure(err)) break;
          const health = await ops.inspect(config);
          if (health.state === 'invalid') {
            await ops.removeInvalid(config);
          }
          recoveryAttempted = true;
        }
      }

      const health = await ops.inspect(config);
      const healthHint =
        health.state === 'verified'
          ? 'The cached default artifact passed checksum validation, so the ONNX runtime or platform may be incompatible.'
          : health.state === 'custom_unverified'
            ? 'The custom model cache cannot be checksum-verified automatically.'
            : `Cache state after the attempt: ${health.state}.`;
      throw new VcmError(
        'EMBED_FAILED',
        `Could not load embedding model ${config.embedModel}${recoveryAttempted ? ' after one safe recovery attempt' : ''} (${boundedDetail(lastError)}). ${healthHint} Run video-context-mcp setup --all and retry; semantic search is unavailable, but full-text search still works.`,
      );
    } finally {
      lock.release();
    }
  };

  return async (config: Config): Promise<FeatureExtractionPipeline> => {
    const key = embedKey(config);
    if (loaded?.key === key) return loaded.pipeline;
    if (pending) {
      if (pending.key === key) return pending.promise;
      await pending.promise.catch(() => undefined);
      return createLoad(config);
    }
    return createLoad(config);

    function createLoad(nextConfig: Config): Promise<FeatureExtractionPipeline> {
      const nextKey = embedKey(nextConfig);
      if (loaded?.key === nextKey) return Promise.resolve(loaded.pipeline);
      if (pending?.key === nextKey) return pending.promise;
      const promise = initialize(nextConfig)
        .then((pipeline) => {
          loaded = { key: nextKey, pipeline };
          return pipeline;
        })
        .finally(() => {
          if (pending?.promise === promise) pending = null;
        });
      pending = { key: nextKey, promise };
      return promise;
    }
  };
}

const loadExtractor = createEmbeddingModelLoader();

export async function warmEmbeddings(config: Config): Promise<void> {
  await loadExtractor(config);
}

export async function embedTexts(texts: string[], config: Config): Promise<number[][]> {
  const pipe = await loadExtractor(config);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const tensor = await pipe(batch, { pooling: 'mean', normalize: true });
    out.push(...(tensor.tolist() as number[][]));
  }
  return out;
}

function assertSafeId(videoId: string): void {
  if (!/^[\w-]+$/.test(videoId)) {
    throw new VcmError('EMBED_FAILED', `Unsafe video id for vector store: ${videoId}`);
  }
}

async function connect(config: Config): Promise<lancedbT.Connection> {
  const lancedb = await import('@lancedb/lancedb');
  return lancedb.connect(join(config.cacheDir, 'lancedb'));
}

/** Replace a video's vectors with a freshly embedded generation. */
export async function replaceVideoVectors(
  videoId: string,
  docs: EmbedDoc[],
  vectors: number[][],
  config: Config,
): Promise<void> {
  return serializeVectorMutation(async () => {
    assertSafeId(videoId);
    const db = await connect(config);
    const rows = docs.map((d, i) => ({ ...d, video_id: videoId, vector: vectors[i]! }));
    const names = await db.tableNames();
    if (!names.includes(TABLE)) {
      if (rows.length > 0) await db.createTable(TABLE, rows);
      return;
    }
    const table = await db.openTable(TABLE);
    await table.delete(`video_id = '${videoId}'`);
    if (rows.length > 0) await table.add(rows);
  });
}

/** Remove a video's semantic rows. Safe to repeat and a no-op before first embed. */
export async function deleteVideoVectors(videoId: string, config: Config): Promise<void> {
  return serializeVectorMutation(async () => {
    assertSafeId(videoId);
    const db = await connect(config);
    const names = await db.tableNames();
    if (!names.includes(TABLE)) return;
    const table = await db.openTable(TABLE);
    await table.delete(`video_id = '${videoId}'`);
  });
}

/** Compact deleted rows and prune old table versions so disk is actually reclaimed. */
export async function optimizeVectors(config: Config): Promise<void> {
  return serializeVectorMutation(async () => {
    const db = await connect(config);
    const names = await db.tableNames();
    if (!names.includes(TABLE)) return;
    const table = await db.openTable(TABLE);
    await table.optimize({ cleanupOlderThan: new Date() });
  });
}

/** Cheap existence check so search never loads the model pointlessly. */
export async function hasVectors(config: Config): Promise<boolean> {
  try {
    const db = await connect(config);
    return (await db.tableNames()).includes(TABLE);
  } catch {
    return false;
  }
}

/** KNN over the vector table; empty when nothing was ever embedded. */
export async function searchVectors(
  queryVector: number[],
  limit: number,
  config: Config,
  videoId?: string,
): Promise<VectorHit[]> {
  const db = await connect(config);
  const names = await db.tableNames();
  if (!names.includes(TABLE)) return [];
  const table = await db.openTable(TABLE);
  let q = table.search(queryVector).limit(limit);
  if (videoId) {
    assertSafeId(videoId);
    q = q.where(`video_id = '${videoId}'`);
  }
  const rows = (await q.toArray()) as unknown as VectorHit[];
  return rows.map((r) => ({
    id: r.id,
    video_id: r.video_id,
    kind: r.kind,
    ts_ms: r.ts_ms,
    text: r.text,
  }));
}

/** Embed one video's transcript + screen text; returns the doc count. */
export async function embedVideo(
  db: Database.Database,
  videoId: string,
  config: Config,
): Promise<EmbedStats> {
  const segments = db
    .prepare('SELECT id, start_ms, text FROM segments WHERE video_id = ? ORDER BY start_ms')
    .all(videoId) as { id: number; start_ms: number; text: string }[];
  const frames = loadEmbedFrames(db, videoId);

  const docs = buildEmbedDocs(segments, frames);
  if (docs.length === 0) {
    await replaceVideoVectors(videoId, [], [], config);
    return { count: 0, vectorBytes: 0 };
  }
  const vectors = await embedTexts(
    docs.map((d) => d.text),
    config,
  );
  await replaceVideoVectors(videoId, docs, vectors, config);
  const vectorBytes = vectors.reduce(
    (total, vector, index) =>
      total + vector.length * Float32Array.BYTES_PER_ELEMENT + Buffer.byteLength(docs[index]!.text),
    0,
  );
  return { count: docs.length, vectorBytes };
}
