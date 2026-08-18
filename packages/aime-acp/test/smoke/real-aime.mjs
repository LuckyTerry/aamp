#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertSafeToolTurn,
  createEphemeralEvidenceLog,
  createEvidenceGetter,
  observeLiveDeltaBeforeTerminal,
  resolveToolProfile,
  scanPrivacyEvidence,
} from './real-aime-guards.mjs';
import { runBoundedProcess, terminateChild } from './child-lifecycle.mjs';

const requiredSites = ['cn', 'i18n-tt'];
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bin = join(packageRoot, 'dist/bin.js');
const homeMarker = '.aime-acp-real-aime-smoke-home';
const bytedcliEntry = createRequire(import.meta.url).resolve(
  '@bytedance-dev/bytedcli',
);
const childTimeoutMs = 300_000;
const requestTimeoutMs = 75_000;
const closeTimeoutMs = 5_000;
const terminateTimeoutMs = 2_000;
const privacyCanaries = {
  credential: 'smoke-credential-canary-do-not-emit',
  identity: 'smoke-identity-canary-do-not-emit',
  cwd: 'smoke-cwd-canary-do-not-emit',
  promptLog: 'smoke-prompt-log-canary-do-not-emit',
  rawTool: 'smoke-raw-tool-canary-do-not-emit',
};
const safeCodes = new Set([
  'APPROVAL_REQUIRED',
  'AUTH_REQUIRED',
  'INVALID_ARGUMENT',
  'REAL_HOME_REFUSED',
  'SMOKE_FAILED',
]);

function safeFailure(code) {
  const error = new Error(code);
  error.safeCode = code;
  return error;
}

function parseArguments(argv) {
  const result = { approved: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--approve-real-aime-smoke') {
      result.approved = true;
      continue;
    }
    if (value === '--test-home' && argv[index + 1] !== undefined) {
      result.testHome = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === '--tool-profile' && argv[index + 1] !== undefined) {
      result.toolProfile = argv[index + 1];
      index += 1;
      continue;
    }
    throw safeFailure('INVALID_ARGUMENT');
  }
  return result;
}

async function existingRealpaths(values) {
  const result = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value === '') continue;
    try {
      result.add(await realpath(value));
    } catch {
      // A missing environment path cannot alias the selected existing home.
    }
  }
  return result;
}

async function validateTestHome(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
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
  if (!(await stat(join(selected, homeMarker))).isFile()) {
    throw safeFailure('INVALID_ARGUMENT');
  }
  return selected;
}

function environment(testHome) {
  return {
    HOME: testHome,
    USERPROFILE: testHome,
    XDG_CACHE_HOME: join(testHome, '.xdg/cache'),
    XDG_CONFIG_HOME: join(testHome, '.xdg/config'),
    XDG_DATA_HOME: join(testHome, '.xdg/data'),
    XDG_STATE_HOME: join(testHome, '.xdg/state'),
    TMPDIR: join(testHome, 'tmp'),
    LANG: 'C.UTF-8',
    PATH: process.env.PATH,
    AIME_ACP_SMOKE_CREDENTIAL_CANARY: privacyCanaries.credential,
    AIME_ACP_SMOKE_IDENTITY_CANARY: privacyCanaries.identity,
    AIME_ACP_SMOKE_CWD_CANARY: privacyCanaries.cwd,
    AIME_ACP_SMOKE_PROMPT_LOG_CANARY: privacyCanaries.promptLog,
    AIME_ACP_SMOKE_RAW_TOOL_CANARY: privacyCanaries.rawTool,
  };
}

async function run(file, args, options) {
  return runBoundedProcess(file, args, {
    ...options,
    timeoutMs: options.timeoutMs ?? childTimeoutMs,
    terminateTimeoutMs,
  });
}

function oneJson(result) {
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw safeFailure('SMOKE_FAILED');
  try {
    return JSON.parse(lines[0]);
  } catch {
    throw safeFailure('SMOKE_FAILED');
  }
}

