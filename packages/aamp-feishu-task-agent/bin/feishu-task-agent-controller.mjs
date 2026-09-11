#!/usr/bin/env node

import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ReadStream, WriteStream } from 'node:tty';
import { emitKeypressEvents } from 'node:readline';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  TASK_AGENT_TYPES,
  resolveTaskAgentMetadata,
} from './agent-metadata.mjs';
import {
  createKeyedSerialExecutor,
  createSerializedRunner,
  runLayeredStarts,
} from './runtime-concurrency.mjs';
import {
  createPackageExecutableLauncher,
  npmExecutableResolverArgs,
  parseResolvedPackageExecutable,
} from './runtime-package-executable.mjs';
import {
  agentStartRetryError,
  agentStartFailureMessage,
  bridgeAuthenticationRetryError,
  classifyNetworkError,
  createSerializedLineWriter,
  describeNetworkError,
  isRetryableNetworkError,
  launchDetachedDiagnostic,
  networkEnvironmentSummary,
  probeEndpoint,
  preserveAgentStartFailure,
  safeDiagnosticUrl,
  withNetworkRetry,
} from './runtime-network.mjs';
import {
  createLaunchdServiceManager,
  findOwnedControllerPids,
  readProcessIdentity,
  stopOwnedControllerProcesses,
} from './launchd-service.mjs';

process.umask(0o077);

const COMMAND = process.argv[2] || 'help';
const NON_INTERACTIVE = COMMAND === '__service-run'
  || process.env.AAMP_TASK_NON_INTERACTIVE === 'true';
const CONTROLLER_PATH = path.resolve(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const STATE_HOME = process.env.AAMP_TASK_STATE_HOME || path.join(HOME, '.aamp', 'feishu-task-agent');
const CONFIG_FILE = process.env.AAMP_TASK_CONFIG_FILE || path.join(STATE_HOME, 'bindings-v1.json');
const RUNTIME_HOME = process.env.AAMP_TASK_RUNTIME_HOME || path.join(STATE_HOME, 'runtime-v1');
const CONFIG_LOCK = path.join(STATE_HOME, 'bindings-v1.lock');
const MUTATION_LOCK = path.join(STATE_HOME, 'bindings-v1-mutation.lock');
const SERVICE_CONTROL_LOCK = path.join(STATE_HOME, 'service-v1-control.lock');
const LEASES_HOME = path.join(RUNTIME_HOME, 'leases');
const RUNTIME_SESSION_LOCK = path.join(LEASES_HOME, 'runtime-session.lock');
const RUN_LOG_DIR = process.env.AAMP_RUN_LOG_DIR || path.join(HOME, '.aamp', 'logs', 'runs', `${Date.now()}-${process.pid}`);
const RUN_ID = process.env.AAMP_RUN_ID || path.basename(RUN_LOG_DIR);
const RUN_STARTED_AT = nowIso();
const MANIFEST_FILE = path.join(RUN_LOG_DIR, 'manifest.json');
const ERRORS_LOG = process.env.ERRORS_LOG || path.join(RUN_LOG_DIR, 'errors.jsonl');
const BOOTSTRAP = process.env.AAMP_TASK_BOOTSTRAP_PATH || '';
const NPM_BIN = process.env.AAMP_TASK_NPM_BIN || 'npm';
const NPM_REGISTRY = process.env.AAMP_TASK_NPM_REGISTRY || 'https://registry.npmjs.org/';
const FEISHU_API_PROBE_URL = 'https://open.feishu.cn/';
const NPM_CACHE_DIR = process.env.AAMP_TASK_NPM_CACHE_DIR || path.join(os.tmpdir(), 'aamp-one-click-npm-cache');
const ACP_PACKAGE = process.env.AAMP_TASK_ACP_BRIDGE_PKG || '@luckyterry/aamp-acp-bridge@0.1.29-dev.0';
const FEISHU_PACKAGE = process.env.AAMP_TASK_FEISHU_BRIDGE_PKG || '@iluolyx/aamp-feishu-bridge@0.1.52-dev.5';
const INSTALL_COMMAND = process.env.AAMP_TASK_INSTALL_COMMAND
  || 'npx -y --package @larktask/aamp-feishu-task-agent@dev feishu-task-agent install';
const DEFAULT_AGENT = process.env.AAMP_TASK_DEFAULT_AGENT || '';
const DEFAULT_AAMP_HOST = process.env.AAMP_TASK_AAMP_HOST || 'https://meshmail.ai';
const DEBUG_MODE = process.env.AAMP_TASK_DEBUG_MODE === 'true';
const READY_TIMEOUT_MS = Number(process.env.AAMP_TASK_READY_TIMEOUT_MS || 90_000);
const FOREGROUND_MODE = process.env.AAMP_TASK_FOREGROUND === 'true';
const NO_START_MODE = process.env.AAMP_TASK_NO_START === 'true';
const SERVICE_BOOTSTRAP = BOOTSTRAP || path.join(HOME, '.aamp', 'bin', 'feishu-task-agent');
const SERVICE_PATH = [...new Set([
  path.dirname(process.execPath),
  ...(path.isAbsolute(NPM_BIN) ? [path.dirname(NPM_BIN)] : []),
  ...String(process.env.PATH || '').split(path.delimiter),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].filter(Boolean))].join(path.delimiter);
const launchdService = createLaunchdServiceManager({
  home: HOME,
  uid: typeof process.getuid === 'function' ? process.getuid() : 0,
  platform: process.platform,
  bootstrapPath: SERVICE_BOOTSTRAP,
  pathValue: SERVICE_PATH,
});
const NETWORK_MAX_ATTEMPTS = Math.max(1, Number(process.env.AAMP_TASK_NETWORK_MAX_ATTEMPTS || 3));
const NETWORK_RETRY_BASE_DELAY_MS = Math.max(0, Number(process.env.AAMP_TASK_NETWORK_RETRY_BASE_DELAY_MS || 500));
const NETWORK_PROBE_TIMEOUT_MS = Math.max(1_000, Number(process.env.AAMP_TASK_NETWORK_PROBE_TIMEOUT_MS || 10_000));
const FEISHU_START_CONCURRENCY = 4;
const AIME_ALLOWED_TENANT_KEY = '736588c9260f175d';
const CONFIG_SCHEMA = 'aamp.feishu-task-agent.bindings';
const CONFIG_VERSION = 1;
const PROFILE_DOMAINS = ['task'];
const OPEN_API_DOMAIN_BY_TENANT_BRAND = Object.freeze({
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
});

const secrets = new Set();
const managedProcesses = new Set();
const transientProcesses = new Set();
const heldLeases = new Set();
const bindingStatuses = new Map();
const runPairingSerially = createKeyedSerialExecutor();
const errorLogWriter = createSerializedLineWriter((content) => appendPrivate(ERRORS_LOG, content));
const manifestWriter = createSerializedRunner(async () => {
  const statuses = [...bindingStatuses.entries()].map(([bindingId, status]) => ({
    binding_id: bindingId,
    ...status,
  }));
  await writeJsonAtomic(MANIFEST_FILE, {
    schema: 'aamp.local_logs.run.v2',
    run_id: RUN_ID,
    task_agent_version: process.env.AAMP_TASK_AGENT_VERSION || '',
    command: COMMAND,
    started_at: process.env.AAMP_TASK_RUN_STARTED_AT || RUN_STARTED_AT,
    config_file: CONFIG_FILE,
    runtime_home: RUNTIME_HOME,
    bindings: statuses,
    errors_log: ERRORS_LOG,
    log_dir: RUN_LOG_DIR,
  });
});
let stopRequested = false;
let stopSignal = '';
let terminal;
let processStartedAtPromise;

function createResourceCleanup(drain) {
  const runner = createSerializedRunner(drain);
  return () => runner.run();
}

function createPromptInterrupter() {
  let activeCancel;
  return {
    activate(cancel) {
      if (activeCancel) throw new Error('已有交互提示正在等待输入');
      activeCancel = cancel;
      return () => {
        if (activeCancel === cancel) activeCancel = undefined;
      };
    },
    interrupt(error) {
      const cancel = activeCancel;
      if (!cancel) return false;
      activeCancel = undefined;
      cancel(error);
      return true;
    },
  };
}

const promptInterrupter = createPromptInterrupter();

function nowIso() {
  return new Date().toISOString();
}

async function currentProcessStartedAt() {
  processStartedAtPromise ||= readProcessIdentity(process.pid)
    .then((identity) => identity?.startedAt || '')
    .catch(() => '');
  return processStartedAtPromise;
}

function terminalStreams() {
  if (terminal) return terminal;
  let inputFd;
  let outputFd;
  try {
    inputFd = fs.openSync('/dev/tty', 'r');
    outputFd = fs.openSync('/dev/tty', 'w');
  } catch {
    throw new Error('交互操作需要终端');
  }
  terminal = {
    input: new ReadStream(inputFd),
    output: new WriteStream(outputFd),
  };
  return terminal;
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function randomId() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'item';
}

function addSecret(value) {
  if (typeof value === 'string' && value.length >= 4) secrets.add(value);
}

function redact(value) {
  let output = String(value ?? '');
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
  output = output.replace(/\b(Bearer|Basic)\s+[^\s,}]+/gi, '$1 [REDACTED]');
  output = output
    .replace(/([?&]pair_code=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/("?(?:app_secret|appSecret|smtpPassword|mailboxToken|access_token|accessToken|refresh_token|refreshToken|id_token|idToken|session_token|sessionToken|device_code|pairCode|api_key|apiKey|api-key|private_key|privateKey|private-key|auth_token|auth-token|password|authorization|cookie|credential|secret|token|session)"?\s*[:=]\s*"?)(?:(?:Bearer|Basic)\s+)?[^",\s}]+/gi, '$1[REDACTED]')
    .replace(/(--app-secret\s+)[^\s]+/gi, '$1[REDACTED]');
  return output;
}

const REMOTE_EVENT_PATH_PREFIX = 'aamp-runtime:';
const REMOTE_AGENT_FAILED = 'REMOTE_AGENT_FAILED: Remote Agent execution failed.';
const REMOTE_AGENT_PREPARATION_FAILED = 'REMOTE_AGENT_PREPARATION_FAILED: Remote Agent preparation failed.';
const REMOTE_FAILURE_CODES = new Set([
  'AIME_ACCESS_DENIED',
  'AIME_EMPTY_RESPONSE',
  'AIME_MODEL_NOT_FOUND',
  'AIME_NETWORK_UNREACHABLE',
  'AIME_PROTOCOL_DRIFT',
  'AIME_SDK_INCOMPATIBLE',
  'AIME_SEND_FAILED',
  'AIME_SESSION_NOT_FOUND',
  'AIME_STREAM_INTERRUPTED',
  'AIME_UNSUPPORTED_CONTENT',
  'AUTH_CONFIGURATION_UNSUPPORTED',
  'AUTH_IDENTITY_CHANGED',
  'AUTH_IDENTITY_UNAVAILABLE',
  'AUTH_REQUIRED',
  'AUTH_SOURCE_UNSUPPORTED',
  'REMOTE_AGENT_FAILED',
  'REMOTE_ARTIFACT_UNSUPPORTED',
]);

function isRemoteExecution(options) {
  return options?.executionLocation === 'remote';
}

