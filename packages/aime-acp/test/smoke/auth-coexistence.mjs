#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const expectedBytedcliVersion = '0.123.0';
const packageMetadata = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);
const packageVersion = packageMetadata.version;
const allowedSites = new Set(['cn', 'i18n-tt']);
const requiredHomeMarker = '.aime-acp-real-auth-smoke-home';
const safeErrorCodes = new Set([
  'APPROVAL_REQUIRED',
  'AUTH_IDENTITY_CHANGED',
  'AUTH_REQUIRED',
  'INVALID_ARGUMENT',
  'REAL_HOME_REFUSED',
  'SMOKE_FAILED',
]);
const defaultLiveAcpTimeouts = {
  requestTimeoutMs: 30_000,
  closeTimeoutMs: 3_000,
  terminateTimeoutMs: 1_000,
};

function safeFailure(code) {
  const error = new Error(code);
  error.safeCode = code;
  return error;
}

function parseArguments(argv) {
  const options = { approved: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--approve-real-auth-smoke') {
      options.approved = true;
      continue;
    }
    const next = argv[index + 1];
    if (value === '--test-home' && next !== undefined) {
      options.testHome = next;
      index += 1;
      continue;
    }
    if (value === '--site' && next !== undefined) {
      options.site = next;
      index += 1;
      continue;
    }
    throw safeFailure('INVALID_ARGUMENT');
  }
  return options;
}

