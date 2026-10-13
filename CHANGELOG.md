# Changelog

All notable changes to this project will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- Updated the pinned yt-dlp from 2026.06.09 to 2026.08.19. The previous build
  could list YouTube formats but received HTTP 403 when downloading media, so
  keyframe indexing failed. After upgrading, run `video-context-mcp setup --update`
  to switch to the new build.
- Release automation no longer contacts YouTube. Provider-boundary behavior is
  covered by deterministic metadata and caption fixtures, while the live smoke
  test remains an explicit maintainer command.
- The release workflow can manually resume an existing signed tag without
  moving it or publishing code from another commit.

## [0.8.0] - 2026-07-26

### Added

- Complete transcript-range export to a local UTF-8 file through
  `get_transcript(delivery="file")`.
- Structured transcript delivery metadata and resume handles.
- Selective asynchronous `repair_embeddings` without media re-download.
- Contributor, security, issue, pull-request, and release guidance.

### Changed

- Embedding failures now direct agents to selective repair instead of a full
  forced re-ingest.
- LanceDB is pinned to the latest stable release that publishes native binaries
  for every supported CI platform, including Intel macOS.
- Documentation now describes supported platforms and common first-run
  remediation.
- Repository text files are checked out with LF line endings on every platform
  so formatting checks are deterministic on Windows.
- GitHub workflows use the current Node 24-based checkout and setup-node action
  majors instead of deprecated Node 20-based releases.
- Monthly Dependabot batches are limited to minor and patch updates; major
  upgrades remain explicit compatibility work. Pre-1.0 LanceDB minor upgrades
  also remain manual until their native packages cover every supported target.
- Managed runtime smoke tests resolve their isolated cache path after a runner
  is assigned, allowing GitHub to validate and schedule the workflow.
- Linux managed FFmpeg now uses one checksum-pinned GPL BtbN archive for both
  `ffmpeg` and `ffprobe`; nonfree builds remain rejected at load time.
- The published CLI vendors its pinned Transformers.js Node bundle and directly
  installs security-fixed Sharp and tar releases instead of exposing vulnerable
  transitive ranges to users.
