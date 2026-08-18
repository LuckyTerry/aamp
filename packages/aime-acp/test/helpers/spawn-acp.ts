import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export interface SpawnedAcp {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  stdoutFrames(): readonly unknown[];
  stderrText(): string;
  close(): Promise<void>;
}

export interface SpawnAcpOptions {
  readonly scenario: unknown;
  readonly cwd?: string;
  readonly permissionModel?: boolean;
  readonly argv?: readonly string[];
  readonly returnAfterExitForTest?: boolean;
  readonly deferStderrUntilCloseForTest?: boolean;
}

export interface PermissionRuntime {
  readonly version: string;
  readonly allowedFlags: ReadonlySet<string>;
}

export class JsonRpcResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcResponseError';
  }
}

export function permissionModelSupport(
  runtime: PermissionRuntime = {
    version: process.versions.node,
    allowedFlags: process.allowedNodeEnvironmentFlags,
  },
):
  | { readonly supported: true; readonly flag: string }
  | { readonly supported: false; readonly reason: string } {
  const [rawMajor, rawMinor] = runtime.version.split('.');
  const major = Number.parseInt(rawMajor ?? '', 10);
  const minor = Number.parseInt(rawMinor ?? '', 10);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    major < 22 ||
    (major === 22 && minor < 13)
  ) {
    return {
      supported: false,
      reason: `Node ${runtime.version} is below the required 22.13 target`,
    };
  }
  if (runtime.allowedFlags.has('--permission'))
    return { supported: true, flag: '--permission' };
  if (runtime.allowedFlags.has('--experimental-permission'))
    return { supported: true, flag: '--experimental-permission' };
  return {
    supported: false,
    reason: `Node ${runtime.version} does not expose a supported permission-model flag`,
  };
}

export async function spawnAcp(options: SpawnAcpOptions): Promise<SpawnedAcp> {
  const helperDirectory = dirname(fileURLToPath(import.meta.url));
  const packageDirectory = resolve(helperDirectory, '../..');
  const loaderPath = resolve(helperDirectory, 'fake-bytedcli-loader.mjs');
  const entryPath = resolve(packageDirectory, 'dist/bin.js');
  const isolatedHome = await mkdtemp(
    resolve(tmpdir(), 'aime-acp-subprocess-home-'),
  );
  const args: string[] = [];
  if (options.permissionModel) {
    const support = permissionModelSupport();
    if (!support.supported) {
      await rm(isolatedHome, { recursive: true, force: true });
      throw new Error(support.reason);
    }
    args.push(
      support.flag,
      '--allow-worker',
      `--allow-fs-read=${resolve(packageDirectory, 'dist')}`,
      `--allow-fs-read=${resolve(packageDirectory, 'node_modules')}`,
      `--allow-fs-read=${helperDirectory}`,
      `--allow-fs-read=${resolve(packageDirectory, 'package.json')}`,
      `--allow-fs-read=${isolatedHome}`,
    );
  }
  args.push('--experimental-loader', loaderPath, entryPath);
  args.push(...(options.argv ?? []));

  let stderr = '';
  let deferredStderr = '';
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? packageDirectory,
    env: {
      HOME: isolatedHome,
      LANG: 'C.UTF-8',
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
    },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolveClose) => {
    child.once('close', () => {
      if (options.deferStderrUntilCloseForTest) {
        setTimeout(() => {
          stderr += deferredStderr;
          deferredStderr = '';
          resolveClose();
        }, 20);
      } else {
        resolveClose();
      }
    });
  });
  const exited = new Promise<void>((resolveExit) =>
    child.once('exit', () => resolveExit()),
  );
  const scenarioPipe = child.stdio[3];
  if (
    scenarioPipe === undefined ||
    scenarioPipe === null ||
    typeof scenarioPipe === 'number' ||
    typeof (scenarioPipe as Writable).end !== 'function'
  ) {
    child.kill();
    await rm(isolatedHome, { recursive: true, force: true });
    throw new Error('scenario FD 3 is unavailable');
  }
  (scenarioPipe as Writable).end(JSON.stringify(options.scenario));

  const frames: Record<string, unknown>[] = [];
  const pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 1;
  let stdoutBuffer = '';
  let fatal: Error | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;

  const fail = (error: Error): void => {
    fatal ??= error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };

  const acceptLine = (line: string): void => {
    if (fatal !== undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(new Error(`invalid ACP stdout line: ${line}`));
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      fail(new Error(`non-object ACP stdout line: ${line}`));
      return;
    }
    const frame = parsed as Record<string, unknown>;
    frames.push(frame);
    if (!Object.hasOwn(frame, 'id') || typeof frame.id !== 'number') return;
    const waiter = pending.get(frame.id);
    if (waiter === undefined) {
      fail(new Error(`unexpected ACP response id: ${String(frame.id)}`));
      return;
    }
    pending.delete(frame.id);
    clearTimeout(waiter.timer);
    const error = frame.error;
    if (typeof error === 'object' && error !== null) {
      const responseError = error as Record<string, unknown>;
      waiter.reject(
        new JsonRpcResponseError(
          typeof responseError.code === 'number' ? responseError.code : -32603,
          typeof responseError.message === 'string'
            ? responseError.message
            : 'JSON-RPC request failed',
          responseError.data,
        ),
      );
      return;
    }
    waiter.resolve(frame.result);
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    while (true) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline === -1) break;
      let line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      acceptLine(line);
    }
  });
  child.stdout?.on('end', () => {
    if (stdoutBuffer !== '') acceptLine(stdoutBuffer);
    stdoutBuffer = '';
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (options.deferStderrUntilCloseForTest) deferredStderr += chunk;
    else stderr += chunk;
  });
  child.on('error', (error) => {
    spawnError = error;
    fail(error);
  });
  child.on('exit', (code, signal) => {
    exit = { code, signal };
    if (pending.size > 0) {
      fail(
        new Error(
          `ACP child exited before responding: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
        ),
      );
    }
  });

  const writeFrame = (frame: Record<string, unknown>): void => {
    if (fatal !== undefined) throw fatal;
    if (exit !== undefined)
      throw new Error('cannot write to an exited ACP subprocess');
    child.stdin?.write(`${JSON.stringify(frame)}\n`);
  };

  if (options.returnAfterExitForTest) await exited;

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error(`ACP request timed out: ${method}`));
        }, 5_000);
        pending.set(id, {
          resolve: resolveRequest,
          reject: rejectRequest,
          timer,
        });
        try {
          writeFrame({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          rejectRequest(error);
        }
      });
    },
    notify(method, params) {
      writeFrame({ jsonrpc: '2.0', method, params });
    },
    stdoutFrames: () => frames,
    stderrText: () => stderr,
    async close() {
      child.stdin?.end();
      child.stderr?.resume();
      try {
        await waitForClose(closed, child, 3_000);
      } finally {
        await rm(isolatedHome, { recursive: true, force: true });
      }
      if (fatal !== undefined) throw fatal;
      if (spawnError !== undefined) throw spawnError;
      if (exit?.code !== 0) {
        throw new Error(
          `ACP child failed: code=${String(exit?.code)} signal=${String(exit?.signal)} stderr=${stderr}`,
        );
      }
    },
  };
}

async function waitForClose(
  closed: Promise<void>,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('ACP child close timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
