import type { ChildProcess } from 'node:child_process';

export interface SmokeAcpClient {
  readonly frames: readonly unknown[];
  evidence(): {
    readonly kind: string;
    readonly frames: readonly unknown[];
    readonly stderr: string;
  };
  request(
    method: string,
    params: unknown,
    options?: { readonly onUpdate?: (update: unknown) => void },
  ): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
}

export interface StartAcpRuntime {
  readonly file?: string;
  readonly args?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly terminateTimeoutMs?: number;
  readonly onChild?: (child: ChildProcess) => void;
}

export function startAcp(
  site: 'cn' | 'i18n-tt',
  env: NodeJS.ProcessEnv,
  cwd: string,
  runtime?: StartAcpRuntime,
): Promise<SmokeAcpClient>;
