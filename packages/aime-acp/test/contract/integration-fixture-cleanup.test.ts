import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { runProcess } from '../integration/process.js';

const packageRoot = dirname(
  fileURLToPath(new URL('../../package.json', import.meta.url)),
);
const vitestBin = resolve(packageRoot, 'node_modules/vitest/vitest.mjs');
const fakeNpm = resolve(
  packageRoot,
  'test/integration/fixtures/fake-package-npm.mjs',
);

interface ProbeState {
  readonly runRoot: string | null;
  readonly fixtureRoot: string;
}

async function runCleanupProbe(
  controlRoot: string,
  outcome: 'success' | 'failure',
): Promise<{ readonly code: number | null; readonly state: ProbeState }> {
  const statePath = join(controlRoot, `${outcome}.json`);
  const controlledHome = join(controlRoot, `${outcome}-home`);
  const controlledTmp = join(controlRoot, `${outcome}-tmp`);
  await Promise.all([
    mkdir(controlledHome, { recursive: true }),
    mkdir(controlledTmp, { recursive: true }),
  ]);
  const result = await runProcess(
    process.execPath,
    [
      vitestBin,
      'run',
      '--config',
      'test/integration/fixtures/package-cleanup-probe.vitest.config.ts',
      '--no-file-parallelism',
      '--maxWorkers=1',
      '--no-isolate',
    ],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        HOME: controlledHome,
        USERPROFILE: controlledHome,
        TMPDIR: controlledTmp,
        npm_execpath: fakeNpm,
        npm_lifecycle_event: 'test:integration',
        AIME_ACP_CLEANUP_PROBE_STATE: statePath,
        ...(outcome === 'failure' ? { AIME_ACP_CLEANUP_PROBE_FAIL: '1' } : {}),
      },
      timeoutMs: 20_000,
    },
  );
  const state = JSON.parse(await readFile(statePath, 'utf8')) as ProbeState;
  return { code: result.code, state };
}

it('removes the owned integration run after passing and failing worker tests', {
  timeout: 30_000,
}, async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), 'aime-acp-integration-cleanup-contract-'),
  );
  const sentinel = join(controlRoot, '.owned-cleanup-contract');
  await writeFile(sentinel, 'owned\n', { mode: 0o600 });
  try {
    const success = await runCleanupProbe(controlRoot, 'success');
    expect(success.code).toBe(0);
    expect(success.state.runRoot).toEqual(expect.any(String));
    expect(
      success.state.fixtureRoot.startsWith(`${success.state.runRoot}/`),
    ).toBe(true);
    expect(existsSync(success.state.fixtureRoot)).toBe(false);
    expect(existsSync(success.state.runRoot as string)).toBe(false);

    const failure = await runCleanupProbe(controlRoot, 'failure');
    expect(failure.code).not.toBe(0);
    expect(failure.state.runRoot).toEqual(expect.any(String));
    expect(
      failure.state.fixtureRoot.startsWith(`${failure.state.runRoot}/`),
    ).toBe(true);
    expect(existsSync(failure.state.fixtureRoot)).toBe(false);
    expect(existsSync(failure.state.runRoot as string)).toBe(false);
  } finally {
    expect(await readFile(sentinel, 'utf8')).toBe('owned\n');
    await rm(controlRoot, { recursive: true, force: true });
  }
});
