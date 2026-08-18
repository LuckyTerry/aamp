import type { AimeSite } from '../config.js';
import { AimeAcpError } from '../errors.js';

export interface AuthSnapshot {
  readonly site: AimeSite;
  readonly authenticated: boolean;
  readonly authSource?: 'bytecloud_auth';
  readonly authType?: 'user';
  readonly expiresAt?: string;
  readonly nextCommand?: string;
}

export interface ManagedIdentity {
  readonly field:
    | 'employeeId'
    | 'newEmployeeId'
    | 'email'
    | 'username'
    | 'userId';
  readonly value: string;
}

export interface SafeLoginEvent {
  readonly type: 'challenge' | 'browser' | 'waiting' | 'completed';
  readonly url?: string;
  readonly displayCode?: string;
  readonly expiresAt?: string;
  readonly status?: LoginOutcome['status'];
}

export interface LoginOutcome {
  readonly status:
    | 'success'
    | 'pending'
    | 'denied'
    | 'expired'
    | 'invalid_ticket'
    | 'server_error'
    | 'already_authenticated'
    | 'not_required'
    | 'unknown';
}

export interface LoginChallenge {
  readonly challengeToken?: string;
  readonly url?: string;
  readonly displayCode?: string;
  readonly expiresAt?: string;
}

export interface AuthProvider {
  status(): Promise<AuthSnapshot>;
  externalSource(): Promise<string | undefined>;
  identity(): Promise<ManagedIdentity>;
  login(onEvent: (event: SafeLoginEvent) => void): Promise<LoginOutcome>;
  beginLogin(): Promise<LoginChallenge>;
  completeLogin(resumeToken: string): Promise<LoginOutcome>;
}

export interface AuthProviderConfig {
  readonly site: AimeSite;
  readonly proxy?: string;
}

export interface SafeHttpConfig {
  readonly httpRetryCount: 0;
  readonly socks5Proxy: undefined;
  readonly httpProxy: string | undefined;
  readonly httpDebug: false;
  readonly httpPrint: undefined;
  readonly httpTraceFile: undefined;
  readonly httpHeaders: undefined;
}

export interface AuthFacade {
  readonly auth: {
    getExternalBytecloudAuthStatus(): Promise<unknown>;
    byteCloudAuthEnsureAuth(options: {
      site: AimeSite;
      as: 'user';
    }): Promise<unknown>;
    byteCloudAuthUserInfo(): Promise<unknown>;
    byteCloudAuthLogin(params: {
      site: AimeSite;
      autoOpenBrowser: true;
      onEvent: (event: unknown) => void;
    }): Promise<unknown>;
    byteCloudAuthBeginLogin(): Promise<unknown>;
    byteCloudAuthCompleteLogin(token: string): Promise<unknown>;
  };
  readonly utils: {
    setCloudSite(site: AimeSite): void;
    setAuthAs(as: 'user'): void;
    setHttpConfig(config: SafeHttpConfig): void;
  };
}

type ImportBytedcli = () => Promise<unknown>;

const identityFields = [
  'employeeId',
  'newEmployeeId',
  'email',
  'username',
  'userId',
] as const;

const loginStatuses = new Set<LoginOutcome['status']>([
  'success',
  'pending',
  'denied',
  'expired',
  'invalid_ticket',
  'server_error',
  'already_authenticated',
  'not_required',
]);

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function incompatibleSdk(): AimeAcpError {
  return new AimeAcpError(
    'AIME_SDK_INCOMPATIBLE',
    'The installed AIME SDK interface is incompatible.',
    false,
  );
}

function unavailableIdentity(): AimeAcpError {
  return new AimeAcpError(
    'AUTH_IDENTITY_UNAVAILABLE',
    'A stable managed-user identity is unavailable.',
    false,
  );
}

function loginCommand(site: AimeSite): string {
  return `aime-acp auth login --site ${site}`;
}

function normalizeLoginStatus(value: unknown): LoginOutcome['status'] {
  return typeof value === 'string' &&
    loginStatuses.has(value as LoginOutcome['status'])
    ? (value as LoginOutcome['status'])
    : 'unknown';
}

function normalizeLoginOutcome(value: unknown): LoginOutcome {
  return { status: normalizeLoginStatus(record(value)?.status) };
}

