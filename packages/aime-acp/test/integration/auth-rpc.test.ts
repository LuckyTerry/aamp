import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getCleanInstallFixture, runInstalled } from './package-fixture.js';
import { parseJsonLines } from './process.js';

const nativeMatrix = [
  ['darwin', 'arm64', 'darwin-arm64'],
  ['darwin', 'x64', 'darwin-amd64'],
  ['linux', 'arm64', 'linux-arm64'],
  ['linux', 'x64', 'linux-amd64'],
] as const;

function nativeAuthPackage(platform: string, architecture: string): string {
  const target = nativeMatrix.find(
    ([candidatePlatform, candidateArchitecture]) =>
      platform === candidatePlatform && architecture === candidateArchitecture,
  )?.[2];
  if (target === undefined)
    throw new Error(
      `unsupported native auth runner: ${platform}-${architecture}`,
    );
  return `@bytedance-dev/bytecloud-auth-rpc-${target}`;
}

describe('native auth RPC package', () => {
  it.each(nativeMatrix)(
    'maps the %s-%s runner to the %s package without relabelling evidence',
    (platform, architecture, suffix) => {
      expect(nativeAuthPackage(platform, architecture)).toBe(
        `@bytedance-dev/bytecloud-auth-rpc-${suffix}`,
      );
    },
  );

  it('loads exactly the current runner package and reports isolated unauthenticated status', {
    timeout: 300_000,
  }, async () => {
    const fixture = await getCleanInstallFixture();
    const expected = nativeAuthPackage(process.platform, process.arch);
    const expectedPackageJson = join(
      fixture.installRoot,
      'node_modules',
      ...expected.split('/'),
      'package.json',
    );

    expect(fixture.packageRequire.resolve(`${expected}/path`)).toBeTruthy();
    expect(fixture.packageRequire.resolve(expectedPackageJson)).toBe(
      await realpath(expectedPackageJson),
    );
    const nativeMetadata = JSON.parse(
      await readFile(expectedPackageJson, 'utf8'),
    ) as Readonly<Record<string, unknown>>;
    expect(nativeMetadata.name).toBe(expected);
    expect(nativeMetadata.version).toBe('0.0.23');

    const scopedEntries = await readdir(
      join(fixture.installRoot, 'node_modules', '@bytedance-dev'),
    );
    expect(
      scopedEntries
        .filter((entry) => entry.startsWith('bytecloud-auth-rpc-'))
        .sort(),
    ).toEqual([expected.split('/')[1]]);

    const status = await runInstalled(
      fixture,
      ['auth', 'status', '--site', 'cn', '--json'],
      { label: 'native-auth-status', timeoutMs: 60_000 },
    );
    expect(status.code).toBe(1);
    expect(status.signal).toBeNull();
    expect(status.env.HOME).not.toBe(homedir());
    expect(status.env.USERPROFILE).toBe(status.env.HOME);
    expect(status.env.PATH).toBe(fixture.emptyPath);
    expect(parseJsonLines(status.stdout)).toEqual([
      {
        schemaVersion: 1,
        ok: true,
        command: 'auth.status',
        site: 'cn',
        status: 'unauthenticated',
      },
    ]);
    expect(`${status.stdout}\n${status.stderr}`).not.toMatch(
      /MODULE_NOT_FOUND|Cannot find module|bad CPU type|wrong architecture|exec format|bytecloud-auth-rpc .*(?:spawn|exited|timed out)/i,
    );
  });
});
