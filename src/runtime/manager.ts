import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { Open } from 'unzipper';
import type { BinaryName, Config } from '../config.js';
import { VcmError } from '../errors.js';
import { acquireRuntimeLock } from './lock.js';
import {
  type ArtifactExecutable,
  type ManagedTool,
  type RuntimeArtifact,
  artifactForTool,
} from './manifest.js';

const execFileAsync = promisify(execFile);
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const HEALTH_TIMEOUT_MS = 15_000;
const ARCHIVE_TIMEOUT_MS = 2 * 60_000;
const MAX_REDIRECTS = 5;

export type RuntimeProgress = (pct: number, detail: string) => void;

interface ActiveTool {
  artifactId: string;
  version: string;
  path: string;
  executableSha256: string;
  activatedAt: string;
}

export interface DoctorComponent {
  name: ManagedTool;
  provider: 'managed' | 'system' | 'override';
  state: 'ready' | 'missing' | 'invalid' | 'update_available' | 'unsupported';
  version: string | null;
  path: string | null;
  recommendedVersion: string | null;
  detail: string;
  remediation: string | null;
}

const installs = new Map<string, Promise<Map<ManagedTool, string>>>();

function hashFile(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function safeDetail(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replaceAll(/\s+/g, ' ').slice(0, 300);
}

function executableName(tool: ManagedTool): BinaryName {
  return tool === 'ytdlp' ? 'ytdlp' : tool;
}

function systemName(tool: ManagedTool): string {
  if (tool === 'ytdlp') return 'yt-dlp';
  return tool;
}

export function validateArchivePath(path: string): void {
  const normalized = path.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new VcmError(
      'TOOLCHAIN_INTEGRITY_FAILED',
      `Managed runtime archive contains an unsafe path: ${path.slice(0, 160)}.`,
    );
  }
}

export function archivePathMatches(path: string, wanted: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return wanted.startsWith('/') ? normalized.endsWith(wanted) : normalized === wanted;
}

export function pathIsWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

