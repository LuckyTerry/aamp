#!/usr/bin/env node

import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ReadStream, WriteStream } from 'node:tty';
import { emitKeypressEvents } from 'node:readline';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

process.umask(0o077);

const COMMAND = process.argv[2] || 'help';
const HOME = os.homedir();
const STATE_HOME = process.env.AAMP_TASK_STATE_HOME || path.join(HOME, '.aamp', 'feishu-task-agent');
const CONFIG_FILE = process.env.AAMP_TASK_CONFIG_FILE || path.join(STATE_HOME, 'bindings-v1.json');
const RUNTIME_HOME = process.env.AAMP_TASK_RUNTIME_HOME || path.join(STATE_HOME, 'runtime-v1');
const CONFIG_LOCK = path.join(STATE_HOME, 'bindings-v1.lock');
const MUTATION_LOCK = path.join(STATE_HOME, 'bindings-v1-mutation.lock');
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
const NPM_CACHE_DIR = process.env.AAMP_TASK_NPM_CACHE_DIR || path.join(os.tmpdir(), 'aamp-one-click-npm-cache');
const ACP_PACKAGE = process.env.AAMP_TASK_ACP_BRIDGE_PKG || '@zengxingyuan/aamp-acp-bridge@0.1.28-dev.19';
const FEISHU_PACKAGE = process.env.AAMP_TASK_FEISHU_BRIDGE_PKG || '@zengxingyuan/aamp-feishu-bridge@0.1.51';
const INSTALL_COMMAND = process.env.AAMP_TASK_INSTALL_COMMAND
  || 'npx -y --package @zengxingyuan/aamp-feishu-task-agent@dev feishu-task-agent install';
const DEFAULT_AGENT = process.env.AAMP_TASK_DEFAULT_AGENT || '';
const DEFAULT_AAMP_HOST = process.env.AAMP_TASK_AAMP_HOST || 'https://meshmail.ai';
const DEBUG_MODE = process.env.AAMP_TASK_DEBUG_MODE === 'true';
const READY_TIMEOUT_MS = Number(process.env.AAMP_TASK_READY_TIMEOUT_MS || 90_000);
const CONFIG_SCHEMA = 'aamp.feishu-task-agent.bindings';
const CONFIG_VERSION = 1;
const AGENT_TYPES = ['codex', 'cursor'];
const PROFILE_DOMAINS = [
  'base', 'calendar', 'contact', 'docs', 'im', 'mail', 'mindnotes', 'minutes',
  'note', 'sheets', 'slides', 'task', 'vc', 'wiki',
];

const secrets = new Set();
const managedProcesses = new Set();
const transientProcesses = new Set();
const heldLeases = new Set();
const bindingStatuses = new Map();
let stopRequested = false;
let stopSignal = '';
let cleanupPromise;
let terminal;

