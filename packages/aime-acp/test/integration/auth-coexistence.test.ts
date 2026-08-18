import { randomBytes } from 'node:crypto';
import { chmod, realpath } from 'node:fs/promises';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  getCleanInstallFixture,
  isolatedRuntime,
  type PackageFixture,
} from './package-fixture.js';
import { parseJsonLines, type ProcessResult, runProcess } from './process.js';

const sharedLoader = fileURLToPath(
  new URL('./shared-auth-loader.mjs', import.meta.url),
);
const controlledSmoke = fileURLToPath(
  new URL('../smoke/auth-coexistence.mjs', import.meta.url),
);
const smokeLifecycleHarness = fileURLToPath(
  new URL('./smoke-lifecycle-harness.mjs', import.meta.url),
);
const smokeFlowHarness = fileURLToPath(
  new URL('./smoke-flow-harness.mjs', import.meta.url),
);
const packageVersion = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
).version as string;

async function runSharedAuth(
  fixture: PackageFixture,
  environment: NodeJS.ProcessEnv,
  storePath: string,
  argv: readonly string[],
  stdin?: string,
): Promise<ProcessResult> {
  return runProcess(
    process.execPath,
    ['--experimental-loader', sharedLoader, fixture.installedBin, ...argv],
    {
      cwd: environment.HOME ?? fixture.root,
      env: environment,
      ...(stdin === undefined ? {} : { stdin }),
      fd3: JSON.stringify({ storePath }),
      timeoutMs: 30_000,
    },
  );
}

async function regularFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files;
}

function onlyJson(result: ProcessResult): Readonly<Record<string, unknown>> {
  const frames = parseJsonLines(result.stdout);
  expect(frames).toHaveLength(1);
  const frame = frames[0];
  expect(frame).toEqual(expect.any(Object));
  return frame as Readonly<Record<string, unknown>>;
}

