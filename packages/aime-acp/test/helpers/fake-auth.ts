import { vi } from 'vitest';

import type {
  AuthFacade,
  AuthProvider,
  AuthSnapshot,
  LoginChallenge,
  LoginOutcome,
  ManagedIdentity,
  SafeLoginEvent,
} from '../../src/auth/provider.js';

type AuthStatus = 'authenticated' | 'unauthenticated';

export interface FakeAuth extends AuthProvider {
  identities(values: readonly string[]): this;
  withExternalSource(source: string | undefined): this;
  withIdentity(identity: ManagedIdentity | undefined): this;
  withStatus(status: AuthStatus): this;
  completeAs(status: LoginOutcome['status']): this;
}

export interface FakeBytedcli {
  readonly facade: AuthFacade;
  readonly auth: {
    readonly getExternalBytecloudAuthStatus: ReturnType<typeof vi.fn>;
    readonly byteCloudAuthEnsureAuth: ReturnType<typeof vi.fn>;
    readonly byteCloudAuthUserInfo: ReturnType<typeof vi.fn>;
    readonly byteCloudAuthLogin: ReturnType<typeof vi.fn>;
    readonly byteCloudAuthBeginLogin: ReturnType<typeof vi.fn>;
    readonly byteCloudAuthCompleteLogin: ReturnType<typeof vi.fn>;
  };
  readonly utils: {
    readonly setCloudSite: ReturnType<typeof vi.fn>;
    readonly setAuthAs: ReturnType<typeof vi.fn>;
    readonly setHttpConfig: ReturnType<typeof vi.fn>;
  };
}

function parseIdentity(value: string): ManagedIdentity {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('fake identity must have field:value form');
  }
  return {
    field: value.slice(0, separator) as ManagedIdentity['field'],
    value: value.slice(separator + 1),
  };
}

export function fakeAuth(): FakeAuth {
  let source: string | undefined;
  let status: AuthStatus = 'authenticated';
  let fallbackIdentity: ManagedIdentity | undefined = {
    field: 'employeeId',
    value: '1001',
  };
  let identityQueue: ManagedIdentity[] = [];
  let completion: LoginOutcome['status'] = 'success';

  return {
    async status(): Promise<AuthSnapshot> {
      return {
        site: 'cn',
        authenticated: status === 'authenticated',
        ...(status === 'authenticated'
          ? { authSource: 'bytecloud_auth' as const, authType: 'user' as const }
          : { nextCommand: 'aime-acp auth login --site cn' }),
      };
    },
    async externalSource(): Promise<string | undefined> {
      return source;
    },
    async identity(): Promise<ManagedIdentity> {
      const next = identityQueue.shift() ?? fallbackIdentity;
      if (!next) throw new Error('identity unavailable');
      return next;
    },
    async login(
      _onEvent: (event: SafeLoginEvent) => void,
    ): Promise<LoginOutcome> {
      return { status: completion };
    },
    async beginLogin(): Promise<LoginChallenge> {
      return { challengeToken: 'fake-challenge' };
    },
    async completeLogin(_resumeToken: string): Promise<LoginOutcome> {
      return { status: completion };
    },
    identities(values: readonly string[]): FakeAuth {
      identityQueue = values.map(parseIdentity);
      return this;
    },
    withExternalSource(value: string | undefined): FakeAuth {
      source = value;
      return this;
    },
    withIdentity(value: ManagedIdentity | undefined): FakeAuth {
      fallbackIdentity = value;
      return this;
    },
    withStatus(value: AuthStatus): FakeAuth {
      status = value;
      return this;
    },
    completeAs(value: LoginOutcome['status']): FakeAuth {
      completion = value;
      return this;
    },
  };
}

export function fakeBytedcli(): FakeBytedcli {
  const auth = {
    getExternalBytecloudAuthStatus: vi.fn(async () => ({
      authenticated: false,
      auth_source: null,
    })),
    byteCloudAuthEnsureAuth: vi.fn(async () => ({
      status: 'ready',
      authType: 'user',
      expiresAt: '2030-01-02T03:04:05.000Z',
    })),
    byteCloudAuthUserInfo: vi.fn(async () => ({ employeeId: '1001' })),
    byteCloudAuthLogin: vi.fn(async () => ({ status: 'success' })),
    byteCloudAuthBeginLogin: vi.fn(async () => ({
      challengeToken: 'resume-token',
      preferredUrl: 'https://login.example.test',
      displayCode: 'ABCD',
      expiresAt: '2030-01-02T03:04:05.000Z',
    })),
    byteCloudAuthCompleteLogin: vi.fn(async () => ({ status: 'success' })),
  };
  const utils = {
    setCloudSite: vi.fn(),
    setAuthAs: vi.fn(),
    setHttpConfig: vi.fn(),
  };

  return { facade: { auth, utils }, auth, utils };
}