function safeLoginEvent(value: unknown): SafeLoginEvent | undefined {
  const source = record(value);
  const payload = record(source?.payload);
  switch (source?.type) {
    case 'auth.login.challenge': {
      const url = nonEmptyString(
        payload?.preferredUrl ??
          payload?.verificationUriComplete ??
          payload?.verificationUri ??
          payload?.browserUrl,
      );
      const displayCode = nonEmptyString(
        payload?.displayCode ?? payload?.userCode,
      );
      const expiresAt = nonEmptyString(payload?.expiresAt);
      return {
        type: 'challenge',
        ...(url === undefined ? {} : { url }),
        ...(displayCode === undefined ? {} : { displayCode }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
    }
    case 'auth.login.browser': {
      const url = nonEmptyString(payload?.url);
      return {
        type: 'browser',
        ...(url === undefined ? {} : { url }),
      };
    }
    case 'auth.login.waiting': {
      const expiresAt = nonEmptyString(payload?.expiresAt);
      return {
        type: 'waiting',
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
    }
    case 'auth.login.completed':
      return {
        type: 'completed',
        status: normalizeLoginStatus(payload?.status),
      };
    default:
      return undefined;
  }
}

function normalizeChallenge(value: unknown): LoginChallenge {
  const source = record(value);
  const url = nonEmptyString(
    source?.preferredUrl ??
      source?.verificationUriComplete ??
      source?.verificationUri ??
      source?.browserUrl,
  );
  const displayCode = nonEmptyString(source?.displayCode ?? source?.userCode);
  const expiresAt = nonEmptyString(source?.expiresAt);
  const challengeToken = nonEmptyString(source?.challengeToken);
  return {
    ...(challengeToken === undefined ? {} : { challengeToken }),
    ...(url === undefined ? {} : { url }),
    ...(displayCode === undefined ? {} : { displayCode }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function asFacade(value: unknown): AuthFacade {
  const root = record(value);
  const auth = record(root?.auth);
  const utils = record(root?.utils);
  const functions = [
    auth?.getExternalBytecloudAuthStatus,
    auth?.byteCloudAuthEnsureAuth,
    auth?.byteCloudAuthUserInfo,
    auth?.byteCloudAuthLogin,
    auth?.byteCloudAuthBeginLogin,
    auth?.byteCloudAuthCompleteLogin,
    utils?.setCloudSite,
    utils?.setAuthAs,
    utils?.setHttpConfig,
  ];
  if (functions.some((value) => typeof value !== 'function')) {
    throw incompatibleSdk();
  }
  return value as AuthFacade;
}

class ManagedUserAuthProvider implements AuthProvider {
  constructor(
    private readonly config: AuthProviderConfig,
    private readonly facade: AuthFacade,
  ) {}

  async status(): Promise<AuthSnapshot> {
    const result = record(
      await this.facade.auth.byteCloudAuthEnsureAuth({
        site: this.config.site,
        as: 'user',
      }),
    );
    if (result?.status !== 'ready') {
      return {
        site: this.config.site,
        authenticated: false,
        nextCommand: loginCommand(this.config.site),
      };
    }
    const expiresAt = nonEmptyString(result.expiresAt);
    return {
      site: this.config.site,
      authenticated: true,
      authSource: 'bytecloud_auth',
      authType: 'user',
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }

  async externalSource(): Promise<string | undefined> {
    const result = record(
      await this.facade.auth.getExternalBytecloudAuthStatus(),
    );
    return result?.authenticated === true
      ? nonEmptyString(result.auth_source)
      : undefined;
  }

  async identity(): Promise<ManagedIdentity> {
    const info = record(await this.facade.auth.byteCloudAuthUserInfo());
    for (const field of identityFields) {
      const value = nonEmptyString(info?.[field]);
      if (value !== undefined) return { field, value };
    }
    throw unavailableIdentity();
  }

  async login(onEvent: (event: SafeLoginEvent) => void): Promise<LoginOutcome> {
    const value = await this.facade.auth.byteCloudAuthLogin({
      site: this.config.site,
      autoOpenBrowser: true,
      onEvent: (event) => {
        const safeEvent = safeLoginEvent(event);
        if (safeEvent !== undefined) onEvent(safeEvent);
      },
    });
    return normalizeLoginOutcome(value);
  }

  async beginLogin(): Promise<LoginChallenge> {
    return normalizeChallenge(await this.facade.auth.byteCloudAuthBeginLogin());
  }

  async completeLogin(resumeToken: string): Promise<LoginOutcome> {
    return normalizeLoginOutcome(
      await this.facade.auth.byteCloudAuthCompleteLogin(resumeToken),
    );
  }
}

export function createAuthProvider(
  config: AuthProviderConfig,
  facade: AuthFacade,
): AuthProvider {
  const verifiedFacade = asFacade(facade);
  verifiedFacade.utils.setCloudSite(config.site);
  verifiedFacade.utils.setAuthAs('user');
  verifiedFacade.utils.setHttpConfig({
    httpRetryCount: 0,
    socks5Proxy: undefined,
    httpProxy: config.proxy,
    httpDebug: false,
    httpPrint: undefined,
    httpTraceFile: undefined,
    httpHeaders: undefined,
  });
  return new ManagedUserAuthProvider(config, verifiedFacade);
}

export async function createProductionAuthProvider(
  config: AuthProviderConfig,
  importer: ImportBytedcli = () => import('@bytedance-dev/bytedcli'),
): Promise<AuthProvider> {
  return createAuthProvider(config, asFacade(await importer()));
}
