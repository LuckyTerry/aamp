import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';

export interface ProcessResult {
  readonly file: string;
  readonly argv: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly fd3?: string;
  readonly timeoutMs?: number;
}

const outputLimit = 16 * 1024 * 1024;

export async function runProcess(
  file: string,
  argv: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...argv], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (error?: Error, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
    };
    const append = (current: string, chunk: Buffer): string => {
      if (settled) return current;
      const next = current + chunk.toString('utf8');
      if (next.length > outputLimit) {
        child.kill('SIGTERM');
        finish(new Error('subprocess output exceeded the safety limit'));
        return current;
      }
      return next;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      finish(undefined, {
        file,
        argv: [...argv],
        env: { ...options.env },
        code,
        signal,
        stdout,
        stderr,
      });
    });

    child.stdin.end(options.stdin ?? '');
    const scenarioPipe = child.stdio[3];
    if (
      scenarioPipe === undefined ||
      scenarioPipe === null ||
      typeof scenarioPipe === 'number'
    ) {
      child.kill('SIGTERM');
      finish(new Error('subprocess FD 3 is unavailable'));
      return;
    }
    (scenarioPipe as Writable).end(options.fd3 ?? '');
  });
}

export function requireSuccess(result: ProcessResult, label: string): void {
  if (result.code === 0 && result.signal === null) return;
  const diagnostic = `${result.stdout}\n${result.stderr}`.slice(-8_192);
  throw new Error(
    `${label} failed: code=${String(result.code)} signal=${String(result.signal)}\n${diagnostic}`,
  );
}

export function parseJsonLines(stdout: string): readonly unknown[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    if (line === '') return [];
    return [JSON.parse(line) as unknown];
  });
}