function nowIso() {
  return new Date().toISOString();
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
  output = output
    .replace(/([?&]pair_code=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/("?(?:app_secret|appSecret|smtpPassword|mailboxToken|access_token|device_code|pairCode)"?\s*[:=]\s*"?)[^",\s}]+/gi, '$1[REDACTED]')
    .replace(/(--app-secret\s+)[^\s]+/gi, '$1[REDACTED]');
  return output;
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
      await writeJsonAtomic(path.join(lockDir, 'owner.json'), {
        pid: process.pid,
        run_id: RUN_ID,
        label,
        created_at: nowIso(),
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
    throw new Error(`检测到已有 feishu-task-agent 正在运行。请先回到之前启动的终端，按 Ctrl+C 关闭后再运行 feishu-task-agent ${action}`);
  }
  let release;
  try {
    release = await acquireDirectoryLock(RUNTIME_SESSION_LOCK, 'Bridge 启动流程', 1_500);
  } catch (error) {
    if (String(error?.message || error).includes('正在被另一个 feishu-task-agent 进程使用')) {
      throw new Error(`检测到已有 feishu-task-agent 正在运行。请先回到之前启动的终端，按 Ctrl+C 关闭后再运行 feishu-task-agent ${action}`);
    }
    throw error;
  }
  const lease = { lockDir: RUNTIME_SESSION_LOCK, release };
  heldLeases.add(lease);
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

function validateBinding(binding, index) {
  if (!binding || typeof binding !== 'object') throw new Error(`bindings[${index}] 无效`);
  assertString(binding.binding_id, `bindings[${index}].binding_id`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.binding_id)) {
    throw new Error(`bindings[${index}].binding_id 必须是 UUID`);
  }
  if (!AGENT_TYPES.includes(binding.agent_type)) throw new Error(`bindings[${index}].agent_type 仅支持 codex/cursor`);
  assertString(binding.aamp_host, `bindings[${index}].aamp_host`);
  assertString(binding.environment?.name, `bindings[${index}].environment.name`);
  assertString(binding.bot?.app_id, `bindings[${index}].bot.app_id`);
  assertString(binding.bot?.app_secret, `bindings[${index}].bot.app_secret`);
  assertString(binding.bot?.lark_cli_profile, `bindings[${index}].bot.lark_cli_profile`);
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

async function replaceBindings(bindings) {
  await withConfigLock(async () => {
    await writeJsonAtomic(CONFIG_FILE, { ...emptyStore(), bindings });
  });
}

async function appendBinding(binding) {
  await withConfigLock(async () => {
    const store = await loadStore();
    if (store.bindings.some((item) => item.bot.app_id === binding.bot.app_id)) {
      throw new Error(`Bot ${binding.bot.app_id} 已绑定，不能重复选择`);
    }
    validateBinding(binding, store.bindings.length);
    await writeJsonAtomic(CONFIG_FILE, { ...emptyStore(), bindings: [...store.bindings, binding] });
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

function bindingLabel(binding) {
  const botName = binding.bot?.display_name || binding.bot?.app_id || 'unknown Bot';
  return `${binding.agent_type} ↔ ${botName} (${binding.bot?.app_id || 'unknown'})`;
}

async function recordError(component, message, binding) {
  await appendPrivate(ERRORS_LOG, `${JSON.stringify({
    timestamp: nowIso(),
    level: 'error',
    component,
    binding_id: binding?.binding_id,
    app_id: binding?.bot?.app_id,
    message: redact(message),
  })}\n`);
}

async function writeManifest() {
  const statuses = [...bindingStatuses.entries()].map(([bindingId, status]) => ({ binding_id: bindingId, ...status }));
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
}

async function setBindingStatus(binding, phase, status, reason = '') {
  bindingStatuses.set(binding.binding_id, {
    agent_type: binding.agent_type,
    app_id: binding.bot.app_id,
    bot_name: binding.bot.display_name || binding.bot.app_id,
    phase,
    status,
    ...(reason ? { reason: redact(reason) } : {}),
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
    const finish = (error) => {
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
    output.write('\x1b[2K\r使用 ↑/↓ 移动，空格多选，回车确认；选择“全部”会忽略其他选项。\n');
  };

  draw();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
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
  const { input } = terminalStreams();
  const helperEnv = { ...extraEnv };
  const inputPayload = helperEnv.AAMP_TASK_INTERNAL_BINDING_JSON || '';
  delete helperEnv.AAMP_TASK_INTERNAL_BINDING_JSON;
  const child = spawn('bash', helperArgs(action, bindingOrAgent), {
    env: {
      ...process.env,
      ...helperEnv,
      AAMP_TASK_INTERNAL: 'true',
      AAMP_TASK_INTERNAL_RESULT_FD: '3',
      AAMP_TASK_INTERNAL_INPUT_FD: '4',
    },
    stdio: [input, 'inherit', 'inherit', 'pipe', 'pipe'],
  });
  const processRecord = trackTransientProcess(child, `Bootstrap helper ${action}`, false);
  let result = '';
  child.stdio[3].setEncoding('utf8');
  child.stdio[3].on('data', (chunk) => { result += chunk; });
  child.stdio[4].end(inputPayload ? `${inputPayload}\n` : '');
  if (stopRequested) await stopManagedProcess(processRecord);
  const exit = await processRecord.exitPromise;
  throwIfStopping();
  if (exit.code !== 0) throw exit.error || new Error(`Bootstrap helper ${action} failed${exit.signal ? ` (${exit.signal})` : ''}`);
  try {
    return JSON.parse(result.trim() || '{}');
  } catch {
    throw new Error(`Bootstrap helper ${action} returned invalid result`);
  }
}

function npmExecArgs(packageSpec, executable, args) {
  return [
    'exec', '--yes', '--registry', NPM_REGISTRY, '--cache', NPM_CACHE_DIR,
    '--package', packageSpec, '--', executable, ...args,
  ];
}

async function runCapture(packageSpec, executable, args, options = {}) {
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
    await appendPrivate(options.logFile, `${stdout}${stderr ? `\n${stderr}` : ''}`);
  }
  if (exit.code !== 0) {
    const detail = redact(stderr.trim() || stdout.trim() || exit.error?.message || `exit ${exit.code}`);
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

async function startManagedProcess({ label, packageSpec, executable, args, env, logFile }) {
  await ensurePrivateDir(path.dirname(logFile));
  throwIfStopping();
  await fsp.writeFile(logFile, '', { mode: 0o600, flag: 'a' });
  throwIfStopping();
  const child = spawn(NPM_BIN, npmExecArgs(packageSpec, executable, args), {
    env: env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
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
  };
  managedProcesses.add(record);
  const handleLine = (streamName, line) => {
    const safeLine = redact(line);
    record.outputTail.push(`[${streamName}] ${safeLine}`);
    if (record.outputTail.length > 30) record.outputTail.shift();
    if (streamName === 'stdout' && line.trim()) {
      try {
        const event = JSON.parse(line.trim());
        if (event && typeof event.type === 'string') {
          record.events.push(event);
          record.emitter.emit('event', event);
        }
      } catch {
        // Feishu task mode can mix human-readable lines with JSON events.
      }
    }
    void appendPrivate(logFile, `${line}\n`).catch(() => {});
  };
  createLineReader(child.stdout, (line) => { handleLine('stdout', line); });
  createLineReader(child.stderr, (line) => { handleLine('stderr', line); });
  record.exitPromise = new Promise((resolve) => {
    child.once('error', (error) => {
      record.exited = true;
      record.exit = { code: 1, error };
      record.emitter.emit('exit', record.exit);
      resolve(record.exit);
    });
    child.once('exit', (code, signal) => {
      record.exited = true;
      record.exit = { code: code ?? 1, signal };
      record.emitter.emit('exit', record.exit);
      resolve(record.exit);
    });
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
    const cleanup = () => {
      clearTimeout(timeout);
      record.emitter.off('event', onEvent);
      record.emitter.off('exit', onExit);
    };
    record.emitter.on('event', onEvent);
    record.emitter.on('exit', onExit);
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

async function setupAgentGroups(bindings) {
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
      leases: new Map(),
      process: undefined,
    };
    groups.set(host, group);
    const agents = [];
    for (const [agentType, sampleBinding] of agentBindings) {
      throwIfStopping();
      try {
        const lease = await acquireAgentLease(host, agentType);
        throwIfStopping();
        group.leases.set(agentType, lease);
        console.log(`[aamp-one-click] 正在检查 ${agentType} 本地智能体...`);
        const prepared = await runBootstrapHelper('__prepare-agent', sampleBinding);
        throwIfStopping();
        if (path.resolve(prepared.lark_cli_config_dir || '') !== path.resolve(bridgeEnv.LARKSUITE_CLI_CONFIG_DIR)) {
          throw new Error(`Agent 使用的 lark-cli 配置目录与 Online 配置不一致：${prepared.lark_cli_config_dir || 'unknown'}`);
        }
        const agentHome = path.join(home, 'agents', agentType);
        await assertNoSymlinkPath(RUNTIME_HOME, agentHome);
        throwIfStopping();
        await ensurePrivateDir(agentHome);
        throwIfStopping();
        agents.push({
          name: agentType,
          acpCommand: prepared.acp_command,
          credentialsFile: path.join(agentHome, 'credentials.json'),
          pairingFile: path.join(agentHome, 'pairing.json'),
          senderPoliciesFile: path.join(agentHome, 'sender-policies.json'),
          createPairing: false,
        });
      } catch (error) {
        const reason = redact(error.message || error);
        group.failures.set(agentType, reason);
        await releaseLease(group.leases.get(agentType));
        group.leases.delete(agentType);
        if (stopRequested) throw error;
      }
    }
    if (!agents.length) continue;
    try {
      throwIfStopping();
      const initResult = await runCapture(
        ACP_PACKAGE,
        'aamp-acp-bridge',
        ['init', '--json', '--config', group.configFile, '--input', '-'],
        { input: JSON.stringify({ aampHost: host, agents }), env: bridgeEnv, logFile },
      );
      throwIfStopping();
      const initialized = parseJsonDocument(initResult.stdout, 'ACP init');
      for (const agent of initialized.agents || []) group.identities.set(agent.name, agent.email);
      console.log(`[aamp-one-click] 正在启动本地 Agent Bridge (${agents.map((agent) => agent.name).join(', ')})...`);
      group.process = await startManagedProcess({
        label: `ACP Bridge ${host}`,
        packageSpec: ACP_PACKAGE,
        executable: 'aamp-acp-bridge',
        args: ['start', '--config', group.configFile, '--json', ...(DEBUG_MODE ? ['--debug'] : [])],
        env: bridgeEnv,
        logFile,
      });
      throwIfStopping();
      const running = await waitForEvent(group.process, (event) => event.type === 'bridge.running');
      throwIfStopping();
      for (const agent of running.agents || []) group.availableAgents.add(agent.name);
      for (const agent of agents) {
        if (!group.availableAgents.has(agent.name)) {
          const failed = group.process.events.find((event) => event.type === 'agent.failed' && event.agent === agent.name);
          group.failures.set(agent.name, failed?.message || `${agent.name} Agent Bridge 启动失败`);
          await releaseLease(group.leases.get(agent.name));
          group.leases.delete(agent.name);
        }
      }
    } catch (error) {
      for (const agent of agents) group.failures.set(agent.name, redact(error.message || error));
      if (group.process) await stopManagedProcess(group.process);
      for (const lease of group.leases.values()) await releaseLease(lease);
      group.leases.clear();
      if (stopRequested) throw error;
    }
  }
  return groups;
}

function resolveGroup(groups, binding) {
  const group = groups.get(binding.aamp_host);
  if (!group) throw new Error(`Agent Bridge group is unavailable for ${binding.aamp_host}`);
  const agentFailure = group.failures.get(binding.agent_type);
  if ((!group.process || group.process.exited) && agentFailure) throw new Error(agentFailure);
  if (!group.process || group.process.exited) {
    const tail = group.process?.outputTail?.slice(-10).join('\n');
    throw new Error(`Agent Bridge 已退出${tail ? `：\n${tail}` : ''}`);
  }
  if (!group.availableAgents.has(binding.agent_type)) {
    throw new Error(group.failures.get(binding.agent_type) || `${binding.agent_type} Agent Bridge 未启动`);
  }
  const email = group.identities.get(binding.agent_type);
  if (!email) throw new Error(`${binding.agent_type} Agent mailbox is unavailable`);
  if (binding.agent_target_email && binding.agent_target_email !== email) {
    throw new Error(`Agent mailbox 已变化（配置=${binding.agent_target_email}，当前=${email}），请使用 add 或 install 重新绑定`);
  }
  return { group, email };
}

async function writeFeishuRuntimeProfile(binding) {
  const profileFile = path.join(binding.feishu_config_dir, 'task-runtime', 'task-profiles-v2.json');
  const instancesDir = path.join(binding.feishu_config_dir, 'task-runtime', 'instances');
  await assertNoSymlinkPath(RUNTIME_HOME, profileFile);
  await assertNoSymlinkPath(RUNTIME_HOME, instancesDir);
  await writeJsonAtomic(profileFile, {
    version: 1,
    profiles: [{
      app_id: binding.bot.app_id,
      app_secret: binding.bot.app_secret,
      profile: binding.bot.lark_cli_profile,
      display_name: binding.bot.display_name,
      auth_mode: 'lark-cli',
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

function feishuArgs(binding, larkCliBin, target) {
  const targetArgs = target.pairingUrl
    ? ['--pairing-url', target.pairingUrl]
    : ['--target-agent', target.agentTargetEmail];
  return [
    'start', '--enable-task',
    '--config-dir', binding.feishu_config_dir,
    '--aamp-host', binding.aamp_host,
    '--agent', binding.agent_type,
    ...targetArgs,
    '--app-id', binding.bot.app_id,
    '--bot-name', binding.bot.display_name || binding.bot.app_id,
    '--use-feishu-cli',
    '--feishu-cli-profile', binding.bot.lark_cli_profile,
    '--feishu-cli-bin', larkCliBin,
    '--json',
    ...(DEBUG_MODE ? ['--debug'] : []),
  ];
}

async function prepareFeishuProcess(binding, phase) {
  throwIfStopping();
  await writeFeishuRuntimeProfile(binding);
  throwIfStopping();
  const profile = await ensureBindingProfile(binding);
  throwIfStopping();
  if (!profile.lark_cli_bin) throw new Error(`lark-cli profile ${binding.bot.lark_cli_profile} is unavailable`);
  return {
    binding,
    phase,
    larkCliBin: profile.lark_cli_bin,
    logFile: path.join(RUN_LOG_DIR, `feishu-bridge-${safeId(binding.binding_id)}-${phase}.jsonl`),
  };
}

async function startPreparedFeishuProcess(prepared, target) {
  throwIfStopping();
  const { binding, phase, larkCliBin, logFile } = prepared;
  const phaseMessage = phase === 'install'
    ? '正在建立绑定并启动飞书任务 Bridge'
    : phase === 'add'
      ? '正在验证飞书任务绑定'
      : '正在启动飞书任务 Bridge';
  console.log(`[aamp-one-click] ${phaseMessage}：${bindingLabel(binding)}...`);
  return startManagedProcess({
    label: `Feishu Bridge ${bindingLabel(binding)}`,
    packageSpec: FEISHU_PACKAGE,
    executable: 'aamp-feishu-bridge',
    args: feishuArgs(binding, larkCliBin, target),
    env: onlineEnvironment(binding),
    logFile,
  });
}

async function startFeishuProcess(binding, phase, target) {
  const prepared = await prepareFeishuProcess(binding, phase);
  throwIfStopping();
  return startPreparedFeishuProcess(prepared, target);
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
  const imFile = path.join(starting.imConfigDir, 'config.json');
  const taskFile = path.join(starting.taskConfigDir, 'config.json');
  if (!isPathInside(binding.feishu_config_dir, starting.imConfigDir) || !isPathInside(binding.feishu_config_dir, starting.taskConfigDir)) {
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
    im_config_dir: starting.imConfigDir,
    task_config_dir: starting.taskConfigDir,
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

async function bindOneDraft(draft, groups, mode) {
  await setBindingStatus(draft, 'bind', 'starting');
  throwIfStopping();
  const { group, email } = resolveGroup(groups, draft);
  const binding = { ...draft, state: 'ready', agent_target_email: email, updated_at: nowIso() };
  const preparedFeishu = await prepareFeishuProcess(binding, mode);
  throwIfStopping();
  const pairResult = await runCapture(
    ACP_PACKAGE,
    'aamp-acp-bridge',
    ['pair', '--agent', draft.agent_type, '--config', group.configFile, '--json', '--no-start'],
    { logFile: group.logFile },
  );
  throwIfStopping();
  const pairing = parseJsonDocument(pairResult.stdout, 'ACP pairing');
  if (!pairing.connectUrl || !pairing.pairingFile || pairing.mailbox !== email) {
    throw new Error('ACP Bridge 返回的配对信息不完整或 mailbox 不一致');
  }
  let feishu;
  let keepRunning = false;
  try {
    feishu = await startPreparedFeishuProcess(preparedFeishu, { pairingUrl: pairing.connectUrl });
    throwIfStopping();
    await waitForInitialBinding(feishu, pairing.pairingFile);
    throwIfStopping();
    binding.runtime = await readInitialRuntimeMetadata(binding, feishu, email);
    throwIfStopping();
    await validateSavedRuntime(binding);
    throwIfStopping();
    const startsBridge = mode === 'install' || mode === 'start';
    await setBindingStatus(binding, startsBridge ? 'start' : 'bind', startsBridge ? 'running' : 'succeeded');
    throwIfStopping();
    keepRunning = startsBridge;
    return { binding, process: keepRunning ? feishu : undefined, group };
  } finally {
    if (!keepRunning) await stopManagedProcess(feishu);
  }
}

async function startOneBinding(binding, groups) {
  await setBindingStatus(binding, 'start', 'starting');
  throwIfStopping();
  const { email } = resolveGroup(groups, binding);
  if (email !== binding.agent_target_email) throw new Error('当前 Agent mailbox 与绑定记录不一致，请重新绑定');
  await validateSavedRuntime(binding);
  throwIfStopping();
  const feishu = await startFeishuProcess(binding, 'start', { agentTargetEmail: binding.agent_target_email });
  try {
    throwIfStopping();
    await waitForEvent(feishu, (event) => event.type === 'bridge.task_runtime.running');
    throwIfStopping();
    await setBindingStatus(binding, 'start', 'running');
    throwIfStopping();
    console.log(`\n🟢 ${binding.agent_type} 已接入飞书任务，可以开始对话 & 派发任务。`);
    console.log(`   飞书 Bot：${binding.bot.display_name || binding.bot.app_id}`);
    return feishu;
  } catch (error) {
    await stopManagedProcess(feishu);
    throw error;
  }
}

async function startSelectedBindings(bindings, existingGroups) {
  const running = [];
  const failed = [];
  const onlineBindings = [];
  for (const binding of bindings) {
    try {
      assertOnlineBinding(binding);
      onlineBindings.push(binding);
    } catch (error) {
      const reason = redact(error.message || error);
      failed.push({ binding, reason });
      await setBindingStatus(binding, 'start', 'failed', reason);
      await recordError('startup', reason, binding);
      console.error(`\n🔴 启动失败：${bindingLabel(binding)}\n   原因：${reason}`);
      console.error('   已跳过该项，继续启动下一项。');
    }
  }
  const groups = existingGroups || await setupAgentGroups(onlineBindings);
  for (const binding of onlineBindings) {
    throwIfStopping();
    try {
      let activeBinding = binding;
      let group = groups.get(binding.aamp_host);
      let processRecord;
      if (bindingNeedsInitialStart(binding)) {
        const paired = await bindOneDraft(binding, groups, 'start');
        if (!paired.process) throw new Error('首次启动完成配对后未获得可监督的 Feishu Bridge 进程');
        try {
          await updateBinding(paired.binding);
        } catch (error) {
          await stopManagedProcess(paired.process);
          throw error;
        }
        activeBinding = paired.binding;
        group = paired.group;
        processRecord = paired.process;
        console.log(`\n🟢 ${activeBinding.agent_type} 已接入飞书任务，可以开始对话 & 派发任务。`);
        console.log(`   飞书 Bot：${activeBinding.bot.display_name || activeBinding.bot.app_id}`);
      } else {
        processRecord = await startOneBinding(binding, groups);
      }
      throwIfStopping();
      running.push({ binding: activeBinding, process: processRecord, group });
    } catch (error) {
      if (stopRequested) throw error;
      const reason = redact(error.message || error);
      failed.push({ binding, reason });
      await setBindingStatus(binding, 'start', 'failed', reason);
      await recordError('startup', reason, binding);
      console.error(`\n🔴 启动失败：${bindingLabel(binding)}\n   原因：${reason}`);
      console.error('   已跳过该项，继续启动下一项。');
    }
  }
  const reconciled = await reconcileRetainedBindings(running);
  running.splice(0, running.length, ...reconciled.alive);
  failed.push(...reconciled.failed);
  if (!running.length) {
    await shutdownGroups(groups);
    throw new Error('全部配置启动失败');
  }
  console.log(`\n已成功启动 ${running.length}/${bindings.length} 个配置。`);
  console.log('保持此终端打开；按 Ctrl+C 停止本次启动的本地连接。');
  printLogHints(true);
  if (failed.length) console.log(`另有 ${failed.length} 个配置启动失败，详情见上方信息和本地日志。`);
  await supervise(running, groups);
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
      ? `${bindingLabel(item.binding)} 的 Feishu Bridge 在进入监督前已退出 (${item.process?.exit?.signal || item.process?.exit?.code || 'unknown'})`
      : `${bindingLabel(item.binding)} 的 Agent Bridge 在进入监督前已退出：${item.group?.host || item.binding.aamp_host}`;
    if (feishuAlive) await stopManagedProcess(item.process);
    await markRuntimeFailed(item.binding, reason, 'startup');
    failed.push({ binding: item.binding, reason });
    console.error(`\n🔴 启动失败：${bindingLabel(item.binding)}\n   原因：${reason}`);
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

async function cleanupAll() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
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
  })();
  return cleanupPromise;
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
    agent: binding.agent_type,
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

async function discoverAgents() {
  const result = await runBootstrapHelper('__discover-agents', '');
  const agents = (result.agents || []).filter((agent) => AGENT_TYPES.includes(agent));
  if (!agents.length) throw new Error('暂未检测到本地智能体。请先安装并登录 Codex 或 Cursor CLI 后重试。');
  return agents;
}

async function createDraft(agents, unavailableAppIds) {
  const agent = DEFAULT_AGENT || await chooseOne('请选择要绑定的本地智能体：', agents, (item) => item);
  const registered = await runBootstrapHelper('__register-binding', agent);
  addSecret(registered.app_secret);
  if (!registered.app_id || !registered.app_secret || !registered.lark_cli_profile) {
    throw new Error('飞书应用授权结果不完整');
  }
  if (unavailableAppIds.has(registered.app_id)) {
    throw new Error(`Bot ${registered.app_id} 已经选择过，不能重复绑定`);
  }
  unavailableAppIds.add(registered.app_id);
  const bindingId = randomId();
  const timestamp = nowIso();
  return {
    binding_id: bindingId,
    agent_type: agent,
    bot: {
      app_id: registered.app_id,
      app_secret: registered.app_secret,
      display_name: registered.display_name || registered.app_id,
      lark_cli_profile: registered.lark_cli_profile,
    },
    environment: { name: 'online' },
    state: 'pending',
    aamp_host: DEFAULT_AAMP_HOST,
    feishu_config_dir: expectedFeishuConfigDir(bindingId),
    created_at: timestamp,
    updated_at: timestamp,
  };
}

async function runBindingSession(mode) {
  const store = await loadStore();
  throwIfStopping();
  const unavailableAppIds = new Set(mode === 'add' ? store.bindings.map((binding) => binding.bot.app_id) : []);
  const agents = DEFAULT_AGENT ? [DEFAULT_AGENT] : await discoverAgents();
  throwIfStopping();
  const sessionDrafts = [];
  const succeeded = [];
  const failed = [];
  const selectionFailures = [];
  const running = [];

  console.log('\n=== 选择绑定配置 ===');
  let keepGoing = true;
  while (keepGoing) {
    throwIfStopping();
    try {
      const draft = await createDraft(agents, unavailableAppIds);
      throwIfStopping();
      sessionDrafts.push(draft);
      console.log(`已选择：${bindingLabel(draft)}`);
    } catch (error) {
      if (stopRequested) throw error;
      const reason = redact(error.message || error);
      selectionFailures.push(reason);
      await recordError('selection', reason);
      console.error(`🔴 本次选择未完成：${reason}`);
    }
    throwIfStopping();
    keepGoing = await confirm('是否继续选择本地智能体和 Bot？', false);
    throwIfStopping();
  }

  if (!sessionDrafts.length) {
    return { groups: new Map(), succeeded, failed, selectionFailures, running, selectedCount: 0 };
  }

  if (mode === 'add') {
    console.log('\n=== 保存绑定配置 ===');
    for (const draft of sessionDrafts) {
      try {
        await appendBinding(draft);
        throwIfStopping();
        succeeded.push(draft);
        await setBindingStatus(draft, 'bind', 'saved');
        console.log(`🟢 已保存：${bindingLabel(draft)}`);
      } catch (error) {
        if (stopRequested) throw error;
        const reason = redact(error.message || error);
        failed.push({ binding: draft, reason });
        await setBindingStatus(draft, 'bind', 'failed', reason);
        await recordError('binding', reason, draft);
        console.error(`🔴 配置保存失败：${bindingLabel(draft)}\n   原因：${reason}`);
        console.error('   已跳过该项，继续处理下一项。');
      }
    }
    return { groups: new Map(), succeeded, failed, selectionFailures, running, selectedCount: sessionDrafts.length };
  }

  console.log('\n=== 建立绑定并启动 ===');
  throwIfStopping();
  const groups = await setupAgentGroups(sessionDrafts);
  throwIfStopping();
  for (const draft of sessionDrafts) {
    throwIfStopping();
    try {
      const paired = await bindOneDraft(draft, groups, mode);
      throwIfStopping();
      if (mode === 'install' && !paired.process) throw new Error('完成绑定后未获得可监督的 Feishu Bridge 进程');
      succeeded.push(paired.binding);
      if (mode === 'install') {
        running.push({ binding: paired.binding, process: paired.process, group: paired.group });
      }
      console.log(`🟢 已完成绑定并启动：${bindingLabel(paired.binding)}`);
    } catch (error) {
      if (stopRequested) throw error;
      const reason = redact(error.message || error);
      failed.push({ binding: draft, reason });
      await setBindingStatus(draft, 'bind', 'failed', reason);
      await recordError('binding', reason, draft);
      console.error(`🔴 绑定失败：${bindingLabel(draft)}\n   原因：${reason}`);
      console.error('   已跳过该项，继续处理下一项。');
    }
  }
  return { groups, succeeded, failed, selectionFailures, running, selectedCount: sessionDrafts.length };
}

async function runInstall() {
  const result = await withMutationLock('install 绑定流程', async () => {
    const bound = await runBindingSession('install');
    throwIfStopping();
    if (!bound.succeeded.length) {
      await shutdownGroups(bound.groups);
      throw new Error('没有配置完成绑定，现有新流程配置保持不变');
    }
    const reconciled = await reconcileRetainedBindings(bound.running);
    throwIfStopping();
    bound.running = reconciled.alive;
    bound.runtimeFailures = reconciled.failed;
    await replaceBindings(bound.succeeded);
    throwIfStopping();
    if (!bound.running.length) {
      await shutdownGroups(bound.groups);
      throw new Error(`全部已绑定配置启动失败；${bound.succeeded.length} 个真实配对配置已写入 ${CONFIG_FILE}`);
    }
    return bound;
  });
  console.log(`已写入 ${result.succeeded.length} 个绑定配置：${CONFIG_FILE}`);
  console.log(`\n已成功建立绑定并启动 ${result.running.length}/${result.selectedCount} 个配置。`);
  console.log('保持此终端打开；按 Ctrl+C 停止本次启动的本地连接。');
  printLogHints(true);
  const failureCount = result.failed.length + result.selectionFailures.length + result.runtimeFailures.length;
  if (failureCount) console.log(`另有 ${failureCount} 次选择或绑定失败，详情见上方信息和本地日志。`);
  await supervise(result.running, result.groups);
}

async function runAdd() {
  await withMutationLock('add 绑定流程', async () => {
    const bound = await runBindingSession('add');
    if (!bound.succeeded.length) throw new Error('没有配置完成绑定');
    return bound;
  });
  console.log('配置添加成功，运行feishu-task-agent start启动时生效');
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

async function runStart() {
  const store = await loadStore();
  if (!store.bindings.length) {
    console.error('未找到已经绑定的智能体-Bot 配置，请先运行安装命令重新绑定：');
    console.error(`  ${INSTALL_COMMAND}`);
    process.exitCode = 1;
    return;
  }
  const selected = await chooseMany('请选择要启动的绑定配置：', store.bindings, bindingLabel);
  await startSelectedBindings(selected);
}

async function main() {
  await ensurePrivateDir(STATE_HOME);
  await assertNoSymlinkPath(RUNTIME_HOME, RUNTIME_HOME);
  await ensurePrivateDir(RUNTIME_HOME);
  await ensurePrivateDir(RUN_LOG_DIR);
  await fsp.writeFile(ERRORS_LOG, '', { mode: 0o600, flag: 'a' });
  await writeManifest();
  if (COMMAND === 'install' || COMMAND === 'start') await acquireRuntimeSessionLease(COMMAND);
  switch (COMMAND) {
    case 'install':
      await runInstall();
      break;
    case 'start':
      await runStart();
      break;
    case 'list':
      await runList();
      break;
    case 'add':
      await runAdd();
      break;
    case 'remove':
      await runRemove();
      break;
    default:
      throw new Error(`unknown controller command: ${COMMAND}`);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopRequested) return;
    stopRequested = true;
    stopSignal = signal;
    if (terminal?.input?.isRaw) terminal.input.setRawMode(false);
    terminal?.output?.write('\x1b[?25h');
    void cleanupAll().finally(() => {
      console.log(`\n已收到 ${signal}，本次启动的 Bridge 已停止。`);
      process.exit(0);
    });
  });
}

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
