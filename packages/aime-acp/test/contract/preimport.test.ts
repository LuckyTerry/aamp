import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const packageRoot = new URL('../../', import.meta.url);
const distBin = new URL('../../dist/bin.js', import.meta.url);
const loader = new URL('./preimport-loader.mjs', import.meta.url);

describe('pre-import bootstrap boundary', () => {
  beforeAll(async () => {
    await execFileAsync('npm', ['run', 'build'], {
      cwd: packageRoot,
      maxBuffer: 1024 * 1024,
    });
  });

  it('fails on forbidden environment before program or bytedcli can resolve', async () => {
    const marker = 'PREIMPORT_ENV_SENTINEL';
    const result = (await execFileAsync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-loader',
        loader.pathname,
        distBin.pathname,
      ],
      {
        env: {
          BYTEDCLI_AIME_API_BASE_URL: marker,
        },
        maxBuffer: 1024 * 1024,
      },
    ).catch((error: unknown) => error)) as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };

    expect(result.code).toBe(1);
    expect(result.stdout ?? '').toBe('');
    expect(result.stderr ?? '').toContain('AUTH_CONFIGURATION_UNSUPPORTED');
    expect(result.stderr ?? '').not.toContain(marker);
    expect(result.stderr ?? '').not.toContain(
      'TEST_FORBIDDEN_PREIMPORT_RESOLUTION',
    );
  });
});
