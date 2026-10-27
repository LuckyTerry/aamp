import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LABEL = 'com.larktask.aamp-feishu-task-agent';

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function renderLaunchAgentPlist({
  label = DEFAULT_LABEL,
  bootstrapPath,
  home,
  pathValue,
  stdoutPath,
  stderrPath,
}) {
  const string = (value) => `<string>${xmlEscape(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(label)}
  <key>ProgramArguments</key>
  <array>
    ${string(bootstrapPath)}
    ${string('__service-run')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    ${string(home)}
    <key>PATH</key>
    ${string(pathValue)}
    <key>AAMP_TASK_ENTRY</key>
    ${string('service')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  ${string('Background')}
  <key>StandardOutPath</key>
  ${string(stdoutPath)}
  <key>StandardErrorPath</key>
  ${string(stderrPath)}
</dict>
</plist>
`;
}

function parseLaunchctlPrint(output, code = 0) {
  if (code !== 0) return { loaded: false, state: 'stopped', pid: null };
  const text = String(output || '');
  const state = text.match(/(?:^|\n)\s*state\s*=\s*([^\s]+)/)?.[1] || 'loaded';
  const rawPid = text.match(/(?:^|\n)\s*pid\s*=\s*(\d+)/)?.[1];
  const pid = rawPid ? Number(rawPid) : null;
  return { loaded: true, state, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

function runLaunchctlCommand(args) {
  const testOverride = process.env.AAMP_TASK_ALLOW_TEST_OVERRIDES === 'true'
    ? process.env.AAMP_TASK_LAUNCHCTL_BIN
    : '';
  return runCapturedCommand(testOverride || '/bin/launchctl', args);
}

function runCapturedCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({
      code: Number.isInteger(code) ? code : 1,
      signal: signal || null,
      stdout,
      stderr,
    }));
  });
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