describe('cross-process auth handoff', () => {
  it('keeps credentialed coexistence gates executable instead of returning placeholder outcomes', async () => {
    const source = await readFile(controlledSmoke, 'utf8');

    expect(source).toContain('startLiveAcp');
    expect(source).toContain('expectAcpError');
    expect(source).toContain("'AUTH_REQUIRED'");
    expect(source).toContain("'AUTH_IDENTITY_CHANGED'");
    expect(source).toContain('Promise.all([');
    expect(source).toContain("stdio: ['pipe', 'pipe', 'pipe']");
    expect(source).toContain('bytedcliModuleUrl(packageDirectory)');
    expect(source).toContain('pathToFileURL(');
    expect(source).toContain('LOGOUT COMPLETE');
    expect(source).toContain('ACCOUNT SWITCH COMPLETE');
    expect(source).toContain('acknowledgeExternalMutation');
    expect(source).not.toContain('byteCloudAuthLogout()');
    expect(source).toContain('const createdHomes = [];');
    expect(source).not.toContain('createdHomes.push(testHome)');
    expect(source).toContain(
      'removeHome(path, { recursive: true, force: true })',
    );
    expect(source.match(/await startAcp\(/g)).toHaveLength(1);
    const logout = source.indexOf("'LOGOUT COMPLETE'");
    const accountSwitch = source.indexOf("'ACCOUNT SWITCH COMPLETE'");
    expect(logout).toBeGreaterThan(-1);
    expect(accountSwitch).toBeGreaterThan(logout);
    expect(source.slice(logout, accountSwitch)).not.toContain(
      'await liveAcp.stop()',
    );
    expect(source).toContain('closeTimeoutMs');
    expect(source).toContain("child.kill('SIGKILL')");
    expect(source).not.toContain(
      "throw safeFailure('AUTH_IDENTITY_CHANGED');\n}",
    );
  });

  it('refuses ordinary, noninteractive, and real-home execution before authentication', {
    timeout: 300_000,
  }, async () => {
    await chmod(controlledSmoke, 0o755);
    const fixture = await getCleanInstallFixture();
    const runtime = await isolatedRuntime(fixture, 'controlled-smoke');
    await writeFile(
      join(runtime.home, '.aime-acp-real-auth-smoke-home'),
      'purpose-built isolated smoke home\n',
      { mode: 0o600 },
    );
    const smokeEnvironment = {
      ...runtime.env,
      HOME: process.env.HOME,
      USERPROFILE: process.env.HOME,
    };
    const ordinary = await runProcess(process.execPath, [controlledSmoke], {
      cwd: runtime.home,
      env: smokeEnvironment,
    });
    expect(ordinary.code).toBe(1);
    expect(parseJsonLines(ordinary.stdout)).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        ok: false,
        site: 'cn',
        packageVersion,
        bytedcliVersion: '0.123.0',
        timingMs: expect.any(Number),
        errorCode: 'INVALID_ARGUMENT',
      }),
    ]);
    expect(ordinary.stderr).toBe('');

    const noninteractive = await runProcess(
      process.execPath,
      [
        controlledSmoke,
        '--test-home',
        runtime.home,
        '--site',
        'cn',
        '--approve-real-auth-smoke',
      ],
      { cwd: runtime.home, env: smokeEnvironment },
    );
    expect(noninteractive.code).toBe(1);
    expect(parseJsonLines(noninteractive.stdout)).toEqual([
      expect.objectContaining({
        ok: false,
        errorCode: 'APPROVAL_REQUIRED',
      }),
    ]);
    expect(noninteractive.stderr).toBe('');
    expect(
      await readFile(
        join(runtime.home, '.aime-acp-real-auth-smoke-home'),
        'utf8',
      ),
    ).toBe('purpose-built isolated smoke home\n');

    const rootCwd = await runProcess(process.execPath, [controlledSmoke], {
      cwd: '/',
      env: smokeEnvironment,
    });
    expect(rootCwd.code).toBe(1);
    expect(parseJsonLines(rootCwd.stdout)).toEqual([
      expect.objectContaining({ errorCode: 'INVALID_ARGUMENT' }),
    ]);

    const osHome = await realpath(userInfo().homedir);
    const overriddenEnvironment = {
      ...runtime.env,
      HOME: runtime.home,
      USERPROFILE: runtime.home,
    };
    const osHomeAttempt = await runProcess(
      process.execPath,
      [
        controlledSmoke,
        '--test-home',
        osHome,
        '--site',
        'cn',
        '--approve-real-auth-smoke',
      ],
      { cwd: runtime.home, env: overriddenEnvironment },
    );
    expect(osHomeAttempt.code).toBe(1);
    expect(parseJsonLines(osHomeAttempt.stdout)).toEqual([
      expect.objectContaining({ errorCode: 'REAL_HOME_REFUSED' }),
    ]);

    const installedModuleUrl = pathToFileURL(
      join(
        fixture.installRoot,
        'node_modules',
        '@bytedance-dev',
        'bytedcli',
        'dist',
        'index.js',
      ),
    ).href;
    const exactImport = await runProcess(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const value = await import(${JSON.stringify(installedModuleUrl)}); process.stdout.write(JSON.stringify({ ok: typeof value.auth?.byteCloudAuthEnsureAuth === 'function' }) + '\\n')`,
      ],
      { cwd: '/', env: runtime.env },
    );
    expect(exactImport.code).toBe(0);
    expect(parseJsonLines(exactImport.stdout)).toEqual([{ ok: true }]);
  });

  it('cleans up a live child when ACP initialize fails', {
    timeout: 300_000,
  }, async () => {
    const fixture = await getCleanInstallFixture();
    const runtime = await isolatedRuntime(fixture, 'smoke-init-failure');
    const marker = join(runtime.home, 'terminated.marker');
    const fakeBin = join(runtime.home, 'init-error.mjs');
    await writeFile(
      fakeBin,
      `
        import { writeFileSync } from 'node:fs';
        let buffer = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
          buffer += chunk;
          const newline = buffer.indexOf('\\n');
          if (newline === -1) return;
          const request = JSON.parse(buffer.slice(0, newline));
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'synthetic' } }) + '\\n');
        });
        process.on('SIGTERM', () => {
          writeFileSync(${JSON.stringify(marker)}, 'terminated\\n');
          process.exit(0);
        });
        setInterval(() => {}, 1000);
      `,
      { mode: 0o700 },
    );
    const result = await runProcess(
      process.execPath,
      [smokeLifecycleHarness, 'init-failure', fakeBin, marker],
      { cwd: '/', env: runtime.env, timeoutMs: 5_000 },
    );
    expect(result.code).toBe(0);
    expect(parseJsonLines(result.stdout)).toEqual([{ ok: true }]);
    expect(await readFile(marker, 'utf8')).toBe('terminated\n');
  });

  it('bounds live ACP stop and uses a kill fallback', {
    timeout: 300_000,
  }, async () => {
    const fixture = await getCleanInstallFixture();
    const runtime = await isolatedRuntime(fixture, 'smoke-bounded-stop');
    const fakeBin = join(runtime.home, 'ignore-stop.mjs');
    await writeFile(
      fakeBin,
      `
        let buffer = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
          buffer += chunk;
          const newline = buffer.indexOf('\\n');
          if (newline === -1) return;
          const request = JSON.parse(buffer.slice(0, newline));
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0' } } }) + '\\n');
        });
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
      `,
      { mode: 0o700 },
    );
    const result = await runProcess(
      process.execPath,
      [smokeLifecycleHarness, 'bounded-stop', fakeBin],
      { cwd: '/', env: runtime.env, timeoutMs: 5_000 },
    );
    expect(result.code).toBe(0);
    expect(parseJsonLines(result.stdout)).toEqual([
      { ok: true, bounded: true },
    ]);
  });

  it('keeps one live ACP across both witnessed mutations and cleans homes in order', {
    timeout: 300_000,
  }, async () => {
    const fixture = await getCleanInstallFixture();
    const runtime = await isolatedRuntime(fixture, 'smoke-flow-success');
    const result = await runProcess(
      process.execPath,
      [smokeFlowHarness, 'success', runtime.home],
      { cwd: '/', env: runtime.env, timeoutMs: 10_000 },
    );

    expect(result.code).toBe(0);
    expect(parseJsonLines(result.stdout)).toEqual([
      {
        ok: true,
        suppliedHomePreserved: true,
        siblingRemoved: true,
        events: [
          'run:login',
          'run:status',
          'start:live-child',
          'request:live-child:baseline',
          'run:probe',
          'run:probe',
          'prompt:logout',
          'request:live-child:auth-required',
          'prompt:switch',
          'request:live-child:identity-changed',
          'stop:live-child',
          'make:sibling',
          'run:bytedcli-login',
          'run:doctor',
          'cleanup-prompt:sibling',
          'cleanup-status:sibling',
          'cleanup-prompt:primary',
          'cleanup-status:primary',
          'remove:sibling',
        ],
      },
    ]);
  });

  it('does not delete a sibling whose external logout cannot be verified', {
    timeout: 300_000,
  }, async () => {
    const fixture = await getCleanInstallFixture();
    const runtime = await isolatedRuntime(
      fixture,
      'smoke-flow-cleanup-failure',
    );
    const result = await runProcess(
      process.execPath,
      [smokeFlowHarness, 'cleanup-status-failure', runtime.home],
      { cwd: '/', env: runtime.env, timeoutMs: 10_000 },
    );

    expect(result.code).toBe(0);
    expect(parseJsonLines(result.stdout)).toEqual([
      expect.objectContaining({
        ok: false,
        errorCode: 'AUTH_REQUIRED',
        suppliedHomePreserved: true,
        siblingRemoved: false,
        events: expect.arrayContaining([
          'cleanup-prompt:sibling',
          'cleanup-status:sibling',
          'cleanup-prompt:primary',
          'cleanup-status:primary',
        ]),
      }),
    ]);
    const events = onlyJson(result).events as readonly string[];
    expect(events.indexOf('cleanup-prompt:sibling')).toBeLessThan(
      events.indexOf('cleanup-status:sibling'),
    );
    expect(events).not.toContain('remove:sibling');
  });

  it('preserves a primary failure when verified cleanup also fails', {
    timeout: 300_000,
  }, async () => {
    const fixture = await getCleanInstallFixture();
    const runtime = await isolatedRuntime(
      fixture,
      'smoke-flow-primary-failure',
    );
    const result = await runProcess(
      process.execPath,
      [smokeFlowHarness, 'primary-and-cleanup-failure', runtime.home],
      { cwd: '/', env: runtime.env, timeoutMs: 10_000 },
    );

    expect(result.code).toBe(0);
    expect(parseJsonLines(result.stdout)).toEqual([
      {
        ok: false,
        errorCode: 'AUTH_IDENTITY_CHANGED',
        suppliedHomePreserved: true,
        siblingRemoved: true,
        events: [
          'run:login',
          'run:status',
          'start:failure',
          'cleanup-prompt:primary',
          'cleanup-status:primary',
        ],
      },
    ]);
  });

  it('verifies cleanup when the primary login attempt fails', {
    timeout: 300_000,
  }, async () => {
    const fixture = await getCleanInstallFixture();
    const runtime = await isolatedRuntime(
      fixture,
      'smoke-flow-primary-login-failure',
    );
    const result = await runProcess(
      process.execPath,
      [smokeFlowHarness, 'primary-login-failure', runtime.home],
      { cwd: '/', env: runtime.env, timeoutMs: 10_000 },
    );

    expect(result.code).toBe(0);
    expect(parseJsonLines(result.stdout)).toEqual([
      {
        ok: false,
        errorCode: 'AUTH_REQUIRED',
        suppliedHomePreserved: true,
        siblingRemoved: true,
        events: [
          'run:login',
          'cleanup-prompt:primary',
          'cleanup-status:primary',
        ],
      },
    ]);
  });

  it('verifies a sibling login attempt before deleting its home', {
    timeout: 300_000,
  }, async () => {
    const fixture = await getCleanInstallFixture();
    const runtime = await isolatedRuntime(
      fixture,
      'smoke-flow-sibling-login-failure',
    );
    const result = await runProcess(
      process.execPath,
      [smokeFlowHarness, 'sibling-login-failure', runtime.home],
      { cwd: '/', env: runtime.env, timeoutMs: 10_000 },
    );

    expect(result.code).toBe(0);
    const frame = onlyJson(result);
    expect(frame).toMatchObject({
      ok: false,
      errorCode: 'AUTH_REQUIRED',
      suppliedHomePreserved: true,
      siblingRemoved: true,
    });
    const events = frame.events as readonly string[];
    expect(events.slice(-5)).toEqual([
      'cleanup-prompt:sibling',
      'cleanup-status:sibling',
      'cleanup-prompt:primary',
      'cleanup-status:primary',
      'remove:sibling',
    ]);
  });

  it.each([
    ['success', 0, 0, 'authenticated'],
    ['pending', 2, 1, 'unauthenticated'],
    ['expired', 1, 1, 'unauthenticated'],
    ['denied', 1, 1, 'unauthenticated'],
  ] as const)(
    'passes an opaque %s resume token only through stdin',
    { timeout: 300_000 },
    async (outcome, completeCode, statusCode, expectedStatus) => {
      const fixture = await getCleanInstallFixture();
      const runtime = await isolatedRuntime(fixture, `shared-auth-${outcome}`);
      const storePath = join(
        fixture.root,
        `fake-bytedcli-${outcome}-${randomBytes(8).toString('hex')}.json`,
      );
      await writeFile(
        storePath,
        `${JSON.stringify({ outcome, authenticated: false })}\n`,
        { mode: 0o600 },
      );

      const begin = await runSharedAuth(fixture, runtime.env, storePath, [
        'auth',
        'login',
        '--begin',
        '--json',
      ]);
      expect(begin.code).toBe(0);
      const beginJson = onlyJson(begin);
      expect(beginJson).toMatchObject({
        schemaVersion: 1,
        ok: true,
        command: 'auth.login.begin',
        site: 'cn',
        status: 'pending',
      });
      const resumeToken = beginJson.resumeToken;
      expect(resumeToken).toEqual(expect.any(String));
      expect((resumeToken as string).length).toBeGreaterThan(32);

      const complete = await runSharedAuth(
        fixture,
        runtime.env,
        storePath,
        ['auth', 'login', '--complete', '--resume-token-stdin', '--json'],
        `${String(resumeToken)}\n`,
      );
      expect(complete.code).toBe(completeCode);
      const completeJson = onlyJson(complete);
      if (outcome === 'success') {
        expect(completeJson).toMatchObject({
          schemaVersion: 1,
          ok: true,
          command: 'auth.login.complete',
          status: 'authenticated',
        });
      } else if (outcome === 'pending') {
        expect(completeJson).toMatchObject({
          schemaVersion: 1,
          ok: true,
          command: 'auth.login.complete',
          status: 'pending',
        });
      } else {
        expect(completeJson).toMatchObject({
          schemaVersion: 1,
          ok: false,
          command: 'auth.login.complete',
          error: { code: 'AUTH_REQUIRED', retryable: false },
        });
      }

      const status = await runSharedAuth(fixture, runtime.env, storePath, [
        'auth',
        'status',
        '--json',
      ]);
      expect(status.code).toBe(statusCode);
      expect(onlyJson(status)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        command: 'auth.status',
        status: expectedStatus,
      });

      const token = String(resumeToken);
      const store = await readFile(storePath, 'utf8');
      const nonBeginSurfaces = [
        begin.stderr,
        complete.stdout,
        complete.stderr,
        status.stdout,
        status.stderr,
        store,
        JSON.stringify(complete.argv),
        JSON.stringify(complete.env),
        JSON.stringify(status.argv),
        JSON.stringify(status.env),
      ].join('\n');
      expect(nonBeginSurfaces).not.toContain(token);
      expect(begin.stdout.split(token)).toHaveLength(2);
      expect(await regularFiles(runtime.home)).toEqual([]);
      expect(store).toMatch(/"tokenHash":"[a-f0-9]{64}"/);
      expect(store).not.toContain(token);
    },
  );
});
