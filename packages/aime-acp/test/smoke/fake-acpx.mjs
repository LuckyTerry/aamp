#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentMessageText } from './fake-acpx-content.mjs';
import {
  runBoundedProcess,
  validateCloseThenCleanup,
} from './child-lifecycle.mjs';

const acpxVersion = '0.11.2';
const registry = 'https://bnpm.byted.org';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const smokeDirectory = dirname(fileURLToPath(import.meta.url));
const packageMetadata = JSON.parse(
  await readFile(join(packageRoot, 'package.json'), 'utf8'),
);
const packageVersion = packageMetadata.version;
const packageTarball = `tengchengwei-aime-acp-${packageVersion}.tgz`;
const sentinels = [
  'CREDENTIAL_SENTINEL',
  'credential-do-not-emit',
  'CWD_SENTINEL',
  'cwd-do-not-emit',
  'RAW_TOOL_SENTINEL',
  'raw-tool-do-not-emit',
];

function npmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? { file: process.execPath, args: [npmExecPath, ...args] }
    : { file: 'npm', args };
}

function run(file, args, options = {}) {
  return runBoundedProcess(file, args, {
    ...options,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function requireSuccess(result, label) {
  if (result.code === 0 && result.signal === null) return;
  throw new Error(
    `${label} failed with code ${String(result.code)}: ${`${result.stdout}\n${result.stderr}`.slice(-8_000)}`,
  );
}

function parseFinalJson(stdout) {
  for (const start of [
    0,
    ...stdout
      .split('')
      .flatMap((value, index) => (value === '\n' ? [index + 1] : [])),
  ].reverse()) {
    const candidate = stdout.slice(start).trim();
    if (!candidate.startsWith('[') && !candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // npm lifecycle output can precede the final JSON value.
    }
  }
  throw new Error('npm command did not emit a final JSON value');
}

function parseStrictJsonLines(stdout) {
  return stdout.split(/\r?\n/).flatMap((line) => {
    if (line === '') return [];
    const value = JSON.parse(line);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('acpx strict JSON line was not an object');
    }
    return [value];
  });
}

function updateType(frame) {
  return (
    frame?.params?.update?.sessionUpdate ??
    frame?.update?.sessionUpdate ??
    frame?.sessionUpdate ??
    frame?.type
  );
}

async function liveProcessCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  const result = await run('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    cwd: '/',
    env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
    timeoutMs: 5_000,
  }).catch(() => undefined);
  return result?.code === 0 ? result.stdout.trim() : undefined;
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await liveProcessCommand(pid)) === undefined) return true;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
  }
  return (await liveProcessCommand(pid)) === undefined;
}

async function verifiedOwnerPids(root) {
  const queueDirectory = join(root, '.acpx/queues');
  const entries = await readdir(queueDirectory).catch(() => []);
  const canonicalRoot = await realpath(root);
  const pids = [];
  for (const name of entries) {
    if (!name.endsWith('.lock')) continue;
    let value;
    try {
      value = JSON.parse(await readFile(join(queueDirectory, name), 'utf8'));
    } catch {
      continue;
    }
    const pid = value?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const command = await liveProcessCommand(pid);
    if (command === undefined) continue;
    if (!command.includes(root) && !command.includes(canonicalRoot)) {
      throw new Error('refusing to terminate an unowned acpx process');
    }
    pids.push(pid);
  }
  return pids;
}

async function terminateVerifiedOwners(root) {
  for (const pid of await verifiedOwnerPids(root)) {
    process.kill(pid, 'SIGTERM');
    if (!(await waitForExit(pid, 2_000))) {
      process.kill(pid, 'SIGKILL');
      if (!(await waitForExit(pid, 2_000))) {
        throw new Error('owned acpx queue owner did not exit');
      }
    }
  }
}