export async function downloadArtifact(
  artifact: RuntimeArtifact,
  destination: string,
  onProgress?: RuntimeProgress,
): Promise<void> {
  let url = artifact.url;
  let response: Response | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (!url.startsWith('https://')) {
        throw new VcmError(
          'TOOLCHAIN_DOWNLOAD_FAILED',
          `Refusing non-HTTPS runtime download for ${artifact.id}.`,
        );
      }
      response = await fetch(url, { redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === MAX_REDIRECTS) {
          throw new VcmError(
            'TOOLCHAIN_DOWNLOAD_FAILED',
            `Too many or invalid redirects while downloading ${artifact.id}.`,
          );
        }
        url = new URL(location, url).toString();
        continue;
      }
      break;
    }
    if (!response?.ok || !response.body) {
      throw new VcmError(
        'TOOLCHAIN_DOWNLOAD_FAILED',
        `Could not download ${artifact.id} (HTTP ${response?.status ?? 'unknown'}). Check network/proxy access and run video-context-mcp setup again.`,
      );
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > artifact.maxDownloadBytes) {
      throw new VcmError(
        'TOOLCHAIN_INTEGRITY_FAILED',
        `${artifact.id} exceeds its pinned download-size limit. Update the package before retrying.`,
      );
    }

    const hash = createHash('sha256');
    const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    const outputFinished = finished(output);
    let received = 0;
    let completed = false;
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += data.length;
        if (received > artifact.maxDownloadBytes) {
          throw new VcmError(
            'TOOLCHAIN_INTEGRITY_FAILED',
            `${artifact.id} exceeded its pinned download-size limit.`,
          );
        }
        hash.update(data);
        if (!output.write(data)) {
          await new Promise<void>((resolve) => output.once('drain', () => resolve()));
        }
        const denominator = declared > 0 ? declared : artifact.maxDownloadBytes;
        onProgress?.(
          Math.min(90, Math.round((received / denominator) * 90)),
          `Downloading ${artifact.id} (${Math.round(received / 1024 / 1024)} MB${
            declared > 0 ? ` of ${Math.round(declared / 1024 / 1024)} MB` : ''
          })`,
        );
      }
      output.end();
      await outputFinished;
      completed = true;
    } finally {
      if (!completed) {
        output.destroy();
        await outputFinished.catch(() => undefined);
      }
    }
    const actual = hash.digest('hex');
    if (actual !== artifact.sha256) {
      throw new VcmError(
        'TOOLCHAIN_INTEGRITY_FAILED',
        `Checksum verification failed for ${artifact.id}. The file was discarded; update the package or retry on a trusted network.`,
      );
    }
  } catch (err) {
    if (err instanceof VcmError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw new VcmError(
        'INSUFFICIENT_DISK',
        `The cache ran out of disk space while downloading ${artifact.id}. Free space or move VCM_CACHE_DIR and retry.`,
      );
    }
    const timedOut = err instanceof Error && err.name === 'AbortError';
    throw new VcmError(
      'TOOLCHAIN_DOWNLOAD_FAILED',
      timedOut
        ? `Downloading ${artifact.id} timed out. Check network/proxy access and run video-context-mcp setup again.`
        : `Downloading ${artifact.id} failed: ${safeDetail(err)}. Check network/proxy access and retry.`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function extractArtifact(
  artifact: RuntimeArtifact,
  archivePath: string,
  destination: string,
): Promise<Map<ManagedTool, string>> {
  mkdirSync(destination, { recursive: true });
  const result = new Map<ManagedTool, string>();
  if (artifact.format === 'file') {
    const executable = artifact.executables[0];
    if (!executable) {
      throw new VcmError('TOOLCHAIN_INTEGRITY_FAILED', `${artifact.id} has no executable entry.`);
    }
    const output = join(destination, executable.filename);
    await pipeline(createReadStream(archivePath), createWriteStream(output, { flags: 'wx' }));
    if (process.platform !== 'win32') chmodSync(output, 0o755);
    result.set(executable.tool, output);
    return result;
  }

  if (artifact.format === 'tar.xz') {
    let members: string[];
    try {
      const { stdout } = await execFileAsync('tar', ['-tJf', archivePath], {
        timeout: ARCHIVE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      members = stdout.split(/\r?\n/).filter(Boolean);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new VcmError(
        code === 'ENOENT' ? 'TOOLCHAIN_UNUSABLE' : 'TOOLCHAIN_INTEGRITY_FAILED',
        code === 'ENOENT'
          ? 'The system tar executable with xz support is required to unpack the managed Linux FFmpeg build. Install tar/xz or use VCM_TOOLCHAIN_MODE=system.'
          : `Could not inspect the pinned ${artifact.id} archive. Clear the disposable runtime cache and run video-context-mcp setup again.`,
      );
    }
    for (const member of members) validateArchivePath(member);

    for (const executable of artifact.executables) {
      const matches = members.filter((member) =>
        archivePathMatches(member, executable.archivePath),
      );
      const member = matches[0];
      if (matches.length !== 1 || !member) {
        throw new VcmError(
          'TOOLCHAIN_INTEGRITY_FAILED',
          `${artifact.id} did not contain exactly one ${executable.tool} executable.`,
        );
      }
      const normalized = member.replaceAll('\\', '/');
      const stripComponents = normalized.split('/').filter(Boolean).length - 1;
      const output = join(destination, executable.filename);
      try {
        await execFileAsync(
          'tar',
          [
            '-xJf',
            archivePath,
            '-C',
            destination,
            `--strip-components=${stripComponents}`,
            '--no-same-owner',
            '--',
            member,
          ],
          {
            timeout: ARCHIVE_TIMEOUT_MS,
            maxBuffer: 2 * 1024 * 1024,
            windowsHide: true,
          },
        );
        const stat = lstatSync(output);
        if (!stat.isFile() || stat.size > 250 * 1024 * 1024) {
          throw new Error('extracted member is not a bounded regular file');
        }
        if (process.platform !== 'win32') chmodSync(output, 0o755);
      } catch (err) {
        if (err instanceof VcmError) throw err;
        throw new VcmError(
          'TOOLCHAIN_INTEGRITY_FAILED',
          `Could not safely unpack ${executable.tool} from ${artifact.id}. Clear the disposable runtime cache and run video-context-mcp setup again.`,
        );
      }
      result.set(executable.tool, output);
    }
    return result;
  }

  const zip = await Open.file(archivePath);
  for (const entry of zip.files) validateArchivePath(entry.path);
  for (const executable of artifact.executables) {
    const matches = zip.files.filter(
      (entry) => entry.type === 'File' && archivePathMatches(entry.path, executable.archivePath),
    );
    if (matches.length !== 1 || !matches[0]) {
      throw new VcmError(
        'TOOLCHAIN_INTEGRITY_FAILED',
        `${artifact.id} did not contain exactly one ${executable.tool} executable.`,
      );
    }
    if (matches[0].uncompressedSize > 250 * 1024 * 1024) {
      throw new VcmError(
        'TOOLCHAIN_INTEGRITY_FAILED',
        `${artifact.id} contains an unexpectedly large ${executable.tool} executable.`,
      );
    }
    const output = join(destination, executable.filename);
    await pipeline(matches[0].stream(), createWriteStream(output, { flags: 'wx' }));
    if (process.platform !== 'win32') chmodSync(output, 0o755);
    result.set(executable.tool, output);
  }
  return result;
}

export async function healthCheck(
  path: string,
  executable: Pick<ArtifactExecutable, 'versionArgs' | 'versionPattern'>,
  rejectNonfree = false,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(path, executable.versionArgs, {
      timeout: HEALTH_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    const output = `${stdout}\n${stderr}`;
    if (executable.versionPattern && !new RegExp(executable.versionPattern, 'i').test(output)) {
      throw new VcmError(
        'TOOLCHAIN_UNUSABLE',
        `Runtime executable ${basename(path)} reported an unexpected version. Run video-context-mcp setup --update to restore the package-pinned build.`,
      );
    }
    if (rejectNonfree && /--enable-nonfree/i.test(output)) {
      throw new VcmError(
        'TOOLCHAIN_UNUSABLE',
        `Runtime executable ${basename(path)} was built with --enable-nonfree and cannot be used as a managed runtime. Run video-context-mcp setup --update to restore the package-pinned build.`,
      );
    }
    return output.trim().split('\n')[0]?.slice(0, 200) ?? 'ready';
  } catch (err) {
    if (err instanceof VcmError) throw err;
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new VcmError(
        'BINARY_MISSING',
        `Runtime executable ${basename(path)} was not found. Run video-context-mcp setup or configure an explicit binary override.`,
      );
    }
    const hint =
      e.code === 'EACCES'
        ? 'The cache may be mounted noexec; move VCM_CACHE_DIR or use VCM_TOOLCHAIN_MODE=system.'
        : 'Run video-context-mcp doctor for details.';
    const reason = e.code
      ? `OS error ${e.code}`
      : 'the version/capability check did not complete successfully';
    throw new VcmError(
      'TOOLCHAIN_UNUSABLE',
      `Runtime executable ${basename(path)} is not usable (${reason}). ${hint}`,
    );
  }
}

export class RuntimeManager {
  readonly runtimeDir: string;

  constructor(private readonly config: Config) {
    this.runtimeDir = join(config.cacheDir, 'runtime');
  }

  private activePath(tool: ManagedTool): string {
    return join(this.runtimeDir, 'active', `${tool}.json`);
  }

  private readActive(tool: ManagedTool): ActiveTool | null {
    try {
      const active = JSON.parse(readFileSync(this.activePath(tool), 'utf8')) as ActiveTool;
      if (!active.path || !existsSync(active.path)) return null;
      const runtimeRoot = realpathSync(this.runtimeDir);
      const executablePath = realpathSync(active.path);
      if (!pathIsWithin(runtimeRoot, executablePath)) return null;
      if (hashFile(executablePath) !== active.executableSha256) return null;
      return { ...active, path: executablePath };
    } catch {
      return null;
    }
  }

  private writeActive(tool: ManagedTool, active: ActiveTool): void {
    const path = this.activePath(tool);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(active, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private async provision(
    artifact: RuntimeArtifact,
    onProgress?: RuntimeProgress,
  ): Promise<Map<ManagedTool, string>> {
    const key = `${this.runtimeDir}:${artifact.id}`;
    const existingPromise = installs.get(key);
    if (existingPromise) return existingPromise;
    const promise = this.provisionLocked(artifact, onProgress).finally(() => installs.delete(key));
    installs.set(key, promise);
    return promise;
  }

  private async provisionLocked(
    artifact: RuntimeArtifact,
    onProgress?: RuntimeProgress,
  ): Promise<Map<ManagedTool, string>> {
    const lock = await acquireRuntimeLock(this.runtimeDir, artifact.id);
    const target = join(this.runtimeDir, 'artifacts', artifact.id);
    const resolved = new Map<ManagedTool, string>();
    try {
      // Artifact IDs are immutable and content-addressed by the package manifest.
      // Reuse a healthy current target even for --update; force only bypasses an
      // older active pointer so a newer package-pinned artifact can be selected.
      if (existsSync(target)) {
        let targetRoot: string | null = null;
        try {
          const runtimeRoot = realpathSync(this.runtimeDir);
          const candidateRoot = realpathSync(target);
          if (pathIsWithin(runtimeRoot, candidateRoot)) targetRoot = candidateRoot;
        } catch {
          // Treat unreadable or dangling cache entries as invalid and replace them.
        }
        let valid = targetRoot !== null;
        if (targetRoot) {
          for (const executable of artifact.executables) {
            const path = join(target, executable.filename);
            if (!existsSync(path)) {
              valid = false;
              break;
            }
            try {
              const executablePath = realpathSync(path);
              if (!pathIsWithin(targetRoot, executablePath)) {
                valid = false;
                break;
              }
              await healthCheck(executablePath, executable, true);
              resolved.set(executable.tool, executablePath);
            } catch {
              valid = false;
              break;
            }
          }
        }
        if (valid) {
          lock.assertOwned();
          for (const executable of artifact.executables) {
            const path = resolved.get(executable.tool);
            if (!path) continue;
            this.writeActive(executable.tool, {
              artifactId: artifact.id,
              version: artifact.version,
              path,
              executableSha256: hashFile(path),
              activatedAt: new Date().toISOString(),
            });
          }
          return resolved;
        }
      }

      const stagingRoot = join(this.runtimeDir, '.staging');
      mkdirSync(stagingRoot, { recursive: true });
      try {
        const fs = statfsSync(stagingRoot);
        const freeBytes = Number(fs.bavail) * Number(fs.bsize);
        const requiredBytes = artifact.maxDownloadBytes * 3;
        if (freeBytes < requiredBytes) {
          throw new VcmError(
            'INSUFFICIENT_DISK',
            `Installing ${artifact.id} needs about ${Math.ceil(requiredBytes / 1024 / 1024)} MB free in ${this.runtimeDir}; only ${Math.floor(freeBytes / 1024 / 1024)} MB is available. Free space or move VCM_CACHE_DIR.`,
          );
        }
      } catch (err) {
        if (err instanceof VcmError) throw err;
        // Some network filesystems do not expose statfs; the bounded download
        // and actionable write error remain the fallback protection.
      }
      const staging = join(stagingRoot, `${artifact.id}-${randomUUID()}`);
      const unpacked = join(staging, 'unpacked');
      const archive = join(staging, 'download');
      mkdirSync(staging, { recursive: true });
      try {
        onProgress?.(0, `Preparing ${artifact.id}`);
        await downloadArtifact(artifact, archive, onProgress);
        onProgress?.(92, `Verifying and unpacking ${artifact.id}`);
        const files = await extractArtifact(artifact, archive, unpacked);
        for (const executable of artifact.executables) {
          const path = files.get(executable.tool);
          if (!path) {
            throw new VcmError(
              'TOOLCHAIN_INTEGRITY_FAILED',
              `${artifact.id} did not produce ${executable.tool}.`,
            );
          }
          await healthCheck(path, executable, true);
        }
        lock.assertOwned();
        rmSync(target, { recursive: true, force: true });
        mkdirSync(dirname(target), { recursive: true });
        renameSync(unpacked, target);
        lock.assertOwned();
        for (const executable of artifact.executables) {
          const path = join(target, executable.filename);
          resolved.set(executable.tool, path);
          this.writeActive(executable.tool, {
            artifactId: artifact.id,
            version: artifact.version,
            path,
            executableSha256: hashFile(path),
            activatedAt: new Date().toISOString(),
          });
        }
        onProgress?.(100, `${artifact.id} ready`);
        return resolved;
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    } finally {
      lock.release();
    }
  }

  private async resolveExternal(tool: ManagedTool, path: string): Promise<string> {
    const args = tool === 'ytdlp' ? ['--version'] : ['-version'];
    await healthCheck(path, { versionArgs: args, versionPattern: '' });
    return path;
  }

  async ensureTool(
    tool: ManagedTool,
    onProgress?: RuntimeProgress,
    forceUpdate = false,
  ): Promise<string> {
    const override = this.config.binaryOverrides[executableName(tool)];
    if (override) return this.resolveExternal(tool, override);
    if (this.config.toolchainMode === 'system') {
      return this.resolveExternal(tool, systemName(tool));
    }

    if (!forceUpdate) {
      const active = this.readActive(tool);
      if (active) return active.path;
    }
    const artifact = artifactForTool(tool);
    if (!artifact) {
      throw new VcmError(
        'TOOLCHAIN_UNSUPPORTED',
        `Managed ${systemName(tool)} is not available for ${process.platform}/${process.arch}. Set an explicit VCM_*_BIN override or use a supported target.`,
      );
    }
    const resolved = await this.provision(artifact, onProgress);
    const path = resolved.get(tool);
    if (!path) {
      throw new VcmError('TOOLCHAIN_INTEGRITY_FAILED', `${artifact.id} did not install ${tool}.`);
    }
    return path;
  }

  async ensureTools(
    tools: ManagedTool[],
    onProgress?: RuntimeProgress,
    forceUpdate = false,
  ): Promise<Record<ManagedTool, string | undefined>> {
    const unique = [...new Set(tools)];
    const result: Record<ManagedTool, string | undefined> = {
      ytdlp: undefined,
      ffmpeg: undefined,
      ffprobe: undefined,
    };
    const updatedArtifacts = new Set<string>();
    for (let index = 0; index < unique.length; index++) {
      const tool = unique[index]!;
      const artifact =
        forceUpdate &&
        this.config.toolchainMode === 'managed' &&
        !this.config.binaryOverrides[executableName(tool)]
          ? artifactForTool(tool)
          : undefined;
      if (artifact && updatedArtifacts.has(artifact.id)) {
        result[tool] = this.readActive(tool)?.path;
        continue;
      }
      result[tool] = await this.ensureTool(
        tool,
        (pct, detail) =>
          onProgress?.(Math.round(((index + pct / 100) / unique.length) * 100), detail),
        forceUpdate,
      );
      if (artifact) updatedArtifacts.add(artifact.id);
    }
    return result;
  }

  applyResolved(paths: Record<ManagedTool, string | undefined>): void {
    if (paths.ytdlp) this.config.ytdlpBin = paths.ytdlp;
    if (paths.ffmpeg) this.config.ffmpegBin = paths.ffmpeg;
    if (paths.ffprobe) this.config.ffprobeBin = paths.ffprobe;
  }

  async doctorTool(tool: ManagedTool): Promise<DoctorComponent> {
    const override = this.config.binaryOverrides[executableName(tool)];
    const artifact = artifactForTool(tool);
    const provider = override
      ? 'override'
      : this.config.toolchainMode === 'system'
        ? 'system'
        : 'managed';
    const path =
      override ?? (provider === 'system' ? systemName(tool) : this.readActive(tool)?.path);
    if (!artifact && provider === 'managed') {
      return {
        name: tool,
        provider,
        state: 'unsupported',
        version: null,
        path: null,
        recommendedVersion: null,
        detail: `No managed artifact for ${process.platform}/${process.arch}.`,
        remediation: 'Use a supported platform or set an explicit binary override.',
      };
    }
    if (!path) {
      return {
        name: tool,
        provider,
        state: 'missing',
        version: null,
        path: null,
        recommendedVersion: artifact?.version ?? null,
        detail: `${systemName(tool)} has not been provisioned.`,
        remediation: 'Run video-context-mcp setup.',
      };
    }
    try {
      const active = provider === 'managed' ? this.readActive(tool) : null;
      const recommendedExecutable = artifact?.executables.find((entry) => entry.tool === tool);
      const executable = recommendedExecutable
        ? {
            ...recommendedExecutable,
            // Only package-managed binaries must match the pinned version. An explicit
            // override or system binary is the user's choice, and ensureTool already
            // accepts any version for those, so doctor must agree.
            versionPattern:
              provider !== 'managed' || (active && artifact && active.artifactId !== artifact.id)
                ? ''
                : recommendedExecutable.versionPattern,
          }
        : {
            versionArgs: tool === 'ytdlp' ? ['--version'] : ['-version'],
            versionPattern: '',
          };
      const version = await healthCheck(path, executable, provider === 'managed');
      const updateAvailable = Boolean(active && artifact && active.artifactId !== artifact.id);
      return {
        name: tool,
        provider,
        state: updateAvailable ? 'update_available' : 'ready',
        version,
        path,
        recommendedVersion: artifact?.version ?? null,
        detail: updateAvailable ? 'A newer package-pinned runtime is available.' : 'Ready.',
        remediation: updateAvailable ? 'Run video-context-mcp setup --update.' : null,
      };
    } catch (err) {
      return {
        name: tool,
        provider,
        state: 'invalid',
        version: null,
        path,
        recommendedVersion: artifact?.version ?? null,
        detail: safeDetail(err),
        remediation:
          provider === 'managed'
            ? 'Run video-context-mcp setup --update.'
            : 'Fix the configured executable or use managed mode.',
      };
    }
  }
}
