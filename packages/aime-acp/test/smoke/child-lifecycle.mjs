import { spawn } from 'node:child_process';

const defaultOutputLimit = 16 * 1024 * 1024;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within(promise, timeoutMs) {
  return Promise.race([
    promise.then((value) => ({ completed: true, value })),
    wait(timeoutMs).then(() => ({ completed: false })),
  ]);
}

export class ChildTimeoutError extends Error {
  constructor(message, stdout, stderr) {
    super(message);
    this.name = 'ChildTimeoutError';
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export async function terminateChild(child, closed, terminateTimeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    const settled = await within(closed, terminateTimeoutMs);
    if (settled.completed) return settled.value;
  }
  child.kill('SIGTERM');
  const terminated = await within(closed, terminateTimeoutMs);
  if (terminated.completed) return terminated.value;
  child.kill('SIGKILL');
  const killed = await within(closed, terminateTimeoutMs);
  if (killed.completed) return killed.value;
  throw new Error('child did not close after SIGKILL');
}

export async function runBoundedProcess(file, args, options = {}) {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
  });
  options.onChild?.(child);
  let stdout = '';
  let stderr = '';
  let triggerTermination;
  const termination = new Promise((resolve) => {
    triggerTermination = resolve;
  });
  const closed = new Promise((resolve) => {
    child.once('error', (error) => resolve({ kind: 'error', error }));
    child.once('close', (code, signal) =>
      resolve({ kind: 'close', code, signal }),
    );
  });
  const outputLimit = options.outputLimit ?? defaultOutputLimit;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > outputLimit) triggerTermination('output limit');
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > outputLimit) triggerTermination('output limit');
  });
  child.stdin?.end(options.stdin ?? '');
  const timeout = setTimeout(
    () => triggerTermination('timeout'),
    options.timeoutMs ?? 120_000,
  );
  const first = await Promise.race([
    closed.then((result) => ({ kind: 'closed', result })),
    termination.then((reason) => ({ kind: 'terminate', reason })),
  ]);
  clearTimeout(timeout);
  if (first.kind === 'closed') {
    if (first.result.kind === 'error') throw first.result.error;
    return {
      code: first.result.code,
      signal: first.result.signal,
      stdout,
      stderr,
    };
  }
  await terminateChild(child, closed, options.terminateTimeoutMs ?? 2_000);
  throw new ChildTimeoutError(
    `subprocess ${first.reason} after ${options.timeoutMs ?? 120_000}ms`,
    stdout,
    stderr,
  );
}

function assertStrictCleanJson(result) {
  if (result?.code !== 0 || result.signal !== null || result.stderr !== '') {
    throw new Error('close did not emit strict clean JSON');
  }
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0)
    throw new Error('close did not emit strict clean JSON');
  for (const line of lines) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('close did not emit strict clean JSON');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('close did not emit strict clean JSON');
    }
  }
}

export async function validateCloseThenCleanup(result, cleanup) {
  let validationFailure;
  try {
    assertStrictCleanJson(result);
  } catch (error) {
    validationFailure = error;
  }
  let cleanupFailure;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = error;
  }
  if (validationFailure !== undefined) throw validationFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}