function encodeRemoteEventPath(value, options = {}) {
  const eventPathRoot = options.eventPathRoot;
  const eventPathHandles = options.eventPathHandles;
  if (!eventPathRoot || !(eventPathHandles instanceof Map)
    || typeof value !== 'string' || !path.isAbsolute(value)) return '';
  const root = path.resolve(eventPathRoot);
  const resolved = path.resolve(value);
  if (!isPathInside(root, resolved)) return '';
  let handle;
  do {
    handle = `${REMOTE_EVENT_PATH_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  } while (eventPathHandles.has(handle));
  eventPathHandles.set(handle, { root, resolved });
  return handle;
}

function safeRemoteFailure(value) {
  const message = redact(value);
  const candidate = /\b(?:AIME|AUTH|REMOTE)_[A-Z0-9_]+\b/.exec(message)?.[0];
  const code = candidate && REMOTE_FAILURE_CODES.has(candidate) ? candidate : 'REMOTE_AGENT_FAILED';
  if (message.trim()) return { code, message };
  return { code, message: code === 'REMOTE_AGENT_FAILED' ? REMOTE_AGENT_FAILED : `${code}: Remote Agent execution failed.` };
}

function trustedAgentExecutionLocations(entries = []) {
  const locations = new Map();
  const ambiguous = new Set();
  const values = entries instanceof Map ? entries.entries() : entries;
  for (const entry of values || []) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [name, executionLocation] = entry;
    if (typeof name !== 'string' || !['local', 'remote'].includes(executionLocation)) continue;
    if (locations.has(name) || ambiguous.has(name)) {
      locations.delete(name);
      ambiguous.add(name);
      continue;
    }
    locations.set(name, executionLocation);
  }
  return locations;
}

function trustedAgentIdentity(value, options, executionLocation) {
  if (typeof value !== 'string') return '';
  const actual = options.agentExecutionLocations?.get(value);
  return actual && (!executionLocation || actual === executionLocation) ? value : '';
}

function allowedStructuralIdentity(value, allowedValues) {
  return typeof value === 'string' && new Set(allowedValues || []).has(value) ? value : '';
}

function safeRemoteDuration(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function projectTrustedLocalAgentEvent(document, options = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return undefined;
  const type = typeof document.type === 'string' ? document.type : '';
  const agent = trustedAgentIdentity(document.agent, options, 'local');
  if (!agent || !['agent.starting', 'agent.started', 'agent.identity', 'agent.failed'].includes(type)) {
    return undefined;
  }
  const event = {
    type,
    ...(document.bridge === 'acp-bridge' ? { bridge: 'acp-bridge' } : {}),
    agent,
  };
  if (type === 'agent.starting') return event;
  const durationMs = safeRemoteDuration(document.durationMs);
  if (type === 'agent.started') {
    return {
      ...event,
      ...(typeof document.email === 'string' ? { email: redact(document.email) } : {}),
      connected: document.connected === true,
      pollingFallback: document.pollingFallback === true,
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  }
  if (type === 'agent.identity') {
    return {
      ...event,
      ...(typeof document.email === 'string' ? { email: redact(document.email) } : {}),
      ...(typeof document.acpCommand === 'string' ? { acpCommand: redact(document.acpCommand) } : {}),
    };
  }
  return {
    ...event,
    message: redact(document.message || `${agent} Agent Bridge 启动失败`),
    ...(typeof document.code === 'string'
      ? { code: redact(document.code) }
      : typeof document.code === 'number' ? { code: document.code } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function projectRemoteOperationalEvent(document, options = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return undefined;
  const type = typeof document.type === 'string' ? document.type : '';
  if (type === 'bridge.process') {
    if (!['started', 'exited'].includes(document.status)) return undefined;
    const event = { type, status: document.status };
    const durationMs = safeRemoteDuration(document.durationMs);
    if (durationMs !== undefined) event.durationMs = durationMs;
    if (document.status === 'exited') {
      event.code = Number.isInteger(document.code) ? document.code : null;
      event.signal = typeof document.signal === 'string' && /^SIG[A-Z0-9]+$/.test(document.signal)
        ? document.signal
        : null;
      event.expectedStop = document.expectedStop === true;
      if (document.error) event.error = REMOTE_AGENT_FAILED;
    }
    return event;
  }
  if (type === 'bridge.running') {
    const agents = Array.isArray(document.agents)
      ? document.agents.flatMap((agent) => {
          const name = trustedAgentIdentity(agent?.name, options);
          return name ? [{ name }] : [];
        })
      : [];
    return { type, agentCount: agents.length, agents };
  }
  if (type === 'bridge.task_runtime.starting') {
    const appId = allowedStructuralIdentity(document.appId, options.allowedAppIds);
    const imConfigDir = encodeRemoteEventPath(document.imConfigDir, options);
    const taskConfigDir = encodeRemoteEventPath(document.taskConfigDir, options);
    if (!appId || !imConfigDir || !taskConfigDir) return undefined;
    return { type, appId, imConfigDir, taskConfigDir };
  }
  if (type === 'bridge.task_runtime.running') {
    return { type };
  }
  if (type === 'agent.starting') {
    const agent = trustedAgentIdentity(document.agent, options, 'remote');
    return agent ? { type, agent } : undefined;
  }
  if (type === 'agent.started') {
    const agent = trustedAgentIdentity(document.agent, options, 'remote');
    if (!agent) return undefined;
    const durationMs = safeRemoteDuration(document.durationMs);
    return {
      type,
      agent,
      connected: document.connected === true,
      pollingFallback: document.pollingFallback === true,
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  }
  if (type === 'agent.identity') {
    const agent = trustedAgentIdentity(document.agent, options, 'remote');
    if (!agent) return undefined;
    return {
      type,
      agent,
      executionLocation: 'remote',
      acpCommandConfigured: document.acpCommandConfigured === true,
    };
  }
  if (type === 'agent.failed') {
    const agent = trustedAgentIdentity(document.agent, options, 'remote');
    if (!agent) return undefined;
    const failure = safeRemoteFailure(document.message);
    const durationMs = safeRemoteDuration(document.durationMs);
    return {
      type,
      agent,
      ...failure,
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  }
  return undefined;
}

function safeOperationalLine(line, options = {}) {
  if (!String(line || '').trim()) return '';
  const text = String(line).trim();
  if (!isRemoteExecution(options)) return redact(text);
  try {
    const document = JSON.parse(text);
    const localEvent = projectTrustedLocalAgentEvent(document, options);
    if (localEvent) return JSON.stringify(localEvent);
    const projected = projectRemoteOperationalEvent(document, options);
    return projected ? JSON.stringify(projected) : redact(text);
  } catch {
    return redact(text);
  }
}

function safeOperationalOutput(value, options = {}) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => safeOperationalLine(line, options))
    .join('\n');
}

function safeCapturedLog(stdout, stderr, options = {}) {
  const chunks = [stdout, stderr]
    .map((value) => safeOperationalOutput(value, options).replace(/\n+$/g, ''))
    .filter(Boolean);
  return chunks.length ? `${chunks.join('\n')}\n` : '';
}

function resolveRemoteEventPath(value, record, eventPathRoot) {
  const isHandle = typeof value === 'string' && value.startsWith(REMOTE_EVENT_PATH_PREFIX);
  if (!isHandle) {
    if (record?.eventPathHandles instanceof Map) throw new Error('Feishu Bridge 返回了无效的安全路径');
    return value;
  }
  const entry = record?.eventPathHandles?.get(value);
  const root = path.resolve(eventPathRoot);
  if (!entry || entry.root !== root || !isPathInside(root, entry.resolved)) {
    throw new Error('Feishu Bridge 返回了无效的安全路径');
  }
  return entry.resolved;
}

async function ensurePrivateDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700).catch(() => {});
}

async function appendPrivate(file, content) {
  await ensurePrivateDir(path.dirname(file));
  await fsp.appendFile(file, redact(content), { encoding: 'utf8', mode: 0o600 });
  await fsp.chmod(file, 0o600).catch(() => {});
}

async function appendDiagnostic(file, event) {
  await appendPrivate(file, `${JSON.stringify({ timestamp: nowIso(), ...event })}\n`).catch(() => {});
}

function aampDiscoveryUrl(host) {
  return safeDiagnosticUrl(new URL('/.well-known/aamp', host).toString());
}

function diagnosticEndpoints(host) {
  return [
    { target: 'aamp', url: aampDiscoveryUrl(host) },
    { target: 'feishu-open-api', url: FEISHU_API_PROBE_URL },
    { target: 'npm-registry', url: new URL('/', NPM_REGISTRY).toString() },
  ];
}

async function probeFailureEndpoints(host, logFile, environment, stage) {
  await Promise.allSettled(diagnosticEndpoints(host).map(async ({ target, url }) => {
    try {
      await probeEndpoint(url, {
        maxAttempts: 1,
        timeoutMs: NETWORK_PROBE_TIMEOUT_MS,
        environment,
        onAttempt: (event) => appendDiagnostic(logFile, { ...event, stage, target }),
      });
    } catch (error) {
      await appendDiagnostic(logFile, {
        type: 'network.probe.failed',
        stage,
        target,
        url: safeDiagnosticUrl(url),
        category: classifyNetworkError(error),
        error: describeNetworkError(error),
      });
    }
  }));
}

async function runNetworkStage(operation, {
  stage,
  label,
  host,
  logFile,
  environment,
  shouldRetry = isRetryableNetworkError,
}) {
  const inherited = networkEnvironmentSummary(process.env);
  const effective = networkEnvironmentSummary(environment);
  await appendDiagnostic(logFile, {
    type: 'network.context',
    stage,
    endpoints: diagnosticEndpoints(host).map(({ target, url }) => ({ target, url: safeDiagnosticUrl(url) })),
    node: effective.node,
    platform: effective.platform,
    arch: effective.arch,
    osRelease: effective.osRelease,
    inheritedProxyEnvPresent: inherited.proxyEnvPresent,
    effectiveProxyEnvPresent: effective.proxyEnvPresent,
    proxyValuesLogged: false,
  });
  return withNetworkRetry(async ({ attempt, maxAttempts }) => {
    const startedAt = Date.now();
    await appendDiagnostic(logFile, {
      type: 'bridge.stage',
      stage,
      status: 'starting',
      attempt,
      maxAttempts,
      host: safeDiagnosticUrl(host),
    });
    try {
      const result = await operation({ attempt, maxAttempts });
      await appendDiagnostic(logFile, {
        type: 'bridge.stage',
        stage,
        status: 'succeeded',
        attempt,
        maxAttempts,
        durationMs: Date.now() - startedAt,
        host: safeDiagnosticUrl(host),
      });
      return result;
    } catch (error) {
      await appendDiagnostic(logFile, {
        type: 'bridge.stage',
        stage,
        status: 'failed',
        attempt,
        maxAttempts,
        durationMs: Date.now() - startedAt,
        host: safeDiagnosticUrl(host),
        category: classifyNetworkError(error),
        retryable: shouldRetry(error),
        error: describeNetworkError(error),
      });
      throw error;
    }
  }, {
    maxAttempts: NETWORK_MAX_ATTEMPTS,
    baseDelayMs: NETWORK_RETRY_BASE_DELAY_MS,
    shouldRetry,
    onRetry: async (event) => {
      await appendDiagnostic(logFile, { type: 'network.retry', stage, label, host: safeDiagnosticUrl(host), ...event });
      if (event.category === 'mail_auth') {
        console.log(`[aamp-one-click] ${label}检测到 AAMP 邮箱凭据失效，正在重新注册并重试（${event.attempt + 1}/${event.maxAttempts}）...`);
      } else {
        console.log(`[aamp-one-click] ${label}遇到网络波动，正在重试（${event.attempt + 1}/${event.maxAttempts}）...`);
      }
      launchDetachedDiagnostic(() => probeFailureEndpoints(host, logFile, environment, `${stage}-retry-probe`));
    },
  });
}

async function writeJsonAtomic(file, value) {
  const parent = path.dirname(file);
  await ensurePrivateDir(parent);
  const temp = path.join(parent, `.${path.basename(file)}.${process.pid}.${randomId()}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await fsp.open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(temp, file);
    renamed = true;
    await fsp.chmod(file, 0o600);
    const parentHandle = await fsp.open(parent, 'r').catch(() => undefined);
    if (parentHandle) {
      await parentHandle.sync().catch(() => {});
      await parentHandle.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!renamed) await fsp.unlink(temp).catch(() => {});
  }
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireDirectoryLock(lockDir, label, timeoutMs = 10_000) {
  const started = Date.now();
  await ensurePrivateDir(path.dirname(lockDir));
  while (Date.now() - started < timeoutMs) {
    try {
      await fsp.mkdir(lockDir, { mode: 0o700 });
      const processStartedAt = await currentProcessStartedAt();
      await writeJsonAtomic(path.join(lockDir, 'owner.json'), {
        pid: process.pid,
        run_id: RUN_ID,
        label,
        created_at: nowIso(),
        controller_path: CONTROLLER_PATH,
        runtime_home: RUNTIME_HOME,
        ...(processStartedAt ? { process_started_at: processStartedAt } : {}),
      });
      return async () => {
        await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = await readJson(path.join(lockDir, 'owner.json'));
      } catch {
        owner = undefined;
      }
      if (!owner) {
        const stat = await fsp.stat(lockDir).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs < 5_000) {
          await delay(150);
          continue;
        }
      }
      if (!owner || !pidAlive(Number(owner.pid))) {
        await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await delay(150);
    }
  }
  throw new Error(`${label} 正在被另一个 feishu-task-agent 进程使用`);
}

async function withConfigLock(callback) {
  const release = await acquireDirectoryLock(CONFIG_LOCK, '配置文件');
  try {
    return await callback();
  } finally {
    await release();
  }
}

async function withMutationLock(label, callback) {
  const release = await acquireDirectoryLock(MUTATION_LOCK, label, 1_500);
  try {
    return await callback();
  } finally {
    await release();
  }
}

async function withServiceControlLock(callback) {
  const release = await acquireDirectoryLock(SERVICE_CONTROL_LOCK, '后台服务配置');
  try {
    return await callback();
  } finally {
    await release();
  }
}

async function hasActiveAgentLease() {
  let entries;
  try {
    entries = await fsp.readdir(LEASES_HOME, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('agent-') || !entry.name.endsWith('.lock')) continue;
    try {
      const owner = await readJson(path.join(LEASES_HOME, entry.name, 'owner.json'));
      if (pidAlive(Number(owner.pid))) return true;
    } catch {
      // Missing or malformed stale leases are handled by normal lease acquisition.
    }
  }
  return false;
}

async function acquireRuntimeSessionLease(action) {
  if (await hasActiveAgentLease()) {
    throw new Error(`检测到已有 feishu-task-agent 正在运行。请先执行 feishu-task-agent status 查看状态；如需重启，执行 feishu-task-agent stop 后再运行 feishu-task-agent ${action}`);
  }
  let release;
  try {
    release = await acquireDirectoryLock(RUNTIME_SESSION_LOCK, 'Bridge 启动流程', 1_500);
  } catch (error) {
    if (String(error?.message || error).includes('正在被另一个 feishu-task-agent 进程使用')) {
      throw new Error(`检测到已有 feishu-task-agent 正在运行。请先执行 feishu-task-agent status 查看状态；如需重启，执行 feishu-task-agent stop 后再运行 feishu-task-agent ${action}`);
    }
    throw error;
  }
  const lease = { lockDir: RUNTIME_SESSION_LOCK, release };
  heldLeases.add(lease);
  if (stopRequested) {
    await releaseLease(lease);
    throwIfStopping();
  }
  return lease;
}

function emptyStore() {
  return { schema: CONFIG_SCHEMA, version: CONFIG_VERSION, bindings: [] };
}

function assertString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`配置字段 ${field} 无效`);
}

function bindingState(binding) {
  return binding?.state ?? 'ready';
}

