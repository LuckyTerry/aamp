import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { AimeAcpError } from '../errors.js';
import type { AuthProvider, ManagedIdentity } from './provider.js';

function unsupportedAuthSource(): AimeAcpError {
  return new AimeAcpError(
    'AUTH_SOURCE_UNSUPPORTED',
    'The configured authentication source is unsupported.',
    false,
  );
}

function authRequired(): AimeAcpError {
  return new AimeAcpError(
    'AUTH_REQUIRED',
    'Managed user authentication is required.',
    false,
  );
}

function identityUnavailable(): AimeAcpError {
  return new AimeAcpError(
    'AUTH_IDENTITY_UNAVAILABLE',
    'A stable managed-user identity is unavailable.',
    false,
  );
}

function identityChanged(): AimeAcpError {
  return new AimeAcpError(
    'AUTH_IDENTITY_CHANGED',
    'The managed-user identity changed during this session.',
    false,
  );
}

function hasStableIdentity(value: ManagedIdentity): boolean {
  return value.value.trim() !== '';
}

export class ManagedUserAuthGuard {
  readonly #salt: Buffer;
  #baseline?: string;

  constructor(
    private readonly auth: AuthProvider,
    salt: Buffer = randomBytes(32),
  ) {
    this.#salt = Buffer.from(salt);
  }

  async assertStable(operation: string): Promise<void> {
    void operation;
    if ((await this.auth.externalSource()) !== undefined) {
      throw unsupportedAuthSource();
    }
    const status = await this.auth.status();
    if (!status.authenticated) throw authRequired();

    let identity: ManagedIdentity;
    try {
      identity = await this.auth.identity();
    } catch {
      throw identityUnavailable();
    }
    if (!hasStableIdentity(identity)) throw identityUnavailable();

    const fingerprint = createHash('sha256')
      .update(this.#salt)
      .update('\0')
      .update(identity.field)
      .update('\0')
      .update(identity.value)
      .digest('hex');
    if (this.#baseline === undefined) {
      this.#baseline = fingerprint;
      return;
    }
    if (
      !timingSafeEqual(Buffer.from(this.#baseline), Buffer.from(fingerprint))
    ) {
      throw identityChanged();
    }
  }
}
