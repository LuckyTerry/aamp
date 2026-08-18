import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runAuthCommand } from '../../src/auth/commands.js';
import type { LoginOutcome, SafeLoginEvent } from '../../src/auth/provider.js';
import { fakeAuth } from '../helpers/fake-auth.js';

function captureIo(input = '') {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  let errors = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString('utf8');
  });
  stdin.end(input);
  return {
    stdin,
    stdout,
    stderr,
    stdoutText: () => output,
    stderrText: () => errors,
  };
}

describe('auth commands', () => {
  it.each([
    ['authenticated', 0],
    ['unauthenticated', 1],
  ] as const)('auth status %s exits %i', async (status, exitCode) => {
    const io = captureIo();

    const result = await runAuthCommand(
      { kind: 'status', site: 'cn', json: true },
      fakeAuth().withStatus(status),
      io,
    );

    expect(result).toBe(exitCode);
    expect(JSON.parse(io.stdoutText())).toMatchObject({
      schemaVersion: 1,
      command: 'auth.status',
      site: 'cn',
      status,
    });
  });

  it('reports pending complete as one JSON object and exit 2', async () => {
    const io = captureIo('opaque-resume-token\n');

    const result = await runAuthCommand(
      {
        kind: 'login.complete',
        site: 'cn',
        json: true,
        resumeTokenStdin: true,
      },
      fakeAuth().completeAs('pending'),
      io,
    );

    expect(result).toBe(2);
    expect(io.stdoutText().trim().split('\n')).toHaveLength(1);
    expect(io.stderrText()).not.toContain('opaque-resume-token');
  });

  it('uses the input site for a pending complete without rechecking auth', async () => {
    const io = captureIo('opaque-resume-token\n');
    const auth = fakeAuth().completeAs('pending');
    auth.status = vi.fn(async () => {
      throw new Error('status must not be called for pending');
    });

    await expect(
      runAuthCommand(
        {
          kind: 'login.complete',
          site: 'i18n-tt',
          json: true,
          resumeTokenStdin: true,
        },
        auth,
        io,
      ),
    ).resolves.toBe(2);

    expect(JSON.parse(io.stdoutText())).toMatchObject({
      command: 'auth.login.complete',
      site: 'i18n-tt',
      status: 'pending',
    });
  });

  it('maps the begin challenge token only to the JSON resume token field', async () => {
    const io = captureIo();
    const auth = fakeAuth();
    auth.beginLogin = vi.fn(async () => ({
      challengeToken: 'never-print-this',
      url: 'https://login.example.test/verify',
      displayCode: 'ABCD',
      expiresAt: '2030-01-02T03:04:05.000Z',
    }));

    const result = await runAuthCommand(
      { kind: 'login.begin', site: 'cn', json: true },
      auth,
      io,
    );

    expect(result).toBe(0);
    expect(JSON.parse(io.stdoutText())).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'auth.login.begin',
      site: 'cn',
      status: 'pending',
      url: 'https://login.example.test/verify',
      displayCode: 'ABCD',
      expiresAt: '2030-01-02T03:04:05.000Z',
      resumeToken: 'never-print-this',
    });
    expect(io.stderrText()).not.toContain('never-print-this');
    expect(io.stdoutText().split('never-print-this')).toHaveLength(2);
  });

  it('does not display the begin resume token outside JSON mode', async () => {
    const io = captureIo();
    const auth = fakeAuth();
    auth.beginLogin = vi.fn(async () => ({
      challengeToken: 'never-print-this',
    }));

    await expect(
      runAuthCommand(
        { kind: 'login.begin', site: 'cn', json: false },
        auth,
        io,
      ),
    ).resolves.toBe(0);

    expect(io.stdoutText()).toBe('pending\n');
    expect(`${io.stdoutText()}${io.stderrText()}`).not.toContain(
      'never-print-this',
    );
  });

  it('rechecks status after a successful blocking login and shows the challenge URL without secrets', async () => {
    const io = captureIo();
    const auth = fakeAuth();
    auth.status = vi
      .fn()
      .mockResolvedValueOnce({
        site: 'cn',
        authenticated: false,
        nextCommand: 'do-not-print-this',
      })
      .mockResolvedValueOnce({
        site: 'cn',
        authenticated: true,
        authSource: 'bytecloud_auth',
        authType: 'user',
      });
    auth.login = vi.fn(
      async (
        onEvent: (event: SafeLoginEvent) => void,
      ): Promise<LoginOutcome> => {
        onEvent({
          type: 'challenge',
          url: 'https://login.example.test/verify?ticket=safe-ticket',
          displayCode: 'SAFE-CODE',
        });
        return { status: 'success' };
      },
    );

    await expect(
      runAuthCommand({ kind: 'login', site: 'cn', json: true }, auth, io),
    ).resolves.toBe(0);

    expect(auth.status).toHaveBeenCalledTimes(2);
    expect(JSON.parse(io.stdoutText())).toMatchObject({
      command: 'auth.login',
      status: 'authenticated',
    });
    expect(io.stderrText()).toContain(
      'Open: https://login.example.test/verify?ticket=safe-ticket',
    );
    expect(io.stderrText()).toContain('Code: SAFE-CODE');
    expect(io.stderrText()).not.toContain('resume-token');
  });

  it.each([['expired'], ['denied']] as const)(
    'reports complete %s as a safe failure',
    async (status) => {
      const io = captureIo('opaque-resume-token\n');

      await expect(
        runAuthCommand(
          {
            kind: 'login.complete',
            site: 'cn',
            json: true,
            resumeTokenStdin: true,
          },
          fakeAuth().completeAs(status),
          io,
        ),
      ).resolves.toBe(1);

      expect(JSON.parse(io.stdoutText())).toMatchObject({
        ok: false,
        command: 'auth.login.complete',
        error: { code: 'AUTH_REQUIRED' },
      });
      expect(io.stdoutText()).not.toContain('opaque-resume-token');
    },
  );

  it.each(['', 'one\ntwo\n', `${'x'.repeat(16_385)}\n`])(
    'rejects malformed resume token input without calling complete',
    async (token) => {
      const io = captureIo(token);
      const auth = fakeAuth();
      const complete = vi.spyOn(auth, 'completeLogin');

      await expect(
        runAuthCommand(
          {
            kind: 'login.complete',
            site: 'cn',
            json: true,
            resumeTokenStdin: true,
          },
          auth,
          io,
        ),
      ).resolves.toBe(1);

      expect(complete).not.toHaveBeenCalled();
      expect(JSON.parse(io.stdoutText())).toMatchObject({
        ok: false,
        error: { code: 'AUTH_CONFIGURATION_UNSUPPORTED' },
      });
    },
  );

  it('rejects logout without inspecting or mutating managed auth state', async () => {
    const io = captureIo();
    const auth = fakeAuth();
    const status = vi.spyOn(auth, 'status');
    const login = vi.spyOn(auth, 'login');

    await expect(
      runAuthCommand({ kind: 'logout', site: 'cn', json: true }, auth, io),
    ).resolves.toBe(1);

    expect(status).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(JSON.parse(io.stdoutText())).toMatchObject({
      ok: false,
      command: 'auth.logout',
      error: { code: 'AUTH_CONFIGURATION_UNSUPPORTED' },
    });
  });

  it('allows only one process-local login operation at a time', async () => {
    const auth = fakeAuth().withStatus('unauthenticated');
    let completeLogin: (() => void) | undefined;
    auth.login = vi.fn(
      () =>
        new Promise<LoginOutcome>((resolve) => {
          completeLogin = () => resolve({ status: 'pending' });
        }),
    );
    const firstIo = captureIo();
    const secondIo = captureIo();

    const first = runAuthCommand(
      { kind: 'login', site: 'cn', json: true },
      auth,
      firstIo,
    );
    await vi.waitFor(() => expect(auth.login).toHaveBeenCalledTimes(1));
    await expect(
      runAuthCommand(
        { kind: 'login.begin', site: 'cn', json: true },
        auth,
        secondIo,
      ),
    ).resolves.toBe(1);
    completeLogin?.();
    await expect(first).resolves.toBe(2);
    expect(JSON.parse(secondIo.stdoutText())).toMatchObject({
      ok: false,
      error: { code: 'AUTH_CONFIGURATION_UNSUPPORTED' },
    });
  });
});
