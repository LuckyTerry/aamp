export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'AUTH_SOURCE_UNSUPPORTED',
  'AUTH_IDENTITY_UNAVAILABLE',
  'AUTH_IDENTITY_CHANGED',
  'AUTH_CONFIGURATION_UNSUPPORTED',
  'AIME_ACCESS_DENIED',
  'AIME_SESSION_NOT_FOUND',
  'SESSION_BUSY',
  'AIME_UNSUPPORTED_CONTENT',
  'AIME_MODEL_NOT_FOUND',
  'AIME_SEND_FAILED',
  'AIME_STREAM_INTERRUPTED',
  'AIME_PROTOCOL_DRIFT',
  'AIME_EMPTY_RESPONSE',
  'AIME_SDK_INCOMPATIBLE',
  'AIME_NETWORK_UNREACHABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type SafeErrorMetadata = Readonly<
  Record<string, string | number | boolean>
>;

export class AimeAcpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly safeMetadata: SafeErrorMetadata = {},
  ) {
    super(message);
    this.name = 'AimeAcpError';
  }
}

export type AimeErrorOperation =
  | 'guard'
  | 'external-auth'
  | 'session-read'
  | 'model'
  | 'create'
  | 'send'
  | 'stream'
  | 'recovery'
  | 'schema'
  | 'offset'
  | 'text'
  | 'compatibility';

export interface SafeError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly safeMetadata: SafeErrorMetadata;
}

const errorMessages: Readonly<Record<ErrorCode, string>> = {
  AUTH_REQUIRED: 'Managed user authentication is required.',
  AUTH_SOURCE_UNSUPPORTED:
    'The configured authentication source is unsupported.',
  AUTH_IDENTITY_UNAVAILABLE: 'A stable managed-user identity is unavailable.',
  AUTH_IDENTITY_CHANGED:
    'The managed-user identity changed during this session.',
  AUTH_CONFIGURATION_UNSUPPORTED:
    'The runtime authentication configuration is unsupported.',
  AIME_ACCESS_DENIED: 'Access to AIME was denied.',
  AIME_SESSION_NOT_FOUND: 'The AIME session was not found.',
  SESSION_BUSY: 'The AIME session is busy.',
  AIME_UNSUPPORTED_CONTENT: 'AIME does not support this content.',
  AIME_MODEL_NOT_FOUND: 'The requested AIME model was not found.',
  AIME_SEND_FAILED: 'The request to AIME failed.',
  AIME_STREAM_INTERRUPTED: 'The AIME response stream was interrupted.',
  AIME_PROTOCOL_DRIFT: 'AIME returned an incompatible response.',
  AIME_EMPTY_RESPONSE: 'AIME returned an empty response.',
  AIME_SDK_INCOMPATIBLE: 'The installed AIME SDK interface is incompatible.',
  AIME_NETWORK_UNREACHABLE: 'AIME is unreachable over the network.',
};

const safeMetadataKeys = new Set([
  'status',
  'requestId',
  'errno',
  'syscall',
  'host',
]);

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    (ERROR_CODES as readonly string[]).includes(value)
  );
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    return undefined;
  }
  if (/[^\x20-\x7e]/.test(value)) return undefined;
  return value;
}

function safeStatus(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return value >= 100 && value <= 599 ? value : undefined;
}

