export type ManagedTool = 'ytdlp' | 'ffmpeg' | 'ffprobe';

export interface ArtifactExecutable {
  tool: ManagedTool;
  /** Exact archive path or a slash-normalized suffix for archives with a versioned root. */
  archivePath: string;
  filename: string;
  versionArgs: string[];
  versionPattern: string;
}

export interface RuntimeArtifact {
  id: string;
  version: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  url: string;
  sourceUrl: string;
  sha256: string;
  format: 'file' | 'zip' | 'tar.xz';
  maxDownloadBytes: number;
  license: string;
  executables: ArtifactExecutable[];
}

const YTDLP_VERSION = '2026.08.19';
const YTDLP_BASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}`;
const YTDLP_SOURCE = `https://github.com/yt-dlp/yt-dlp/releases/tag/${YTDLP_VERSION}`;

const ytdlp = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  asset: string,
  sha256: string,
  filename: string,
): RuntimeArtifact => ({
  id: `yt-dlp-${YTDLP_VERSION}-${platform}-${arch}`,
  version: YTDLP_VERSION,
  platform,
  arch,
  url: `${YTDLP_BASE}/${asset}`,
  sourceUrl: YTDLP_SOURCE,
  sha256,
  format: 'file',
  maxDownloadBytes: 80 * 1024 * 1024,
  license: 'GPL-3.0-or-later (standalone executable distribution)',
  executables: [
    {
      tool: 'ytdlp',
      archivePath: asset,
      filename,
      versionArgs: ['--version'],
      versionPattern: YTDLP_VERSION.replaceAll('.', '\\.'),
    },
  ],
});

const FF_VERSION = '8.1.2';
const MARTIN_SOURCE = 'https://ffmpeg.martin-riedl.de/';

const martin = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  build: string,
  tool: 'ffmpeg' | 'ffprobe',
  sha256: string,
): RuntimeArtifact => ({
  id: `${tool}-${FF_VERSION}-${platform}-${arch}`,
  version: FF_VERSION,
  platform,
  arch,
  url: `https://ffmpeg.martin-riedl.de/download/${
    platform === 'darwin' ? 'macos' : 'linux'
  }/${arch === 'x64' ? 'amd64' : arch}/${build}_${FF_VERSION}/${tool}.zip`,
  sourceUrl: MARTIN_SOURCE,
  sha256,
  format: 'zip',
  maxDownloadBytes: 150 * 1024 * 1024,
  license: 'GPL-3.0-or-later',
  executables: [
    {
      tool,
      archivePath: tool,
      filename: tool,
      versionArgs: ['-version'],
      versionPattern: `version ${FF_VERSION.replaceAll('.', '\\.')}`,
    },
  ],
});

const windowsFfmpeg: RuntimeArtifact = {
  id: `ffmpeg-${FF_VERSION}-win32-x64`,
  version: FF_VERSION,
  platform: 'win32',
  arch: 'x64',
  url: `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${FF_VERSION}-essentials_build.zip`,
  sourceUrl: 'https://www.gyan.dev/ffmpeg/builds/',
  sha256: 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec',
  format: 'zip',
  maxDownloadBytes: 160 * 1024 * 1024,
  license: 'GPL-3.0-or-later',
  executables: [
    {
      tool: 'ffmpeg',
      archivePath: '/bin/ffmpeg.exe',
      filename: 'ffmpeg.exe',
      versionArgs: ['-version'],
      versionPattern: `version ${FF_VERSION.replaceAll('.', '\\.')}`,
    },
    {
      tool: 'ffprobe',
      archivePath: '/bin/ffprobe.exe',
      filename: 'ffprobe.exe',
      versionArgs: ['-version'],
      versionPattern: `version ${FF_VERSION.replaceAll('.', '\\.')}`,
    },
  ],
};

const linuxFfmpeg: RuntimeArtifact = {
  id: `ffmpeg-${FF_VERSION}-linux-x64-btbn-2026-06-30`,
  version: FF_VERSION,
  platform: 'linux',
  arch: 'x64',
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-06-30-13-34/ffmpeg-n8.1.2-21-gce3c09c101-linux64-gpl-8.1.tar.xz',
  sourceUrl: 'https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-06-30-13-34',
  sha256: '0ba73bbd93472c7622f6dec26d334c5e62e64d858d072490b2844320970456cd',
  format: 'tar.xz',
  maxDownloadBytes: 150 * 1024 * 1024,
  license: 'GPL-3.0-or-later',
  executables: [
    {
      tool: 'ffmpeg',
      archivePath: '/bin/ffmpeg',
      filename: 'ffmpeg',
      versionArgs: ['-version'],
      versionPattern: `version n?${FF_VERSION.replaceAll('.', '\\.')}`,
    },
    {
      tool: 'ffprobe',
      archivePath: '/bin/ffprobe',
      filename: 'ffprobe',
      versionArgs: ['-version'],
      versionPattern: `version n?${FF_VERSION.replaceAll('.', '\\.')}`,
    },
  ],
};

/**
 * Release-pinned runtime artifacts. Updating any entry is a release change:
 * verify the upstream checksum, run the binary audit, update notices, and run
 * the four-platform package smoke suite before publishing.
 */
export const RUNTIME_ARTIFACTS: RuntimeArtifact[] = [
  ytdlp(
    'darwin',
    'arm64',
    'yt-dlp_macos',
    '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
    'yt-dlp',
  ),
  ytdlp(
    'darwin',
    'x64',
    'yt-dlp_macos',
    '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
    'yt-dlp',
  ),
  ytdlp(
    'linux',
    'x64',
    'yt-dlp_linux',
    '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a',
    'yt-dlp',
  ),
  ytdlp(
    'win32',
    'x64',
    'yt-dlp.exe',
    '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
    'yt-dlp.exe',
  ),
  martin(
    'darwin',
    'arm64',
    '1783011502',
    'ffmpeg',
    'ef1aa60006c7b77ce170c1608c08d8e4ba1c30c5746f2ac986ded932d0ac2c3c',
  ),
  martin(
    'darwin',
    'arm64',
    '1783011502',
    'ffprobe',
    'c39787f4af7a3932502d2d48db6f6feaaa836b48a73ef78c32cc3285df61dfaf',
  ),
  martin(
    'darwin',
    'x64',
    '1783018342',
    'ffmpeg',
    'a52ef43883f44c219766d4b3bdde4e635b35465d0b704c01c3a0566b59775df9',
  ),
  martin(
    'darwin',
    'x64',
    '1783018342',
    'ffprobe',
    '5408ca588c8c72b0dde3afe676d0a7acf25ef97e55ae6eba5c7bede1cda42695',
  ),
  linuxFfmpeg,
  windowsFfmpeg,
];

export function artifactsFor(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): RuntimeArtifact[] {
  return RUNTIME_ARTIFACTS.filter(
    (artifact) => artifact.platform === platform && artifact.arch === arch,
  );
}

export function artifactForTool(
  tool: ManagedTool,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): RuntimeArtifact | undefined {
  return artifactsFor(platform, arch).find((artifact) =>
    artifact.executables.some((executable) => executable.tool === tool),
  );
}