function bindingNeedsInitialStart(binding) {
  return bindingState(binding) === 'pending';
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function expectedFeishuConfigDir(bindingId) {
  const bindingsHome = path.join(RUNTIME_HOME, 'bindings');
  const resolved = path.join(bindingsHome, bindingId, 'feishu-bridge');
  if (!isPathInside(bindingsHome, resolved)) throw new Error('binding_id 不能逃逸新流程 runtime-v1');
  return resolved;
}

async function assertNoSymlinkPath(root, candidate) {
  if (!isPathInside(root, candidate)) throw new Error('runtime 路径逃逸新流程目录');
  const rootPath = path.resolve(root);
  const segments = path.relative(rootPath, path.resolve(candidate)).split(path.sep).filter(Boolean);
  let current = rootPath;
  for (const segment of ['', ...segments]) {
    if (segment) current = path.join(current, segment);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`拒绝使用包含符号链接的 runtime 路径：${current}`);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

async function resolveConfiguredPendingPairingFile(group, agentType) {
  const configuredAgents = (group?.agents || []).filter((agent) => agent?.name === agentType);
  if (configuredAgents.length !== 1 || typeof configuredAgents[0].pairingFile !== 'string'
    || !configuredAgents[0].pairingFile.trim()) {
    throw new Error('ACP Bridge 私有配对文件配置缺失或 Agent 不唯一');
  }
  if (typeof group?.home !== 'string' || !path.isAbsolute(group.home)
    || !isPathInside(RUNTIME_HOME, group.home)) {
    throw new Error('ACP Bridge runtime 不属于 Task Agent 私有目录');
  }
  if (!path.isAbsolute(configuredAgents[0].pairingFile)
    || !isPathInside(group.home, configuredAgents[0].pairingFile)) {
    throw new Error('ACP Bridge 私有配对文件不属于当前 Agent Bridge runtime');
  }
  const configuredPairingFile = path.resolve(configuredAgents[0].pairingFile);
  await assertNoSymlinkPath(RUNTIME_HOME, configuredPairingFile);
  return configuredPairingFile;
}

async function resolvePendingPairingFile(group, agentType, pairing) {
  const configuredPairingFile = await resolveConfiguredPendingPairingFile(group, agentType);
  const executionLocation = resolveTaskAgentMetadata(agentType).executionLocation;
  if (executionLocation === 'remote' && pairing?.pairingFileConfigured !== true) {
    throw new Error('ACP Bridge 未确认远程 Agent 的私有配对文件配置');
  }
  if (executionLocation !== 'remote' && (typeof pairing?.pairingFile !== 'string'
    || path.resolve(pairing.pairingFile) !== configuredPairingFile)) {
    throw new Error('ACP Bridge 返回的本地配对文件与私有配置不一致');
  }
  return configuredPairingFile;
}

function validateBinding(binding, index) {
  if (!binding || typeof binding !== 'object') throw new Error(`bindings[${index}] 无效`);
  assertString(binding.binding_id, `bindings[${index}].binding_id`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.binding_id)) {
    throw new Error(`bindings[${index}].binding_id 必须是 UUID`);
  }
  if (!TASK_AGENT_TYPES.includes(binding.agent_type)) {
    throw new Error(`bindings[${index}].agent_type 仅支持 codex/cursor/coco/traex/traecli/workbuddy/workbuddy_ai/aime`);
  }
  assertString(binding.aamp_host, `bindings[${index}].aamp_host`);
  assertString(binding.environment?.name, `bindings[${index}].environment.name`);
  assertString(binding.bot?.app_id, `bindings[${index}].bot.app_id`);
  assertString(binding.bot?.app_secret, `bindings[${index}].bot.app_secret`);
  normalizeTenantBrand(binding.bot?.tenant_brand, `bindings[${index}].bot.tenant_brand`);
  const metadata = resolveTaskAgentMetadata(binding.agent_type);
  if (metadata.executionLocation === 'local') {
    assertString(binding.bot?.lark_cli_profile, `bindings[${index}].bot.lark_cli_profile`);
  }
  assertString(binding.feishu_config_dir, `bindings[${index}].feishu_config_dir`);
  const expectedConfigDir = expectedFeishuConfigDir(binding.binding_id);
  if (path.resolve(binding.feishu_config_dir) !== path.resolve(expectedConfigDir)) {
    throw new Error(`bindings[${index}].feishu_config_dir 不属于新流程 runtime-v1`);
  }
  const state = bindingState(binding);
  if (!['pending', 'ready'].includes(state)) throw new Error(`bindings[${index}].state 无效`);
  if (state === 'pending') {
    if (binding.agent_target_email !== undefined || binding.runtime !== undefined) {
      throw new Error(`bindings[${index}] 待启动配置不能包含运行时配对信息`);
    }
  } else {
    assertString(binding.agent_target_email, `bindings[${index}].agent_target_email`);
    assertString(binding.runtime?.im_config_dir, `bindings[${index}].runtime.im_config_dir`);
    assertString(binding.runtime?.task_config_dir, `bindings[${index}].runtime.task_config_dir`);
    if (!isPathInside(expectedConfigDir, binding.runtime.im_config_dir) || !isPathInside(expectedConfigDir, binding.runtime.task_config_dir)) {
      throw new Error(`bindings[${index}].runtime 配置目录不属于新流程 runtime-v1`);
    }
  }
  addSecret(binding.bot.app_secret);
  return binding;
}

function validateStore(store) {
  if (!store || store.schema !== CONFIG_SCHEMA || store.version !== CONFIG_VERSION || !Array.isArray(store.bindings)) {
    throw new Error(`新流程配置格式无效：${CONFIG_FILE}`);
  }
  const ids = new Set();
  const appIds = new Set();
  store.bindings.forEach((binding, index) => {
    validateBinding(binding, index);
    if (ids.has(binding.binding_id)) throw new Error(`配置中存在重复 binding_id：${binding.binding_id}`);
    if (appIds.has(binding.bot.app_id)) throw new Error(`配置中存在重复 Bot：${binding.bot.app_id}`);
    ids.add(binding.binding_id);
    appIds.add(binding.bot.app_id);
  });
  return store;
}

async function loadStore() {
  try {
    return validateStore(await readJson(CONFIG_FILE));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
    throw error;
  }
}

function bindingExpectation(binding) {
  return {
    binding_id: binding.binding_id,
    updated_at: binding.updated_at,
  };
}

function normalizeTenantBrand(value, field = 'tenant_brand') {
  if (value === undefined || value === null || value === '') return 'feishu';
  if (value !== 'feishu' && value !== 'lark') {
    throw new Error(`${field} 仅支持 feishu/lark`);
  }
  return value;
}

function openApiDomainForTenantBrand(value) {
  return OPEN_API_DOMAIN_BY_TENANT_BRAND[normalizeTenantBrand(value)];
}

function sameBindingRelationship(existing, candidate) {
  return Boolean(existing && candidate
    && existing.agent_type === candidate.agent_type
    && existing.aamp_host === candidate.aamp_host
    && existing.environment?.name === candidate.environment?.name
    && existing.bot?.app_id === candidate.bot?.app_id
    && normalizeTenantBrand(existing.bot?.tenant_brand)
      === normalizeTenantBrand(candidate.bot?.tenant_brand));
}

async function upsertBindings(intents) {
  return withConfigLock(async () => {
    const store = await loadStore();
    const intentByAppId = new Map();
    for (const intent of intents) {
      const appId = intent.binding.bot.app_id;
      if (intentByAppId.has(appId)) throw new Error(`Bot ${appId} 在本次操作中重复选择`);
      intentByAppId.set(appId, intent);
    }

    let replacedCount = 0;
    const consumed = new Set();
    const bindings = store.bindings.map((current) => {
      const appId = current.bot.app_id;
      const intent = intentByAppId.get(appId);
      if (!intent) return current;
      const expected = intent.expected;
      if (!expected
        || current.binding_id !== expected.binding_id
        || current.updated_at !== expected.updated_at) {
        throw new Error(`Bot ${appId} 的绑定已发生变化，请重新执行`);
      }
      consumed.add(appId);
      replacedCount += 1;
      return intent.binding;
    });

    for (const [appId, intent] of intentByAppId) {
      if (consumed.has(appId)) continue;
      if (intent.expected) throw new Error(`Bot ${appId} 的绑定已发生变化，请重新执行`);
      bindings.push(intent.binding);
    }

    const next = validateStore({ ...emptyStore(), bindings });
    await writeJsonAtomic(CONFIG_FILE, next);
    return { bindings: intents.map(({ binding }) => binding), replacedCount };
  });
}

async function updateBinding(binding) {
  await withConfigLock(async () => {
    const store = await loadStore();
    const index = store.bindings.findIndex((item) => item.binding_id === binding.binding_id);
    if (index < 0) throw new Error(`绑定配置已被移除：${binding.binding_id}`);
    if (store.bindings[index].bot.app_id !== binding.bot.app_id) {
      throw new Error(`绑定配置的 Bot 已变化：${binding.binding_id}`);
    }
    validateBinding(binding, index);
    const bindings = [...store.bindings];
    bindings[index] = binding;
    await writeJsonAtomic(CONFIG_FILE, { ...emptyStore(), bindings });
  });
}

function agentSelectionDisplayName(agent) {
  return agent;
}

function agentBindingDisplayName(agent) {
  return agent;
}

function bindingLabel(binding, resolvedAgentType = binding.agent_type) {
  const botName = binding.bot?.display_name || binding.bot?.app_id || 'unknown Bot';
  return `${agentBindingDisplayName(resolvedAgentType)} ↔ ${botName} (${binding.bot?.app_id || 'unknown'})`;
}

function pairingQueueKey(prepared) {
  return `${prepared.group.host}\u0000${prepared.binding.agent_type}`;
}

function orderStartupItems(bindings, items) {
  const order = new Map(bindings.map((binding, index) => [binding.binding_id, index]));
  return [...items].sort((left, right) => (
    (order.get(left.binding.binding_id) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.binding.binding_id) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function startupSummaryLines({ title, plannedCount, running = [], failed = [], cancelled = [] }) {
  const lines = [`${title} ${running.length}/${plannedCount} 个配置。`];
  if (running.length) {
    lines.push('启动成功：');
    for (const item of running) {
      lines.push(`- ${bindingLabel(item.binding, item.runtimeAgentType)}`);
    }
  }
  if (failed.length) {
    lines.push('启动失败：');
    for (const item of failed) {
      lines.push(`- ${bindingLabel(item.binding, item.runtimeAgentType)}`);
      lines.push(`  原因：${safeBindingFailureReason(item.binding, item.reason)}`);
    }
  }
  if (cancelled.length) {
    lines.push('已取消：');
    for (const item of cancelled) {
      lines.push(`- ${bindingLabel(item.binding, item.runtimeAgentType)}`);
      lines.push(`  原因：${redact(item.reason)}`);
    }
  }
  return lines;
}

function printStartupSummary(options) {
  console.log(`\n${startupSummaryLines(options).join('\n')}`);
}

function installHasOnlyCancellations({ cancelled = [], failures = [], selectionFailures = [] }) {
  return cancelled.length > 0 && failures.length === 0 && selectionFailures.length === 0;
}

function agentFailureMessage(agentType, message) {
  const text = safeAgentFailureReason(agentType, message || 'Agent Bridge 启动失败');
  if (agentType === 'traecli') {
    return `${text}\n请执行 'traecli doctor --json' 检查 TraeCode CLI，修复后重试。`;
  }
  const productName = agentType === 'workbuddy'
    ? 'WorkBuddy'
    : agentType === 'workbuddy_ai'
      ? 'WorkBuddy AI'
      : '';
  if (!productName) return text;
  if (text.startsWith(`${productName} is not logged in.`)
    || text.startsWith(`${productName} login expired.`)) return text;
  return `${text}\n如果尚未登录，请打开 ${productName} 完成登录后重试。`;
}

function safeAgentFailureReason(agentType, message) {
  try {
    if (typeof resolveTaskAgentMetadata === 'function'
      && resolveTaskAgentMetadata(agentType).executionLocation === 'remote') {
      return safeRemoteFailure(message).message;
    }
  } catch {
    // Unknown Agent validation remains authoritative at its existing call sites.
  }
  return String(message ?? '');
}

function safeBindingFailureReason(binding, message) {
  try {
    if (resolveTaskAgentMetadata(binding?.agent_type).executionLocation === 'remote') {
      return safeRemoteFailure(message).message;
    }
  } catch {
    // Binding validation remains authoritative at its existing call sites.
  }
  return redact(message);
}

function resolvePreparedAgentBindings(bindings, host, requestedAgentType, preparedAgentType) {
  const runtimeAgentType = preparedAgentType || requestedAgentType;
  if (!TASK_AGENT_TYPES.includes(runtimeAgentType)) {
    throw new Error(`unexpected prepared Agent type: ${runtimeAgentType}`);
  }
  if (runtimeAgentType === requestedAgentType) {
    return {
      requestedAgentType,
      runtimeAgentType,
      stableAgentType: requestedAgentType,
      stableAgentTypes: [requestedAgentType],
      bindingsToNormalize: [],
    };
  }
  if (requestedAgentType !== 'coco' || !['traex', 'traecli'].includes(runtimeAgentType)) {
    throw new Error(`unexpected prepared Agent type: ${requestedAgentType} -> ${runtimeAgentType}`);
  }
  const matching = bindings.filter((binding) => (
    binding.aamp_host === host && binding.agent_type === requestedAgentType
  ));
  const bindingsToNormalize = matching.filter((binding) => (
    binding.state === 'pending' && !binding.agent_target_email
  ));
  const keepHistoricalIdentity = matching.some((binding) => !bindingsToNormalize.includes(binding));
  const stableAgentTypes = [
    ...(keepHistoricalIdentity || !bindingsToNormalize.length ? [requestedAgentType] : []),
    ...(bindingsToNormalize.length ? [runtimeAgentType] : []),
  ];
  return {
    requestedAgentType,
    runtimeAgentType,
    stableAgentType: stableAgentTypes[0],
    stableAgentTypes,
    bindingsToNormalize,
  };
}

function commitPreparedAgentBindings(plan) {
  for (const binding of plan.bindingsToNormalize) binding.agent_type = plan.runtimeAgentType;
  return plan.stableAgentType;
}

async function prepareAndCommitAgentBindings(plan, prepare) {
  const results = [];
  for (const stableAgentType of plan.stableAgentTypes) {
    results.push(await prepare(stableAgentType));
  }
  commitPreparedAgentBindings(plan);
  return results;
}

function recordPreparationFailure(group, requestedAgentType, runtimeAgentType, error) {
  const reason = agentFailureMessage(runtimeAgentType || requestedAgentType, error?.message || error);
  group.failures.set(requestedAgentType, reason);
  return reason;
}

function recordStableAgentFailure(group, stableAgentType, message) {
  const runtimeAgentType = group.runtimeAgentTypes.get(stableAgentType) || stableAgentType;
  const reason = agentFailureMessage(runtimeAgentType, message);
  group.failures.set(stableAgentType, reason);
  return reason;
}

function printBindingStarted(binding, runtimeAgentType = binding.agent_type) {
  console.log(`[aamp-one-click] 启动成功：${bindingLabel(binding, runtimeAgentType)}`);
}

function bindingCancellationReason(groups, binding) {
  return groups.get(binding.aamp_host)?.cancellations?.get(binding.agent_type) || '';
}

function printBindingCancelled(binding, reason) {
  console.log(`\n🟡 已取消：${bindingLabel(binding)}`);
  console.log(`   原因：${reason}`);
}

async function recordError(component, message, binding) {
  const safeMessage = binding ? safeBindingFailureReason(binding, message) : redact(message);
  await errorLogWriter.write(`${JSON.stringify({
    timestamp: nowIso(),
    level: 'error',
    component,
    binding_id: binding?.binding_id,
    app_id: binding?.bot?.app_id,
    message: safeMessage,
  })}\n`);
}

async function writeManifest() {
  await manifestWriter.run();
}

async function setBindingStatus(binding, phase, status, reason = '') {
  const safeReason = status === 'failed'
    ? safeBindingFailureReason(binding, reason)
    : redact(reason);
  bindingStatuses.set(binding.binding_id, {
    agent_type: binding.agent_type,
    app_id: binding.bot.app_id,
    bot_name: binding.bot.display_name || binding.bot.app_id,
    phase,
    status,
    ...(reason ? { reason: safeReason } : {}),
    updated_at: nowIso(),
  });
  await writeManifest();
}

async function chooseOne(title, items, render, initialIndex = 0) {
  if (!items.length) throw new Error(`${title}：没有可选项`);
  const { input, output } = terminalStreams();
  let cursor = Math.min(Math.max(initialIndex, 0), items.length - 1);
  const lineCount = items.length + 2;
  const wasRaw = Boolean(input.isRaw);
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write('\x1b[?25l');

  const draw = (redraw = false) => {
    if (redraw) output.write(`\x1b[${lineCount}A`);
    output.write(`\x1b[2K\r${title}\n`);
    items.forEach((item, index) => {
      const pointer = index === cursor ? '>' : ' ';
      output.write(`\x1b[2K\r  ${pointer} ${render(item)}\n`);
    });
    output.write('\x1b[2K\r使用 ↑/↓ 移动，回车确认。\n');
  };

  draw();
  return new Promise((resolve, reject) => {
    let finished = false;
    let releasePrompt = () => {};
    const finish = (error) => {
      if (finished) return;
      finished = true;
      releasePrompt();
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\x1b[?25h');
      if (error) reject(error);
      else resolve(items[cursor]);
    };
    const onKeypress = (_value, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        stopRequested = true;
        stopSignal = 'SIGINT';
        finish(new Error('用户取消操作'));
        void cleanupAll();
        return;
      }
      if (key.name === 'up' || key.name === 'k') cursor = (cursor + items.length - 1) % items.length;
      else if (key.name === 'down' || key.name === 'j') cursor = (cursor + 1) % items.length;
      else if (key.name === 'return' || key.name === 'enter') {
        finish();
        return;
      } else {
        return;
      }
      draw(true);
    };
    releasePrompt = promptInterrupter.activate(finish);
    input.on('keypress', onKeypress);
  });
}

async function chooseMany(title, items, render) {
  const { input, output } = terminalStreams();
  const options = [{ all: true, label: '全部' }, ...items.map((item) => ({ item, label: render(item) }))];
  let cursor = 0;
  const checked = new Set();
  const lineCount = options.length + 2;
  const wasRaw = Boolean(input.isRaw);
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write('\x1b[?25l');

  const draw = (redraw = false) => {
    if (redraw) output.write(`\x1b[${lineCount}A`);
    output.write(`\x1b[2K\r${title}\n`);
    options.forEach((option, index) => {
      const pointer = index === cursor ? '>' : ' ';
      const mark = checked.has(index) ? 'x' : ' ';
      output.write(`\x1b[2K\r  ${pointer} [${mark}] ${option.label}\n`);
    });
    output.write('\x1b[2K\r使用 ↑/↓ 移动，按空格键选择（支持多选），按回车键确认；选择“全部”会取消其他选项的选中状态。\n');
  };

  draw();
  return new Promise((resolve, reject) => {
    let finished = false;
    let releasePrompt = () => {};
    const finish = (error) => {
      if (finished) return;
      finished = true;
      releasePrompt();
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\x1b[?25h');
      if (error) reject(error);
      else if (checked.has(0)) resolve(items);
      else resolve([...checked].sort((left, right) => left - right).map((index) => options[index].item));
    };
    const onKeypress = (_value, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        stopRequested = true;
        stopSignal = 'SIGINT';
        finish(new Error('用户取消操作'));
        void cleanupAll();
        return;
      }
      if (key.name === 'up' || key.name === 'k') cursor = (cursor + options.length - 1) % options.length;
      else if (key.name === 'down' || key.name === 'j') cursor = (cursor + 1) % options.length;
      else if (key.name === 'space') {
        if (cursor === 0) {
          checked.clear();
          checked.add(0);
        } else {
          checked.delete(0);
          if (checked.has(cursor)) checked.delete(cursor);
          else checked.add(cursor);
        }
      } else if (key.name === 'return' || key.name === 'enter') {
        if (checked.size) finish();
        return;
      } else {
        return;
      }
      draw(true);
    };
    releasePrompt = promptInterrupter.activate(finish);
    input.on('keypress', onKeypress);
  });
}

async function confirm(message, defaultValue = false) {
  const options = [
    { label: '是', value: true },
    { label: '否', value: false },
  ];
  const selected = await chooseOne(message, options, (item) => item.label, defaultValue ? 0 : 1);
  return selected.value;
}

function helperArgs(action, bindingOrAgent) {
  const agent = typeof bindingOrAgent === 'object' ? bindingOrAgent.agent_type : bindingOrAgent;
  const host = typeof bindingOrAgent === 'object' ? bindingOrAgent.aamp_host : DEFAULT_AAMP_HOST;
  const args = [BOOTSTRAP, action];
  if (agent) args.push('--agent', agent);
  args.push('--aamp-host', host || DEFAULT_AAMP_HOST);
  if (DEBUG_MODE) args.push('--debug');
  return args;
}

async function runBootstrapHelper(action, bindingOrAgent, extraEnv = {}) {
  if (!BOOTSTRAP) throw new Error('Bootstrap path is unavailable');
  throwIfStopping();
  const helperAgent = typeof bindingOrAgent === 'object'
    ? bindingOrAgent?.agent_type
    : bindingOrAgent;
  let executionLocation = 'local';
  if (helperAgent) executionLocation = resolveTaskAgentMetadata(helperAgent).executionLocation;
  const helperEnv = { ...extraEnv };
  const nonInteractive = NON_INTERACTIVE
    || helperEnv.AAMP_TASK_NON_INTERACTIVE === 'true';
  if (nonInteractive) helperEnv.AAMP_TASK_NON_INTERACTIVE = 'true';
  const inputPayload = helperEnv.AAMP_TASK_INTERNAL_BINDING_JSON || '';
  delete helperEnv.AAMP_TASK_INTERNAL_BINDING_JSON;
  const remoteHelper = executionLocation === 'remote';
  const helperProcessGroup = remoteHelper && process.platform !== 'win32';
  // node (v25) aborts at startup when spawned detached with a /dev/tty stdin.
  // Remote helpers and service workers never read stdin. Interactive preparation
  // is completed by the foreground process before launchd takes ownership.
  const helperStdin = remoteHelper || nonInteractive ? 'ignore' : terminalStreams().input;
  const helperOutputOptions = {
    executionLocation,
    agentExecutionLocations: trustedAgentExecutionLocations(
      helperAgent ? [[helperAgent, executionLocation]] : [],
    ),
  };
  const child = spawn('bash', helperArgs(action, bindingOrAgent), {
    env: {
      ...process.env,
      ...helperEnv,
      AAMP_TASK_INTERNAL: 'true',
      AAMP_TASK_INTERNAL_RESULT_FD: '3',
      AAMP_TASK_INTERNAL_INPUT_FD: '4',
      ...(remoteHelper ? {
        AAMP_TASK_INTERNAL_EXECUTION_LOCATION: 'remote',
        ONE_CLICK_LOG: '/dev/null',
        ERRORS_LOG: '/dev/null',
      } : {}),
    },
    stdio: [helperStdin, remoteHelper ? 'pipe' : 'inherit', remoteHelper ? 'pipe' : 'inherit', 'pipe', 'pipe'],
    ...(helperProcessGroup ? { detached: true } : {}),
  });
  const processRecord = trackTransientProcess(child, `Bootstrap helper ${action}`, helperProcessGroup);
  let result = '';
  const relayWrites = [];
  const remoteDiagnostics = [];
  const relayRemoteLine = (streamName, line) => {
    if (!String(line || '').trim()) return;
    const safeLine = safeOperationalLine(line, helperOutputOptions);
    remoteDiagnostics.push(safeLine);
    const target = streamName === 'stderr' ? process.stderr : process.stdout;
    target.write(`${safeLine}\n`);
    if (process.env.ONE_CLICK_LOG && process.env.ONE_CLICK_LOG !== '/dev/null') {
      relayWrites.push(appendPrivate(process.env.ONE_CLICK_LOG, `${safeLine}\n`));
    }
  };
  if (remoteHelper) {
    createLineReader(child.stdout, (line) => relayRemoteLine('stdout', line));
    createLineReader(child.stderr, (line) => relayRemoteLine('stderr', line));
  }
  child.stdio[3].setEncoding('utf8');
  child.stdio[3].on('data', (chunk) => { result += chunk; });
  child.stdio[4].end(inputPayload ? `${inputPayload}\n` : '');
  if (stopRequested) await stopManagedProcess(processRecord);
  const exit = await processRecord.exitPromise;
  await Promise.allSettled(relayWrites);
  throwIfStopping();
  if (exit.code !== 0) {
    if (remoteHelper) {
      throw new Error(remoteDiagnostics.at(-1) || REMOTE_AGENT_PREPARATION_FAILED);
    }
    throw exit.error || new Error(`Bootstrap helper ${action} failed${exit.signal ? ` (${exit.signal})` : ''}`);
  }
  try {
    return JSON.parse(result.trim() || '{}');
  } catch {
    if (remoteHelper) {
      throw new Error(remoteDiagnostics.at(-1) || REMOTE_AGENT_PREPARATION_FAILED);
    }
    throw new Error(`Bootstrap helper ${action} returned invalid result`);
  }
}

function npmExecArgs(packageSpec, executable, args) {
  return [
    'exec', '--yes', '--registry', NPM_REGISTRY, '--cache', NPM_CACHE_DIR,
    '--package', packageSpec, '--', executable, ...args,
  ];
}

async function runNpmExecCapture(packageSpec, executable, args, options = {}) {
  throwIfStopping();
  const child = spawn(NPM_BIN, npmExecArgs(packageSpec, executable, args), {
    env: options.env || process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const processRecord = trackTransientProcess(child, executable, process.platform !== 'win32');
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
  if (stopRequested) await stopManagedProcess(processRecord);
  const exit = await processRecord.exitPromise;
  throwIfStopping();
  if (options.logFile) {
    await appendPrivate(options.logFile, safeCapturedLog(stdout, stderr, options));
  }
  if (exit.code !== 0) {
    const detail = safeOperationalOutput(
      stderr.trim() || stdout.trim() || exit.error?.message || `exit ${exit.code}`,
      options,
    );
    throw new Error(`${executable} failed: ${detail.split('\n').slice(-8).join('\n')}`);
  }
  return { stdout, stderr };
}

const packageExecutableLauncher = createPackageExecutableLauncher({
  materialize: async (packageSpec, executable, options = {}) => {
    const result = await runNpmExecCapture(
      packageSpec,
      process.execPath,
      npmExecutableResolverArgs(executable),
      options,
    );
    return parseResolvedPackageExecutable(result.stdout, executable);
  },
});

async function runCapture(packageSpec, executable, args, options = {}) {
  throwIfStopping();
  const preparedExecutable = await packageExecutableLauncher.resolve(
    packageSpec,
    executable,
    options,
  );
  throwIfStopping();
  const child = packageExecutableLauncher.launchPrepared({
    preparedExecutable,
    args,
    spawnOptions: {
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  });
  const processRecord = trackTransientProcess(child, executable, process.platform !== 'win32');
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
  if (stopRequested) await stopManagedProcess(processRecord);
  const exit = await processRecord.exitPromise;
  throwIfStopping();
  if (options.logFile) {
    await appendPrivate(options.logFile, safeCapturedLog(stdout, stderr, options));
  }
  if (exit.code !== 0) {
    const detail = safeOperationalOutput(
      stderr.trim() || stdout.trim() || exit.error?.message || `exit ${exit.code}`,
      options,
    );
    throw new Error(`${executable} failed: ${detail.split('\n').slice(-8).join('\n')}`);
  }
  return { stdout, stderr };
}

function trackTransientProcess(child, label, processGroup) {
  const record = {
    label,
    child,
    exited: false,
    exit: undefined,
    expectedStop: false,
    processGroup,
  };
  let spawnError;
  record.exitPromise = new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => {
      record.exited = true;
      record.exit = { code: code ?? 1, signal, ...(spawnError ? { error: spawnError } : {}) };
      transientProcesses.delete(record);
      resolve(record.exit);
    });
  });
  transientProcesses.add(record);
  return record;
}

function parseJsonDocument(value, label) {
  const text = String(value || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        // Continue looking for a JSON line.
      }
    }
  }
  throw new Error(`${label} did not return valid JSON`);
}

function createLineReader(stream, onLine) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => {
    if (pending) onLine(pending);
  });
}