function safeResult(ok, site, startedAt, errorCode) {
  return {
    schemaVersion: 1,
    ok,
    site,
    packageVersion,
    bytedcliVersion: expectedBytedcliVersion,
    timingMs: Date.now() - startedAt,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

async function existingRealpaths(values) {
  const paths = [];
  for (const value of values) {
    if (typeof value !== 'string' || value === '') continue;
    try {
      paths.push(await realpath(value));
    } catch {
      // An absent environment path cannot alias the selected existing home.
    }
  }
  return new Set(paths);
}

async function validateHome(value) {
  if (typeof value !== 'string' || value === '' || !isAbsolute(value)) {
    throw safeFailure('INVALID_ARGUMENT');
  }
  const selected = await realpath(value);
  const forbidden = await existingRealpaths([
    userInfo().homedir,
    homedir(),
    process.env.HOME,
    process.env.USERPROFILE,
  ]);
  if (forbidden.has(selected)) throw safeFailure('REAL_HOME_REFUSED');
  const metadata = await stat(selected);
  if (!metadata.isDirectory()) throw safeFailure('INVALID_ARGUMENT');
  try {
    const marker = await stat(join(selected, requiredHomeMarker));
    if (!marker.isFile()) throw safeFailure('INVALID_ARGUMENT');
  } catch (error) {
    if (error?.safeCode === 'INVALID_ARGUMENT') throw error;
    throw safeFailure('INVALID_ARGUMENT');
  }
  return selected;
}

async function question(input, prompt, expected) {
  const response = await input.question(prompt);
  if (response !== expected) throw safeFailure('APPROVAL_REQUIRED');
}

async function acknowledgeExternalMutation(input, action, expected) {
  const response = await input.question(
    `At this pause, externally perform this serialized action in the designated isolated home only: ${action}. Then type ${expected}: `,
  );
  if (response !== expected) throw safeFailure('APPROVAL_REQUIRED');
}

async function approvalPrompt(options) {
  if (!options.approved || !process.stdin.isTTY || !process.stderr.isTTY) {
    throw safeFailure('APPROVAL_REQUIRED');
  }
  const input = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  await question(
    input,
    'Type RUN REAL AUTH SMOKE to authorize browser auth checks in the designated temporary homes: ',
    'RUN REAL AUTH SMOKE',
  );
  return input;
}

function childEnvironment(testHome) {
  return {
    HOME: testHome,
    USERPROFILE: testHome,
    XDG_CACHE_HOME: join(testHome, '.xdg', 'cache'),
    XDG_CONFIG_HOME: join(testHome, '.xdg', 'config'),
    XDG_DATA_HOME: join(testHome, '.xdg', 'data'),
    XDG_STATE_HOME: join(testHome, '.xdg', 'state'),
    LANG: 'C.UTF-8',
    PATH: process.env.PATH,
    TMPDIR: join(testHome, 'tmp'),
  };
}

async function prepareEnvironment(testHome) {
  const environment = childEnvironment(testHome);
  await Promise.all([
    mkdir(environment.TMPDIR, { recursive: true }),
    mkdir(dirname(environment.XDG_CACHE_HOME), { recursive: true }),
  ]);
  return environment;
}

async function runJson(file, argv, environment, cwd, stdin = '') {
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(file, argv, {
      cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectResult);
    child.once('close', (code, signal) =>
      resolveResult({ code, signal, stdout, stderr }),
    );
    child.stdin.end(stdin);
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw safeFailure('SMOKE_FAILED');
  try {
    return { ...result, json: JSON.parse(lines[0]) };
  } catch {
    throw safeFailure('SMOKE_FAILED');
  }
}

function bytedcliModuleUrl(packageDirectory) {
  return pathToFileURL(
    join(
      packageDirectory,
      'node_modules',
      '@bytedance-dev',
      'bytedcli',
      'dist',
      'index.js',
    ),
  ).href;
}

async function assertPinnedBytedcli(packageDirectory) {
  const metadata = JSON.parse(
    await readFile(
      join(
        packageDirectory,
        'node_modules',
        '@bytedance-dev',
        'bytedcli',
        'package.json',
      ),
      'utf8',
    ),
  );
  if (metadata.version !== expectedBytedcliVersion) {
    throw safeFailure('SMOKE_FAILED');
  }
  const entry = fileURLToPath(bytedcliModuleUrl(packageDirectory));
  if (!(await stat(entry)).isFile()) throw safeFailure('SMOKE_FAILED');
}

function bytedcliProbeSource(moduleUrl) {
  return `
    const { api, auth } = await import(${JSON.stringify(moduleUrl)});
    const site = process.argv[1];
    const [statuses, spaces] = await Promise.all([
      Promise.all(Array.from({ length: 3 }, () => auth.byteCloudAuthEnsureAuth({ site, as: 'user', forceRefresh: true }))),
      api.aime.listSpaces({ limit: 1 }),
    ]);
    const authenticated = statuses.every((value) => value?.status === 'ready');
    process.stdout.write(JSON.stringify({ ok: authenticated && Array.isArray(spaces?.spaces), authenticated, aimeReachable: Array.isArray(spaces?.spaces) }) + '\\n');
  `;
}

function bytedcliLoginSource(moduleUrl) {
  return `
    const { auth } = await import(${JSON.stringify(moduleUrl)});
    const outcome = await auth.byteCloudAuthLogin({ site: process.argv[1], autoOpenBrowser: true });
    process.stdout.write(JSON.stringify({ ok: ['success', 'already_authenticated', 'not_required'].includes(outcome?.status) }) + '\\n');
  `;
}

export async function startLiveAcp(
  bin,
  environment,
  cwd,
  site,
  timeouts = defaultLiveAcpTimeouts,
) {
  const child = spawn(process.execPath, [bin, '--site', site], {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();
  let closed = false;
  const close = new Promise((resolveClose) =>
    child.once('close', (code, signal) => {
      closed = true;
      resolveClose({ code, signal });
    }),
  );

  const waitForClose = async (timeoutMs) => {
    let timer;
    try {
      return await Promise.race([
        close,
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const terminate = async () => {
    if (closed) return close;
    child.kill('SIGTERM');
    const afterTerm = await waitForClose(timeouts.terminateTimeoutMs);
    if (afterTerm !== undefined) return afterTerm;
    child.kill('SIGKILL');
    const afterKill = await waitForClose(timeouts.terminateTimeoutMs);
    if (afterKill === undefined) throw safeFailure('SMOKE_FAILED');
    return afterKill;
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    while (true) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        for (const waiter of pending.values())
          waiter.reject(safeFailure('SMOKE_FAILED'));
        pending.clear();
        child.kill('SIGTERM');
        return;
      }
      if (typeof frame?.id !== 'number') continue;
      const waiter = pending.get(frame.id);
      if (waiter === undefined) continue;
      pending.delete(frame.id);
      if (frame.error !== undefined) waiter.reject(frame.error);
      else waiter.resolve(frame.result);
    }
  });
  child.once('error', (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  child.once('close', () => {
    for (const waiter of pending.values())
      waiter.reject(safeFailure('SMOKE_FAILED'));
    pending.clear();
  });

  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(safeFailure('SMOKE_FAILED'));
        child.kill('SIGTERM');
      }, timeouts.requestTimeoutMs);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject(error) {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  };
  try {
    await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
  } catch (error) {
    await terminate();
    throw error;
  }
  return {
    request,
    async stop() {
      child.stdin.end();
      let result = await waitForClose(timeouts.closeTimeoutMs);
      if (result === undefined) result = await terminate();
      if (result.code !== 0 || result.signal !== null || stderr !== '') {
        throw safeFailure('SMOKE_FAILED');
      }
    },
  };
}

async function expectAcpError(operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    if (error?.data?.code === expectedCode) return;
    throw safeFailure('SMOKE_FAILED');
  }
  throw safeFailure('SMOKE_FAILED');
}

function statusIsUnauthenticated(result) {
  return result.code === 1 && result.json?.status === 'unauthenticated';
}

export async function cleanupAuthenticatedHome(
  home,
  site,
  input,
  bin,
  packageDirectory,
  dependencies = {},
) {
  const promptMutation =
    dependencies.acknowledgeExternalMutation ?? acknowledgeExternalMutation;
  const run = dependencies.runJson ?? runJson;
  await promptMutation(
    input,
    'log out the currently active isolated smoke home',
    'CLEANUP LOGOUT COMPLETE',
  );
  const result = await run(
    process.execPath,
    [bin, 'auth', 'status', '--site', site, '--json'],
    await prepareEnvironment(home),
    packageDirectory,
  );
  if (!statusIsUnauthenticated(result)) throw safeFailure('AUTH_REQUIRED');
}

export async function runApprovedSmoke(
  testHome,
  site,
  input,
  dependencies = {},
) {
  const packageDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const bin = join(packageDirectory, 'dist', 'bin.js');
  const moduleUrl = bytedcliModuleUrl(packageDirectory);
  await assertPinnedBytedcli(packageDirectory);
  const startAcp = dependencies.startLiveAcp ?? startLiveAcp;
  const run = dependencies.runJson ?? runJson;
  const promptMutation =
    dependencies.acknowledgeExternalMutation ?? acknowledgeExternalMutation;
  const cleanupHome =
    dependencies.cleanupAuthenticatedHome ?? cleanupAuthenticatedHome;
  const makeHome = dependencies.mkdtemp ?? mkdtemp;
  const removeHome = dependencies.rm ?? rm;
  const environment = await prepareEnvironment(testHome);
  const createdHomes = [];
  const loginAttemptedHomes = [];
  const cleanupVerifiedHomes = new Set();
  const liveAcps = [];
  let primaryFailure;
  let cleanupFailure;
  try {
    loginAttemptedHomes.push(testHome);
    const login = await run(
      process.execPath,
      [bin, 'auth', 'login', '--site', site, '--json'],
      environment,
      testHome,
    );
    if (login.code !== 0 || login.json?.status !== 'authenticated') {
      throw safeFailure('AUTH_REQUIRED');
    }
    const status = await run(
      process.execPath,
      [bin, 'auth', 'status', '--site', site, '--json'],
      environment,
      testHome,
    );
    if (status.code !== 0 || status.json?.status !== 'authenticated') {
      throw safeFailure('AUTH_REQUIRED');
    }

    const liveAcp = await startAcp(bin, environment, testHome, site);
    liveAcps.push(liveAcp);
    const remote = await liveAcp.request('session/new', {
      cwd: testHome,
      mcpServers: [],
    });
    if (typeof remote?.sessionId !== 'string')
      throw safeFailure('SMOKE_FAILED');

    const probeArguments = [
      '--input-type=module',
      '--eval',
      bytedcliProbeSource(moduleUrl),
      site,
    ];
    const [probeA, probeB] = await Promise.all([
      run(process.execPath, probeArguments, environment, testHome),
      run(process.execPath, probeArguments, environment, testHome),
    ]);
    for (const probe of [probeA, probeB]) {
      if (
        probe.code !== 0 ||
        probe.json?.ok !== true ||
        probe.json?.authenticated !== true ||
        probe.json?.aimeReachable !== true
      ) {
        throw safeFailure('SMOKE_FAILED');
      }
    }

    await promptMutation(
      input,
      'run exact-pinned bytedcli logout',
      'LOGOUT COMPLETE',
    );
    await expectAcpError(
      () =>
        liveAcp.request('session/new', {
          cwd: testHome,
          mcpServers: [],
        }),
      'AUTH_REQUIRED',
    );
    await promptMutation(
      input,
      'log in a different managed account',
      'ACCOUNT SWITCH COMPLETE',
    );
    await expectAcpError(
      () =>
        liveAcp.request('session/new', {
          cwd: testHome,
          mcpServers: [],
        }),
      'AUTH_IDENTITY_CHANGED',
    );
    await liveAcp.stop();
    liveAcps.splice(liveAcps.indexOf(liveAcp), 1);

    const bytedcliFirstHome = await makeHome(
      join(dirname(testHome), 'aime-acp-bytedcli-first-'),
    );
    createdHomes.push(bytedcliFirstHome);
    const bytedcliEnvironment = await prepareEnvironment(bytedcliFirstHome);
    loginAttemptedHomes.push(bytedcliFirstHome);
    const bytedcliLogin = await run(
      process.execPath,
      ['--input-type=module', '--eval', bytedcliLoginSource(moduleUrl), site],
      bytedcliEnvironment,
      packageDirectory,
    );
    if (bytedcliLogin.code !== 0 || bytedcliLogin.json?.ok !== true) {
      throw safeFailure('AUTH_REQUIRED');
    }
    const doctor = await run(
      process.execPath,
      [bin, 'doctor', '--site', site, '--json'],
      bytedcliEnvironment,
      bytedcliFirstHome,
    );
    if (
      doctor.code !== 0 ||
      doctor.json?.authenticated !== true ||
      doctor.json?.aimeReachable !== true
    ) {
      throw safeFailure('SMOKE_FAILED');
    }
  } catch (error) {
    primaryFailure = error;
  } finally {
    await Promise.all(liveAcps.map((acp) => acp.stop().catch(() => undefined)));
    for (const home of [...loginAttemptedHomes].reverse()) {
      try {
        await cleanupHome(home, site, input, bin, packageDirectory);
        cleanupVerifiedHomes.add(home);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    for (const path of createdHomes) {
      if (
        loginAttemptedHomes.includes(path) &&
        !cleanupVerifiedHomes.has(path)
      ) {
        continue;
      }
      try {
        await removeHome(path, { recursive: true, force: true });
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw safeFailure('AUTH_REQUIRED');
}

async function main() {
  const startedAt = Date.now();
  let site = 'cn';
  let input;
  try {
    const options = parseArguments(process.argv.slice(2));
    site = options.site ?? 'cn';
    if (!allowedSites.has(site)) throw safeFailure('INVALID_ARGUMENT');
    const testHome = await validateHome(options.testHome);
    input = await approvalPrompt(options);
    await runApprovedSmoke(testHome, site, input);
    process.stdout.write(
      `${JSON.stringify(safeResult(true, site, startedAt))}\n`,
    );
  } catch (error) {
    const candidate = error?.safeCode;
    const errorCode = safeErrorCodes.has(candidate)
      ? candidate
      : 'SMOKE_FAILED';
    process.stdout.write(
      `${JSON.stringify(safeResult(false, site, startedAt, errorCode))}\n`,
    );
    process.exitCode = 1;
  } finally {
    input?.close();
  }
}

if (process.argv[1] !== undefined) {
  const invoked = await realpath(process.argv[1]).catch(() => undefined);
  const current = await realpath(fileURLToPath(import.meta.url));
  if (invoked === current) await main();
}
