import type { AimeSite } from '../config.js';
import { AimeAcpError, toSafeError } from '../errors.js';
import type {
  AuthProvider,
  AuthSnapshot,
  LoginChallenge,
  LoginOutcome,
  SafeLoginEvent,
} from './provider.js';

export interface AuthCommandStreams {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export type AuthCommandInput =
  | { readonly kind: 'status'; readonly site: AimeSite; readonly json: boolean }
  | { readonly kind: 'login'; readonly site: AimeSite; readonly json: boolean }
  | {
      readonly kind: 'login.begin';
      readonly site: AimeSite;
      readonly json: boolean;
    }
  | {
      readonly kind: 'login.complete';
      readonly site: AimeSite;
      readonly json: boolean;
      readonly resumeTokenStdin: true;
    }
  | {
      readonly kind: 'logout';
      readonly site: AimeSite;
      readonly json: boolean;
    }
  | {
      readonly kind: 'invalid';
      readonly site: AimeSite;
      readonly json: boolean;
      readonly command: string;
    };

export type AuthCommandResult =
  | {
      readonly schemaVersion: 1;
      readonly ok: true;
      readonly command:
        | 'auth.status'
        | 'auth.login'
        | 'auth.login.begin'
        | 'auth.login.complete';
      readonly site: AimeSite;
      readonly status: 'authenticated' | 'unauthenticated' | 'pending';
      readonly authSource?: 'bytecloud_auth';
      readonly authType?: 'user';
      readonly expiresAt?: string;
      readonly url?: string;
      readonly displayCode?: string;
      readonly resumeToken?: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly ok: false;
      readonly command: string;
      readonly site: AimeSite;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

let loginInFlight: Promise<unknown> | undefined;

function unsupported(): AimeAcpError {
  return new AimeAcpError(
    'AUTH_CONFIGURATION_UNSUPPORTED',
    'Unsupported authentication command.',
    false,
  );
}

function invalidResumeToken(): AimeAcpError {
  return new AimeAcpError(
    'AUTH_CONFIGURATION_UNSUPPORTED',
    'Invalid login resume token.',
    false,
  );
}

function loginFailure(outcome: LoginOutcome): AimeAcpError {
  return new AimeAcpError(
    outcome.status === 'server_error' ? 'AIME_SEND_FAILED' : 'AUTH_REQUIRED',
    'Authentication did not complete.',
    outcome.status === 'server_error',
  );
}

function write(stream: NodeJS.WritableStream, value: string): void {
  stream.write(`${value}\n`);
}

function commandName(input: AuthCommandInput): string {
  switch (input.kind) {
    case 'status':
      return 'auth.status';
    case 'login':
      return 'auth.login';
    case 'login.begin':
      return 'auth.login.begin';
    case 'login.complete':
      return 'auth.login.complete';
    case 'logout':
      return 'auth.logout';
    case 'invalid':
      return input.command;
  }
}

function resultFromStatus(
  command: Extract<AuthCommandResult, { readonly ok: true }>['command'],
  snapshot: AuthSnapshot,
): Extract<AuthCommandResult, { readonly ok: true }> {
  return {
    schemaVersion: 1,
    ok: true,
    command,
    site: snapshot.site,
    status: snapshot.authenticated ? 'authenticated' : 'unauthenticated',
    ...(snapshot.authenticated && snapshot.authSource !== undefined
      ? { authSource: snapshot.authSource }
      : {}),
    ...(snapshot.authenticated && snapshot.authType !== undefined
      ? { authType: snapshot.authType }
      : {}),
    ...(snapshot.authenticated && snapshot.expiresAt !== undefined
      ? { expiresAt: snapshot.expiresAt }
      : {}),
  };
}

function resultFromChallenge(
  site: AimeSite,
  challenge: LoginChallenge,
): Extract<AuthCommandResult, { readonly ok: true }> {
  return {
    schemaVersion: 1,
    ok: true,
    command: 'auth.login.begin',
    site,
    status: 'pending',
    ...(challenge.url === undefined ? {} : { url: challenge.url }),
    ...(challenge.displayCode === undefined
      ? {}
      : { displayCode: challenge.displayCode }),
    ...(challenge.expiresAt === undefined
      ? {}
      : { expiresAt: challenge.expiresAt }),
    ...(challenge.challengeToken === undefined
      ? {}
      : { resumeToken: challenge.challengeToken }),
  };
}

function errorResult(
  command: string,
  site: AimeSite,
  error: unknown,
): Extract<AuthCommandResult, { readonly ok: false }> {
  const safe = toSafeError(error);
  return {
    schemaVersion: 1,
    ok: false,
    command,
    site,
    error: {
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
    },
  };
}

function render(
  result: AuthCommandResult,
  json: boolean,
  streams: AuthCommandStreams,
): void {
  if (json) {
    write(streams.stdout, JSON.stringify(result));
    return;
  }
  if (result.ok) {
    write(streams.stdout, result.status);
    return;
  }
  write(streams.stderr, `${result.error.code}: ${result.error.message}`);
}

function writeProgress(
  event: SafeLoginEvent,
  streams: AuthCommandStreams,
): void {
  if (event.type === 'challenge') {
    write(streams.stderr, 'Login challenge received.');
    if (event.url !== undefined) write(streams.stderr, `Open: ${event.url}`);
    if (event.displayCode !== undefined)
      write(streams.stderr, `Code: ${event.displayCode}`);
    if (event.expiresAt !== undefined)
      write(streams.stderr, `Expires: ${event.expiresAt}`);
    return;
  }
  const message =
    event.type === 'browser'
      ? 'Login browser step received.'
      : event.type === 'waiting'
        ? 'Waiting for login completion.'
        : 'Login completed.';
  write(streams.stderr, message);
}

async function exclusiveLogin<T>(fn: () => Promise<T>): Promise<T> {
  if (loginInFlight !== undefined) throw unsupported();
  const current = fn();
  loginInFlight = current;
  try {
    return await current;
  } finally {
    if (loginInFlight === current) loginInFlight = undefined;
  }
}

async function successStatus(
  command: Extract<AuthCommandResult, { readonly ok: true }>['command'],
  auth: AuthProvider,
): Promise<Extract<AuthCommandResult, { readonly ok: true }>> {
  const snapshot = await auth.status();
  if (!snapshot.authenticated) throw loginFailure({ status: 'unknown' });
  return resultFromStatus(command, snapshot);
}

async function resultAfterLogin(
  command: Extract<AuthCommandResult, { readonly ok: true }>['command'],
  site: AimeSite,
  outcome: LoginOutcome,
  auth: AuthProvider,
): Promise<{
  readonly result: Extract<AuthCommandResult, { readonly ok: true }>;
  readonly exitCode: 0 | 2;
}> {
  if (outcome.status === 'pending') {
    return {
      result: {
        schemaVersion: 1,
        ok: true,
        command,
        site,
        status: 'pending',
      },
      exitCode: 2,
    };
  }
  if (
    outcome.status !== 'success' &&
    outcome.status !== 'already_authenticated' &&
    outcome.status !== 'not_required'
  ) {
    throw loginFailure(outcome);
  }
  return { result: await successStatus(command, auth), exitCode: 0 };
}

export async function readResumeToken(
  stdin: NodeJS.ReadableStream,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 16_384) throw invalidResumeToken();
    chunks.push(buffer);
  }
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 1 || !lines[0]) throw invalidResumeToken();
  return lines[0];
}