async function startManagedProcess({
  label,
  packageSpec,
  executable,
  args,
  env,
  logFile,
  preparedExecutable,
  executionLocation = 'local',
  eventPathRoot,
  agentExecutionLocations = [],
  allowedAppIds = [],
}) {
  await ensurePrivateDir(path.dirname(logFile));
  throwIfStopping();
  await fsp.writeFile(logFile, '', { mode: 0o600, flag: 'a' });
  throwIfStopping();
  const executableDescriptor = preparedExecutable || await packageExecutableLauncher.resolve(
    packageSpec,
    executable,
    {
      env: env || process.env,
      executionLocation,
      eventPathRoot,
      ...(executionLocation === 'remote' ? { logFile } : {}),
    },
  );
  throwIfStopping();
  const child = packageExecutableLauncher.launchPrepared({
    preparedExecutable: executableDescriptor,
    args,
    spawnOptions: {
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  });
  const processStartedAt = Date.now();
  const logWriter = createSerializedLineWriter((content) => appendPrivate(logFile, content));
  const record = {
    label,
    child,
    logFile,
    events: [],
    emitter: new EventEmitter(),
    exited: false,
    exit: undefined,
    expectedStop: false,
    processGroup: process.platform !== 'win32',
    outputTail: [],
    eventPathHandles: executionLocation === 'remote' && eventPathRoot ? new Map() : undefined,
    logWriter,
    logWriteError: undefined,
  };
  managedProcesses.add(record);
  const outputOptions = {
    executionLocation,
    eventPathRoot,
    eventPathHandles: record.eventPathHandles,
    agentExecutionLocations: trustedAgentExecutionLocations(agentExecutionLocations),
    allowedAppIds,
  };
  void logWriter.write(`${safeOperationalLine(JSON.stringify({
    timestamp: nowIso(),
    type: 'bridge.process',
    status: 'started',
    label,
    executable,
    package: packageSpec,
    pid: child.pid || null,
    node: process.version,
  }), outputOptions)}\n`).catch((error) => {
    record.logWriteError ??= error;
  });
  const handleLine = (streamName, line) => {
    const safeLine = safeOperationalLine(line, outputOptions);
    record.outputTail.push(`[${streamName}] ${safeLine}`);
    if (record.outputTail.length > 30) record.outputTail.shift();
    record.emitter.emit('output', safeLine);
    if (streamName === 'stdout' && safeLine.trim()) {
      try {
        const rawEvent = JSON.parse(String(line).trim());
        const event = executionLocation === 'remote'
          ? (projectTrustedLocalAgentEvent(rawEvent, outputOptions)
            || projectRemoteOperationalEvent(rawEvent, outputOptions))
          : JSON.parse(safeLine.trim());
        if (event && typeof event.type === 'string') {
          record.events.push(event);
          record.emitter.emit('event', event);
        }
      } catch {
        // Feishu task mode can mix human-readable lines with JSON events.
      }
    }
    void logWriter.write(`${safeLine}\n`).catch((error) => {
      record.logWriteError ??= error;
    });
  };
  createLineReader(child.stdout, (line) => { handleLine('stdout', line); });
  createLineReader(child.stderr, (line) => { handleLine('stderr', line); });
  record.exitPromise = new Promise((resolve) => {
    let settled = false;
    const finish = async (exit) => {
      if (settled) return;
      settled = true;
      await logWriter.write(`${safeOperationalLine(JSON.stringify({
        timestamp: nowIso(),
        type: 'bridge.process',
        status: 'exited',
        label,
        executable,
        package: packageSpec,
        pid: child.pid || null,
        durationMs: Date.now() - processStartedAt,
        code: exit.code,
        signal: exit.signal || null,
        expectedStop: record.expectedStop,
        ...(exit.error ? { error: describeNetworkError(exit.error) } : {}),
      }), outputOptions)}\n`).catch((error) => {
        record.logWriteError ??= error;
      });
      await logWriter.flush().catch((error) => {
        record.logWriteError ??= error;
      });
      record.eventPathHandles?.clear();
      record.exited = true;
      record.exit = {
        ...exit,
        ...(record.logWriteError ? { logError: record.logWriteError } : {}),
      };
      record.emitter.emit('exit', record.exit);
      resolve(record.exit);
    };
    child.once('error', (error) => { void finish({ code: 1, error }); });
    child.once('close', (code, signal) => { void finish({ code: code ?? 1, signal }); });
  });
  if (stopRequested) {
    await stopManagedProcess(record);
    throwIfStopping();
  }
  return record;
}

function signalProcess(record, signal) {
  if (!record || record.exited || !record.child.pid) return;
  try {
    if (process.platform !== 'win32' && record.processGroup) process.kill(-record.child.pid, signal);
    else record.child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function stopManagedProcess(record) {
  if (!record || record.exited) return;
  record.expectedStop = true;
  signalProcess(record, 'SIGTERM');
  await Promise.race([record.exitPromise, delay(5_000)]);
  if (!record.exited) {
    signalProcess(record, 'SIGKILL');
    await Promise.race([record.exitPromise, delay(2_000)]);
  }
}

async function waitForEvent(record, predicate, timeoutMs = READY_TIMEOUT_MS) {
  const authenticationError = bridgeAuthenticationRetryError(record.outputTail);
  if (authenticationError) throw authenticationError;
  const existing = record.events.find(predicate);
  if (existing) return existing;
  if (record.exited) {
    const tail = record.outputTail.slice(-10).join('\n');
    throw new Error(`${record.label} exited before ready (${record.exit?.signal || record.exit?.code})${tail ? `:\n${tail}` : ''}\n日志：${record.logFile}`);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      const tail = record.outputTail.slice(-10).join('\n');
      reject(new Error(`${record.label} readiness timed out${tail ? `:\n${tail}` : ''}\n日志：${record.logFile}`));
    }, timeoutMs);
    const onEvent = (event) => {
      if (!predicate(event)) return;
      cleanup();
      resolve(event);
    };
    const onExit = (exit) => {
      cleanup();
      const tail = record.outputTail.slice(-10).join('\n');
      reject(new Error(`${record.label} exited before ready (${exit.signal || exit.code})${tail ? `:\n${tail}` : ''}\n日志：${record.logFile}`));
    };
    const onOutput = () => {
      const error = bridgeAuthenticationRetryError(record.outputTail);
      if (!error) return;
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      record.emitter.off('event', onEvent);
      record.emitter.off('exit', onExit);
      record.emitter.off('output', onOutput);
    };
    record.emitter.on('event', onEvent);
    record.emitter.on('exit', onExit);
    record.emitter.on('output', onOutput);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfStopping() {
  if (stopRequested) throw new Error(`已收到 ${stopSignal || '停止信号'}，不再启动新的 Bridge`);
}

function assertOnlineBinding(binding) {
  if (binding?.environment?.name === 'online') return;
  const environment = binding?.environment?.name || 'unknown';
  throw new Error(`配置环境 ${environment} 不受支持；Task Agent 仅支持 Online，请使用 remove 删除后重新绑定`);
}

function onlineEnvironment(binding) {
  if (binding) assertOnlineBinding(binding);
  const env = { ...process.env };
  const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  proxyKeys.forEach((key) => delete env[key]);
  env.LARKSUITE_CLI_CONFIG_DIR = process.env.AAMP_LARK_CLI_CONFIG_DIR || path.join(HOME, '.lark-cli-aamp-one-click-v1');
  return env;
}

function groupIdForHost(host) {
  return shortHash(host);
}

function groupHomeForHost(host) {
  return path.join(RUNTIME_HOME, 'agent-bridges', groupIdForHost(host));
}

async function acquireAgentLease(host, agentType) {
  throwIfStopping();
  const name = `agent-${shortHash(`${host}\u0000${agentType}`)}.lock`;
  const lockDir = path.join(LEASES_HOME, name);
  const release = await acquireDirectoryLock(lockDir, `${agentType} (${host})`, 1_500);
  const lease = { lockDir, release };
  heldLeases.add(lease);
  if (stopRequested) {
    await releaseLease(lease);
    throwIfStopping();
  }
  return lease;
}

async function releaseLease(lease) {
  if (!lease || !heldLeases.has(lease)) return;
  heldLeases.delete(lease);
  await lease.release();
}

function acpBridgeAgentPolicy(stableAgentType) {
  const metadata = resolveTaskAgentMetadata(stableAgentType);
  return {
    executionLocation: metadata.executionLocation,
    ...(metadata.attachmentPolicy ? { attachmentPolicy: metadata.attachmentPolicy } : {}),
    ...(metadata.taskDispatchConcurrency
      ? { taskDispatchConcurrency: metadata.taskDispatchConcurrency }
      : {}),
  };
}

function agentExecutionLocations(agents) {
  return new Set((agents || []).map((agent) => (
    resolveTaskAgentMetadata(agent.name).executionLocation
  )));
}

function groupProcessExecutionLocation(agents) {
  return agentExecutionLocations(agents).has('remote') ? 'remote' : 'local';
}

async function initializeAgentGroups(bindings, operations = {}) {
  const prepareAgent = operations.runBootstrapHelper || runBootstrapHelper;
  const prepareAgentEnv = operations.nonInteractive
    ? { AAMP_TASK_NON_INTERACTIVE: 'true' }
    : {};
  const byHost = new Map();
  for (const binding of bindings) {
    if (!byHost.has(binding.aamp_host)) byHost.set(binding.aamp_host, new Map());
    if (!byHost.get(binding.aamp_host).has(binding.agent_type)) byHost.get(binding.aamp_host).set(binding.agent_type, binding);
  }
  const groups = new Map();
  for (const [host, agentBindings] of byHost) {
    throwIfStopping();
    const hostBinding = agentBindings.values().next().value;
    const bridgeEnv = onlineEnvironment(hostBinding);
    const home = groupHomeForHost(host);
    await assertNoSymlinkPath(RUNTIME_HOME, home);
    throwIfStopping();
    await ensurePrivateDir(home);
    throwIfStopping();
    const logFile = path.join(RUN_LOG_DIR, `acp-bridge-${groupIdForHost(host)}.jsonl`);
    const configFile = path.join(home, 'runs', safeId(RUN_ID), `${randomId()}.json`);
    await assertNoSymlinkPath(RUNTIME_HOME, configFile);
    const group = {
      host,
      home,
      configFile,
      logFile,
      identities: new Map(),
      availableAgents: new Set(),
      failures: new Map(),
      cancellations: new Map(),
      runtimeAgentTypes: new Map(),
      leases: new Map(),
      agents: [],
      bridgeEnv,
      process: undefined,
    };
    groups.set(host, group);
    const agents = [];
    for (const [agentType, sampleBinding] of agentBindings) {
      throwIfStopping();
      let runtimeAgentType;
      let stableAgentTypes = [agentType];
      try {
        const lease = await acquireAgentLease(host, agentType);
        throwIfStopping();
        group.leases.set(agentType, lease);
        const metadata = resolveTaskAgentMetadata(agentType);
        console.log(`[aamp-one-click] 正在检查 ${agentSelectionDisplayName(agentType)} ${metadata.executionLocation === 'remote' ? '远程智能体' : '本地智能体'}...`);
        const prepared = await prepareAgent('__prepare-agent', sampleBinding, prepareAgentEnv);
        throwIfStopping();
        runtimeAgentType = prepared.agent_type || agentType;
        if (prepared.cancelled === true) {
          const reason = redact(prepared.reason || '用户取消了 Agent 准备流程');
          group.cancellations.set(agentType, reason);
          await releaseLease(group.leases.get(agentType));
          group.leases.delete(agentType);
          continue;
        }
        if (prepared.agent_type && prepared.agent_type !== agentType && agentBindings.has(prepared.agent_type)) {
          throw new Error(`Agent 类型归一化后发生重复：${agentType} -> ${prepared.agent_type}`);
        }
        const bindingPlan = resolvePreparedAgentBindings(
          bindings,
          host,
          agentType,
          runtimeAgentType,
        );
        stableAgentTypes = bindingPlan.stableAgentTypes;
        const preparedAgents = await prepareAndCommitAgentBindings(bindingPlan, async (stableAgentType) => {
          if (!group.leases.has(stableAgentType)) {
            group.leases.set(stableAgentType, await acquireAgentLease(host, stableAgentType));
          }
          const stableMetadata = resolveTaskAgentMetadata(stableAgentType);
          if (stableMetadata.executionLocation === 'local'
            && path.resolve(prepared.lark_cli_config_dir || '') !== path.resolve(bridgeEnv.LARKSUITE_CLI_CONFIG_DIR)) {
            throw new Error(`Agent 使用的 lark-cli 配置目录与 Online 配置不一致：${prepared.lark_cli_config_dir || 'unknown'}`);
          }
          const agentHome = path.join(home, 'agents', stableAgentType);
          await assertNoSymlinkPath(RUNTIME_HOME, agentHome);
          throwIfStopping();
          await ensurePrivateDir(agentHome);
          throwIfStopping();
          return {
            name: stableAgentType,
            acpCommand: prepared.acp_command,
            credentialsFile: path.join(agentHome, 'credentials.json'),
            pairingFile: path.join(agentHome, 'pairing.json'),
            senderPoliciesFile: path.join(agentHome, 'sender-policies.json'),
            createPairing: false,
            ...acpBridgeAgentPolicy(stableAgentType),
          };
        });
        if (!stableAgentTypes.includes(agentType)) {
          await releaseLease(group.leases.get(agentType));
          group.leases.delete(agentType);
        }
        agents.push(...preparedAgents);
        for (const stableAgentType of stableAgentTypes) {
          group.runtimeAgentTypes.set(stableAgentType, runtimeAgentType);
        }
      } catch (error) {
        recordPreparationFailure(group, agentType, runtimeAgentType, redact(error.message || error));
        for (const stableAgentType of new Set([...stableAgentTypes, agentType])) {
          await releaseLease(group.leases.get(stableAgentType));
          group.leases.delete(stableAgentType);
        }
        if (stopRequested) throw error;
      }
    }
    if (!agents.length) continue;
    group.executionLocation = groupProcessExecutionLocation(agents);
    try {
      throwIfStopping();
      const initResult = await runNetworkStage(async () => {
        return runCapture(
          ACP_PACKAGE,
          'aamp-acp-bridge',
          ['init', '--json', '--config', group.configFile, '--input', '-'],
          { input: JSON.stringify({ aampHost: host, agents }),
            env: bridgeEnv,
            logFile,
            executionLocation: group.executionLocation,
            eventPathRoot: group.home,
            agentExecutionLocations: trustedAgentExecutionLocations(agents.map((agent) => [
              agent.name,
              resolveTaskAgentMetadata(agent.name).executionLocation,
            ])),
          },
        );
      }, {
        stage: 'acp-init',
        label: 'Agent Bridge 初始化',
        host,
        logFile,
        environment: bridgeEnv,
      });
      throwIfStopping();
      const initialized = parseJsonDocument(initResult.stdout, 'ACP init');
      for (const agent of initialized.agents || []) group.identities.set(agent.name, agent.email);
      group.agents = agents;
    } catch (error) {
      for (const agent of agents) {
        const message = agentStartFailureMessage(
          error?.agentStartEvents || group.process?.events,
          agent.name,
          redact(error.message || error),
        );
        recordStableAgentFailure(group, agent.name, message);
      }
      if (group.process) await stopManagedProcess(group.process);
      for (const lease of group.leases.values()) await releaseLease(lease);
      group.leases.clear();
      if (stopRequested) throw error;
    }
  }
  return groups;
}

async function startAgentGroups(groups) {
  for (const group of groups.values()) {
    const agents = group.agents || [];
    if (!agents.length) continue;
    const bridgeEnv = group.bridgeEnv;
    try {
      throwIfStopping();
      const runtimeAgentNames = agents
        .map((agent) => group.runtimeAgentTypes.get(agent.name) || agent.name)
        .map(agentSelectionDisplayName);
      const executionLocations = agentExecutionLocations(agents);
      if (executionLocations.size === 1 && executionLocations.has('remote')) {
        console.log(`[aamp-one-click] 正在启动远程 Agent Bridge (${runtimeAgentNames.join(', ')})...`);
      } else if (executionLocations.size === 1 && executionLocations.has('local')) {
        console.log(`[aamp-one-click] 正在启动本地 Agent Bridge (${runtimeAgentNames.join(', ')})...`);
      } else {
        console.log(`[aamp-one-click] 正在启动 Agent Bridge (${runtimeAgentNames.join(', ')})...`);
      }
      const executionLocation = executionLocations.has('remote') ? 'remote' : 'local';
      const started = await runNetworkStage(async ({ attempt, maxAttempts }) => {
        const process = await startManagedProcess({
          label: `ACP Bridge ${group.host}`,
          packageSpec: ACP_PACKAGE,
          executable: 'aamp-acp-bridge',
          args: ['start', '--config', group.configFile, '--json', ...(DEBUG_MODE ? ['--debug'] : [])],
          env: bridgeEnv,
          logFile: group.logFile,
          executionLocation,
          eventPathRoot: group.home,
          agentExecutionLocations: agents.map((agent) => [
            agent.name,
            resolveTaskAgentMetadata(agent.name).executionLocation,
          ]),
        });
        group.process = process;
        try {
          const running = await waitForEvent(process, (event) => event.type === 'bridge.running');
          const retryError = agentStartRetryError(
            process.events,
            agents.map((agent) => agent.name),
            attempt,
            maxAttempts,
          );
          if (retryError) throw retryError;
          return { process, running };
        } catch (error) {
          const failure = preserveAgentStartFailure(error, process.events);
          await stopManagedProcess(process);
          managedProcesses.delete(process);
          if (group.process === process) group.process = undefined;
          throw failure;
        }
      }, {
        stage: 'acp-start',
        label: 'Agent Bridge 启动',
        host: group.host,
        logFile: group.logFile,
        environment: bridgeEnv,
      });
      group.process = started.process;
      throwIfStopping();
      const running = started.running;
      throwIfStopping();
      for (const agent of running.agents || []) group.availableAgents.add(agent.name);
      for (const agent of agents) {
        if (!group.availableAgents.has(agent.name)) {
          const failed = group.process.events.find((event) => event.type === 'agent.failed' && event.agent === agent.name);
          recordStableAgentFailure(
            group,
            agent.name,
            failed?.message || `${agent.name} Agent Bridge 启动失败`,
          );
          await releaseLease(group.leases.get(agent.name));
          group.leases.delete(agent.name);
        }
      }
    } catch (error) {
      for (const agent of agents) {
        const message = agentStartFailureMessage(
          error?.agentStartEvents || group.process?.events,
          agent.name,
          redact(error.message || error),
        );
        recordStableAgentFailure(group, agent.name, message);
      }
      if (group.process) await stopManagedProcess(group.process);
      for (const lease of group.leases.values()) await releaseLease(lease);
      group.leases.clear();
      if (stopRequested) throw error;
    }
  }
  return groups;
}

async function setupAgentGroups(bindings) {
  const groups = await initializeAgentGroups(bindings);
  await startAgentGroups(groups);
  return groups;
}

function resolveInitializedGroup(groups, binding) {
  const group = groups.get(binding.aamp_host);
  if (!group) throw new Error(`Agent Bridge group is unavailable for ${binding.aamp_host}`);
  const agentCancellation = group.cancellations.get(binding.agent_type);
  if (agentCancellation) throw new Error(agentCancellation);
  const agentFailure = group.failures.get(binding.agent_type);
  if (agentFailure) throw new Error(agentFailure);
  const email = group.identities.get(binding.agent_type);
  if (!email) throw new Error(`${binding.agent_type} Agent mailbox is unavailable`);
  if (binding.agent_target_email && binding.agent_target_email !== email) {
    throw new Error(`Agent mailbox 已变化（配置=${binding.agent_target_email}，当前=${email}），请使用 add 或 install 重新绑定`);
  }
  const runtimeAgentType = group.runtimeAgentTypes.get(binding.agent_type) || binding.agent_type;
  return { group, email, runtimeAgentType };
}

function resolveGroup(groups, binding) {
  const resolved = resolveInitializedGroup(groups, binding);
  const { group } = resolved;
  if (!group.process || group.process.exited) {
    const tail = group.process?.outputTail?.slice(-10).join('\n');
    throw new Error(`Agent Bridge 已退出${tail ? `：\n${tail}` : ''}`);
  }
  if (!group.availableAgents.has(binding.agent_type)) {
    throw new Error(group.failures.get(binding.agent_type) || `${binding.agent_type} Agent Bridge 未启动`);
  }
  return resolved;
}

async function writeFeishuRuntimeProfile(binding) {
  const profileFile = path.join(binding.feishu_config_dir, 'task-runtime', 'task-profiles-v2.json');
  const instancesDir = path.join(binding.feishu_config_dir, 'task-runtime', 'instances');
  await assertNoSymlinkPath(RUNTIME_HOME, profileFile);
  await assertNoSymlinkPath(RUNTIME_HOME, instancesDir);
  const metadata = resolveTaskAgentMetadata(binding.agent_type);
  await writeJsonAtomic(profileFile, {
    version: 1,
    profiles: [{
      app_id: binding.bot.app_id,
      app_secret: binding.bot.app_secret,
      display_name: binding.bot.display_name,
      auth_mode: metadata.executionLocation === 'remote' ? 'app-secret' : 'lark-cli',
      ...(metadata.executionLocation === 'local' ? { profile: binding.bot.lark_cli_profile } : {}),
      capabilities: ['im', 'task'],
      domains: PROFILE_DOMAINS,
      updated_at: nowIso(),
    }],
  });
}

async function ensureBindingProfile(binding) {
  return runBootstrapHelper('__ensure-profile', binding, {
    AAMP_TASK_INTERNAL_BINDING_JSON: JSON.stringify(binding),
  });
}

async function probeBindingProfile(binding) {
  return runBootstrapHelper('__probe-profile', binding, {
    AAMP_TASK_INTERNAL_BINDING_JSON: JSON.stringify({
      agent_type: binding.agent_type,
      aamp_host: binding.aamp_host,
      bot: {
        app_id: binding.bot.app_id,
        lark_cli_profile: binding.bot.lark_cli_profile,
      },
    }),
  });
}

const readyProfileProbeOperations = Object.freeze({
  probeBindingProfile,
  throwIfStopping,
});

async function probeReadyBindingProfiles(
  bindings,
  operations = readyProfileProbeOperations,
) {
  const probes = new Map();
  for (const binding of bindings) {
    if (bindingNeedsInitialStart(binding)
      || resolveTaskAgentMetadata(binding.agent_type).executionLocation === 'remote') continue;
    operations.throwIfStopping();
    try {
      const profile = await operations.probeBindingProfile(binding);
      operations.throwIfStopping();
      if (profile?.ready === true && profile.lark_cli_bin) probes.set(binding, profile);
    } catch {
      operations.throwIfStopping();
      // The normal binding preparation remains authoritative for misses and failures.
    }
  }
  return probes;
}

function prewarmFeishuExecutable(binding) {
  return packageExecutableLauncher.resolve(
    FEISHU_PACKAGE,
    'aamp-feishu-bridge',
    { env: onlineEnvironment(binding) },
  );
}

function feishuArgs(binding, larkCliBin, target) {
  const metadata = resolveTaskAgentMetadata(binding.agent_type);
  const targetArgs = target.pairingUrl
    ? ['--pairing-url', target.pairingUrl]
    : ['--target-agent', target.agentTargetEmail];
  return [
    'start', '--enable-task',
    '--config-dir', binding.feishu_config_dir,
    '--aamp-host', binding.aamp_host,
    '--agent', binding.agent_type,
    '--agent-execution-location', metadata.executionLocation,
    ...targetArgs,
    '--app-id', binding.bot.app_id,
    '--bot-name', binding.bot.display_name || binding.bot.app_id,
    '--domain', openApiDomainForTenantBrand(binding.bot.tenant_brand),
    ...(metadata.executionLocation === 'local' ? [
      '--use-feishu-cli',
      '--feishu-cli-profile', binding.bot.lark_cli_profile,
      '--feishu-cli-bin', larkCliBin,
    ] : []),
    '--json',
    ...(DEBUG_MODE ? ['--debug'] : []),
  ];
}

const feishuPreparationOperations = Object.freeze({
  ensureBindingProfile,
  onlineEnvironment,
  throwIfStopping,
  writeFeishuRuntimeProfile,
});

async function prepareFeishuProcess(
  binding,
  phase,
  runtimeAgentType = binding.agent_type,
  profileProbes,
  operations = feishuPreparationOperations,
) {
  operations.throwIfStopping();
  await operations.writeFeishuRuntimeProfile(binding);
  operations.throwIfStopping();
  const environment = operations.onlineEnvironment(binding);
  const metadata = resolveTaskAgentMetadata(binding.agent_type);
  const probedProfile = profileProbes?.get(binding);
  const profile = metadata.executionLocation === 'remote'
    ? {}
    : (probedProfile?.ready === true
      && probedProfile.lark_cli_bin
      && path.resolve(probedProfile.lark_cli_config_dir || '')
        === path.resolve(environment.LARKSUITE_CLI_CONFIG_DIR || '')
      ? probedProfile
      : await operations.ensureBindingProfile(binding));
  operations.throwIfStopping();
  if (metadata.executionLocation === 'local' && !profile.lark_cli_bin) throw new Error(`lark-cli profile ${binding.bot.lark_cli_profile} is unavailable`);
  const logFile = path.join(RUN_LOG_DIR, `feishu-bridge-${safeId(binding.binding_id)}-${phase}.jsonl`);
  const preparedExecutable = operations.resolveFeishuExecutable
    ? await operations.resolveFeishuExecutable(environment)
    : await packageExecutableLauncher.resolve(
        FEISHU_PACKAGE,
        'aamp-feishu-bridge',
        {
          env: environment,
          executionLocation: metadata.executionLocation,
          ...(metadata.executionLocation === 'remote' ? { logFile } : {}),
        },
      );
  operations.throwIfStopping();
  return {
    binding,
    phase,
    runtimeAgentType,
    larkCliBin: profile.lark_cli_bin,
    logFile,
    preparedExecutable,
  };
}

async function startPreparedFeishuProcess(prepared, target, environment = onlineEnvironment(prepared.binding)) {
  throwIfStopping();
  const {
    binding,
    phase,
    runtimeAgentType,
    larkCliBin,
    logFile,
    preparedExecutable,
  } = prepared;
  const phaseMessage = phase === 'install'
    ? '正在建立绑定并启动飞书任务 Bridge'
    : phase === 'add'
      ? '正在验证飞书任务绑定'
      : '正在启动飞书任务 Bridge';
  console.log(`[aamp-one-click] ${phaseMessage}：${bindingLabel(binding, runtimeAgentType)}...`);
  return startManagedProcess({
    label: `Feishu Bridge ${bindingLabel(binding, runtimeAgentType)}`,
    packageSpec: FEISHU_PACKAGE,
    executable: 'aamp-feishu-bridge',
    args: feishuArgs(binding, larkCliBin, target),
    env: environment,
    logFile,
    preparedExecutable,
    executionLocation: resolveTaskAgentMetadata(binding.agent_type).executionLocation,
    eventPathRoot: binding.feishu_config_dir,
    agentExecutionLocations: [[
      binding.agent_type,
      resolveTaskAgentMetadata(binding.agent_type).executionLocation,
    ]],
    allowedAppIds: [binding.bot.app_id],
  });
}

async function startFeishuProcess(binding, phase, target) {
  const prepared = await prepareFeishuProcess(binding, phase);
  throwIfStopping();
  return startPreparedFeishuProcess(prepared, target);
}

async function startPreparedFeishuUntilReady(prepared, target, { stage, pairingFile } = {}) {
  const { binding, logFile } = prepared;
  const environment = onlineEnvironment(binding);
  return runNetworkStage(async () => {
    const processRecord = await startPreparedFeishuProcess(prepared, target, environment);
    try {
      throwIfStopping();
      if (pairingFile) await waitForInitialBinding(processRecord, pairingFile);
      else await waitForEvent(processRecord, (event) => event.type === 'bridge.task_runtime.running');
      throwIfStopping();
      return processRecord;
    } catch (error) {
      await stopManagedProcess(processRecord);
      managedProcesses.delete(processRecord);
      const consumed = pairingFile
        && isRetryableNetworkError(error)
        && await pairingConsumed(pairingFile);
      await appendDiagnostic(logFile, {
        type: 'bridge.readiness.failed',
        stage,
        pairingConsumed: Boolean(consumed),
        category: classifyNetworkError(error),
        error: describeNetworkError(error),
      });
      if (consumed) {
        const pairingError = new Error('Feishu Bridge 启动失败且本次配对码已被消费，请重新执行绑定');
        pairingError.retryable = false;
        throw pairingError;
      }
      throw error;
    }
  }, {
    stage,
    label: 'Feishu Bridge 启动',
    host: binding.aamp_host,
    logFile,
    environment,
    shouldRetry: (error) => error?.retryable !== false && isRetryableNetworkError(error),
  });
}

async function pairingConsumed(pairingFile) {
  try {
    const state = await readJson(pairingFile);
    return typeof state.consumedAt === 'string' && Boolean(state.consumedAt);
  } catch {
    return false;
  }
}

async function waitForInitialBinding(record, pairingFile) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const authenticationError = bridgeAuthenticationRetryError(record.outputTail);
    if (authenticationError) throw authenticationError;
    if (record.exited) {
      const tail = record.outputTail.slice(-10).join('\n');
      throw new Error(`${record.label} exited before binding completed${tail ? `:\n${tail}` : ''}\n日志：${record.logFile}`);
    }
    const running = record.events.some((event) => event.type === 'bridge.task_runtime.running');
    if (running && await pairingConsumed(pairingFile)) return;
    await delay(250);
  }
  const tail = record.outputTail.slice(-10).join('\n');
  throw new Error(`${record.label} binding timed out${tail ? `:\n${tail}` : ''}\n日志：${record.logFile}`);
}

async function readInitialRuntimeMetadata(binding, record, expectedAgentEmail) {
  const starting = record.events.find((event) => event.type === 'bridge.task_runtime.starting' && event.appId === binding.bot.app_id);
  if (!starting?.imConfigDir || !starting?.taskConfigDir) throw new Error('Feishu Bridge 未返回实例配置目录');
  const imConfigDir = resolveRemoteEventPath(starting.imConfigDir, record, binding.feishu_config_dir);
  const taskConfigDir = resolveRemoteEventPath(starting.taskConfigDir, record, binding.feishu_config_dir);
  const imFile = path.join(imConfigDir, 'config.json');
  const taskFile = path.join(taskConfigDir, 'config.json');
  if (!isPathInside(binding.feishu_config_dir, imConfigDir) || !isPathInside(binding.feishu_config_dir, taskConfigDir)) {
    throw new Error('Feishu Bridge 返回了新流程 runtime-v1 之外的配置目录');
  }
  await assertNoSymlinkPath(RUNTIME_HOME, imFile);
  await assertNoSymlinkPath(RUNTIME_HOME, taskFile);
  const [imConfig, taskConfig] = await Promise.all([readJson(imFile), readJson(taskFile)]);
  if (imConfig.targetAgentEmail !== expectedAgentEmail || taskConfig.targetAgentEmail !== expectedAgentEmail) {
    throw new Error('Feishu Bridge 实例的 Agent mailbox 与本次配对不一致');
  }
  if (imConfig.feishu?.appId !== binding.bot.app_id || taskConfig.feishu?.appId !== binding.bot.app_id) {
    throw new Error('Feishu Bridge 实例的 Bot App ID 与本次配对不一致');
  }
  return {
    im_config_dir: imConfigDir,
    task_config_dir: taskConfigDir,
    feishu_bridge_email: imConfig.mailbox?.email || '',
  };
}

async function validateSavedRuntime(binding) {
  if (!isPathInside(binding.feishu_config_dir, binding.runtime.im_config_dir)
    || !isPathInside(binding.feishu_config_dir, binding.runtime.task_config_dir)) {
    throw new Error('绑定运行配置不属于新流程 runtime-v1，请重新绑定');
  }
  const imFile = path.join(binding.runtime.im_config_dir, 'config.json');
  const taskFile = path.join(binding.runtime.task_config_dir, 'config.json');
  await assertNoSymlinkPath(RUNTIME_HOME, imFile);
  await assertNoSymlinkPath(RUNTIME_HOME, taskFile);
  let imConfig;
  let taskConfig;
  try {
    [imConfig, taskConfig] = await Promise.all([readJson(imFile), readJson(taskFile)]);
  } catch (error) {
    throw new Error(`绑定运行配置缺失，请使用 add 或 install 重新绑定：${redact(error.message || error)}`);
  }
  if (imConfig.targetAgentEmail !== binding.agent_target_email || taskConfig.targetAgentEmail !== binding.agent_target_email) {
    throw new Error('绑定运行配置与 Agent mailbox 不一致，请使用 add 或 install 重新绑定');
  }
  if (imConfig.feishu?.appId !== binding.bot.app_id || taskConfig.feishu?.appId !== binding.bot.app_id) {
    throw new Error('绑定运行配置与 Bot App ID 不一致，请重新绑定');
  }
  if (!imConfig.mailbox?.email || !taskConfig.mailbox?.email || imConfig.mailbox.email !== taskConfig.mailbox.email) {
    throw new Error('绑定运行配置中的 Feishu Bridge mailbox 无效，请重新绑定');
  }
  if (binding.runtime.feishu_bridge_email && binding.runtime.feishu_bridge_email !== imConfig.mailbox.email) {
    throw new Error('Feishu Bridge mailbox 已变化，请重新绑定');
  }
}

const bindingStartOperations = Object.freeze({
  // User-visible success output is deferred until layered results are back in selection order.
  printBindingStarted: () => {},
  readInitialRuntimeMetadata,
  runCapture,
  parseJsonDocument,
  resolveConfiguredPendingPairingFile,
  resolvePendingPairingFile,
  setBindingStatus,
  startPreparedFeishuUntilReady,
  stopManagedProcess,
  throwIfStopping,
  updateBinding,
  validateSavedRuntime,
});

const bindingPreparationOperations = Object.freeze({
  nowIso,
  prepareFeishuProcess,
  resolveGroup,
  resolveInitializedGroup,
  setBindingStatus,
  throwIfStopping,
  validateSavedRuntime,
});

async function prepareBindingStart(
  binding,
  groups,
  mode,
  operations = bindingPreparationOperations,
  options = {},
) {
  operations.throwIfStopping();
  const pending = bindingNeedsInitialStart(binding);
  await operations.setBindingStatus(binding, pending ? 'bind' : 'start', 'starting');
  operations.throwIfStopping();
  const resolve = options.allowAgentStarting && !pending
    ? operations.resolveInitializedGroup
    : operations.resolveGroup;
  const { group, email, runtimeAgentType } = resolve(groups, binding);
  const activeBinding = pending
    ? { ...binding, state: 'ready', agent_target_email: email, updated_at: operations.nowIso() }
    : binding;
  if (!pending) {
    if (email !== binding.agent_target_email) {
      throw new Error('当前 Agent mailbox 与绑定记录不一致，请重新绑定');
    }
    await operations.validateSavedRuntime(binding);
  }
  operations.throwIfStopping();
  const preparedFeishu = await operations.prepareFeishuProcess(
    activeBinding,
    mode,
    runtimeAgentType,
    options.profileProbes,
  );
  return {
    originalBinding: binding,
    binding: activeBinding,
    group,
    mode,
    pending,
    email,
    runtimeAgentType,
    preparedFeishu,
    deferReadyCommit: Boolean(options.deferReadyCommit && !pending),
  };
}

async function executePreparedReadyBindingStart(prepared, operations = bindingStartOperations) {
  const { binding, group, runtimeAgentType, preparedFeishu } = prepared;
  let feishu;
  try {
    feishu = await operations.startPreparedFeishuUntilReady(
      preparedFeishu,
      { agentTargetEmail: binding.agent_target_email },
      { stage: 'feishu-start' },
    );
    operations.throwIfStopping();
    if (!prepared.deferReadyCommit) {
      await operations.setBindingStatus(binding, 'start', 'running');
      operations.throwIfStopping();
      operations.printBindingStarted(binding, runtimeAgentType);
    }
    return { binding, process: feishu, group, runtimeAgentType };
  } catch (error) {
    if (feishu) await operations.stopManagedProcess(feishu);
    throw error;
  }
}

async function executePreparedPendingBindingStart(prepared, operations = bindingStartOperations) {
  const {
    originalBinding,
    binding,
    group,
    mode,
    email,
    runtimeAgentType,
    preparedFeishu,
  } = prepared;
  let feishu;
  try {
    const configuredPairingFile = await operations.resolveConfiguredPendingPairingFile(
      group,
      originalBinding.agent_type,
    );
    operations.throwIfStopping();
    const pairResult = await operations.runCapture(
      ACP_PACKAGE,
      'aamp-acp-bridge',
      ['pair', '--agent', originalBinding.agent_type, '--config', group.configFile, '--json', '--no-start'],
      {
        logFile: group.logFile,
        executionLocation: resolveTaskAgentMetadata(originalBinding.agent_type).executionLocation,
      },
    );
    operations.throwIfStopping();
    const pairing = operations.parseJsonDocument(pairResult.stdout, 'ACP pairing');
    if (!pairing.connectUrl || pairing.mailbox !== email) {
      throw new Error('ACP Bridge 返回的配对信息不完整或 mailbox 不一致');
    }
    const pairingFile = await operations.resolvePendingPairingFile(
      group,
      originalBinding.agent_type,
      pairing,
    );
    if (pairingFile !== configuredPairingFile) {
      throw new Error('ACP Bridge 私有配对文件在配对过程中发生变化');
    }
    feishu = await operations.startPreparedFeishuUntilReady(
      preparedFeishu,
      { pairingUrl: pairing.connectUrl },
      { stage: mode === 'install' ? 'feishu-install-bind' : 'feishu-add-bind', pairingFile },
    );
    operations.throwIfStopping();
    binding.runtime = await operations.readInitialRuntimeMetadata(binding, feishu, email);
    operations.throwIfStopping();
    await operations.validateSavedRuntime(binding);
    operations.throwIfStopping();
    await operations.updateBinding(binding);
    operations.throwIfStopping();
    await operations.setBindingStatus(binding, 'start', 'running');
    operations.throwIfStopping();
    return { binding, process: feishu, group, runtimeAgentType };
  } catch (error) {
    if (feishu) await operations.stopManagedProcess(feishu);
    throw error;
  }
}

async function executePreparedBindingStart(prepared, operations = bindingStartOperations) {
  if (!prepared.pending) return executePreparedReadyBindingStart(prepared, operations);
  return runPairingSerially(pairingQueueKey(prepared), async () => {
    return executePreparedPendingBindingStart(prepared, operations);
  });
}

async function runPreparedBindingStarts(preparedItems, start = executePreparedBindingStart) {
  const lanes = [];
  const pendingLanes = new Map();
  for (const item of preparedItems) {
    if (!item.prepared.pending) {
      lanes.push([item]);
      continue;
    }
    const key = pairingQueueKey(item.prepared);
    let lane = pendingLanes.get(key);
    if (!lane) {
      lane = [];
      pendingLanes.set(key, lane);
      lanes.push(lane);
    }
    lane.push(item);
  }

  const laneOutcomes = await runLayeredStarts(lanes, {
    concurrency: FEISHU_START_CONCURRENCY,
    prepare: async (lane) => lane,
    start: async (lane) => {
      const outcomes = [];
      for (const item of lane) {
        try {
          outcomes.push({
            status: 'fulfilled',
            phase: 'start',
            value: await start(item.prepared),
            item: item.prepared.originalBinding || item.prepared.binding,
            index: item.index,
          });
        } catch (reason) {
          if (stopRequested) throw reason;
          outcomes.push({
            status: 'rejected',
            phase: 'start',
            reason,
            item: item.prepared.originalBinding || item.prepared.binding,
            index: item.index,
          });
        }
      }
      return outcomes;
    },
  });
  const rejectedLane = laneOutcomes.find((outcome) => outcome.status === 'rejected');
  if (rejectedLane && stopRequested) throw rejectedLane.reason;
  const byIndex = new Map(laneOutcomes.flatMap((outcome) => (
    outcome.status === 'fulfilled' ? outcome.value : []
  )).map((outcome) => [outcome.index, outcome]));
  return preparedItems.map(({ index }) => byIndex.get(index));
}

function reportBindingFailure(binding, runtimeAgentType, reason, mode) {
  const safeReason = safeBindingFailureReason(binding, reason);
  console.error(`🔴 启动失败：${bindingLabel(binding, runtimeAgentType)}\n   原因：${safeReason}`);
  if (mode === 'install') {
    console.error('   绑定配置已保存，可稍后运行 feishu-task-agent start 重试。');
  } else {
    console.error('   已跳过该项，继续启动下一项。');
  }
}

const bindingLauncherOperations = Object.freeze({
  bindingCancellationReason,
  executePreparedBindingStart,
  prepareBindingStart: (binding, groups, mode, options) => (
    prepareBindingStart(binding, groups, mode, bindingPreparationOperations, options)
  ),
  printBindingCancelled,
  printBindingStarted,
  recordError,
  reportBindingFailure,
  setBindingStatus,
  throwIfStopping,
});

async function finalizeDeferredLaunchResults(launched, mode, operations = bindingLauncherOperations) {
  for (const item of launched.cancelled) {
    await operations.setBindingStatus(
      item.binding,
      mode === 'install' ? 'bind' : 'start',
      'cancelled',
      item.reason,
    );
    operations.printBindingCancelled(item.binding, item.reason);
  }
  for (const item of launched.failed) {
    await operations.setBindingStatus(item.binding, 'start', 'failed', item.reason);
    await operations.recordError('startup', item.reason, item.binding);
    operations.reportBindingFailure(
      item.binding,
      item.runtimeAgentType,
      item.reason,
      mode,
    );
  }
}

async function startBindingsWithGroups(
  bindings,
  groups,
  mode,
  operations = bindingLauncherOperations,
  options = {},
) {
  const cancelled = [];
  const candidates = [];
  for (const binding of bindings) {
    operations.throwIfStopping();
    const reason = operations.bindingCancellationReason(groups, binding);
    if (reason) {
      const runtimeAgentType = groups.get(binding.aamp_host)?.runtimeAgentTypes?.get(binding.agent_type)
        || binding.agent_type;
      cancelled.push({ binding, reason, runtimeAgentType });
    } else {
      candidates.push(binding);
    }
  }

  const outcomes = new Array(candidates.length);
  const preparedItems = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const binding = candidates[index];
    try {
      preparedItems.push({
        index,
        prepared: await operations.prepareBindingStart(binding, groups, mode, options),
      });
    } catch (reason) {
      if (stopRequested) throw reason;
      outcomes[index] = { status: 'rejected', phase: 'prepare', reason, item: binding, index };
    }
  }
  const started = await runPreparedBindingStarts(preparedItems, (prepared) => {
    operations.throwIfStopping();
    return operations.executePreparedBindingStart(prepared);
  });
  started.forEach((outcome, preparedIndex) => {
    outcomes[preparedItems[preparedIndex].index] = outcome;
  });
  operations.throwIfStopping();

  const running = [];
  const failed = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      running.push(outcome.value);
      if (mode === 'start' && !options.deferReadyCommit) {
        operations.printBindingStarted(outcome.value.binding, outcome.value.runtimeAgentType);
      }
      continue;
    }
    const binding = outcome.item;
    const reason = safeBindingFailureReason(binding, outcome.reason?.message || outcome.reason);
    const runtimeAgentType = groups.get(binding.aamp_host)?.runtimeAgentTypes?.get(binding.agent_type)
      || binding.agent_type;
    failed.push({ binding, reason, runtimeAgentType });
  }
  const launched = {
    running: orderStartupItems(bindings, running),
    failed: orderStartupItems(bindings, failed),
    cancelled: orderStartupItems(bindings, cancelled),
  };
  if (!options.deferReadyCommit) {
    await finalizeDeferredLaunchResults(launched, mode, operations);
  }
  return launched;
}