function commandEvidence(kind, result) {
  return { kind, stdout: result.stdout, stderr: result.stderr };
}

async function ensureAuthentication(site, env, cwd, evidence) {
  let status = await run(
    process.execPath,
    [bin, 'auth', 'status', '--site', site, '--json'],
    { cwd, env, timeoutMs: 60_000 },
  );
  evidence.push(commandEvidence('auth-status-before', status));
  if (status.code === 0 && oneJson(status).status === 'authenticated') {
    return evidence;
  }
  const login = await run(
    process.execPath,
    [bin, 'auth', 'login', '--site', site, '--json'],
    { cwd, env },
  );
  evidence.push(commandEvidence('auth-login', login));
  if (login.code !== 0 || oneJson(login).status !== 'authenticated') {
    throw safeFailure('AUTH_REQUIRED');
  }
  status = await run(
    process.execPath,
    [bin, 'auth', 'status', '--site', site, '--json'],
    { cwd, env, timeoutMs: 60_000 },
  );
  evidence.push(commandEvidence('auth-status-after', status));
  if (status.code !== 0 || oneJson(status).status !== 'authenticated') {
    throw safeFailure('AUTH_REQUIRED');
  }
}

async function within(promise, timeoutMs) {
  let timer;
  const value = await Promise.race([
    promise.then((result) => ({ completed: true, result })),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ completed: false }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return value;
}

export async function startAcp(site, env, cwd, runtime = {}) {
  const requestLimitMs = runtime.requestTimeoutMs ?? requestTimeoutMs;
  const closeLimitMs = runtime.closeTimeoutMs ?? closeTimeoutMs;
  const terminateLimitMs = runtime.terminateTimeoutMs ?? terminateTimeoutMs;
  const child = spawn(
    runtime.file ?? process.execPath,
    runtime.args ?? [bin, '--site', site],
    {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  runtime.onChild?.(child);
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();
  const frames = [];
  let activePromptObserver;
  let closeState;
  let closeConfirmed = false;
  let fatalTermination;
  let resolveClosed;
  const closed = new Promise((resolveClose) => {
    resolveClosed = resolveClose;
  });

  const rejectAll = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    activePromptObserver = undefined;
  };
  const beginFatalTermination = () => {
    if (fatalTermination === undefined) {
      fatalTermination = terminateChild(child, closed, terminateLimitMs);
      void fatalTermination.catch(() => undefined);
    }
    return fatalTermination;
  };
  const failAndTerminate = () => {
    rejectAll(safeFailure('SMOKE_FAILED'));
    void beginFatalTermination();
  };
  const writeFrame = (frame) => {
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error !== null && error !== undefined) failAndTerminate();
      });
    } catch {
      failAndTerminate();
    }
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.on('error', () => {
    failAndTerminate();
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        failAndTerminate();
        return;
      }
      frames.push(frame);
      if (frame?.method === 'session/update') {
        activePromptObserver?.(frame.params?.update);
      }
      if (typeof frame?.id !== 'number') continue;
      const waiter = pending.get(frame.id);
      if (!waiter) continue;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (activePromptObserver === waiter.onUpdate) {
        activePromptObserver = undefined;
      }
      if (frame.error !== undefined) waiter.reject(frame.error);
      else waiter.resolve(frame.result);
    }
  });
  child.once('error', () => {
    failAndTerminate();
  });
  child.once('close', (code, signal) => {
    closeState = { code, signal };
    resolveClosed(closeState);
    rejectAll(safeFailure('SMOKE_FAILED'));
  });
  const request = (method, params, options = {}) => {
    const id = nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const onUpdate =
        method === 'session/prompt' && typeof options.onUpdate === 'function'
          ? options.onUpdate
          : undefined;
      if (onUpdate !== undefined) activePromptObserver = onUpdate;
      const timer = setTimeout(() => {
        const waiter = pending.get(id);
        if (waiter === undefined) return;
        pending.delete(id);
        clearTimeout(waiter.timer);
        if (activePromptObserver === onUpdate) activePromptObserver = undefined;
        rejectAll(safeFailure('SMOKE_FAILED'));
        void beginFatalTermination().then(
          () => rejectRequest(safeFailure('SMOKE_FAILED')),
          () => rejectRequest(safeFailure('SMOKE_FAILED')),
        );
      }, requestLimitMs);
      pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
        onUpdate,
      });
      writeFrame({ jsonrpc: '2.0', id, method, params });
    });
  };
  try {
    await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
  } catch (error) {
    await beginFatalTermination().catch(() => undefined);
    const confirmation = await within(closed, terminateLimitMs);
    if (!confirmation.completed) throw safeFailure('SMOKE_FAILED');
    closeConfirmed = true;
    throw error;
  }
  const getEvidence = createEvidenceGetter('acp', frames, () => stderr);
  return {
    frames,
    evidence() {
      if (fatalTermination !== undefined && !closeConfirmed) {
        throw safeFailure('SMOKE_FAILED');
      }
      return getEvidence();
    },
    request,
    notify(method, params) {
      writeFrame({ jsonrpc: '2.0', method, params });
    },
    async close() {
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        !child.stdin.destroyed
      ) {
        try {
          child.stdin.end();
        } catch {
          failAndTerminate();
        }
      }

      let terminationFailure;
      if (fatalTermination !== undefined) {
        try {
          await fatalTermination;
        } catch (error) {
          terminationFailure = error;
        }
      } else {
        const normal = await within(closed, closeLimitMs);
        if (!normal.completed) {
          try {
            await beginFatalTermination();
          } catch (error) {
            terminationFailure = error;
          }
        }
      }

      if (fatalTermination !== undefined) {
        try {
          await fatalTermination;
        } catch (error) {
          terminationFailure ??= error;
        }
      }
      const confirmation = await within(closed, terminateLimitMs);
      if (!confirmation.completed) throw safeFailure('SMOKE_FAILED');
      closeConfirmed = true;
      closeState = confirmation.result;
      if (
        terminationFailure !== undefined ||
        closeState?.code !== 0 ||
        closeState?.signal !== null
      ) {
        throw safeFailure('SMOKE_FAILED');
      }
    },
  };
}

