import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { VcmError } from '../src/errors.js';
import { buildYtdlpArgs } from '../src/pipeline/ytdlp.js';
import {
  RuntimeManager,
  archivePathMatches,
  downloadArtifact,
  healthCheck,
  pathIsWithin,
  validateArchivePath,
} from '../src/runtime/manager.js';
import { type RuntimeArtifact, artifactForTool } from '../src/runtime/manifest.js';

afterEach(() => vi.unstubAllGlobals());

describe('runtime manifest', () => {
  it.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'x64'],
    ['win32', 'x64'],
  ] as const)('covers every core tool on %s/%s', (platform, arch) => {
    for (const tool of ['ytdlp', 'ffmpeg', 'ffprobe'] as const) {
      const artifact = artifactForTool(tool, platform, arch);
      expect(artifact, `${tool} on ${platform}/${arch}`).toBeDefined();
      expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact?.url.startsWith('https://')).toBe(true);
    }
  });

  it('does not claim unsupported targets', () => {
    expect(artifactForTool('ffmpeg', 'linux', 'arm64')).toBeUndefined();
  });

  it('uses one checksum-pinned GPL archive for both Linux FFmpeg tools', () => {
    const ffmpeg = artifactForTool('ffmpeg', 'linux', 'x64');
    const ffprobe = artifactForTool('ffprobe', 'linux', 'x64');
    expect(ffmpeg).toBe(ffprobe);
    expect(ffmpeg).toMatchObject({
      format: 'tar.xz',
      license: 'GPL-3.0-or-later',
      sha256: '0ba73bbd93472c7622f6dec26d334c5e62e64d858d072490b2844320970456cd',
    });
    expect(ffmpeg?.url).toContain('/BtbN/FFmpeg-Builds/releases/download/');
  });
});

describe('runtime archive safety', () => {
  it.each(['../evil', 'bin/../../evil', '/absolute/evil', 'C:/evil'])('rejects %s', (path) => {
    expect(() => validateArchivePath(path)).toThrowError(VcmError);
  });

  it('matches exact and version-rooted archive members without substring ambiguity', () => {
    expect(archivePathMatches('ffmpeg', 'ffmpeg')).toBe(true);
    expect(archivePathMatches('ffmpeg-8.1.2/bin/ffmpeg.exe', '/bin/ffmpeg.exe')).toBe(true);
    expect(archivePathMatches('tools/not-ffmpeg.exe', '/bin/ffmpeg.exe')).toBe(false);
  });

  it('constrains active executables to the managed runtime directory', () => {
    const root = join(tmpdir(), 'vcm-cache', 'runtime');
    expect(pathIsWithin(root, join(root, 'artifacts', 'tool', 'binary'))).toBe(true);
    expect(pathIsWithin(root, join(root, '..', 'runtime-other', 'binary'))).toBe(false);
  });
});

describe('runtime downloads', () => {
  function fixtureArtifact(data: Buffer, sha256?: string): RuntimeArtifact {
    return {
      id: 'fixture-linux-x64',
      version: '1.0.0',
      platform: 'linux',
      arch: 'x64',
      url: 'https://artifacts.example.test/tool',
      sourceUrl: 'https://source.example.test/',
      sha256: sha256 ?? createHash('sha256').update(data).digest('hex'),
      format: 'file',
      maxDownloadBytes: 1024,
      license: 'MIT',
      executables: [
        {
          tool: 'ytdlp',
          archivePath: 'tool',
          filename: 'tool',
          versionArgs: ['--version'],
          versionPattern: '1\\.0\\.0',
        },
      ],
    };
  }

  it('streams and verifies a pinned artifact', async () => {
    const data = Buffer.from('verified runtime fixture');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(data, { status: 200, headers: { 'content-length': String(data.length) } }),
      ),
    );
    const dir = mkdtempSync(join(tmpdir(), 'vcm-download-'));
    try {
      const destination = join(dir, 'artifact');
      await downloadArtifact(fixtureArtifact(data), destination);
      expect(readFileSync(destination)).toEqual(data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects checksum mismatches and non-HTTPS redirects', async () => {
    const data = Buffer.from('tampered runtime fixture');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(data, { status: 200 })),
    );
    const dir = mkdtempSync(join(tmpdir(), 'vcm-download-'));
    try {
      await expect(
        downloadArtifact(fixtureArtifact(data, '0'.repeat(64)), join(dir, 'bad')),
      ).rejects.toMatchObject({ code: 'TOOLCHAIN_INTEGRITY_FAILED' });

      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(null, { status: 302, headers: { location: 'http://unsafe.test/tool' } }),
        ),
      );
      await expect(
        downloadArtifact(fixtureArtifact(data), join(dir, 'redirect')),
      ).rejects.toMatchObject({ code: 'TOOLCHAIN_DOWNLOAD_FAILED' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('yt-dlp isolation', () => {
  it('ignores ambient config and supplies the current Node runtime', () => {
    const config = loadConfig({ VCM_CACHE_DIR: '/tmp/vcm-runtime-test' });
    const args = buildYtdlpArgs(['-J', 'https://example.invalid'], config);
    expect(args.slice(0, 3)).toEqual([
      '--ignore-config',
      '--js-runtimes',
      `node:${process.execPath}`,
    ]);
  });
});

describe('toolchain health check', () => {
  it('names the real reason when a binary reports an unexpected version', async () => {
    const err = await healthCheck(process.execPath, {
      versionArgs: ['--version'],
      versionPattern: '^never-matches$',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VcmError);
    expect((err as VcmError).code).toBe('TOOLCHAIN_UNUSABLE');
    expect((err as VcmError).message).toContain('unexpected version');
    expect((err as VcmError).message).not.toContain('capability check');
  });

  it('accepts any version when no pattern is required', async () => {
    await expect(
      healthCheck(process.execPath, { versionArgs: ['--version'], versionPattern: '' }),
    ).resolves.toMatch(/\d/);
  });

  it('does not require an override binary to match the pinned version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcm-doctor-'));
    try {
      const config = loadConfig({ VCM_CACHE_DIR: dir, VCM_YTDLP_BIN: process.execPath });
      const component = await new RuntimeManager(config).doctorTool('ytdlp');
      expect(component.provider).toBe('override');
      expect(component.state).toBe('ready');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
