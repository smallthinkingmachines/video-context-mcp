#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const tag = args[0];
const writeNotesIndex = args.indexOf('--write-notes');
const notesPath = writeNotesIndex === -1 ? null : args[writeNotesIndex + 1];
const skipRemote = args.includes('--skip-remote');
const skipPack = args.includes('--skip-pack');

function fail(message) {
  console.error(`[release-check] ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function changelogSection(contents, version) {
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, 'm');
  const match = heading.exec(contents);
  if (!match) fail(`CHANGELOG.md needs a dated [${version}] release heading`);
  const start = match.index + match[0].length;
  const rest = contents.slice(start);
  const nextHeading = rest.search(/^## /m);
  const section = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  if (!section) fail(`CHANGELOG.md release section for ${version} is empty`);
  return section;
}

async function githubJson(path) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token)
    fail('GITHUB_REPOSITORY and GH_TOKEN are required for tag verification');
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) fail(`GitHub API ${path} returned ${response.status}`);
  return response.json();
}

if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail('usage: release-check.mjs v<semver> [--write-notes <path>] [--skip-remote] [--skip-pack]');
}
if (writeNotesIndex !== -1 && !notesPath) fail('--write-notes requires a path');

const version = tag.slice(1);
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
if (pkg.name !== '@smallthinkingmachines/video-context-mcp')
  fail(`unexpected package name: ${pkg.name}`);
if (pkg.version !== version) fail(`package.json version ${pkg.version} does not match ${tag}`);
if (lock.version !== version || lock.packages?.['']?.version !== version) {
  fail('package-lock.json root versions do not match the release tag');
}
if (pkg.publishConfig?.access !== 'public' || pkg.publishConfig?.provenance !== true) {
  fail('package.json must publish publicly with provenance');
}

const sourceVersion = readFileSync('src/version.ts', 'utf8').match(
  /VERSION\s*=\s*['"]([^'"]+)['"]/,
)?.[1];
if (sourceVersion !== version)
  fail(`src/version.ts version ${sourceVersion ?? 'missing'} does not match ${tag}`);

const notes = changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version);
if (notesPath) writeFileSync(notesPath, `${notes}\n`);

if (!skipPack) {
  const npmCache =
    process.env.VCM_RELEASE_NPM_CACHE ?? join(tmpdir(), 'video-context-mcp-release-npm-cache');
  mkdirSync(npmCache, { recursive: true });
  const packed = execFileSync('npm', ['pack', '--dry-run', '--json', '--cache', npmCache], {
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'silent' },
  });
  const result = JSON.parse(packed)[0];
  const paths = new Set(result.files.map((file) => file.path));
  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'dist/index.js',
  ]) {
    if (!paths.has(required)) fail(`package tarball is missing ${required}`);
  }
  const forbidden = result.files.find((file) =>
    /(^|\/)(?:node_modules|tests|coverage|\.github|\.env|\.git|scripts|cache)(?:\/|$)/.test(
      file.path,
    ),
  );
  if (forbidden) fail(`package tarball contains forbidden path ${forbidden.path}`);
  if (result.size > 2 * 1024 * 1024 || result.unpackedSize > 5 * 1024 * 1024) {
    fail(
      `package tarball is unexpectedly large (${result.size} packed, ${result.unpackedSize} unpacked)`,
    );
  }
}

if (!skipRemote) {
  const ref = await githubJson(`/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.object?.type !== 'tag')
    fail(`${tag} must be an annotated signed tag, not a lightweight tag`);
  const tagObject = await githubJson(`/git/tags/${ref.object.sha}`);
  if (tagObject.tag !== tag || tagObject.object?.type !== 'commit')
    fail(`${tag} does not point directly to a commit`);
  if (!tagObject.verification?.verified) {
    fail(
      `${tag} signature is not verified by GitHub (${tagObject.verification?.reason ?? 'unknown'})`,
    );
  }
  const localCommit = execFileSync('git', ['rev-parse', `${tag}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  if (localCommit !== tagObject.object.sha) fail('local and GitHub tag targets differ');
  execFileSync('git', ['fetch', 'origin', 'main', '--no-tags'], { stdio: 'inherit' });
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', localCommit, 'origin/main']);
  } catch {
    fail(`${tag} does not point to a commit on origin/main`);
  }
}

console.log(`[release-check] ${tag} is internally consistent`);
