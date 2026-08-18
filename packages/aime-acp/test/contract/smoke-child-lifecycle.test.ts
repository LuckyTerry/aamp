import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const smokeRoot = dirname(
  fileURLToPath(new URL('../smoke/child-lifecycle.mjs', import.meta.url)),
);

async function lifecycle() {
  return import('../smoke/child-lifecycle.mjs').catch(() => undefined);
}

describe('smoke child lifecycle', () => {
  it('waits for close after TERM then escalates to KILL before rejecting', async () => {
    const module = await lifecycle();
    expect(typeof module?.runBoundedProcess).toBe('function');
    let closed = false;
    let signal: NodeJS.Signals | null = null;
    const result = module?.runBoundedProcess?.(
      process.execPath,
      [join(smokeRoot, 'fixtures/stubborn-child.mjs')],
      {
        cwd: smokeRoot,
        env: { LANG: 'C.UTF-8', PATH: process.env.PATH },
        timeoutMs: 1_000,
        terminateTimeoutMs: 100,
        onChild(child: import('node:child_process').ChildProcess) {
          child.once('close', (_code, closeSignal) => {
            closed = true;
            signal = closeSignal;
          });
        },
      },
    );
    await expect(result).rejects.toMatchObject({
      name: 'ChildTimeoutError',
      stdout: expect.stringContaining('TERM_OBSERVED'),
    });
    expect(closed).toBe(true);
    expect(signal).toBe('SIGKILL');
  });

  it('runs cleanup even when successful close output is malformed', async () => {
    const module = await lifecycle();
    expect(typeof module?.validateCloseThenCleanup).toBe('function');
    const cleanup = vi.fn(async () => undefined);
    await expect(
      module?.validateCloseThenCleanup?.(
        { code: 0, signal: null, stdout: 'not-json\n', stderr: '' },
        cleanup,
      ),
    ).rejects.toThrow('strict clean JSON');
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
