import { describe, expect, it, vi } from 'vitest';

import {
  createAuthProvider,
  createProductionAuthProvider,
} from '../../src/auth/provider.js';
import type { ManagedIdentity } from '../../src/auth/provider.js';
import { fakeBytedcli } from '../helpers/fake-auth.js';

type UnavailableIdentityFields = Partial<Record<ManagedIdentity['field'], ''>>;

const identityPriorityCases: readonly (readonly [
  string,
  UnavailableIdentityFields,
  ManagedIdentity,
])[] = [
  [
    'employeeId when every identity field is available',
    {},
    { field: 'employeeId', value: 'employee-1' },
  ],
  [
    'newEmployeeId after employeeId is unavailable',
    { employeeId: '' },
    { field: 'newEmployeeId', value: 'employee-2' },
  ],
  [
    'email after employeeId and newEmployeeId are unavailable',
    { employeeId: '', newEmployeeId: '' },
    { field: 'email', value: 'person@example.test' },
  ],
  [
    'username after every higher-priority field is unavailable',
    { employeeId: '', newEmployeeId: '', email: '' },
    { field: 'username', value: 'person' },
  ],
  [
    'userId after every higher-priority field is unavailable',
    { employeeId: '', newEmployeeId: '', email: '', username: '' },
    { field: 'userId', value: 'user-1' },
  ],
];

describe('managed-user auth provider', () => {
  it('normalizes ready status and configures only safe SDK controls', async () => {
    const fake = fakeBytedcli();
    const auth = createAuthProvider(
      { site: 'i18n-tt', proxy: 'https://proxy.example.test' },
      fake.facade,
    );

    await expect(auth.status()).resolves.toEqual({
      site: 'i18n-tt',
      authenticated: true,
      authSource: 'bytecloud_auth',
      authType: 'user',
      expiresAt: '2030-01-02T03:04:05.000Z',
    });
    expect(fake.auth.byteCloudAuthEnsureAuth).toHaveBeenCalledWith({
      site: 'i18n-tt',
      as: 'user',
    });
    expect(fake.utils.setCloudSite).toHaveBeenCalledWith('i18n-tt');
    expect(fake.utils.setAuthAs).toHaveBeenCalledWith('user');
    expect(fake.utils.setHttpConfig).toHaveBeenCalledWith({
      httpRetryCount: 0,
      socks5Proxy: undefined,
      httpProxy: 'https://proxy.example.test',
      httpDebug: false,
      httpPrint: undefined,
      httpTraceFile: undefined,
      httpHeaders: undefined,
    });
  });

  it('normalizes non-ready status to unauthenticated stable login guidance', async () => {
    const fake = fakeBytedcli();
    fake.auth.byteCloudAuthEnsureAuth.mockResolvedValue({
      status: 'pending',
      nextCommand: 'bytedcli auth login --unsafe JWT_SENTINEL',
      credentials: { jwtToken: 'JWT_SENTINEL' },
    });
    const auth = createAuthProvider({ site: 'cn' }, fake.facade);

    const status = await auth.status();

    expect(status).toEqual({
      site: 'cn',
      authenticated: false,
      nextCommand: 'aime-acp auth login --site cn',
    });
    expect(JSON.stringify(status)).not.toContain('JWT_SENTINEL');
  });

  it.each(identityPriorityCases)(
    'selects %s by exact approved identity priority',
    async (_description, unavailable, expected) => {
      const fake = fakeBytedcli();
      fake.auth.byteCloudAuthUserInfo.mockResolvedValue({
        employeeId: unavailable.employeeId ?? 'employee-1',
        newEmployeeId: unavailable.newEmployeeId ?? 'employee-2',
        email: unavailable.email ?? 'person@example.test',
        username: unavailable.username ?? 'person',
        userId: unavailable.userId ?? 'user-1',
        jwtToken: 'JWT_SENTINEL',
        credentials: { accessToken: 'CREDENTIAL_SENTINEL' },
      });
      const auth = createAuthProvider({ site: 'cn' }, fake.facade);

      const identity = await auth.identity();

      expect(identity).toEqual(expected);
      expect(JSON.stringify(identity)).not.toContain('JWT_SENTINEL');
      expect(JSON.stringify(identity)).not.toContain('CREDENTIAL_SENTINEL');
    },
  );

  it('returns only safe login values and filters unsafe login events', async () => {
    const fake = fakeBytedcli();
    fake.auth.byteCloudAuthLogin.mockImplementation(async (params) => {
      await params.onEvent?.({
        type: 'auth.login.completed',
        timestamp: '2030-01-02T03:04:05.000Z',
        payload: { username: 'PERSON_SENTINEL', credentials: 'JWT_SENTINEL' },
      });
      return { status: 'success', credentials: { jwtToken: 'JWT_SENTINEL' } };
    });
    fake.auth.byteCloudAuthCompleteLogin.mockResolvedValue({
      status: 'success',
      credentials: { jwtToken: 'JWT_SENTINEL' },
    });
    const auth = createAuthProvider({ site: 'cn' }, fake.facade);
    const events: unknown[] = [];

    const [outcome, challenge, completed] = await Promise.all([
      auth.login((event) => events.push(event)),
      auth.beginLogin(),
      auth.completeLogin('opaque-resume-token'),
    ]);

    expect(outcome).toEqual({ status: 'success' });
    expect(completed).toEqual({ status: 'success' });
    expect(challenge).toEqual({
      challengeToken: 'resume-token',
      url: 'https://login.example.test',
      displayCode: 'ABCD',
      expiresAt: '2030-01-02T03:04:05.000Z',
    });
    expect(
      JSON.stringify({ events, outcome, challenge, completed }),
    ).not.toContain('JWT_SENTINEL');
    expect(JSON.stringify(events)).not.toContain('PERSON_SENTINEL');
    expect(fake.auth.byteCloudAuthLogin).toHaveBeenCalledWith({
      site: 'cn',
      autoOpenBrowser: true,
      onEvent: expect.any(Function),
    });
  });

  it('uses a lazy import and rejects incomplete SDK exports with a stable code', async () => {
    const fake = fakeBytedcli();
    const importer = vi.fn(async () => fake.facade);

    const auth = await createProductionAuthProvider({ site: 'cn' }, importer);
    await auth.status();
    expect(importer).toHaveBeenCalledTimes(1);

    await expect(
      createProductionAuthProvider({ site: 'cn' }, async () => ({ auth: {} })),
    ).rejects.toMatchObject({ code: 'AIME_SDK_INCOMPATIBLE' });
  });
});
