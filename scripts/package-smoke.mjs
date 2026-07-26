#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const specIndex = args.indexOf('--spec');
const requestedSpec = specIndex === -1 ? null : args[specIndex + 1];
const managed = args.includes('--managed');
if (specIndex !== -1 && !requestedSpec) throw new Error('--spec requires a package specification');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'video-context-mcp-package-'));
const packDir = join(temporaryRoot, 'pack');
const installDir = join(temporaryRoot, 'install');
const cacheDir = join(temporaryRoot, 'cache');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmEnv = { ...process.env, npm_config_cache: join(temporaryRoot, 'npm-cache') };

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim(),
    );
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function install(target) {
  const attempts = requestedSpec ? 12 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      run(
        npm,
        [
          'install',
          '--prefix',
          installDir,
          '--no-audit',
          '--no-fund',
          '--cache',
          npmEnv.npm_config_cache,
          target,
        ],
        {
          env: npmEnv,
        },
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  throw lastError;
}

try {
  let target = requestedSpec;
  if (!target) {
    mkdirSync(packDir, { recursive: true });
    const packed = execFileSync(
      npm,
      ['pack', '--json', '--pack-destination', packDir, '--cache', npmEnv.npm_config_cache],
      {
        encoding: 'utf8',
        env: { ...npmEnv, npm_config_loglevel: 'silent' },
      },
    );
    const filename = JSON.parse(packed)[0]?.filename;
    if (!filename) throw new Error('npm pack did not return a tarball filename');
    target = join(packDir, filename);
  }

  await install(target);
  const packageRoot = join(
    installDir,
    'node_modules',
    '@smallthinkingmachines',
    'video-context-mcp',
  );
  const entry = join(packageRoot, 'dist', 'index.js');
  const commandEnv = { ...process.env, VCM_CACHE_DIR: cacheDir };
  const versionResult = run(process.execPath, [entry, '--version'], { env: commandEnv });
  const versionText = `${versionResult.stdout}\n${versionResult.stderr}`;
  if (!versionText.includes(`video-context-mcp ${pkg.version}`)) {
    throw new Error(`installed CLI reported an unexpected version: ${versionText.trim()}`);
  }

  if (managed) {
    const setup = JSON.parse(
      run(process.execPath, [entry, 'setup', '--json'], { env: commandEnv }).stdout,
    );
    if (!setup.ready) throw new Error(`managed setup was not ready: ${JSON.stringify(setup)}`);
    const doctor = JSON.parse(
      run(process.execPath, [entry, 'doctor', '--json'], { env: commandEnv }).stdout,
    );
    if (!doctor.ready)
      throw new Error(`installed package doctor failed: ${JSON.stringify(doctor)}`);
  }

  const client = new Client({ name: 'package-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: commandEnv,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === 'ingest_video')) {
      throw new Error('installed MCP server did not expose ingest_video');
    }
  } finally {
    await client.close().catch(() => undefined);
  }

  console.log(`[package-smoke] ${target} installed and initialized successfully`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
