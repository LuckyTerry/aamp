import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface BoundedProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BoundedProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: SpawnOptions['stdio'];
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly terminateTimeoutMs?: number;
  readonly outputLimit?: number;
  readonly onChild?: (child: ChildProcess) => void;
}

export class ChildTimeoutError extends Error {
  readonly stdout: string;
  readonly stderr: string;
}

export function runBoundedProcess(
  file: string,
  args: readonly string[],
  options?: BoundedProcessOptions,
): Promise<BoundedProcessResult>;

export function terminateChild(
  child: ChildProcess,
  closed: Promise<unknown>,
  terminateTimeoutMs: number,
): Promise<unknown>;

export function validateCloseThenCleanup(
  result: BoundedProcessResult | undefined,
  cleanup: () => Promise<void>,
): Promise<void>;
