import { Readable } from 'node:stream';

import {
  ndJsonStream,
  type AnyMessage,
  type Stream,
} from '@agentclientprotocol/sdk';

import {
  RequestScopedNotifications,
  createAcpApp,
  type HandlerDependencies,
} from './acp/handlers.js';
import { createProductionAimeTransport } from './aime/bytedcli-transport.js';
import { ManagedUserAuthGuard } from './auth/identity-guard.js';
import { createProductionAuthProvider } from './auth/provider.js';
import type { BootstrapConfig } from './config.js';
import { createLogger } from './logger.js';
import type { ProgramStreams } from './program.js';
import { SessionManager } from './session/session-manager.js';
import {
  systemClock,
  TurnRuntime,
  type RuntimeDiagnostics,
} from './session/turn-runtime.js';

export type ProductionDependenciesFactory = (
  config: BootstrapConfig,
  stderr: NodeJS.WritableStream,
) => Promise<HandlerDependencies>;

export async function createProductionDependencies(
  config: BootstrapConfig,
  stderr: NodeJS.WritableStream,
): Promise<HandlerDependencies> {
  const logger = createLogger(stderr, config.logLevel);
  const auth = await createProductionAuthProvider({
    site: config.site,
    ...(config.proxy === undefined ? {} : { proxy: config.proxy }),
  });
  const guard = new ManagedUserAuthGuard(auth);
  const transport = await createProductionAimeTransport(
    {
      ...(config.spaceId === undefined ? {} : { spaceId: config.spaceId }),
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.executionMode === undefined
        ? {}
        : { executionMode: config.executionMode }),
    },
    guard,
  );
  const manager = new SessionManager(transport);
  const notifications = new RequestScopedNotifications();
  const diagnostics: RuntimeDiagnostics = {
    record(event) {
      logger.info(event.event, { state: event.outcome });
    },
  };
  const runtime = new TurnRuntime(
    manager,
    transport,
    notifications.notifications,
    {
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.locale === undefined ? {} : { locale: config.locale }),
      ...(config.executionMode === undefined
        ? {}
        : { executionMode: config.executionMode }),
    },
    systemClock,
    diagnostics,
  );
  return {
    transport,
    manager,
    runtime,
    notifications,
    authLoginCommand: `aime-acp auth login --site ${config.site}`,
    warnIgnoredMcp(count) {
      logger.warn('acp.mcp_servers_ignored', { count });
    },
  };
}

function rawOutput(
  write: NodeJS.WritableStream['write'],
  output: NodeJS.WritableStream,
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        const onError = () => undefined;
        output.once('error', onError);
        write(chunk, (error?: Error | null) => {
          if (error) {
            reject(error);
          } else {
            output.off('error', onError);
            resolve();
          }
        });
      });
    },
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function requestId(value: unknown): string | number | null | undefined {
  return value === null ||
    typeof value === 'string' ||
    typeof value === 'number'
    ? value
    : undefined;
}

function messageKey(id: string | number | null): string {
  return `${id === null ? 'null' : typeof id}:${String(id)}`;
}

function requestKey(message: unknown): string | undefined {
  const source = record(message);
  if (source?.jsonrpc !== '2.0' || typeof source.method !== 'string')
    return undefined;
  if (!Object.hasOwn(source, 'id')) return undefined;
  const id = requestId(source.id);
  return id === undefined ? undefined : messageKey(id);
}

function responseKey(message: unknown): string | undefined {
  const source = record(message);
  if (source?.jsonrpc !== '2.0' || Object.hasOwn(source, 'method'))
    return undefined;
  if (!Object.hasOwn(source, 'id')) return undefined;
  const id = requestId(source.id);
  return id === undefined ? undefined : messageKey(id);
}

interface DrainedResponses {
  readonly stream: Stream;
  failure(): unknown;
}