async function stopRunningBindings(running) {
  for (const item of [...running].reverse()) {
    if (item.process && !item.process.exited) await stopManagedProcess(item.process);
  }
}

const overlappedReadyReconcileOperations = Object.freeze({
  printBindingCancelled,
  printBindingStarted,
  recordError,
  reportBindingFailure,
  setBindingStatus,
  stopManagedProcess,
  throwIfStopping,
});

async function reconcileOverlappedReadyBindings(
  bindings,
  launched,
  groups,
  operations = overlappedReadyReconcileOperations,
) {
  const alive = [];
  const failed = [];
  const cancelled = [];
  const outcomes = orderStartupItems(bindings, [
    ...launched.running.map((item) => ({ ...item, launchStatus: 'running' })),
    ...launched.failed.map((item) => ({ ...item, launchStatus: 'failed' })),
    ...launched.cancelled.map((item) => ({ ...item, launchStatus: 'cancelled' })),
  ]);
  for (const item of outcomes) {
    operations.throwIfStopping();
    const { binding, process: feishu } = item;
    const group = item.group || groups.get(binding.aamp_host);
    const runtimeAgentType = item.runtimeAgentType
      || group?.runtimeAgentTypes?.get(binding.agent_type)
      || binding.agent_type;
    const cancellation = group?.cancellations?.get(binding.agent_type) || '';
    if (cancellation) {
      if (feishu && !feishu.exited) await operations.stopManagedProcess(feishu);
      await operations.setBindingStatus(binding, 'start', 'cancelled', cancellation);
      operations.printBindingCancelled(binding, cancellation);
      cancelled.push({ binding, reason: cancellation, runtimeAgentType });
      continue;
    }

    let reason = group?.failures?.get(binding.agent_type) || '';
    if (!reason && (!group?.process || group.process.exited)) {
      reason = `${bindingLabel(binding, runtimeAgentType)} 的 Agent Bridge 在启动期间已退出：${group?.host || binding.aamp_host}`;
    }
    if (!reason && !group.availableAgents?.has(binding.agent_type)) {
      reason = `${binding.agent_type} Agent Bridge 未启动`;
    }
    if (!reason && item.launchStatus === 'failed') {
      reason = item.reason;
    }
    if (!reason && item.launchStatus === 'running' && (!feishu || feishu.exited)) {
      reason = `${bindingLabel(binding, runtimeAgentType)} 的 Feishu Bridge 在进入监督前已退出 (${feishu?.exit?.signal || feishu?.exit?.code || 'unknown'})`;
    }
    if (reason) {
      const redactedReason = safeBindingFailureReason(binding, reason);
      if (feishu && !feishu.exited) await operations.stopManagedProcess(feishu);
      await operations.setBindingStatus(binding, 'start', 'failed', redactedReason);
      await operations.recordError('startup', redactedReason, binding);
      operations.reportBindingFailure(binding, runtimeAgentType, redactedReason, 'start');
      failed.push({ binding, reason: redactedReason, runtimeAgentType });
      continue;
    }
    if (item.launchStatus === 'cancelled') {
      const launchCancellation = redact(item.reason);
      await operations.setBindingStatus(binding, 'start', 'cancelled', launchCancellation);
      operations.printBindingCancelled(binding, launchCancellation);
      cancelled.push({ binding, reason: launchCancellation, runtimeAgentType });
      continue;
    }

    await operations.setBindingStatus(binding, 'start', 'running');
    operations.throwIfStopping();
    operations.printBindingStarted(binding, runtimeAgentType);
    alive.push(item);
  }
  return { alive, failed, cancelled };
}

