import {
  createProductionAimeTransport,
  type AimeTransportConfig,
} from './aime/bytedcli-transport.js';
import type { AimeTransport } from './aime/transport.js';
import { type AuthCommandInput, runAuthCommand } from './auth/commands.js';
import { ManagedUserAuthGuard } from './auth/identity-guard.js';
import {
  createProductionAuthProvider,
  type AuthProvider,
  type AuthSnapshot,
  type LoginChallenge,
  type LoginOutcome,
  type ManagedIdentity,
  type SafeLoginEvent,
} from './auth/provider.js';
import type { BootstrapConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { AIME_ACP_PACKAGE_VERSION } from './package-info.js';
import { runServer } from './server.js';

export interface ProgramStreams {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

interface DoctorDependencies {
  readonly guard: Pick<ManagedUserAuthGuard, 'assertStable'>;
  readonly transport: Pick<
    AimeTransport,
    'checkCompatibility' | 'resolveSpace'
  >;
}

export interface ProgramDependencies {
  createAuth(config: BootstrapConfig): Promise<AuthProvider>;
  createDoctor(config: BootstrapConfig): Promise<DoctorDependencies>;
  startServer(
    config: BootstrapConfig,
    streams: ProgramStreams,
  ): Promise<number>;
}

export function serverTransportConfig(
  config: BootstrapConfig,
): AimeTransportConfig {
  return {
    ...(config.spaceId === undefined ? {} : { spaceId: config.spaceId }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.executionMode === undefined
      ? {}
      : { executionMode: config.executionMode }),
  };
}

export function doctorTransportConfig(
  config: BootstrapConfig,
): AimeTransportConfig {
  return {
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.executionMode === undefined
      ? {}
      : { executionMode: config.executionMode }),
  };
}

const productionDependencies: ProgramDependencies = {
  async createAuth(config) {
    return createProductionAuthProvider({
      site: config.site,
      ...(config.proxy === undefined ? {} : { proxy: config.proxy }),
    });
  },
  async createDoctor(config) {
    const auth = await createProductionAuthProvider({
      site: config.site,
      ...(config.proxy === undefined ? {} : { proxy: config.proxy }),
    });
    const guard = new ManagedUserAuthGuard(auth);
    return {
      guard,
      transport: await createProductionAimeTransport(
        doctorTransportConfig(config),
        guard,
      ),
    };
  },
  async startServer(config, streams) {
    return runServer(config, streams);
  },
};

const optionsWithValues = new Set([
  '--site',
  '--space-id',
  '--model',
  '--execution-mode',
  '--locale',
  '--log-level',
  '--proxy',
  '--resume-token',
]);

function positionals(argv: readonly string[]): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (optionsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if ([...optionsWithValues].some((option) => value.startsWith(`${option}=`)))
      continue;
    if (value.startsWith('-')) continue;
    values.push(value);
  }
  return values;
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

function hasResumeTokenArgument(argv: readonly string[]): boolean {
  return argv.some(
    (value) =>
      value === '--resume-token' || value.startsWith('--resume-token='),
  );
}

function authInput(config: BootstrapConfig): AuthCommandInput {
  const json = hasFlag(config.argv, '--json');
  if (hasResumeTokenArgument(config.argv)) {
    return { kind: 'invalid', site: config.site, json, command: 'auth.login' };
  }
  const parts = positionals(config.argv);
  const command = parts[1];
  if (command === 'logout') return { kind: 'logout', site: config.site, json };
  if (command === 'status' || command === undefined) {
    return { kind: 'status', site: config.site, json };
  }
  if (command !== 'login') return { kind: 'logout', site: config.site, json };
  const action = parts[2];
  if (action === 'begin' || hasFlag(config.argv, '--begin')) {
    return { kind: 'login.begin', site: config.site, json };
  }
  if (
    (action === 'complete' || hasFlag(config.argv, '--complete')) &&
    hasFlag(config.argv, '--resume-token-stdin')
  ) {
    return {
      kind: 'login.complete',
      site: config.site,
      json,
      resumeTokenStdin: true,
    };
  }
  if (action === 'complete' || hasFlag(config.argv, '--complete')) {
    return {
      kind: 'invalid',
      site: config.site,
      json,
      command: 'auth.login.complete',
    };
  }
  return { kind: 'login', site: config.site, json };
}

function write(stream: NodeJS.WritableStream, value: string): void {
  stream.write(`${value}\n`);
}

function printHelp(streams: ProgramStreams): void {
  write(
    streams.stdout,
    'Usage: aime-acp [--site cn|i18n-tt] [auth status|login|login begin|login --complete --resume-token-stdin|doctor]',
  );
  write(
    streams.stdout,
    'Doctor always probes an available AIME space; --space-id is server-only.',
  );
}

function unusedAuthProvider(): AuthProvider {
  const unsupported = (): never => {
    throw new Error('unreachable auth operation');
  };
  return {
    status: unsupported as () => Promise<AuthSnapshot>,
    externalSource: unsupported as () => Promise<string | undefined>,
    identity: unsupported as () => Promise<ManagedIdentity>,
    login: unsupported as (
      onEvent: (event: SafeLoginEvent) => void,
    ) => Promise<LoginOutcome>,
    beginLogin: unsupported as () => Promise<LoginChallenge>,
    completeLogin: unsupported as (
      resumeToken: string,
    ) => Promise<LoginOutcome>,
  };
}

export async function runProgram(
  config: BootstrapConfig,
  streams: ProgramStreams,
  dependencies: ProgramDependencies = productionDependencies,
): Promise<number> {
  if (config.mode === 'help') {
    printHelp(streams);
    return 0;
  }
  if (config.mode === 'version') {
    write(streams.stdout, AIME_ACP_PACKAGE_VERSION);
    return 0;
  }
  if (config.mode === 'auth') {
    const input = authInput(config);
    return runAuthCommand(
      input,
      input.kind === 'logout' || input.kind === 'invalid'
        ? unusedAuthProvider()
        : await dependencies.createAuth(config),
      streams,
    );
  }
  if (config.mode === 'doctor') {
    const doctor = await dependencies.createDoctor(config);
    return runDoctor({ site: config.site, ...doctor }, streams);
  }
  return dependencies.startServer(config, streams);
}
