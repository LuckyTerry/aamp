import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runDoctor } from '../../src/doctor.js';
import { AimeAcpError } from '../../src/errors.js';
import { AIME_ACP_PACKAGE_VERSION } from '../../src/package-info.js';

function captureIo() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  return { stdout, stderr, stdoutText: () => output };
}

function dependencies() {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      checkCompatibility: vi.fn(async () => {
        calls.push('compatibility');
      }),
      resolveSpace: vi.fn(async () => {
        calls.push('space');
        return { id: 'personal-space-id' };
      }),
    },
    guard: {
      assertStable: vi.fn(async () => {
        calls.push('guard');
      }),
    },
  };
}

describe('doctor', () => {
  it('checks compatibility, managed user auth, then one transport space probe', async () => {
    const io = captureIo();
    const deps = dependencies();

    await expect(
      runDoctor({ site: 'cn', ...deps, salt: Buffer.alloc(32, 7) }, io),
    ).resolves.toBe(0);

    expect(deps.calls).toEqual(['compatibility', 'guard', 'space']);
    expect(JSON.parse(io.stdoutText())).toEqual({
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
    expect(io.stdoutText()).not.toContain('personal-space-id');
  });

  it.each([
    ['unauthenticated', 'AUTH_REQUIRED', true, false],
    ['access', 'AIME_ACCESS_DENIED', true, true],
    ['network', 'AIME_NETWORK_UNREACHABLE', true, true],
    ['protocol', 'AIME_PROTOCOL_DRIFT', true, true],
  ] as const)(
    'reports %s failures safely',
    async (_name, code, compatible, authenticated) => {
      const io = captureIo();
      const deps = dependencies();
      const failure = new AimeAcpError(
        code,
        'untrusted raw failure detail',
        code === 'AIME_NETWORK_UNREACHABLE',
        { host: 'aime.example.test', errno: 'ENOTFOUND' },
      );
      if (code === 'AUTH_REQUIRED')
        deps.guard.assertStable.mockRejectedValue(failure);
      else deps.transport.resolveSpace.mockRejectedValue(failure);

      await expect(runDoctor({ site: 'cn', ...deps }, io)).resolves.toBe(1);

      expect(JSON.parse(io.stdoutText())).toMatchObject({
        schemaVersion: 1,
        ok: false,
        compatible,
        authenticated,
        aimeReachable: false,
        error: { code },
      });
      expect(io.stdoutText()).not.toContain('untrusted raw failure detail');
    },
  );
});