function updates(frames) {
  return frames
    .filter((frame) => frame?.method === 'session/update')
    .map((frame) => frame.params?.update)
    .filter(Boolean);
}

function textContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (
    typeof value === 'object' &&
    value !== null &&
    value.type === 'text' &&
    typeof value.text === 'string'
  ) {
    return value.text;
  }
  return '';
}

function assertTurn(frames, start) {
  const current = updates(frames.slice(start));
  const text = current
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => textContent(update.content))
    .join('')
    .trim();
  if (text === '') {
    throw safeFailure('SMOKE_FAILED');
  }
  return current;
}

const waitingProbeSource = `
  const { api, utils } = await import(${JSON.stringify(pathToFileURL(bytedcliEntry).href)});
  utils.setCloudSite(process.argv[1]);
  utils.setAuthAs('user');
  let sessionId = '';
  for await (const chunk of process.stdin) sessionId += chunk;
  const session = await api.aime.getSession(sessionId.trim());
  process.stdout.write(JSON.stringify({ waiting: session?.status === 'waiting_for_next' }) + '\\n');
`;

async function assertWaitingForNext(site, sessionId, env, cwd, evidence) {
  const result = await run(
    process.execPath,
    ['--input-type=module', '--eval', waitingProbeSource, site],
    { cwd, env, stdin: `${sessionId}\n`, timeoutMs: 60_000 },
  );
  evidence.push(commandEvidence('waiting-for-next', result));
  if (result.code !== 0 || oneJson(result).waiting !== true) {
    throw safeFailure('SMOKE_FAILED');
  }
}

async function promptAfterDrain(client, sessionId, prompt) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const start = client.frames.length;
    try {
      const result = await client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      return { result, start };
    } catch (error) {
      if (error?.data?.code !== 'SESSION_BUSY') throw error;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
    }
  }
  throw safeFailure('SMOKE_FAILED');
}

