# Third-party runtime notices

`video-context-mcp` is MIT-licensed. In managed mode it downloads and executes
the following separately distributed programs on first use; they are not
included in the npm tarball and retain their own licenses.

## yt-dlp 2026.06.09

- Project and corresponding source: https://github.com/yt-dlp/yt-dlp/tree/2026.06.09
- Release artifacts: https://github.com/yt-dlp/yt-dlp/releases/tag/2026.06.09
- Upstream project license: Unlicense
- Standalone executable distribution: GPL-3.0-or-later; see the release's
  bundled component notices and source for the exact executable composition.

The package pins the upstream SHA-256 value for each supported platform.

## FFmpeg 8.1.2

This software uses code of the FFmpeg project. FFmpeg is licensed under
LGPL-2.1-or-later, with GPL-2.0-or-later applying when GPL components are
enabled. The selected standalone builds enable GPL components and do not
enable `--enable-nonfree`.

- FFmpeg source baseline: https://github.com/FFmpeg/FFmpeg/tree/n8.1.2
- FFmpeg license and compliance guidance: https://ffmpeg.org/legal.html
- macOS builds, checksums, configuration, and build-script source:
  https://ffmpeg.martin-riedl.de/
- Linux GPL build, checksum, configuration, and build-script source:
  https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-06-30-13-34
- Windows build, checksum, configuration, and corresponding source link:
  https://www.gyan.dev/ffmpeg/builds/

Exact artifact URLs, versions, and SHA-256 values are recorded in
`src/runtime/manifest.ts` and the compiled package. Before publishing an
updated manifest, inspect `ffmpeg -buildconf`, reject `--enable-nonfree`, and
retain the matching upstream source/build information.

## JavaScript/WASM components

- Tesseract.js — Apache-2.0: https://github.com/naptha/tesseract.js
- Transformers.js 3.8.1 (vendored Node bundle, upstream commit
  `2ec882e739e4cb461f8d440d4d7394cbf5372429`) — Apache-2.0:
  https://github.com/huggingface/transformers.js/tree/2ec882e739e4cb461f8d440d4d7394cbf5372429
- `Xenova/whisper-base.en` model files — Apache-2.0:
  https://huggingface.co/Xenova/whisper-base.en
- `Xenova/all-MiniLM-L6-v2` model files — Apache-2.0:
  https://huggingface.co/Xenova/all-MiniLM-L6-v2

The model repository revisions are pinned in the package configuration.