async function runOverlappedStartup(bindings, groups, operations, profileProbes) {
  const readyBindings = bindings.filter((binding) => !bindingNeedsInitialStart(binding));
  const pendingBindings = bindings.filter((binding) => bindingNeedsInitialStart(binding));
  const emptyLaunch = { running: [], failed: [], cancelled: [] };
  const agentBranch = Promise.resolve().then(() => operations.startAgentGroups(groups));
  const readyBranch = readyBindings.length
    ? Promise.resolve().then(() => operations.startBindingsWithGroups(
        readyBindings,
        groups,
        'start',
        { allowAgentStarting: true, deferReadyCommit: true, profileProbes },
      ))
    : Promise.resolve(emptyLaunch);

  const [agentOutcome, readyOutcome] = await Promise.allSettled([agentBranch, readyBranch]);
  const earlyRunning = readyOutcome.status === 'fulfilled' ? readyOutcome.value.running : [];
  if (agentOutcome.status === 'rejected' || readyOutcome.status === 'rejected') {
    await operations.stopRunningBindings(earlyRunning);
    operations.throwIfStopping();
    throw (agentOutcome.status === 'rejected' ? agentOutcome.reason : readyOutcome.reason);
  }
  operations.throwIfStopping();

  const reconciledReady = await operations.reconcileOverlappedReadyBindings(
    readyBindings,
    readyOutcome.value,
    groups,
  );
  operations.throwIfStopping();
  const pendingLaunch = pendingBindings.length
    ? await operations.startBindingsWithGroups(pendingBindings, groups, 'start')
    : emptyLaunch;
  operations.throwIfStopping();

  return {
    running: orderStartupItems(bindings, [
      ...reconciledReady.alive,
      ...pendingLaunch.running,
    ]),
    failed: orderStartupItems(bindings, [
      ...reconciledReady.failed,
      ...pendingLaunch.failed,
    ]),
    cancelled: orderStartupItems(bindings, [
      ...reconciledReady.cancelled,
      ...pendingLaunch.cancelled,
    ]),
  };
}

function startupDisposition({ running = [], failed = [], cancelled = [] }, extraFailureCount = 0) {
  if (running.length) return 'supervise';
  if (cancelled.length && !failed.length && extraFailureCount === 0) return 'only-cancel';
  return 'all-failed';
}

async function reconcileStartupResults(
  bindings,
  launched,
  validationFailures = [],
  reconcile = reconcileRetainedBindings,
) {
  const reconciled = await reconcile(launched.running);
  const result = {
    running: orderStartupItems(bindings, reconciled.alive),
    failed: orderStartupItems(bindings, [
      ...validationFailures,
      ...launched.failed,
      ...reconciled.failed,
    ]),
    cancelled: orderStartupItems(bindings, launched.cancelled),
  };
  return { ...result, disposition: startupDisposition(result) };
}

async function recordOnlineValidationFailure(binding, error) {
  const reason = safeBindingFailureReason(binding, error.message || error);
  await setBindingStatus(binding, 'start', 'failed', reason);
  await recordError('startup', reason, binding);
  console.error(`\n🔴 启动失败：${bindingLabel(binding)}\n   原因：${reason}`);
  console.error('   已跳过该项，继续启动下一项。');
  return { binding, reason };
}

function startBindingsForOverlap(bindings, groups, mode, options) {
  return startBindingsWithGroups(bindings, groups, mode, bindingLauncherOperations, options);
}

const startupOrchestrationOperations = Object.freeze({
  finalizeDeferredLaunchResults: (launched) => finalizeDeferredLaunchResults(launched, 'start'),
  initializeAgentGroups,
  prewarmFeishuExecutable,
  probeReadyBindingProfiles,
  reconcileRetainedBindings,
  reconcileOverlappedReadyBindings,
  recordValidationFailure: recordOnlineValidationFailure,
  startAgentGroups,
  startBindingsWithGroups: startBindingsForOverlap,
  stopRunningBindings,
  throwIfStopping,
  validateBinding: assertOnlineBinding,
});

async function orchestrateStartupBindings(
  bindings,
  existingGroups,
  operations = startupOrchestrationOperations,
  runtimeOptions = {},
) {
  const validationFailures = [];
  const onlineBindings = [];
  for (const binding of bindings) {
    try {
      operations.validateBinding(binding);
      onlineBindings.push(binding);
    } catch (error) {
      validationFailures.push(await operations.recordValidationFailure(binding, error));
    }
  }
  if (onlineBindings.length && operations.prewarmFeishuExecutable) {
    try {
      void Promise.resolve(operations.prewarmFeishuExecutable(onlineBindings[0])).catch(() => {});
    } catch {
      // This is speculative only. Binding preparation performs the authoritative resolve.
    }
  }
  let groups = existingGroups;
  let profileProbes;
  if (!groups) {
    const initialization = Promise.resolve().then(() => operations.initializeAgentGroups(
      onlineBindings,
      runtimeOptions,
    ));
    const probing = operations.probeReadyBindingProfiles
      ? Promise.resolve().then(() => operations.probeReadyBindingProfiles(onlineBindings))
      : Promise.resolve(new Map());
    const [initializationOutcome, probingOutcome] = await Promise.allSettled([
      initialization,
      probing,
    ]);
    operations.throwIfStopping();
    if (initializationOutcome.status === 'rejected') throw initializationOutcome.reason;
    groups = initializationOutcome.value;
    profileProbes = probingOutcome.status === 'fulfilled' ? probingOutcome.value : new Map();
  }
  const launched = existingGroups
    ? await operations.startBindingsWithGroups(onlineBindings, groups, 'start')
    : await runOverlappedStartup(onlineBindings, groups, operations, profileProbes);
  const result = await reconcileStartupResults(
    bindings,
    launched,
    validationFailures,
    operations.reconcileRetainedBindings,
  );
  return { groups, ...result };
}

async function dispatchStartupResult(result, operations) {
  const disposition = startupDisposition(result, operations.extraFailureCount || 0);
  if (disposition === 'supervise') {
    return operations.supervise(result.running, result.groups);
  }
  await operations.shutdown(result.groups);
  if (disposition === 'only-cancel') return operations.onlyCancelled();
  return operations.allFailed();
}