async function runSite(
  site,
  testHome,
  toolProfile,
  salt,
  rawLog,
  forbiddenValues,
) {
  const siteHome = join(testHome, site);
  await mkdir(siteHome, { recursive: true });
  const env = environment(siteHome);
  await mkdir(env.TMPDIR, { recursive: true });
  const evidence = [];
  const clients = [];
  const promptStrings = [];
  let sessionId;
  let cancelLatencyMs;
  let primaryFailure;
  try {
    await ensureAuthentication(site, env, siteHome, evidence);

    const doctor = await run(
      process.execPath,
      [bin, 'doctor', '--site', site, '--json'],
      { cwd: siteHome, env },
    );
    evidence.push(commandEvidence('doctor', doctor));
    const diagnosis = oneJson(doctor);
    if (
      doctor.code !== 0 ||
      diagnosis.compatible !== true ||
      diagnosis.authenticated !== true ||
      diagnosis.aimeReachable !== true
    ) {
      throw safeFailure('SMOKE_FAILED');
    }

    const first = await startAcp(site, env, siteHome);
    clients.push(first);
    const created = await first.request('session/new', {
      cwd: siteHome,
      mcpServers: [],
    });
    sessionId = created?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw safeFailure('SMOKE_FAILED');
    }
    const nonce = randomBytes(8).toString('hex');
    const firstPrompt = `Reply with this short safe smoke nonce: ${nonce}`;
    promptStrings.push(firstPrompt);
    let start = first.frames.length;
    const firstTurn = await observeLiveDeltaBeforeTerminal(
      (onUpdate) =>
        first.request(
          'session/prompt',
          {
            sessionId,
            prompt: [{ type: 'text', text: firstPrompt }],
          },
          { onUpdate },
        ),
      requestTimeoutMs,
    );
    if (firstTurn?.stopReason !== 'end_turn') throw safeFailure('SMOKE_FAILED');
    assertTurn(first.frames, start);
    await assertWaitingForNext(site, sessionId, env, siteHome, evidence);
    await first.close();

    const second = await startAcp(site, env, siteHome);
    clients.push(second);
    await second.request('session/load', {
      sessionId,
      cwd: siteHome,
      mcpServers: [],
    });
    start = second.frames.length;
    const secondPrompt = 'Reply with a second short safe nonce.';
    promptStrings.push(secondPrompt);
    const nextTurn = await second.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: secondPrompt }],
    });
    if (nextTurn?.stopReason !== 'end_turn') throw safeFailure('SMOKE_FAILED');
    assertTurn(second.frames, start);
    await assertWaitingForNext(site, sessionId, env, siteHome, evidence);

    start = second.frames.length;
    promptStrings.push(toolProfile.prompt);
    const toolTurn = await second.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: toolProfile.prompt }],
    });
    if (toolTurn?.stopReason !== 'end_turn') throw safeFailure('SMOKE_FAILED');
    const toolUpdates = assertTurn(second.frames, start);
    assertSafeToolTurn(toolUpdates, toolProfile.expectedToolTitle);
    await assertWaitingForNext(site, sessionId, env, siteHome, evidence);

    const cancellationPrompt =
      'Safely think for at least ten seconds, then answer briefly.';
    promptStrings.push(cancellationPrompt);
    const longPrompt = second.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: cancellationPrompt }],
    });
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 1_000));
    const cancelStartedAt = Date.now();
    second.notify('session/cancel', { sessionId });
    const cancelled = await longPrompt;
    cancelLatencyMs = Date.now() - cancelStartedAt;
    if (
      cancelled?.stopReason !== 'cancelled' ||
      cancelLatencyMs > terminateTimeoutMs
    ) {
      throw safeFailure('SMOKE_FAILED');
    }

    const afterCancelPrompt = 'Reply briefly after the drained cancellation.';
    promptStrings.push(afterCancelPrompt);
    const afterDrain = await promptAfterDrain(
      second,
      sessionId,
      afterCancelPrompt,
    );
    if (afterDrain.result?.stopReason !== 'end_turn') {
      throw safeFailure('SMOKE_FAILED');
    }
    assertTurn(second.frames, afterDrain.start);
    await assertWaitingForNext(site, sessionId, env, siteHome, evidence);
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupFailure;
  for (const client of clients.reverse()) {
    try {
      await client.close();
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  forbiddenValues.push(siteHome, ...promptStrings);
  const lateEvidence = [
    ...evidence,
    ...clients.map((client) => client.evidence()),
  ];
  try {
    await rawLog.append({ site, evidence: lateEvidence });
    scanPrivacyEvidence(JSON.stringify(lateEvidence), forbiddenValues);
  } catch (error) {
    primaryFailure ??= error;
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (typeof sessionId !== 'string' || cancelLatencyMs === undefined) {
    throw safeFailure('SMOKE_FAILED');
  }
  return {
    sessionHash: createHash('sha256')
      .update(salt)
      .update('\0')
      .update(sessionId)
      .digest('hex')
      .slice(0, 16),
    cancelLatencyMs,
  };
}

async function approval(options) {
  if (
    !options.approved ||
    !process.stdin.isTTY ||
    !process.stderr.isTTY ||
    options.toolProfile !== 'public-http-lookup'
  ) {
    throw safeFailure('APPROVAL_REQUIRED');
  }
  const input = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const answer = await input.question(
    'Type RUN REAL AIME CN AND I18N-TT to authorize browser auth and safe remote prompts in both isolated homes: ',
  );
  input.close();
  if (answer !== 'RUN REAL AIME CN AND I18N-TT') {
    throw safeFailure('APPROVAL_REQUIRED');
  }
}

async function main() {
  const startedAt = Date.now();
  let rawLog;
  let output;
  let exitCode = 0;
  const forbiddenValues = [...Object.values(privacyCanaries)];
  try {
    const options = parseArguments(process.argv.slice(2));
    const testHome = await validateTestHome(options.testHome);
    const toolProfile = resolveToolProfile(options.toolProfile);
    await approval(options);
    rawLog = await createEphemeralEvidenceLog(testHome);
    forbiddenValues.push(testHome);
    const salt = randomBytes(32);
    const sessions = {};
    const cancelLatencyMs = {};
    for (const site of requiredSites) {
      const result = await runSite(
        site,
        testHome,
        toolProfile,
        salt,
        rawLog,
        forbiddenValues,
      );
      sessions[site] = result.sessionHash;
      cancelLatencyMs[site] = result.cancelLatencyMs;
    }
    output = {
      schemaVersion: 1,
      ok: true,
      sites: requiredSites,
      sessionHashes: sessions,
      cancelLatencyMs,
      timingMs: Date.now() - startedAt,
    };
  } catch (error) {
    const candidate = error?.safeCode;
    output = {
      schemaVersion: 1,
      ok: false,
      sites: requiredSites,
      errorCode: safeCodes.has(candidate) ? candidate : 'SMOKE_FAILED',
      timingMs: Date.now() - startedAt,
    };
    exitCode = 1;
  } finally {
    if (rawLog !== undefined) {
      try {
        await rawLog.sync();
        await rawLog.readAndScan(forbiddenValues);
      } catch {
        output = {
          schemaVersion: 1,
          ok: false,
          sites: requiredSites,
          errorCode: 'SMOKE_FAILED',
          timingMs: Date.now() - startedAt,
        };
        exitCode = 1;
      }
      try {
        await rawLog.closeAndDelete();
      } catch {
        output = {
          schemaVersion: 1,
          ok: false,
          sites: requiredSites,
          errorCode: 'SMOKE_FAILED',
          timingMs: Date.now() - startedAt,
        };
        exitCode = 1;
      }
    }
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] !== undefined) {
  const invoked = await realpath(process.argv[1]).catch(() => undefined);
  const current = await realpath(fileURLToPath(import.meta.url));
  if (invoked === current) await main();
}