function safeHost(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.username || url.password ? undefined : url.host || undefined;
  } catch {
    if (/[/\\?#@\s]/.test(value)) return undefined;
    return /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(value) ? value : undefined;
  }
}

function extractSafeMetadata(error: unknown): SafeErrorMetadata {
  const source = asRecord(error);
  if (!source) return {};

  const metadata: Record<string, string | number | boolean> = {};
  const status = safeStatus(source.status ?? source.statusCode);
  const requestId = safeString(source.requestId);
  const errno = safeString(source.errno);
  const syscall = safeString(source.syscall);
  const host = safeHost(source.host ?? source.url);

  if (status !== undefined) metadata.status = status;
  if (requestId !== undefined) metadata.requestId = requestId;
  if (errno !== undefined) metadata.errno = errno;
  if (syscall !== undefined) metadata.syscall = syscall;
  if (host !== undefined) metadata.host = host;
  return metadata;
}

function filterSafeMetadata(metadata: SafeErrorMetadata): SafeErrorMetadata {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!safeMetadataKeys.has(key)) continue;
    if (key === 'status') {
      const status = safeStatus(value);
      if (status !== undefined) filtered.status = status;
      continue;
    }
    if (key === 'host') {
      const host = safeHost(value);
      if (host !== undefined) filtered.host = host;
      continue;
    }
    const string = safeString(value);
    if (string !== undefined) filtered[key] = string;
  }
  return filtered;
}

function safeError(
  code: ErrorCode,
  retryable: boolean,
  metadata: SafeErrorMetadata,
): AimeAcpError {
  return new AimeAcpError(code, errorMessages[code], retryable, metadata);
}

function rawCode(error: unknown): string | undefined {
  const source = asRecord(error);
  return safeString(source?.code);
}

function isExplicitModelMiss(error: unknown): boolean {
  const code = rawCode(error)?.toUpperCase();
  return code === 'MODEL_NOT_FOUND' || code === 'AIME_MODEL_NOT_FOUND';
}

function isNetworkFailure(
  error: unknown,
  metadata: SafeErrorMetadata,
): boolean {
  const candidates = [rawCode(error), metadata.errno]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toUpperCase());
  return candidates.some(
    (value) =>
      [
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'EPROTO',
      ].includes(value) ||
      value.startsWith('ERR_TLS_') ||
      value.startsWith('ERR_PROXY_') ||
      value.startsWith('UNABLE_TO_'),
  );
}

export function toSafeError(error: unknown): SafeError {
  const metadata = extractSafeMetadata(error);
  if (error instanceof AimeAcpError) {
    return {
      code: error.code,
      message: errorMessages[error.code],
      retryable: error.retryable,
      safeMetadata: filterSafeMetadata(error.safeMetadata),
    };
  }

  const code = isErrorCode(asRecord(error)?.code)
    ? (asRecord(error)?.code as ErrorCode)
    : 'AIME_SEND_FAILED';
  return {
    code,
    message: errorMessages[code],
    retryable: isNetworkFailure(error, metadata),
    safeMetadata: metadata,
  };
}

export function normalizeAimeError(
  error: unknown,
  operation: AimeErrorOperation,
): AimeAcpError {
  if (error instanceof AimeAcpError) return error;

  const metadata = extractSafeMetadata(error);
  const status = metadata.status;

  if (operation === 'external-auth') {
    return safeError('AUTH_SOURCE_UNSUPPORTED', false, metadata);
  }
  if (operation === 'guard' || status === 401) {
    return safeError('AUTH_REQUIRED', false, metadata);
  }
  if (status === 403) return safeError('AIME_ACCESS_DENIED', false, metadata);
  if (operation === 'session-read' && status === 404) {
    return safeError('AIME_SESSION_NOT_FOUND', false, metadata);
  }
  if (isNetworkFailure(error, metadata)) {
    return safeError('AIME_NETWORK_UNREACHABLE', true, metadata);
  }
  if (operation === 'model' && isExplicitModelMiss(error)) {
    return safeError('AIME_MODEL_NOT_FOUND', false, metadata);
  }
  if (operation === 'stream' || operation === 'recovery') {
    return safeError('AIME_STREAM_INTERRUPTED', true, metadata);
  }
  if (
    operation === 'schema' ||
    operation === 'offset' ||
    operation === 'text'
  ) {
    return safeError('AIME_PROTOCOL_DRIFT', false, metadata);
  }
  if (operation === 'compatibility') {
    return safeError('AIME_SDK_INCOMPATIBLE', false, metadata);
  }
  return safeError('AIME_SEND_FAILED', true, metadata);
}
