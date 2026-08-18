import { describe, expect, it } from 'vitest';

import { ManagedUserAuthGuard } from '../../src/auth/identity-guard.js';
import { fakeAuth } from '../helpers/fake-auth.js';

describe('managed-user identity guard', () => {
  it.each(['env_jwt', 'jwt_override', 'session_jwt', 'byteclaw_mock'])(
    'rejects unsupported external source %s',
    async (source) => {
      const guard = new ManagedUserAuthGuard(
        fakeAuth().withExternalSource(source),
        Buffer.alloc(32, 7),
      );

      await expect(guard.assertStable('session/new')).rejects.toMatchObject({
        code: 'AUTH_SOURCE_UNSUPPORTED',
      });
    },
  );

  it('accepts refresh with the same stable identity', async () => {
    const auth = fakeAuth().identities(['employeeId:1001', 'employeeId:1001']);
    const guard = new ManagedUserAuthGuard(auth, Buffer.alloc(32, 7));

    await guard.assertStable('session/new');
    await expect(guard.assertStable('session/prompt')).resolves.toBeUndefined();
  });

  it('fails closed after status loss', async () => {
    const guard = new ManagedUserAuthGuard(
      fakeAuth().withStatus('unauthenticated'),
      Buffer.alloc(32, 7),
    );

    await expect(guard.assertStable('session/new')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('fails closed when no stable identity is available', async () => {
    const guard = new ManagedUserAuthGuard(
      fakeAuth().withIdentity(undefined),
      Buffer.alloc(32, 7),
    );

    await expect(guard.assertStable('session/new')).rejects.toMatchObject({
      code: 'AUTH_IDENTITY_UNAVAILABLE',
    });
  });

  it('fails closed after an account switch without exposing an identity', async () => {
    const auth = fakeAuth().identities(['employeeId:1001', 'employeeId:2002']);
    const guard = new ManagedUserAuthGuard(auth, Buffer.alloc(32, 7));

    await guard.assertStable('session/new');
    await expect(guard.assertStable('session/prompt')).rejects.toMatchObject({
      code: 'AUTH_IDENTITY_CHANGED',
    });
  });
});