async function liveSessionPids(root) {
  const sessionDirectory = join(root, '.acpx/sessions');
  const entries = await readdir(sessionDirectory).catch(() => []);
  const pids = [];
  for (const name of entries) {
    if (!name.endsWith('.json') || name === 'index.json') continue;
    let value;
    try {
      value = JSON.parse(await readFile(join(sessionDirectory, name), 'utf8'));
    } catch {
      continue;
    }
    if (
      Number.isSafeInteger(value?.pid) &&
      value.pid > 0 &&
      (await liveProcessCommand(value.pid)) !== undefined
    ) {
      pids.push(value.pid);
    }
  }
  return pids;
}

async function closeSmokeSession(root, acpx, agent, env) {
  const closed = await run(
    process.execPath,
    [
      acpx,
      '--agent',
      agent,
      '--format',
      'json',
      '--json-strict',
      'sessions',
      'close',
    ],
    { cwd: root, env, timeoutMs: 10_000 },
  ).catch(() => undefined);
  await validateCloseThenCleanup(closed, async () => {
    await terminateVerifiedOwners(root);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && (await liveSessionPids(root)).length > 0) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
    }
    if ((await liveSessionPids(root)).length > 0) {
      throw new Error('owned acpx session process remained after cleanup');
    }
  });
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'aime-acp-fake-acpx-'));
  let tarballPath;
  let acpx;
  let agent;
  let childEnv;
  let sessionAttempted = false;
  let primaryFailure;
  try {
    const npmEnv = {
      ...process.env,
      npm_config_registry: registry,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    };
    const pack = npmInvocation([
      'pack',
      '--json',
      `--registry=${registry}`,
      '--pack-destination',
      root,
    ]);
    const packed = await run(pack.file, pack.args, {
      cwd: packageRoot,
      env: npmEnv,
    });
    requireSuccess(packed, 'npm pack');
    const packResult = parseFinalJson(packed.stdout);
    const artifact = Array.isArray(packResult) ? packResult[0] : packResult;
    if (artifact?.filename !== packageTarball) {
      throw new Error('unexpected package artifact');
    }
    tarballPath = join(root, artifact.filename);

    const install = npmInvocation([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `--registry=${registry}`,
      tarballPath,
      `acpx@${acpxVersion}`,
    ]);
    const installed = await run(install.file, install.args, {
      cwd: root,
      env: npmEnv,
    });
    requireSuccess(installed, 'npm install packaged smoke project');

    const installedPackage = JSON.parse(
      await readFile(
        join(root, 'node_modules/@tengchengwei/aime-acp/package.json'),
        'utf8',
      ),
    );
    const installedAcpx = JSON.parse(
      await readFile(join(root, 'node_modules/acpx/package.json'), 'utf8'),
    );
    if (
      installedPackage.version !== packageVersion ||
      installedAcpx.version !== acpxVersion
    ) {
      throw new Error('installed package versions do not match the smoke pin');
    }

    const copiedSmokeDirectory = join(root, 'test/smoke');
    await mkdir(copiedSmokeDirectory, { recursive: true });
    for (const name of [
      'fake-acpx-register.mjs',
      'fake-acpx-loader.mjs',
      'fake-acpx-module.mjs',
    ]) {
      await copyFile(
        join(smokeDirectory, name),
        join(copiedSmokeDirectory, name),
      );
    }
    const fakePackageDirectory = join(
      copiedSmokeDirectory,
      'fake-acpx-bytedcli',
    );
    await mkdir(fakePackageDirectory);
    await copyFile(
      join(smokeDirectory, 'fake-acpx-bytedcli/package.json'),
      join(fakePackageDirectory, 'package.json'),
    );
    await mkdir(join(fakePackageDirectory, 'dist'));
    await copyFile(
      join(smokeDirectory, 'fake-acpx-bytedcli/dist/index.mjs'),
      join(fakePackageDirectory, 'dist/index.mjs'),
    );
    const register = join(copiedSmokeDirectory, 'fake-acpx-register.mjs');
    const safeBin = join(root, 'safe-bin');
    await mkdir(safeBin);
    await symlink(process.execPath, join(safeBin, 'node'));
    const installedBytedcli = join(
      root,
      'node_modules/@bytedance-dev/bytedcli',
    );
    const originalBytedcli = `${installedBytedcli}.real`;
    await rm(originalBytedcli, { recursive: true, force: true });
    await rename(installedBytedcli, originalBytedcli);
    await symlink(fakePackageDirectory, installedBytedcli, 'dir');
    const installedRequire = createRequire(
      join(root, 'node_modules/@tengchengwei/aime-acp/dist/bin.js'),
    );
    const resolvedFakeEntry = installedRequire.resolve(
      '@bytedance-dev/bytedcli',
    );
    const resolvedFakeMetadata = resolve(
      dirname(resolvedFakeEntry),
      '..',
      'package.json',
    );
    if (
      JSON.parse(await readFile(resolvedFakeMetadata, 'utf8')).version !==
      '0.123.0'
    ) {
      throw new Error(
        'fake bytedcli package topology does not match production',
      );
    }

    acpx = join(root, 'node_modules/.bin/acpx');
    agent = './node_modules/.bin/aime-acp';
    childEnv = {
      HOME: root,
      USERPROFILE: root,
      LANG: 'C.UTF-8',
      PATH: safeBin,
      NODE_OPTIONS: `--import=${register}`,
      CREDENTIAL_SENTINEL: 'credential-do-not-emit',
      CWD_SENTINEL: 'cwd-do-not-emit',
      RAW_TOOL_SENTINEL: 'raw-tool-do-not-emit',
      NO_GLOBAL_BYTEDCLI: 'true',
      AIME_ACP_LOG_LEVEL: 'error',
    };
    sessionAttempted = true;
    const created = await run(
      process.execPath,
      [
        acpx,
        '--agent',
        agent,
        '--format',
        'json',
        '--json-strict',
        'sessions',
        'new',
      ],
      { cwd: root, env: childEnv },
    );
    requireSuccess(created, 'acpx sessions new for packaged smoke');
    const createFrames = parseStrictJsonLines(created.stdout);
    if (
      createFrames.length === 0 ||
      !createFrames.some((frame) => frame.created === true)
    ) {
      throw new Error('acpx sessions new emitted no created result');
    }
    if (created.stderr !== '')
      throw new Error('strict acpx sessions new wrote stderr');

    const result = await run(
      process.execPath,
      [
        acpx,
        '--agent',
        agent,
        '--format',
        'json',
        '--json-strict',
        'reply with AIME_ACP_OK',
      ],
      {
        cwd: root,
        env: childEnv,
      },
    );
    requireSuccess(result, 'acpx packaged smoke using test-only --import hook');
    const frames = parseStrictJsonLines(result.stdout);
    if (frames.length === 0) throw new Error('acpx emitted no strict JSON');
    const types = frames.map(updateType).filter(Boolean);
    for (const expected of [
      'agent_thought_chunk',
      'plan',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ]) {
      if (!types.includes(expected))
        throw new Error(
          `missing ${expected} update: ${JSON.stringify(frames).slice(0, 12_000)}`,
        );
    }
    const finalText = agentMessageText(frames);
    if (finalText !== 'AIME_ACP_OK') {
      throw new Error(`unexpected final text: ${finalText}`);
    }
    if (result.stderr !== '') throw new Error('strict acpx wrote stderr');
    const serialized = `${result.stdout}\n${result.stderr}`;
    for (const sentinel of sentinels) {
      if (serialized.includes(sentinel)) throw new Error('sentinel leaked');
    }
    await closeSmokeSession(root, acpx, agent, childEnv);
    sessionAttempted = false;
    const digest = createHash('sha256')
      .update(await readFile(tarballPath))
      .digest('hex');
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        ok: true,
        packageVersion,
        acpxVersion,
        tarball: packageTarball,
        sha256: digest,
        frames: frames.length,
        final: 'AIME_ACP_OK',
      })}\n`,
    );
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupFailure;
  if (sessionAttempted && acpx && agent && childEnv) {
    try {
      await closeSmokeSession(root, acpx, agent, childEnv);
    } catch (error) {
      cleanupFailure = error;
    }
  }
  await rm(root, { recursive: true, force: true });
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'fake acpx smoke failed'}\n`,
  );
  process.exitCode = 1;
});