async function startSelectedBindings(bindings, existingGroups, options = {}) {
  const orchestrate = options.orchestrate || orchestrateStartupBindings;
  const result = await orchestrate(
    bindings,
    existingGroups,
    undefined,
    { nonInteractive: Boolean(options.serviceWorker) },
  );
  printStartupSummary({
    title: '已成功启动',
    plannedCount: bindings.length,
    running: result.running,
    failed: result.failed,
    cancelled: result.cancelled,
  });
  if (options.serviceWorker && result.running.length !== bindings.length) {
    const shutdown = options.shutdown || shutdownGroups;
    await shutdown(result.groups);
    throw new Error(`后台服务绑定未全部启动（${result.running.length}/${bindings.length}），将由 launchd 稍后重试`);
  }
  await dispatchStartupResult(result, {
    supervise: async (running, groups) => {
      if (!options.background) {
        console.log(options.serviceWorker
          ? '🟢 Task Agent 后台服务运行中'
          : '🟢 保持终端打开，你可以给 agent 派发飞书任务');
      }
      const runtime = await continueStartedRuntime({
        background: Boolean(options.background),
        serviceWorker: Boolean(options.serviceWorker),
        serviceGeneration: options.serviceGeneration,
        bindings: running.map((item) => item.binding),
        running,
        groups,
      }, options.runtimeOperations);
      if (runtime.mode === 'background') {
        console.log(`🟢 后台服务已启动${runtime.pid ? `（PID ${runtime.pid}）` : ''}，现在可以关闭终端。`);
      }
    },
    shutdown: shutdownGroups,
    onlyCancelled: async () => {},
    allFailed: async () => { throw new Error('全部配置启动失败'); },
  });
}

async function markRuntimeFailed(binding, reason, component) {
  await setBindingStatus(binding, 'start', 'failed', reason);
  await recordError(component, reason, binding);
}

async function reconcileRetainedBindings(running) {
  const alive = [];
  const failed = [];
  for (const item of running) {
    throwIfStopping();
    const feishuAlive = Boolean(item.process && !item.process.exited);
    const groupAlive = Boolean(item.group?.process && !item.group.process.exited);
    if (feishuAlive && groupAlive) {
      alive.push(item);
      continue;
    }
    const reason = !feishuAlive
      ? `${bindingLabel(item.binding, item.runtimeAgentType)} 的 Feishu Bridge 在进入监督前已退出 (${item.process?.exit?.signal || item.process?.exit?.code || 'unknown'})`
      : `${bindingLabel(item.binding, item.runtimeAgentType)} 的 Agent Bridge 在进入监督前已退出：${item.group?.host || item.binding.aamp_host}`;
    if (feishuAlive) await stopManagedProcess(item.process);
    await markRuntimeFailed(item.binding, reason, 'startup');
    failed.push({ binding: item.binding, reason, runtimeAgentType: item.runtimeAgentType });
    console.error(`\n🔴 启动失败：${bindingLabel(item.binding, item.runtimeAgentType)}\n   原因：${reason}`);
  }
  return { alive, failed };
}

async function supervise(running, groups) {
  const active = new Set(running);
  const reportedGroups = new Set();
  while (active.size && !stopRequested) {
    for (const item of [...active]) {
      if (!item.process.exited) continue;
      active.delete(item);
      if (!item.process.expectedStop) {
        const reason = `${bindingLabel(item.binding)} 的 Feishu Bridge 已退出 (${item.process.exit?.signal || item.process.exit?.code})`;
        await markRuntimeFailed(item.binding, reason, 'supervisor');
        console.error(`\n🔴 ${reason}`);
      }
    }
    for (const group of groups.values()) {
      if (!group.process?.exited || group.process.expectedStop || reportedGroups.has(group)) continue;
      reportedGroups.add(group);
      console.error(`\n🔴 Agent Bridge 已退出：${group.host}`);
      for (const item of [...active]) {
        if (item.group !== group) continue;
        const reason = `${bindingLabel(item.binding)} 的 Agent Bridge 已退出：${group.host}`;
        await markRuntimeFailed(item.binding, reason, 'supervisor');
        await stopManagedProcess(item.process);
        active.delete(item);
      }
    }
    if (active.size) await delay(400);
  }
  if (!stopRequested) process.exitCode = 1;
  await cleanupAll();
}

async function shutdownGroups(groups) {
  for (const group of groups.values()) {
    if (group.process) await stopManagedProcess(group.process);
    for (const lease of group.leases.values()) await releaseLease(lease);
    group.leases.clear();
  }
}

const cleanupRuntimeResources = createResourceCleanup(async () => {
  while (managedProcesses.size || transientProcesses.size || heldLeases.size) {
    const records = [...managedProcesses].reverse();
    for (const record of records) {
      managedProcesses.delete(record);
      await stopManagedProcess(record).catch(() => {});
    }
    for (const record of [...transientProcesses].reverse()) {
      transientProcesses.delete(record);
      await stopManagedProcess(record).catch(() => {});
    }
    for (const lease of [...heldLeases]) await releaseLease(lease).catch(() => {});
  }
});

async function cleanupAll() {
  await cleanupRuntimeResources();
  await Promise.allSettled([
    (async () => await manifestWriter.flush())(),
    (async () => await errorLogWriter.flush())(),
  ]);
}

function printLogHints(detailed = false) {
  console.log(`   日志：${RUN_LOG_DIR}`);
  if (!detailed) return;
  const logsBin = process.env.AAMP_LOGS_BIN || path.join(HOME, '.aamp', 'bin', 'aamp-logs');
  console.log(`   日志打包：${logsBin} collect --run-dir ${RUN_LOG_DIR}`);
  console.log(`   特定任务日志打包：${logsBin} collect --task-id xxx`);
  console.log(`   特定任务日志打包：${logsBin} collect --task-guid yyy`);
}

function displayBindings(bindings) {
  if (!bindings.length) {
    console.log('当前电脑未绑定智能体-机器人');
    return;
  }
  const rows = bindings.map((binding, index) => ({
    index: String(index + 1),
    agent: agentBindingDisplayName(binding.agent_type),
    bot: binding.bot.display_name || binding.bot.app_id,
    appId: binding.bot.app_id,
    environment: binding.environment.name,
    state: bindingNeedsInitialStart(binding) ? '待首次启动' : '已就绪',
  }));
  const widths = {
    index: Math.max(2, ...rows.map((row) => row.index.length)),
    agent: Math.max(5, ...rows.map((row) => row.agent.length)),
    bot: Math.max(3, ...rows.map((row) => row.bot.length)),
    appId: Math.max(6, ...rows.map((row) => row.appId.length)),
  };
  console.log(`${'#'.padEnd(widths.index)}  ${'Agent'.padEnd(widths.agent)}  ${'Bot'.padEnd(widths.bot)}  ${'App ID'.padEnd(widths.appId)}  环境    状态`);
  rows.forEach((row) => console.log(`${row.index.padEnd(widths.index)}  ${row.agent.padEnd(widths.agent)}  ${row.bot.padEnd(widths.bot)}  ${row.appId.padEnd(widths.appId)}  ${row.environment.padEnd(6)}  ${row.state}`));
}

async function discoverAgents(tenantKey) {
  const result = await runBootstrapHelper('__discover-agents', '', {
    AAMP_TASK_USER_TENANT_KEY: tenantKey || '',
  });
  const agents = (result.agents || []).filter((agent) => TASK_AGENT_TYPES.includes(agent));
  if (!agents.length) {
    throw new Error('暂未检测到智能体。请先安装 Codex、Cursor、Trae CLI、TraeCode CLI、WorkBuddy 或 WorkBuddy AI；AIME 仅对已登录的字节租户开放。');
  }
  return agents;
}

function buildPendingBinding(agent, registered, bindingId = randomId(), timestamp = nowIso()) {
  const metadata = resolveTaskAgentMetadata(agent);
  return {
    binding_id: bindingId,
    agent_type: agent,
    bot: {
      app_id: registered.app_id,
      app_secret: registered.app_secret,
      display_name: registered.display_name || registered.app_id,
      tenant_brand: normalizeTenantBrand(registered.tenant_brand, 'registered.tenant_brand'),
      ...(metadata.executionLocation === 'local' ? { lark_cli_profile: registered.lark_cli_profile } : {}),
    },
    environment: { name: 'online' },
    state: 'pending',
    aamp_host: DEFAULT_AAMP_HOST,
    feishu_config_dir: expectedFeishuConfigDir(bindingId),
    created_at: timestamp,
    updated_at: timestamp,
  };
}

async function createDraft(selectedAppIds, overrides = {}) {
  const registerBinding = overrides.registerBinding
    || (() => runBootstrapHelper('__register-binding', ''));
  const discoverAvailableAgents = overrides.discoverAgents || discoverAgents;
  const chooseAgent = overrides.chooseAgent
    || ((agents) => chooseOne('请选择要绑定的智能体：', agents, agentSelectionDisplayName));
  const defaultAgent = overrides.defaultAgent ?? DEFAULT_AGENT;
  const registered = await registerBinding();
  addSecret(registered.app_secret);
  if (!registered.app_id || !registered.app_secret || !registered.lark_cli_profile) {
    throw new Error('飞书应用授权结果不完整');
  }
  const tenantKey = typeof registered.tenant_key === 'string' ? registered.tenant_key.trim() : '';
  const detectedAgents = await discoverAvailableAgents(tenantKey);
  const agents = detectedAgents.filter((candidate) => (
    candidate !== 'aime' || tenantKey === AIME_ALLOWED_TENANT_KEY
  ));
  const agent = defaultAgent || await chooseAgent(agents);
  if (!agents.includes(agent)) {
    if (agent === 'aime') throw new Error('AIME 仅对字节租户开放；当前飞书 CLI 登录账号不可用');
    throw new Error(`未检测到指定智能体：${agent}`);
  }
  const metadata = resolveTaskAgentMetadata(agent);
  if (selectedAppIds.has(registered.app_id)) {
    throw new Error(`Bot ${registered.app_id} 已经选择过，不能重复绑定`);
  }
  selectedAppIds.add(registered.app_id);
  return buildPendingBinding(
    agent,
    registered,
    overrides.bindingId,
    overrides.timestamp,
  );
}

async function runBindingSession(mode) {
  const store = await loadStore();
  throwIfStopping();
  const existingByAppId = new Map(store.bindings.map((binding) => [binding.bot.app_id, binding]));
  const selectedAppIds = new Set();
  const bindingIntents = [];
  const acceptedBindings = [];
  const selectedBindings = [];
  const succeeded = [];
  const failed = [];
  const cancelled = [];
  const selectionFailures = [];
  const running = [];
  let selectedCount = 0;

  console.log('\n=== 选择绑定配置 ===');
  let keepGoing = true;
  while (keepGoing) {
    throwIfStopping();
    try {
      const draft = await createDraft(selectedAppIds);
      throwIfStopping();
      selectedCount += 1;
      const existing = existingByAppId.get(draft.bot.app_id);
      let accepted = true;
      let acceptedBinding = draft;
      if (existing && sameBindingRelationship(existing, draft)) {
        acceptedBinding = existing;
      } else if (existing) {
        console.log(`Bot ${draft.bot.app_id} 已存在绑定：${bindingLabel(existing)}`);
        console.log(`拟替换为：${bindingLabel(draft)}`);
        if (!await confirm('是否替换绑定？', false)) {
          accepted = false;
          const reason = '用户取消替换已有绑定';
          cancelled.push({ binding: draft, reason });
          await setBindingStatus(draft, 'bind', 'cancelled', reason);
          printBindingCancelled(draft, reason);
        }
      }
      selectedBindings.push(accepted ? acceptedBinding : draft);
      if (accepted) {
        acceptedBindings.push(acceptedBinding);
        if (acceptedBinding === draft) {
          bindingIntents.push({
            binding: draft,
            expected: existing ? bindingExpectation(existing) : undefined,
          });
        }
        console.log(`已选择：${bindingLabel(acceptedBinding)}`);
      }
    } catch (error) {
      if (stopRequested) throw error;
      const reason = redact(error.message || error);
      selectionFailures.push(reason);
      await recordError('selection', reason);
      console.error(`🔴 本次选择未完成：${reason}`);
    }
    throwIfStopping();
    keepGoing = await confirm('是否继续选择智能体和 Bot？', false);
    throwIfStopping();
  }

  if (!acceptedBindings.length) {
    return {
      groups: new Map(),
      saved: [],
      acceptedBindings,
      selectedBindings,
      succeeded,
      failed,
      cancelled,
      selectionFailures,
      running,
      selectedCount,
      replacedCount: 0,
    };
  }

  let persisted = { bindings: [], replacedCount: 0 };
  if (bindingIntents.length) {
    console.log('\n=== 保存绑定配置 ===');
    persisted = await upsertBindings(bindingIntents);
    for (const binding of persisted.bindings) {
      await setBindingStatus(binding, 'bind', 'saved');
      console.log(`已保存：${bindingLabel(binding)}`);
    }
  }
  const saved = persisted.bindings;

  if (mode === 'add') {
    succeeded.push(...acceptedBindings);
    return {
      previousBindings: store.bindings,
      groups: new Map(),
      saved,
      acceptedBindings,
      selectedBindings,
      succeeded,
      failed,
      cancelled,
      selectionFailures,
      running,
      selectedCount,
      replacedCount: persisted.replacedCount,
    };
  }

  console.log('\n=== 建立绑定并启动 ===');
  throwIfStopping();
  const groups = await setupAgentGroups(acceptedBindings);
  throwIfStopping();
  const launched = await startBindingsWithGroups(acceptedBindings, groups, mode);
  running.push(...launched.running);
  succeeded.push(...launched.running.map(({ binding }) => binding));
  failed.push(...launched.failed);
  cancelled.push(...launched.cancelled);
  return {
    groups,
    saved,
    acceptedBindings,
    selectedBindings,
    succeeded,
    failed,
    cancelled,
    selectionFailures,
    running,
    selectedCount,
    replacedCount: persisted.replacedCount,
  };
}

async function finalizeInstallRuntime(result, options = {}) {
  if (!result.acceptedBindings.length) {
    if (result.cancelled.length && !result.selectionFailures.length) {
      printStartupSummary({
        title: '已成功建立绑定并启动',
        plannedCount: result.selectedCount,
        running: [],
        failed: [],
        cancelled: result.cancelled,
      });
      return;
    }
    throw new Error('没有配置完成绑定，现有配置保持不变');
  }
  printStartupSummary({
    title: '已成功建立绑定并启动',
    plannedCount: result.selectedCount,
    running: result.running,
    failed: result.failed,
    cancelled: result.cancelled,
  });
  await dispatchStartupResult(result, {
    extraFailureCount: result.selectionFailures.length,
    supervise: async (running, groups) => {
      if (!options.background) console.log('🟢 保持终端打开，你可以给 agent 派发飞书任务');
      if (result.selectionFailures.length) {
        console.log(`另有 ${result.selectionFailures.length} 次选择未完成，详情见上方信息和本地日志。`);
      }
      const continueRuntime = options.continueRuntime || continueStartedRuntime;
      const runtime = await continueRuntime({
        background: Boolean(options.background),
        serviceWorker: false,
        bindings: running.map((item) => item.binding),
        running,
        groups,
      });
      if (runtime.mode === 'background') {
        console.log(`🟢 后台服务已启动${runtime.pid ? `（PID ${runtime.pid}）` : ''}，现在可以关闭终端。`);
      }
    },
    shutdown: options.shutdown || shutdownGroups,
    onlyCancelled: async () => {},
    allFailed: async () => {
      throw new Error(`全部配置启动失败；${result.acceptedBindings.length} 个绑定配置已保存，可稍后运行 feishu-task-agent start 重试`);
    },
  });
}

async function runInstall() {
  const result = await withMutationLock('install 绑定流程', async () => {
    const bound = await runBindingSession('install');
    throwIfStopping();
    const composed = await reconcileStartupResults(bound.selectedBindings, {
      running: bound.running,
      failed: bound.failed,
      cancelled: bound.cancelled,
    });
    throwIfStopping();
    bound.running = composed.running;
    bound.failed = composed.failed;
    bound.cancelled = composed.cancelled;
    bound.disposition = composed.disposition;
    return bound;
  });
  await finalizeInstallRuntime(result, {
    background: shouldUseBackgroundService('install'),
  });
}

async function runAdd(operations = {}) {
  const runSession = operations.runBindingSession || runBindingSession;
  const activate = operations.activateAddedBindings || activateAddedBindings;
  const mutate = operations.withMutationLock || withMutationLock;
  const log = operations.log || console.log;
  const noStart = operations.noStart ?? NO_START_MODE;
  const result = await mutate('add 绑定流程', async () => {
    return runSession('add');
  });
  if (!result.acceptedBindings.length) {
    if (result.cancelled.length && !result.selectionFailures.length) {
      log(`已取消 ${result.cancelled.length} 个配置的绑定；现有配置保持不变。`);
      return;
    }
    throw new Error('没有配置完成绑定');
  }
  if (noStart) {
    log('配置添加成功，未自动启动；运行 feishu-task-agent start 时生效');
    return result;
  }
  log('配置添加成功，正在自动启动新增绑定...');
  const restoreBindings = operations.restoreReplacedBindings || restoreReplacedBindings;
  const activation = await activate(result.acceptedBindings, {
    beforeRollback: async () => {
      return restoreBindings(result.previousBindings || [], result.acceptedBindings);
    },
  });
  if (activation?.mode === 'manual') {
    if (activation.reason === 'foreground-running') {
      log(`检测到旧版前台 Task Agent 正在运行${activation.pid ? `（PID ${activation.pid}）` : ''}；新增配置已保存。请先运行 feishu-task-agent stop，再运行 feishu-task-agent start 使其生效`);
    } else {
      log('当前平台不支持后台服务；请运行 feishu-task-agent start 启动新增绑定');
    }
  } else {
    log(`🟢 新增绑定自动启动成功${activation?.pid ? `（后台服务 PID ${activation.pid}）` : ''}`);
  }
  return { ...result, activation };
}

async function runList() {
  const store = await loadStore();
  displayBindings(store.bindings);
}

async function runRemove() {
  const removed = await withMutationLock('remove 配置流程', async () => {
    const initial = await loadStore();
    if (!initial.bindings.length) return undefined;
    const selected = await chooseMany('请选择要移除的绑定配置：', initial.bindings, bindingLabel);
    const selectedIds = new Set(selected.map((binding) => binding.binding_id));
    return withConfigLock(async () => {
      const current = await loadStore();
      const next = current.bindings.filter((binding) => !selectedIds.has(binding.binding_id));
      const count = current.bindings.length - next.length;
      await writeJsonAtomic(CONFIG_FILE, { ...emptyStore(), bindings: next });
      return count;
    });
  });
  if (removed === undefined) {
    console.log('当前电脑未绑定智能体-机器人');
    return;
  }
  console.log(`已移除 ${removed} 个绑定配置；当前已经运行的 Bridge 不受影响。`);
}