function drainResponses(stream: Stream): DrainedResponses {
  const pending = new Set<string>();
  let cancelled = false;
  let outputFailure: unknown;
  let inputReader: ReadableStreamDefaultReader<AnyMessage> | undefined;
  let signalDrained: (() => void) | undefined;
  const waitForDrained = async (): Promise<void> => {
    if (cancelled || pending.size === 0) return;
    await new Promise<void>((resolve) => {
      signalDrained = resolve;
    });
  };
  const wakeIfDrained = () => {
    if (!cancelled && pending.size > 0) return;
    signalDrained?.();
    signalDrained = undefined;
  };

  return {
    failure: () => outputFailure,
    stream: {
      readable: new ReadableStream<AnyMessage>({
        async start(controller) {
          const reader = stream.readable.getReader();
          inputReader = reader;
          try {
            while (!cancelled) {
              const item = await reader.read();
              if (item.done) break;
              const key = requestKey(item.value);
              if (key !== undefined) pending.add(key);
              controller.enqueue(item.value);
            }
            await waitForDrained();
            if (!cancelled) controller.close();
          } catch (error) {
            if (!cancelled) controller.error(error);
          } finally {
            if (inputReader === reader) inputReader = undefined;
            reader.releaseLock();
          }
        },
        async cancel(reason) {
          cancelled = true;
          wakeIfDrained();
          await inputReader?.cancel(reason);
        },
      }),
      writable: new WritableStream<AnyMessage>({
        async write(message) {
          const writer = stream.writable.getWriter();
          const key = responseKey(message);
          try {
            await writer.write(message);
          } catch (error) {
            outputFailure ??= error;
            pending.clear();
            wakeIfDrained();
            throw error;
          } finally {
            writer.releaseLock();
          }
          if (key !== undefined) {
            pending.delete(key);
            wakeIfDrained();
          }
        },
      }),
    },
  };
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';
type ConsoleOwner = {
  readonly token: symbol;
  readonly write: (value: string) => unknown;
};

const consoleMethods: readonly ConsoleMethod[] = [
  'log',
  'info',
  'warn',
  'error',
];
const consoleOwners: ConsoleOwner[] = [];
const knownConsoleRedirects = new WeakSet<typeof console.log>();
let restoreConsole: Record<ConsoleMethod, typeof console.log> | undefined;
let redirectedConsole: Record<ConsoleMethod, typeof console.log> | undefined;

function reconcileConsoleSuppression(): void {
  if (restoreConsole === undefined || redirectedConsole === undefined)
    throw new Error('Console suppression state is unavailable.');
  for (const method of consoleMethods) {
    const current = console[method];
    const redirect = redirectedConsole[method];
    if (current === redirect) continue;
    if (!knownConsoleRedirects.has(current)) restoreConsole[method] = current;
    console[method] = redirect;
  }
}

function acquireConsoleSuppression(
  write: (value: string) => unknown,
): () => void {
  const token = Symbol('aime-acp-console-owner');
  if (consoleOwners.length === 0) {
    restoreConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const suppress = () => {
      try {
        consoleOwners.at(-1)?.write('application console output suppressed\n');
      } catch {
        // Application diagnostics must never affect the ACP connection.
      }
    };
    knownConsoleRedirects.add(suppress);
    redirectedConsole = {
      log: suppress,
      info: suppress,
      warn: suppress,
      error: suppress,
    };
  }
  consoleOwners.push({ token, write });
  reconcileConsoleSuppression();

  return () => {
    const index = consoleOwners.findIndex((owner) => owner.token === token);
    if (index === -1) return;
    consoleOwners.splice(index, 1);
    if (consoleOwners.length !== 0) {
      reconcileConsoleSuppression();
      return;
    }
    if (restoreConsole !== undefined && redirectedConsole !== undefined) {
      for (const method of consoleMethods) {
        if (console[method] === redirectedConsole[method]) {
          console[method] = restoreConsole[method];
        }
      }
    }
    restoreConsole = undefined;
    redirectedConsole = undefined;
  };
}

export async function runServer(
  config: BootstrapConfig,
  io: ProgramStreams,
  createDependencies: ProductionDependenciesFactory = createProductionDependencies,
): Promise<number> {
  const writeStdout = io.stdout.write.bind(io.stdout);
  const writeStderr = io.stderr.write.bind(io.stderr);
  const releaseConsole = acquireConsoleSuppression(writeStderr);

  try {
    const dependencies = await createDependencies(config, io.stderr);
    const drained = drainResponses(
      ndJsonStream(
        rawOutput(writeStdout, io.stdout),
        Readable.toWeb(
          io.stdin as Readable,
        ) as unknown as ReadableStream<Uint8Array>,
      ),
    );
    const connection = createAcpApp(dependencies).connect(drained.stream);
    await connection.closed;
    const outputFailure = drained.failure();
    if (outputFailure !== undefined) throw outputFailure;
    return 0;
  } finally {
    releaseConsole();
  }
}
