import type { LogLevel } from './config.js';

export type SafeLogFields = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export interface Logger {
  error(event: string, fields?: SafeLogFields): void;
  warn(event: string, fields?: SafeLogFields): void;
  info(event: string, fields?: SafeLogFields): void;
  debug(event: string, fields?: SafeLogFields): void;
}

const allowedFields = new Set([
  'operation',
  'state',
  'durationMs',
  'sessionHash',
  'eventType',
  'offset',
  'reconnectAttempt',
  'errorCode',
  'httpStatus',
  'requestId',
  'bytes',
  'count',
]);

const severity: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function assertSafeFields(fields: SafeLogFields): void {
  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.has(key))
      throw new TypeError(`Log field is not allowed: ${key}`);
    if (
      value !== undefined &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new TypeError(`Log field must be a primitive: ${key}`);
    }
  }
}

export function createLogger(
  stderr: Pick<NodeJS.WriteStream, 'write'>,
  level: LogLevel,
): Logger {
  const write = (
    messageLevel: LogLevel,
    event: string,
    fields: SafeLogFields = {},
  ) => {
    assertSafeFields(fields);
    if (severity[messageLevel] > severity[level]) return;
    stderr.write(
      `${JSON.stringify({ level: messageLevel, event, ...fields })}\n`,
    );
  };

  return {
    error: (event, fields) => write('error', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    info: (event, fields) => write('info', event, fields),
    debug: (event, fields) => write('debug', event, fields),
  };
}
