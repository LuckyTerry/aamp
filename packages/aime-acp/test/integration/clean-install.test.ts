import { readFile, readdir } from 'node:fs/promises';

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

import { describe, expect, it } from 'vitest';

import {
  getCleanInstallFixture,
  installedEntries,
  installedJson,
  runInstalled,
} from './package-fixture.js';
import { parseJsonLines, requireSuccess } from './process.js';

const packageJson = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  readonly version: string;
  readonly scripts?: Readonly<Record<string, string>>;
};

describe('clean installed package', () => {
  it('keeps network-backed integration tests outside recursive prepack checks', () => {
    expect(packageJson.scripts?.test).toContain(
      "--exclude 'test/integration/**'",
    );
    expect(packageJson.scripts?.['test:integration']).toContain(
      'test/integration',
    );
    expect(packageJson.scripts?.['verify:package']).toContain(
      'test/integration/clean-install.test.ts',
    );
  });

  it('ships truthful package documentation and the evidence-gated concurrency limit', async () => {
    const [readme, license] = await Promise.all([
      readFile(new URL('../../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../../LICENSE', import.meta.url), 'utf8'),
    ]);

    expect(readme).toContain(
      'one active `aime-acp` ACP process per OS user and site; stop it before login/logout/account changes.',
    );
    expect(readme).toContain('remote AIME agent');
    expect(readme).toContain("does not access the caller's local workspace");
    expect(license).toContain('All rights reserved.');
  });

  it('packs the actual package, installs it from BNPM, and runs without a global bytedcli', {
    timeout: 300_000,
  }, async () => {
    const fixture = await getCleanInstallFixture();
    const installedPackage = await installedJson(fixture, 'aime-acp');
    const installedBytedcli = await installedJson(
      fixture,
      '@bytedance-dev/bytedcli',
    );
    const installedAcpSdk = await installedJson(
      fixture,
      '@agentclientprotocol/sdk',
    );

    expect(installedPackage.version).toBe(packageJson.version);
    expect([...(await installedEntries(fixture))].sort()).toEqual([
      'LICENSE',
      'README.md',
      'dist',
      'package.json',
    ]);
    expect(installedBytedcli.version).toBe('0.123.0');
    expect(installedAcpSdk.version).toBe('0.28.1');

    const topLevelPackFiles = [
      ...new Set(fixture.packFiles.map((path) => path.split('/')[0])),
    ].sort();
    expect(topLevelPackFiles).toEqual([
      'LICENSE',
      'README.md',
      'dist',
      'package.json',
    ]);
    expect([...fixture.dryRunFiles].sort()).toEqual(
      [...fixture.packFiles].sort(),
    );
    for (const path of fixture.dryRunFiles) {
      expect(path).not.toMatch(
        /(^|\/)(?:src|test|fixtures?|credentials?|\.env|\.npmrc|package-lock\.json)(?:\/|$)/i,
      );
      expect(path.toLowerCase()).not.toContain('togo');
    }

    expect(await readdir(fixture.emptyPath)).toEqual([]);
    const help = await runInstalled(fixture, ['--help'], { label: 'help' });
    requireSuccess(help, 'installed help');
    expect(help.file).toBe(process.execPath);
    expect(help.stdout).toContain('Usage: aime-acp');

    const fakeScenario = {
      auth: {
        authenticated: true,
        identity: { field: 'employeeId', value: 'package-proof-user' },
      },
      space: { id: 'package-proof-space' },
      sessions: {},
      prompts: [],
    };
    const status = await runInstalled(fixture, ['auth', 'status', '--json'], {
      label: 'fake-status',
      fakeScenario,
    });
    requireSuccess(status, 'installed fake auth status');
    expect(parseJsonLines(status.stdout)).toEqual([
      {
        schemaVersion: 1,
        ok: true,
        command: 'auth.status',
        site: 'cn',
        status: 'authenticated',
        authSource: 'bytecloud_auth',
        authType: 'user',
        expiresAt: '2035-01-02T03:04:05.000Z',
      },
    ]);

    const doctor = await runInstalled(fixture, ['doctor', '--json'], {
      label: 'fake-doctor',
      fakeScenario,
    });
    requireSuccess(doctor, 'installed fake doctor');
    expect(parseJsonLines(doctor.stdout)).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        ok: true,
        packageVersion: packageJson.version,
        bytedcliVersion: '0.123.0',
        acpSdkVersion: '0.28.1',
        compatible: true,
        authenticated: true,
        aimeReachable: true,
      }),
    ]);

    const initialize = await runInstalled(fixture, [], {
      label: 'fake-acp-initialize',
      fakeScenario,
      stdin: `${JSON.stringify({
        jsonrpc: '2.0',
        id: 41,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        },
      })}\n`,
    });
    requireSuccess(initialize, 'installed ACP initialize');
    expect(parseJsonLines(initialize.stdout)).toEqual([
      {
        jsonrpc: '2.0',
        id: 41,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {},
          },
          agentInfo: { name: 'aime-acp', version: packageJson.version },
        },
      },
    ]);
  });
});
