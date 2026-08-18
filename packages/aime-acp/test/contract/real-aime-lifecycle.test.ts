import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createEphemeralEvidenceLog } from '../smoke/real-aime-guards.mjs';

const smokeRoot = dirname(
  fileURLToPath(new URL('../smoke/real-aime.mjs', import.meta.url)),
);

function processExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('real AIME ACP child lifecycle', () => {
  it('waits for malformed-child close and late stderr before evidence deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'real-aime-lifecycle-'));
    const rawLog = await createEphemeralEvidenceLog(root);
    let child: ChildProcess | undefined;
    let holderPid: number | undefined;
    try {
      const module = await import('../smoke/real-aime.mjs');
      expect(typeof module.startAcp).toBe('function');
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const client = await module.startAcp(
        'cn',
        { LANG: 'C.UTF-8', PATH: process.env.PATH },
        root,
        {
          file: process.execPath,
          args: [join(smokeRoot, 'fixtures/malformed-acp-child.mjs')],
          requestTimeoutMs: 2_000,
          closeTimeoutMs: 500,
          terminateTimeoutMs: 500,
          onChild(spawned) {
            child = spawned;
            spawned.once('exit', () => resolveExit());
          },
        },
      );

      await expect(client.request('smoke/malformed', {})).rejects.toThrow(
        'SMOKE_FAILED',
      );
      await exited;

      let closeSettled = false;
      const closing = client.close().finally(() => {
        closeSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(closeSettled).toBe(false);
      await expect(stat(rawLog.path)).resolves.toBeDefined();
      await closing;

      const evidence = client.evidence();
      expect(evidence.stderr).toContain('LATE_STDERR_AFTER_TERM');
      holderPid = Number(evidence.stderr.match(/HOLDER_PID=(\d+)/)?.[1]);
      expect(Number.isSafeInteger(holderPid)).toBe(true);
      expect(processExists(child?.pid)).toBe(false);
      expect(processExists(holderPid)).toBe(false);

      await rawLog.append(evidence);
      await expect(rawLog.readAndScan([])).resolves.toContain(
        'LATE_STDERR_AFTER_TERM',
      );
      await rawLog.closeAndDelete();
      await expect(stat(rawLog.path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (processExists(child?.pid)) child?.kill('SIGKILL');
      if (processExists(holderPid))
        process.kill(holderPid as number, 'SIGKILL');
      await rawLog.closeAndDelete().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('routes child stdin EPIPE through bounded fatal termination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'real-aime-stdin-error-'));
    let child: ChildProcess | undefined;
    try {
      const { startAcp } = await import('../smoke/real-aime.mjs');
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const client = await startAcp(
        'cn',
        { LANG: 'C.UTF-8', PATH: process.env.PATH },
        root,
        {
          file: process.execPath,
          args: [join(smokeRoot, 'fixtures/stdin-error-acp-child.mjs')],
          requestTimeoutMs: 2_000,
          closeTimeoutMs: 500,
          terminateTimeoutMs: 500,
          onChild(spawned) {
            child = spawned;
            spawned.once('exit', () => resolveExit());
          },
        },
      );
      await exited;
      const startedAt = Date.now();
      await expect(client.request('smoke/epipe', {})).rejects.toThrow(
        'SMOKE_FAILED',
      );
      expect(Date.now() - startedAt).toBeLessThan(250);
      await client.close();
      expect(client.evidence().stderr).toContain('STDIN_ERROR_TERMINATED');
      expect(processExists(child?.pid)).toBe(false);
    } finally {
      if (processExists(child?.pid)) child?.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });
});
