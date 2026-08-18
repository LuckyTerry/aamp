import { createHash, randomBytes } from 'node:crypto';

import type { AimeTransport } from './aime/transport.js';
import type { ManagedUserAuthGuard } from './auth/identity-guard.js';
import type { AimeSite } from './config.js';
import { toSafeError } from './errors.js';
import { AIME_ACP_PACKAGE_VERSION } from './package-info.js';

export interface DoctorStreams {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export interface DoctorResult {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly site: AimeSite;
  readonly packageVersion: string;
  readonly bytedcliVersion: '0.123.0';
  readonly acpSdkVersion: '0.28.1';
  readonly compatible: boolean;
  readonly authenticated: boolean;
  readonly aimeReachable: boolean;
  readonly spaceHash?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly stage: 'compatibility' | 'authentication' | 'space-resolve';
    readonly host?: string;
    readonly errno?: string;
  };
}

export interface DoctorInput {
  readonly site: AimeSite;
  readonly transport: Pick<
    AimeTransport,
    'checkCompatibility' | 'resolveSpace'
  >;
  readonly guard: Pick<ManagedUserAuthGuard, 'assertStable'>;
  /** Test-only deterministic hash salt; production deliberately omits it. */
  readonly salt?: Buffer;
}

function write(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function spaceHash(id: string, salt: Buffer): string {
  return createHash('sha256')
    .update(salt)
    .update('\0')
    .update(id)
    .digest('hex');
}

export async function runDoctor(
  input: DoctorInput,
  streams: DoctorStreams,
): Promise<0 | 1> {
  let compatible = false;
  let authenticated = false;
  let stage: 'compatibility' | 'authentication' | 'space-resolve' =
    'compatibility';
  try {
    await input.transport.checkCompatibility();
    compatible = true;
    stage = 'authentication';
    await input.guard.assertStable('doctor');
    authenticated = true;
    stage = 'space-resolve';
    const space = await input.transport.resolveSpace();
    write(streams.stdout, {
      schemaVersion: 1,
      ok: true,
      site: input.site,
      packageVersion: AIME_ACP_PACKAGE_VERSION,
      bytedcliVersion: '0.123.0',
      acpSdkVersion: '0.28.1',
      compatible,
      authenticated,
      aimeReachable: true,
      spaceHash: spaceHash(space.id, input.salt ?? randomBytes(32)),
    } satisfies DoctorResult);
    return 0;
  } catch (error) {
    const safe = toSafeError(error);
    write(streams.stdout, {
      schemaVersion: 1,
      ok: false,
      site: input.site,
      packageVersion: AIME_ACP_PACKAGE_VERSION,
      bytedcliVersion: '0.123.0',
      acpSdkVersion: '0.28.1',
      compatible,
      authenticated,
      aimeReachable: false,
      error: {
        code: safe.code,
        message: safe.message,
        retryable: safe.retryable,
        stage,
        ...(typeof safe.safeMetadata.host === 'string'
          ? { host: safe.safeMetadata.host }
          : {}),
        ...(typeof safe.safeMetadata.errno === 'string'
          ? { errno: safe.safeMetadata.errno }
          : {}),
      },
    } satisfies DoctorResult);
    return 1;
  }
}
