import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  doctorTransportConfig,
  runProgram,
  serverTransportConfig,
} from '../../src/program.js';
import type { BootstrapConfig } from '../../src/config.js';
import {
  BytedcliAimeTransport,
  type BytedcliAimeFacade,
} from '../../src/aime/bytedcli-transport.js';
import { ScriptedAimeTransport } from '../helpers/fake-aime.js';
import { fakeAuth } from '../helpers/fake-auth.js';
import { AIME_ACP_PACKAGE_VERSION } from '../../src/package-info.js';

const execFileAsync = promisify(execFile);

function config(
  argv: readonly string[],
  mode: BootstrapConfig['mode'],
): BootstrapConfig {
  return { argv, mode, site: 'cn', logLevel: 'info' };
}

function captureStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  stdin.end();
  return { stdin, stdout, stderr, stdoutText: () => output };
}

function dependencies() {
  const server = vi.fn(async () => 99);
  return {
    server,
    deps: {
      createAuth: vi.fn(async () => fakeAuth()),
      createDoctor: vi.fn(async () => ({
        guard: { assertStable: vi.fn(async () => undefined) },
        transport: new ScriptedAimeTransport(),
      })),
      startServer: server,
    },
  };
}

describe('operational CLI router', () => {
  it.each([
    ['help', ['--help'], 'help', /Usage: aime-acp/],
    [
      'version',
      ['--version'],
      'version',
      new RegExp(AIME_ACP_PACKAGE_VERSION.replaceAll('.', '\\.')),
    ],
  ] as const)(
    '%s bypasses ACP server construction',
    async (_name, argv, mode, expected) => {
      const streams = captureStreams();
      const { deps, server } = dependencies();

      await expect(runProgram(config(argv, mode), streams, deps)).resolves.toBe(
        0,
      );

      expect(streams.stdoutText()).toMatch(expected);
      expect(server).not.toHaveBeenCalled();
      expect(streams.stdoutText()).not.toContain('jsonrpc');
    },
  );

  it.each([
    [['auth', 'status', '--json'], 'auth'],
    [['doctor', '--json'], 'doctor'],
  ] as const)(
    'operational command %j bypasses ACP server construction',
    async (argv, mode) => {
      const streams = captureStreams();
      const { deps, server } = dependencies();

      await expect(runProgram(config(argv, mode), streams, deps)).resolves.toBe(
        0,
      );

      expect(JSON.parse(streams.stdoutText())).toMatchObject({
        schemaVersion: 1,
      });

      expect(server).not.toHaveBeenCalled();
    },
  );

  it('rejects argv resume tokens before invoking the auth provider', async () => {
    const streams = captureStreams();
    const { deps, server } = dependencies();

    await expect(
      runProgram(
        config(['auth', 'login', '--resume-token', 'secret', '--json'], 'auth'),
        streams,
        deps,
      ),
    ).resolves.toBe(1);

    expect(JSON.parse(streams.stdoutText())).toMatchObject({
      ok: false,
      command: 'auth.login',
      error: { code: 'AUTH_CONFIGURATION_UNSUPPORTED' },
    });
    expect(deps.createAuth).not.toHaveBeenCalled();
    expect(server).not.toHaveBeenCalled();
    expect(streams.stdoutText()).not.toContain('secret');
  });

  it('uses a transport list probe for doctor even with an explicit server space', async () => {
    const streams = captureStreams();
    const { deps } = dependencies();
    const input = {
      ...config(['doctor', '--space-id', 'server-space', '--json'], 'doctor'),
      spaceId: 'server-space',
    };
    const listSpaces = vi.fn(async () => ({
      spaces: [{ id: 'probed-space', type: 'personal', status: 'active' }],
    }));
    const facade = {
      auth: {
        getExternalBytecloudAuthStatus: vi.fn(),
        byteCloudAuthEnsureAuth: vi.fn(),
        byteCloudAuthUserInfo: vi.fn(),
        byteCloudAuthLogin: vi.fn(),
        byteCloudAuthBeginLogin: vi.fn(),
        byteCloudAuthCompleteLogin: vi.fn(),
      },
      utils: {
        setCloudSite: vi.fn(),
        setAuthAs: vi.fn(),
        setHttpConfig: vi.fn(),
      },
      api: {
        aime: {
          listSpaces,
          listModels: vi.fn(),
          createSession: vi.fn(),
          getSession: vi.fn(),
          sendMessage: vi.fn(),
          streamEvents: vi.fn(),
        },
      },
    } as unknown as BytedcliAimeFacade;
    const probe = new BytedcliAimeTransport(
      facade,
      { assertStable: vi.fn(async () => undefined) } as never,
      doctorTransportConfig(input),
    );
    const resolveSpace = vi.fn(() => probe.resolveSpace());
    deps.createDoctor.mockResolvedValue({
      guard: { assertStable: vi.fn(async () => undefined) },
      transport: {
        checkCompatibility: vi.fn(async () => undefined),
        resolveSpace,
      },
    } as never);
    await expect(runProgram(input, streams, deps)).resolves.toBe(0);

    expect(resolveSpace).toHaveBeenCalledOnce();
    expect(listSpaces).toHaveBeenCalledOnce();
    expect(doctorTransportConfig(input)).not.toHaveProperty('spaceId');
    expect(JSON.parse(streams.stdoutText())).not.toHaveProperty('spaceId');
  });

  it('preserves explicit space selection for ACP server transport configuration', () => {
    const input = {
      ...config(['--space-id', 'server-space'], 'server'),
      spaceId: 'server-space',
    };

    expect(serverTransportConfig(input)).toMatchObject({
      spaceId: 'server-space',
    });
  });

  it.each([
    [['--help'], 'help'],
    [['--version'], 'version'],
    [['auth', 'status', '--json'], 'auth'],
    [['doctor', '--json'], 'doctor'],
  ] as const)(
    'runs operational argv %j in a subprocess without ACP frames',
    async (argv, kind) => {
      await execFileAsync('npm', ['run', 'build'], { cwd: process.cwd() });
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          '--import',
          './test/contract/register-operational-loader.mjs',
          'dist/bin.js',
          ...argv,
        ],
        { cwd: process.cwd() },
      );

      if (kind === 'help') {
        expect(stdout).toBe(
          'Usage: aime-acp [--site cn|i18n-tt] [auth status|login|login begin|login --complete --resume-token-stdin|doctor]\nDoctor always probes an available AIME space; --space-id is server-only.\n',
        );
      } else if (kind === 'version') {
        expect(stdout).toBe(`${AIME_ACP_PACKAGE_VERSION}\n`);
      } else if (kind === 'auth') {
        expect(JSON.parse(stdout)).toEqual({
          schemaVersion: 1,
          ok: true,
          command: 'auth.status',
          site: 'cn',
          status: 'authenticated',
          authSource: 'bytecloud_auth',
          authType: 'user',
        });
      } else {
        const result = JSON.parse(stdout);
        expect(result).toEqual({
          schemaVersion: 1,
          ok: true,
          site: 'cn',
          packageVersion: AIME_ACP_PACKAGE_VERSION,
          bytedcliVersion: '0.123.0',
          acpSdkVersion: '0.28.1',
          compatible: true,
          authenticated: true,
          aimeReachable: true,
          spaceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      }
      if (kind === 'auth' || kind === 'doctor') {
        expect(stdout.trim().split('\n')).toHaveLength(1);
      }
      expect(stderr).toBe('');
      expect(stdout).not.toContain('jsonrpc');
      expect(`${stdout}${stderr}`).not.toContain('ACP_TOUCH_SENTINEL');
    },
  );

  it('uses a test loader whose ACP/session methods fail if operational routing touches them', async () => {
    const source = await readFile(
      new URL('./operational-loader.mjs', import.meta.url),
      'utf8',
    );

    expect(source).toContain('ACP_TOUCH_SENTINEL');
    expect(source).toMatch(/createSession/);
    expect(source).toMatch(/sendMessage/);
    expect(source).toMatch(/streamEvents/);
  });

  it.each([
    [[], 'server'],
    [['doctor'], 'doctor'],
    [['--help'], 'help'],
    [['--version'], 'version'],
    [['auth', 'status'], 'auth'],
  ] as const)(
    'rejects raw resume tokens in the %s subprocess mode',
    async (prefix, _mode) => {
      await execFileAsync('npm', ['run', 'build'], { cwd: process.cwd() });
      await expect(
        execFileAsync(
          process.execPath,
          [
            '--import',
            './test/contract/register-operational-loader.mjs',
            'dist/bin.js',
            ...prefix,
            '--resume-token',
            'secret',
          ],
          { cwd: process.cwd() },
        ),
      ).rejects.toMatchObject({
        stdout: '',
        stderr: expect.not.stringContaining('secret'),
      });
    },
  );

  it('rejects a stdin resume token hidden after -- in the built launcher', async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: process.cwd() });

    await expect(
      execFileAsync(
        process.execPath,
        [
          '--import',
          './test/contract/register-operational-loader.mjs',
          'dist/bin.js',
          'doctor',
          '--',
          '--resume-token-stdin',
        ],
        { cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({
      stdout: '',
      stderr: expect.not.stringContaining('ACP_TOUCH_SENTINEL'),
    });
  });
});