async function readProcessIdentity(pid) {
  const result = await runCapturedCommand('/bin/ps', [
    '-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command=',
  ], { env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  if (result.code !== 0) return undefined;
  const line = result.stdout.trim();
  const match = /^(.{24})\s+([\s\S]+)$/.exec(line);
  if (!match) return undefined;
  const startedAtMs = Date.parse(match[1]);
  if (!Number.isFinite(startedAtMs)) return undefined;
  return { command: match[2].trim(), startedAt: new Date(startedAtMs).toISOString() };
}

function commandContainsExactPath(command, expectedPath) {
  if (!expectedPath) return false;
  const escaped = expectedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s"'])${escaped}(?:$|[\\s"'])`).test(String(command || ''));
}

async function findOwnedControllerPids({
  leasesHome,
  expectedControllerPath,
  expectedRuntimeHome,
  pidAlive: isAlive = pidAlive,
  readProcessIdentity: readIdentity = readProcessIdentity,
}) {
  let entries;
  try {
    entries = await fsp.readdir(leasesHome, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const candidates = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== 'runtime-session.lock'
      && !(entry.name.startsWith('agent-') && entry.name.endsWith('.lock'))) continue;
    try {
      const owner = JSON.parse(await fsp.readFile(path.join(leasesHome, entry.name, 'owner.json'), 'utf8'));
      const ownerPid = Number(owner?.pid);
      if (Number.isInteger(ownerPid) && ownerPid > 0 && isAlive(ownerPid)) candidates.set(ownerPid, owner);
    } catch {
      // Malformed and partial lock owners are stale and ignored here.
    }
  }
  const verified = [];
  for (const [ownerPid, owner] of candidates) {
    if ((owner?.controller_path && owner.controller_path !== expectedControllerPath)
      || (owner?.runtime_home && owner.runtime_home !== expectedRuntimeHome)) continue;
    const identity = await readIdentity(ownerPid).catch(() => undefined);
    if (!identity || !commandContainsExactPath(identity.command, expectedControllerPath)) continue;
    const startedAtMs = Date.parse(identity.startedAt);
    const ownerCreatedAtMs = Date.parse(owner.created_at);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(ownerCreatedAtMs)
      || startedAtMs > ownerCreatedAtMs + 5_000) continue;
    if (owner?.process_started_at) {
      const recordedStartMs = Date.parse(owner.process_started_at);
      if (!Number.isFinite(recordedStartMs) || Math.abs(startedAtMs - recordedStartMs) > 5_000) continue;
    }
    verified.push(ownerPid);
  }
  return verified.sort((left, right) => left - right);
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !pidAlive(pid);
}

async function stopOwnedControllerProcesses({
  pids,
  validateProcess = async () => true,
  signalProcess = (pid, signal) => process.kill(pid, signal),
  waitForExit = waitForProcessExit,
}) {
  const stopped = [];
  const remaining = [];
  for (const ownerPid of [...new Set(pids)]) {
    if (!await validateProcess(ownerPid)) {
      remaining.push(ownerPid);
      continue;
    }
    try {
      signalProcess(ownerPid, 'SIGTERM');
      stopped.push(ownerPid);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  for (const ownerPid of stopped) {
    if (!await waitForExit(ownerPid)) remaining.push(ownerPid);
  }
  return { stopped, remaining };
}

async function ensurePrivateDir(directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700).catch(() => {});
}

async function writePrivateFile(file, content) {
  const directory = path.dirname(file);
  await ensurePrivateDir(directory);
  const temporary = `${file}.tmp.${process.pid}`;
  try {
    await fsp.writeFile(temporary, content, { mode: 0o600 });
    await fsp.rename(temporary, file);
    await fsp.chmod(file, 0o600);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

function servicePaths(home, label = DEFAULT_LABEL) {
  const serviceHome = path.join(home, '.aamp', 'feishu-task-agent', 'service-v1');
  const logFile = path.join(home, '.aamp', 'logs', 'feishu-task-agent-service.log');
  return {
    serviceHome,
    selectionFile: path.join(serviceHome, 'selection.json'),
    readinessFile: path.join(serviceHome, 'readiness.json'),
    plistFile: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    logFile,
  };
}

function normalizeBindingIds(bindingIds = []) {
  return [...new Set(bindingIds.map((value) => String(value).trim()).filter(Boolean))];
}

function sameBindingIds(left = [], right = []) {
  const normalizedLeft = normalizeBindingIds(left).sort();
  const normalizedRight = normalizeBindingIds(right).sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function createLaunchdServiceManager({
  home,
  uid,
  platform = process.platform,
  label = DEFAULT_LABEL,
  bootstrapPath,
  pathValue,
  runLaunchctl = runLaunchctlCommand,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  startupAttempts = 600,
  stopAttempts = 25,
  statusIntervalMs = 500,
}) {
  const paths = servicePaths(home, label);
  const target = `gui/${uid}/${label}`;
  const domain = `gui/${uid}`;

  const requireMacOS = () => {
    if (platform !== 'darwin') throw new Error('后台服务当前仅支持 macOS；请使用 start --foreground');
  };

  const readSelectionPayload = async () => {
    try {
      const payload = JSON.parse(await fsp.readFile(paths.selectionFile, 'utf8'));
      if (payload?.version !== 1 || !Array.isArray(payload.binding_ids)) return undefined;
      return payload;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    }
  };

  const readReadiness = async () => {
    try {
      const payload = JSON.parse(await fsp.readFile(paths.readinessFile, 'utf8'));
      return payload?.version === 1 ? payload : undefined;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    }
  };

  const hasValidSelection = (payload) => (
    typeof payload?.generation === 'string'
      && Boolean(payload.generation.trim())
      && normalizeBindingIds(payload.binding_ids).length > 0
  );

  const status = async () => {
    requireMacOS();
    const result = await runLaunchctl(['print', target]);
    const launchctlStatus = parseLaunchctlPrint(result.stdout, result.code);
    if (!launchctlStatus.loaded || launchctlStatus.state !== 'running' || !launchctlStatus.pid) {
      return { ...launchctlStatus, ready: false };
    }
    const selected = await readSelectionPayload();
    if (!hasValidSelection(selected)) {
      return { ...launchctlStatus, state: 'starting', ready: false };
    }
    const readiness = await readReadiness();
    if (readiness?.state === 'ready'
      && readiness.generation === selected.generation
      && Number(readiness.pid) === launchctlStatus.pid
      && sameBindingIds(readiness.binding_ids, selected.binding_ids)) {
      return { ...launchctlStatus, ready: true };
    }
    return { ...launchctlStatus, state: 'starting', ready: false };
  };

  const waitForStatus = async (predicate, attempts) => {
    let current = { loaded: false, state: 'stopped', pid: null, ready: false };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      current = await status();
      if (predicate(current)) return current;
      if (attempt + 1 < attempts) await wait(statusIntervalMs);
    }
    return current;
  };

  const start = async (bindingIds = []) => {
    requireMacOS();
    const uniqueBindingIds = normalizeBindingIds(bindingIds);
    const current = await status();
    const currentSelection = current.loaded
      ? await readSelectionPayload()
      : undefined;
    const sameSelection = hasValidSelection(currentSelection)
      && sameBindingIds(uniqueBindingIds, currentSelection.binding_ids);
    if (current.loaded && current.state === 'running' && current.pid && current.ready
      && sameSelection) {
      return { ...current, alreadyRunning: true };
    }
    if (current.loaded && current.state === 'starting' && current.pid
      && sameSelection) {
      const settled = await waitForStatus((currentStatus) => (
        currentStatus.loaded && currentStatus.state === 'running'
          && currentStatus.pid && currentStatus.ready
      ), startupAttempts);
      if (settled.state === 'running' && settled.pid && settled.ready) {
        return { ...settled, alreadyRunning: true };
      }
      throw new Error('后台服务启动尚未完成；请运行 feishu-task-agent logs 查看原因');
    }
    const generation = randomUUID();
    await ensurePrivateDir(path.dirname(paths.logFile));
    await writePrivateFile(paths.selectionFile, `${JSON.stringify({
      version: 1,
      generation,
      binding_ids: uniqueBindingIds,
    }, null, 2)}\n`);
    await fsp.rm(paths.readinessFile, { force: true }).catch(() => {});
    await writePrivateFile(paths.plistFile, renderLaunchAgentPlist({
      label,
      bootstrapPath,
      home,
      pathValue,
      stdoutPath: paths.logFile,
      stderrPath: paths.logFile,
    }));

    if (current.loaded) {
      const kicked = await runLaunchctl(['kickstart', '-k', target]);
      if (kicked.code !== 0) throw new Error(`无法启动后台服务：${String(kicked.stderr || kicked.stdout).trim() || 'launchctl kickstart failed'}`);
    } else {
      const bootstrapped = await runLaunchctl(['bootstrap', domain, paths.plistFile]);
      if (bootstrapped.code !== 0) throw new Error(`无法注册后台服务：${String(bootstrapped.stderr || bootstrapped.stdout).trim() || 'launchctl bootstrap failed'}`);
    }
    const started = await waitForStatus((currentStatus) => (
      currentStatus.loaded && currentStatus.state === 'running'
        && currentStatus.pid && currentStatus.ready
    ), startupAttempts);
    if (!started.loaded) throw new Error('后台服务注册后未出现在 launchctl 中');
    if (started.state !== 'running' || !started.pid || !started.ready) {
      throw new Error('后台服务已注册但未进入运行状态；请运行 feishu-task-agent logs 查看原因');
    }
    return { ...started, alreadyRunning: false };
  };

  const stop = async () => {
    requireMacOS();
    const current = await status();
    if (current.loaded) {
      const result = await runLaunchctl(['bootout', target]);
      if (result.code !== 0) throw new Error(`无法停止后台服务：${String(result.stderr || result.stdout).trim() || 'launchctl bootout failed'}`);
    }
    const after = await waitForStatus((currentStatus) => !currentStatus.loaded, stopAttempts);
    if (after.loaded) throw new Error('后台服务仍在运行');
    await fsp.rm(paths.readinessFile, { force: true }).catch(() => {});
    return { stopped: true, wasLoaded: current.loaded };
  };

  const selectionSnapshot = async () => {
    const payload = await readSelectionPayload();
    return {
      generation: hasValidSelection(payload) ? payload.generation.trim() : '',
      bindingIds: normalizeBindingIds(payload?.binding_ids || []),
    };
  };

  const selection = async () => (await selectionSnapshot()).bindingIds;

  const markReady = async (bindingIds = [], generation = '') => {
    requireMacOS();
    const payload = await readSelectionPayload();
    if (!hasValidSelection(payload)) throw new Error('后台服务选择配置缺少启动代次');
    if (!generation || payload.generation.trim() !== generation) {
      throw new Error('后台服务启动代次已变化，忽略旧进程的 readiness');
    }
    const selectedIds = normalizeBindingIds(bindingIds);
    if (!sameBindingIds(selectedIds, payload.binding_ids)) {
      throw new Error('后台服务启动绑定已变化，忽略旧进程的 readiness');
    }
    await writePrivateFile(paths.readinessFile, `${JSON.stringify({
      version: 1,
      state: 'ready',
      generation,
      pid: process.pid,
      binding_ids: selectedIds,
      ready_at: new Date().toISOString(),
    }, null, 2)}\n`);
  };

  const restart = async (bindingIds) => {
    requireMacOS();
    const selected = bindingIds === undefined ? await selection() : bindingIds;
    await stop();
    return start(selected);
  };

  const recentLogs = async (lineCount = 100) => {
    const boundedCount = Math.max(1, Math.min(1_000, Math.trunc(Number(lineCount) || 100)));
    let content;
    try {
      content = await fsp.readFile(paths.logFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
    return content.trimEnd().split('\n').slice(-boundedCount).join('\n');
  };

  return {
    markReady,
    paths,
    recentLogs,
    restart,
    selection,
    selectionSnapshot,
    start,
    status,
    stop,
  };
}

export {
  DEFAULT_LABEL,
  createLaunchdServiceManager,
  findOwnedControllerPids,
  parseLaunchctlPrint,
  readProcessIdentity,
  renderLaunchAgentPlist,
  runLaunchctlCommand,
  servicePaths,
  stopOwnedControllerProcesses,
};