export async function runAuthCommand(
  input: AuthCommandInput,
  auth: AuthProvider,
  streams: AuthCommandStreams,
): Promise<0 | 1 | 2> {
  const command = commandName(input);
  try {
    if (input.kind === 'logout' || input.kind === 'invalid')
      throw unsupported();

    if (input.kind === 'status') {
      const result = resultFromStatus('auth.status', await auth.status());
      render(result, input.json, streams);
      return result.status === 'authenticated' ? 0 : 1;
    }

    if (input.kind === 'login.begin') {
      const challenge = await exclusiveLogin(() => auth.beginLogin());
      const result = resultFromChallenge(input.site, challenge);
      render(result, input.json, streams);
      return 0;
    }

    if (input.kind === 'login.complete') {
      const token = await readResumeToken(streams.stdin);
      const completed = await exclusiveLogin(() => auth.completeLogin(token));
      const { result, exitCode } = await resultAfterLogin(
        'auth.login.complete',
        input.site,
        completed,
        auth,
      );
      render(result, input.json, streams);
      return exitCode;
    }

    const initial = await auth.status();
    if (initial.authenticated) {
      render(resultFromStatus('auth.login', initial), input.json, streams);
      return 0;
    }
    const outcome = await exclusiveLogin(() =>
      auth.login((event) => writeProgress(event, streams)),
    );
    const { result, exitCode } = await resultAfterLogin(
      'auth.login',
      input.site,
      outcome,
      auth,
    );
    render(result, input.json, streams);
    return exitCode;
  } catch (error) {
    render(errorResult(command, input.site, error), input.json, streams);
    return 1;
  }
}
