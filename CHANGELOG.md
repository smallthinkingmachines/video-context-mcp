# Changelog

All notable changes to this project will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- Release automation no longer contacts YouTube. Provider-boundary behavior is
  covered by deterministic metadata and caption fixtures, while the live smoke
  test remains an explicit maintainer command.
- The release workflow can manually resume an existing signed tag without
  moving it or publishing code from another commit.
- Keyframe extraction now keeps the last frame of each burst of consecutive
  scene-change candidates (at most 1 s apart, cut at 5 s), so fades and zooms
  yield the settled picture instead of a mid-transition frame.

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