function selectServiceBindings(bindings, bindingIds) {
  if (!bindingIds?.length) return [...bindings];
  const byId = new Map(bindings.map((binding) => [binding.binding_id, binding]));
  return bindingIds.map((bindingId) => byId.get(bindingId)).filter(Boolean);
}

async function restoreReplacedBindings(previousBindings, acceptedBindings, operations = {}) {
  const restore = async () => {
    const loadBindings = operations.loadBindings || (async () => (await loadStore()).bindings);
    const writeBindings = operations.writeBindings || (async (bindings) => {
      await writeJsonAtomic(CONFIG_FILE, { ...emptyStore(), bindings });
    });
    const currentBindings = await loadBindings();
    const acceptedByAppId = new Map(acceptedBindings
      .filter((binding) => binding.bot?.app_id)
      .map((binding) => [binding.bot.app_id, binding]));
    const previousByAppId = new Map(previousBindings
      .filter((binding) => acceptedByAppId.has(binding.bot?.app_id))
      .map((binding) => [binding.bot.app_id, binding]));
    const restored = [];
    const nextBindings = currentBindings.map((binding) => {
      const accepted = acceptedByAppId.get(binding.bot?.app_id);
      const previous = previousByAppId.get(binding.bot?.app_id);
      if (!accepted || binding.binding_id !== accepted.binding_id
        || !previous || previous.binding_id === binding.binding_id) return binding;
      restored.push(previous);
      return previous;
    });
    if (restored.length) await writeBindings(nextBindings);
    return restored;
  };
  if (operations.loadBindings || operations.writeBindings) return restore();
  return withConfigLock(restore);
}

async function activateAddedBindings(addedBindings, operations = {}) {
  const platform = operations.platform || process.platform;
  const addedBindingIds = [...new Set(addedBindings.map((binding) => binding.binding_id))];
  if (platform !== 'darwin') {
    return { mode: 'manual', bindingIds: addedBindingIds, pid: null };
  }
  const withControlLock = operations.withControlLock || withServiceControlLock;
  return withControlLock(async () => {
    const getRuntimeStatus = operations.getRuntimeStatus || resolveManagedRuntimeStatus;
    const runtimeStatus = await getRuntimeStatus();
    const foregroundOwnerPids = (runtimeStatus.pids || [])
      .filter((pid) => !runtimeStatus.pid || pid !== runtimeStatus.pid);
    if (runtimeStatus.mode === 'foreground' || foregroundOwnerPids.length) {
      return {
        mode: 'manual',
        reason: 'foreground-running',
        bindingIds: addedBindingIds,
        pid: runtimeStatus.mode === 'foreground'
          ? runtimeStatus.pid || foregroundOwnerPids[0] || null
          : foregroundOwnerPids[0] || null,
      };
    }
    const loadBindings = operations.loadBindings || (async () => (await loadStore()).bindings);
    const readSelection = operations.readSelection || (() => launchdService.selection());
    const startService = operations.startService || ((bindingIds) => launchdService.start(bindingIds));
    const stopService = operations.stopService || (() => launchdService.stop());
    const beforeRollback = operations.beforeRollback || (async () => {});
    const availableBindings = await loadBindings();
    const availableIds = new Set(availableBindings.map((binding) => binding.binding_id));
    const missingAddedBindingIds = addedBindingIds.filter((bindingId) => !availableIds.has(bindingId));
    if (missingAddedBindingIds.length) {
      throw new Error('新增绑定无法自动启动：配置已被其他命令修改，请重新运行 feishu-task-agent add');
    }
    const previousBindingIds = [...new Set((await readSelection()) || [])];
    const retainedBindingIds = previousBindingIds.filter((bindingId) => availableIds.has(bindingId));
    const bindingIds = [...new Set([
      ...retainedBindingIds,
      ...addedBindingIds.filter((bindingId) => availableIds.has(bindingId)),
    ])];
    try {
      const service = await startService(bindingIds);
      return { mode: 'background', bindingIds, pid: service.pid || null };
    } catch (error) {
      let rollbackError;
      let restoredReplacements = [];
      try {
        const restored = await beforeRollback();
        if (Array.isArray(restored)) restoredReplacements = restored;
        if (previousBindingIds.length) await startService(previousBindingIds);
        else await stopService();
      } catch (caught) {
        rollbackError = caught;
      }
      const reason = redact(error?.message || error);
      const rollbackSuffix = rollbackError
        ? `；恢复原后台绑定也失败：${redact(rollbackError?.message || rollbackError)}`
        : '';
      if (restoredReplacements.length) {
        throw new Error(`替换绑定自动启动失败，已恢复原绑定；如需重试新绑定，请重新运行 feishu-task-agent add：${reason}${rollbackSuffix}`);
      }
      throw new Error(`新增绑定已保存，但自动启动失败：${reason}${rollbackSuffix}`);
    }
  });
}

function shouldUseBackgroundService(command, platform = process.platform, foreground = FOREGROUND_MODE) {
  return platform === 'darwin' && !foreground && (command === 'install' || command === 'start');
}

async function handoffToBackground(bindings, operations = {}) {
  const cleanupRuntime = operations.cleanupRuntime || cleanupAll;
  const startService = operations.startService || ((bindingIds) => launchdService.start(bindingIds));
  const withControlLock = operations.withControlLock || withServiceControlLock;
  return withControlLock(async () => {
    await cleanupRuntime();
    return startService(bindings.map((binding) => binding.binding_id));
  });
}

async function continueStartedRuntime(runtime, operations = {}) {
  const handoff = operations.handoff || handoffToBackground;
  const superviseRuntime = operations.superviseRuntime || supervise;
  if (runtime.background) {
    const service = await handoff(runtime.bindings);
    return { mode: 'background', state: service.state, pid: service.pid };
  }
  if (runtime.serviceWorker) {
    const markServiceReady = operations.markServiceReady
      || ((bindings, generation) => launchdService.markReady(
        bindings.map((binding) => binding.binding_id),
        generation,
      ));
    await markServiceReady(runtime.bindings, runtime.serviceGeneration);
  }
  await superviseRuntime(runtime.running, runtime.groups);
  return { mode: runtime.serviceWorker ? 'service' : 'foreground' };
}

async function resolveManagedRuntimeStatus(operations = {}) {
  const launchdStatus = operations.launchdStatus || (process.platform === 'darwin'
    ? () => launchdService.status()
    : async () => ({ loaded: false, state: 'stopped', pid: null }));
  const foregroundPids = operations.foregroundPids || (() => findOwnedControllerPids({
    leasesHome: LEASES_HOME,
    expectedControllerPath: CONTROLLER_PATH,
    expectedRuntimeHome: RUNTIME_HOME,
  }));
  const service = await launchdStatus();
  const pids = await foregroundPids();
  if (service.loaded) {
    return {
      mode: 'background',
      state: service.state,
      pid: service.pid,
      pids,
    };
  }
  if (pids.length) {
    return {
      mode: 'foreground',
      state: 'running',
      pid: pids[0],
      pids,
    };
  }
  return { mode: 'stopped', state: 'stopped', pid: null, pids: [] };
}

async function stopManagedRuntime(operations = {}) {
  const stopLaunchd = operations.stopLaunchd || (process.platform === 'darwin'
    ? () => launchdService.stop()
    : async () => ({ stopped: true, wasLoaded: false }));
  const discoverOwnedControllerPids = () => findOwnedControllerPids({
    leasesHome: LEASES_HOME,
    expectedControllerPath: CONTROLLER_PATH,
    expectedRuntimeHome: RUNTIME_HOME,
  });
  const foregroundPids = operations.foregroundPids || discoverOwnedControllerPids;
  const stopForeground = operations.stopForeground || ((pids) => stopOwnedControllerProcesses({
    pids,
    validateProcess: async (pid) => (await discoverOwnedControllerPids()).includes(pid),
  }));
  const launchd = await stopLaunchd();
  const pids = await foregroundPids();
  const foreground = pids.length
    ? await stopForeground(pids)
    : { stopped: [], remaining: [] };
  if (foreground.remaining.length) {
    throw new Error(`以下 Task Agent 进程未能停止：${foreground.remaining.join(', ')}`);
  }
  return { launchd: launchd.wasLoaded, stoppedPids: foreground.stopped };
}

async function runServiceLifecycleCommand(command, operations = {}) {
  const log = operations.log || console.log;
  if (command === 'status') {
    const getStatus = operations.getStatus || resolveManagedRuntimeStatus;
    const status = await getStatus();
    if (status.mode === 'background') {
      if (status.state === 'running' && status.pid) {
        log(`🟢 Task Agent 正在后台运行（PID ${status.pid}），终端可以关闭。`);
      } else {
        log(`🟡 Task Agent 后台服务已加载但未运行（状态：${status.state}）；请执行 feishu-task-agent logs 查看原因。`);
      }
    } else if (status.mode === 'foreground') {
      log(`🟡 Task Agent 正在旧版前台模式运行（PID ${status.pid}）；可执行 feishu-task-agent stop 安全停止。`);
    } else {
      log('⚪ Task Agent 当前未运行。');
    }
    return status;
  }
  if (command === 'stop') {
    const stopRuntime = operations.stopRuntime || stopManagedRuntime;
    const withControlLock = operations.withControlLock || withServiceControlLock;
    const result = await withControlLock(() => stopRuntime());
    log(result.launchd || result.stoppedPids.length
      ? '🟢 Task Agent 已停止。'
      : '⚪ Task Agent 当前未运行。');
    return result;
  }
  if (command === 'restart') {
    if (process.platform !== 'darwin' && !operations.startService) {
      throw new Error('后台服务当前仅支持 macOS；请使用 start --foreground');
    }
    const readSelection = operations.readSelection || (() => launchdService.selection());
    const loadBindings = operations.loadBindings || (async () => (await loadStore()).bindings);
    const stopRuntime = operations.stopRuntime || stopManagedRuntime;
    const startService = operations.startService || ((bindingIds) => launchdService.start(bindingIds));
    const withControlLock = operations.withControlLock || withServiceControlLock;
    const result = await withControlLock(async () => {
      const savedBindingIds = await readSelection();
      const bindingIds = selectServiceBindings(await loadBindings(), savedBindingIds)
        .map((binding) => binding.binding_id);
      if (!bindingIds.length) throw new Error('未找到已经绑定的智能体-Bot 配置，请先运行 install');
      await stopRuntime();
      return startService(bindingIds);
    });
    log(`🟢 Task Agent 已重新启动${result.pid ? `（PID ${result.pid}）` : ''}。`);
    return result;
  }
  if (command === 'logs') {
    const recentLogs = operations.recentLogs || (() => launchdService.recentLogs(100));
    const logFile = operations.logFile || launchdService.paths.logFile;
    const content = await recentLogs();
    log(`后台日志：${logFile}`);
    log(content || '暂无后台日志。');
    return content;
  }
  throw new Error(`unknown service lifecycle command: ${command}`);
}

async function runStart(operations = {}) {
  const background = operations.background ?? shouldUseBackgroundService('start');
  const log = operations.log || console.log;
  const loadBindings = operations.loadBindings || (async () => (await loadStore()).bindings);
  const availableBindings = await loadBindings();
  if (!availableBindings.length) {
    console.error('未找到已经绑定的智能体-Bot 配置，请先运行安装命令重新绑定：');
    console.error(`  ${INSTALL_COMMAND}`);
    process.exitCode = 1;
    return;
  }
  if (background) {
    const getStatus = operations.getStatus || resolveManagedRuntimeStatus;
    const status = await getStatus();
    if (status.mode === 'background') {
      if (status.state === 'running' && status.pid) {
        log(`🟢 Task Agent 已经在后台运行（PID ${status.pid}），无需重复启动。`);
        return status;
      }
      const readSelection = operations.readSelection || (() => launchdService.selection());
      const resumeService = operations.resumeService || ((bindingIds) => launchdService.start(bindingIds));
      const withControlLock = operations.withControlLock || withServiceControlLock;
      const resumed = await withControlLock(async () => {
        const lockedStatus = await getStatus();
        if (lockedStatus.mode === 'background' && lockedStatus.state === 'running' && lockedStatus.pid) {
          return { ...lockedStatus, alreadyRunning: true };
        }
        if (lockedStatus.mode !== 'background') {
          throw new Error('Task Agent 运行状态已变化，请重新执行 feishu-task-agent start');
        }
        const savedBindingIds = await readSelection();
        const selectedIds = selectServiceBindings(availableBindings, savedBindingIds)
          .map((binding) => binding.binding_id);
        if (!selectedIds.length) throw new Error('后台服务选择的绑定配置已被移除，请运行 feishu-task-agent stop 后重新 start');
        return resumeService(selectedIds);
      });
      if (resumed.alreadyRunning) {
        log(`🟢 Task Agent 已经在后台运行（PID ${resumed.pid}），无需重复启动。`);
        return resumed;
      }
      log(`🟢 Task Agent 后台服务已启动${resumed.pid ? `（PID ${resumed.pid}）` : ''}。`);
      return resumed;
    }
    if (status.mode === 'foreground') {
      log(`🟡 Task Agent 已在旧版前台模式运行（PID ${status.pid}）；如需切换后台，请先执行 feishu-task-agent stop。`);
      return status;
    }
  }
  const acquireLease = operations.acquireLease || (() => acquireRuntimeSessionLease('start'));
  const chooseBindings = operations.chooseBindings
    || ((prompt, bindings) => chooseMany(prompt, bindings, bindingLabel));
  const startBindings = operations.startBindings || startSelectedBindings;
  await acquireLease();
  const selected = await chooseBindings('请选择要启动的绑定配置：', availableBindings);
  await startBindings(selected, undefined, { background });
}

async function runServiceWorker(operations = {}) {
  const loadBindings = operations.loadBindings || (async () => (await loadStore()).bindings);
  const readSelectionSnapshot = operations.readSelectionSnapshot
    || (() => launchdService.selectionSnapshot());
  const acquireLease = operations.acquireLease || (() => acquireRuntimeSessionLease('__service-run'));
  const startBindings = operations.startBindings || startSelectedBindings;
  const availableBindings = await loadBindings();
  const selectionSnapshot = await readSelectionSnapshot();
  if (!selectionSnapshot?.generation) throw new Error('后台服务选择配置缺少启动代次，请重新运行 start');
  const selected = selectServiceBindings(availableBindings, selectionSnapshot.bindingIds);
  if (!selected.length) throw new Error('后台服务没有可启动的绑定配置，请重新运行 install');
  await acquireLease();
  await startBindings(selected, undefined, {
    serviceWorker: true,
    serviceGeneration: selectionSnapshot.generation,
  });
}

async function dispatchControllerCommand(command, operations = {}) {
  if (command === 'install') {
    const acquireLease = operations.acquireLease || acquireRuntimeSessionLease;
    await acquireLease('install');
    return (operations.install || runInstall)();
  }
  if (command === 'start') return (operations.start || runStart)();
  if (command === '__service-run') return (operations.serviceWorker || runServiceWorker)();
  if (['status', 'stop', 'restart', 'logs'].includes(command)) {
    const lifecycle = operations.lifecycle || runServiceLifecycleCommand;
    return lifecycle(command);
  }
  if (command === 'list') return (operations.list || runList)();
  if (command === 'add') return (operations.add || runAdd)();
  if (command === 'remove') return (operations.remove || runRemove)();
  throw new Error(`unknown controller command: ${command}`);
}

async function main() {
  await ensurePrivateDir(STATE_HOME);
  await assertNoSymlinkPath(RUNTIME_HOME, RUNTIME_HOME);
  await ensurePrivateDir(RUNTIME_HOME);
  await ensurePrivateDir(RUN_LOG_DIR);
  await fsp.writeFile(ERRORS_LOG, '', { mode: 0o600, flag: 'a' });
  await writeManifest();
  await dispatchControllerCommand(COMMAND);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopRequested) return;
    stopRequested = true;
    stopSignal = signal;
    const interruptedPrompt = promptInterrupter.interrupt(new Error(`已收到 ${signal}`));
    if (!interruptedPrompt) {
      if (terminal?.input?.isRaw) terminal.input.setRawMode(false);
      terminal?.output?.write('\x1b[?25h');
    }
    void cleanupAll().catch(() => {});
  });
}

let isMainModule = false;
if (process.argv[1]) {
  try {
    isMainModule = fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    isMainModule = path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule) {
  main()
    .catch(async (error) => {
      if (!stopRequested) {
        const reason = redact(error?.message || error);
        await recordError('controller', reason).catch(() => {});
        console.error(`\n🔴 运行失败：${reason}`);
        printLogHints(true);
        process.exitCode = 1;
      }
    })
    .finally(async () => {
      await cleanupAll();
      if (stopRequested && stopSignal) console.log(`\n已收到 ${stopSignal}，本次启动的 Bridge 已停止。`);
    });
}

export {
  buildPendingBinding,
  activateAddedBindings,
  createDraft,
  bindingExpectation,
  acpBridgeAgentPolicy,
  commitPreparedAgentBindings,
  continueStartedRuntime,
  createPromptInterrupter,
  createResourceCleanup,
  dispatchStartupResult,
  dispatchControllerCommand,
  executePreparedBindingStart,
  executePreparedPendingBindingStart,
  executePreparedReadyBindingStart,
  installHasOnlyCancellations,
  initializeAgentGroups,
  orderStartupItems,
  prepareBindingStart,
  prepareFeishuProcess,
  readInitialRuntimeMetadata,
  resolveConfiguredPendingPairingFile,
  resolvePendingPairingFile,
  feishuArgs,
  finalizeInstallRuntime,
  handoffToBackground,
  prepareAndCommitAgentBindings,
  probeReadyBindingProfiles,
  reconcileStartupResults,
  reconcileOverlappedReadyBindings,
  recordPreparationFailure,
  recordError,
  recordStableAgentFailure,
  resolvePreparedAgentBindings,
  resolveManagedRuntimeStatus,
  restoreReplacedBindings,
  orchestrateStartupBindings,
  runOverlappedStartup,
  runPreparedBindingStarts,
  sameBindingRelationship,
  startBindingsWithGroups,
  startAgentGroups,
  startManagedProcess,
  startSelectedBindings,
  runBootstrapHelper,
  runAdd,
  runServiceLifecycleCommand,
  runServiceWorker,
  runStart,
  setBindingStatus,
  selectServiceBindings,
  shouldUseBackgroundService,
  startupSummaryLines,
  stopManagedRuntime,
  cleanupAll,
  upsertBindings,
  writeFeishuRuntimeProfile,
  writeManifest,
};
