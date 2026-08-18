import { parseArgs } from 'node:util';

import { AimeAcpError } from './errors.js';

export type AimeSite = 'cn' | 'i18n-tt';
export type ExecutionMode = 'fast' | 'max';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface BootstrapConfig {
  readonly mode: 'server' | 'auth' | 'doctor' | 'help' | 'version';
  readonly site: AimeSite;
  readonly spaceId?: string;
  readonly model?: string;
  readonly executionMode?: ExecutionMode;
  readonly locale?: string;
  readonly logLevel: LogLevel;
  readonly proxy?: string;
  readonly argv: readonly string[];
}

const forbiddenExact = new Set([
  'BYTEDCLI_AIME_API_BASE_URL',
  'BYTEDCLI_BYTECLOUD_AUTH_FALLBACK',
  'BYTECLOUD_AUTH_AS',
  'AIME_WORKSPACE_PATH',
  'AIME_CURRENT_USER',
  'AIME_USER_CLOUD_JWT',
  'BYTEDCLI_USER_CLOUD_JWT',
  'BYTEDCLI_SERVICE_ACCOUNT_JWT',
  'BYTECLOUD_AUTH_ACCESS_KEY_ID',
  'BYTECLOUD_AUTH_SECRET_ACCESS_KEY',
  'BYTECLOUD_AUTH_RPC_BINARY',
  'BYTECLOUD_CORE_RPC_BINARY',
  'AIME_ACP_RESUME_TOKEN',
]);

const sites = new Set<AimeSite>(['cn', 'i18n-tt']);
const executionModes = new Set<ExecutionMode>(['fast', 'max']);
const logLevels = new Set<LogLevel>(['error', 'warn', 'info', 'debug']);

function configurationError(detail: string): AimeAcpError {
  return new AimeAcpError(
    'AUTH_CONFIGURATION_UNSUPPORTED',
    `Unsupported AIME ACP configuration: ${detail}`,
    false,
  );
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function nonEmpty(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '')
    throw configurationError(`${name} must not be empty`);
  return value;
}

function selectValue(
  cli: string | undefined,
  env: NodeJS.ProcessEnv,
  environmentName: string,
  displayName: string,
): string | undefined {
  return nonEmpty(cli ?? environmentValue(env, environmentName), displayName);
}

function requiredEnum<T extends string>(
  value: string | undefined,
  values: ReadonlySet<T>,
  fallback: T,
  label: string,
): T {
  const selected = value ?? fallback;
  if (!values.has(selected as T)) {
    throw configurationError(
      `${label} must be one of ${[...values].join(', ')}`,
    );
  }
  return selected as T;
}

function parseCli(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        site: { type: 'string' },
        'space-id': { type: 'string' },
        model: { type: 'string' },
        'execution-mode': { type: 'string' },
        locale: { type: 'string' },
        'log-level': { type: 'string' },
        proxy: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        json: { type: 'boolean' },
        begin: { type: 'boolean' },
        complete: { type: 'boolean' },
        'resume-token-stdin': { type: 'boolean' },
      },
    });
  } catch {
    throw configurationError('invalid command line arguments');
  }
}

function rejectsRawResumeToken(argv: readonly string[]): boolean {
  return argv.some(
    (value) =>
      value === '--resume-token' || value.startsWith('--resume-token='),
  );
}

function validateResumeTokenStdin(
  mode: BootstrapConfig['mode'],
  positionals: readonly string[],
  values: Readonly<Record<string, string | boolean | undefined>>,
  argv: readonly string[],
): void {
  const count = (option: string): number =>
    argv.filter((value) => value === option).length;
  const hasInline = (option: string): boolean =>
    argv.some((value) => value.startsWith(`${option}=`));
  const separator = argv.indexOf('--');
  const afterSeparator = separator === -1 ? [] : argv.slice(separator + 1);
  const resumeCount = count('--resume-token-stdin');
  const beginCount = count('--begin');
  const completeCount = count('--complete');
  const hasResumeAfterSeparator = afterSeparator.some(
    (value) =>
      value === '--resume-token-stdin' ||
      value.startsWith('--resume-token-stdin='),
  );
  const hasUnsupportedInline =
    hasInline('--resume-token-stdin') ||
    hasInline('--begin') ||
    hasInline('--complete');
  const invalid = (): never => {
    throw configurationError(
      'resume token stdin is only supported for auth login complete',
    );
  };

  if (hasResumeAfterSeparator || hasUnsupportedInline) invalid();
  if (resumeCount === 0 && beginCount === 0 && completeCount === 0) {
    if (mode !== 'auth') return;
    const validNoModeFlags =
      (positionals.length === 1 && positionals[0] === 'auth') ||
      (positionals.length === 2 &&
        positionals[0] === 'auth' &&
        (positionals[1] === 'status' ||
          positionals[1] === 'login' ||
          positionals[1] === 'logout')) ||
      (positionals.length === 3 &&
        positionals[0] === 'auth' &&
        positionals[1] === 'login' &&
        positionals[2] === 'begin');
    if (!validNoModeFlags) invalid();
    return;
  }

  const exactComplete =
    mode === 'auth' &&
    positionals.length === 2 &&
    positionals[0] === 'auth' &&
    positionals[1] === 'login' &&
    resumeCount === 1 &&
    completeCount === 1 &&
    beginCount === 0 &&
    values['resume-token-stdin'] === true &&
    values.complete === true;
  if (exactComplete) return;

  const exactBegin =
    mode === 'auth' &&
    positionals.length === 2 &&
    positionals[0] === 'auth' &&
    positionals[1] === 'login' &&
    beginCount === 1 &&
    completeCount === 0 &&
    resumeCount === 0 &&
    values.begin === true;
  if (exactBegin) return;

  const positionalBegin =
    mode === 'auth' &&
    positionals.length === 3 &&
    positionals[0] === 'auth' &&
    positionals[1] === 'login' &&
    positionals[2] === 'begin' &&
    beginCount === 0 &&
    completeCount === 0 &&
    resumeCount === 0;
  if (positionalBegin) return;

  invalid();
}

function parseMode(
  positionals: readonly string[],
  help: boolean,
  version: boolean,
): BootstrapConfig['mode'] {
  if (help) return 'help';
  if (version) return 'version';
  if (positionals.length === 0) return 'server';
  if (positionals[0] === 'auth') return 'auth';
  if (positionals[0] === 'doctor') return 'doctor';
  throw configurationError('command must be auth, doctor, or omitted');
}

function validateProxy(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError('proxy must be a valid http or https URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    throw configurationError('proxy must be an origin-only http or https URL');
  }
  return url.origin;
}

export function redactProxyForLog(proxy: string): string {
  const safeProxy = validateProxy(proxy);
  const url = new URL(safeProxy);
  return `${url.protocol}//${url.host}`;
}

export function validatePreImportEnvironment(env: NodeJS.ProcessEnv): void {
  const bad = Object.entries(env)
    .filter(([, value]) => value != null && value !== '')
    .map(([name]) => name)
    .filter(
      (name) =>
        forbiddenExact.has(name) ||
        /^BYTEDCLI_SERVICE_ACCOUNT_.*_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)$/.test(
          name,
        ),
    )
    .sort();
  if (bad.length > 0)
    throw configurationError(`forbidden environment: ${bad.join(', ')}`);
}

export function parseBootstrapConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): BootstrapConfig {
  if (rejectsRawResumeToken(argv)) {
    throw configurationError('resume token must be provided via stdin');
  }
  const parsed = parseCli(argv);
  const values = parsed.values;
  const mode = parseMode(
    parsed.positionals,
    values.help === true,
    values.version === true,
  );
  validateResumeTokenStdin(mode, parsed.positionals, values, argv);
  const site = requiredEnum(
    selectValue(values.site, env, 'AIME_ACP_SITE', 'site'),
    sites,
    'cn',
    'site',
  );
  const executionMode = selectValue(
    values['execution-mode'],
    env,
    'AIME_ACP_EXECUTION_MODE',
    'execution mode',
  );
  const logLevel = requiredEnum(
    selectValue(values['log-level'], env, 'AIME_ACP_LOG_LEVEL', 'log level'),
    logLevels,
    'info',
    'log level',
  );
  const proxy = selectValue(values.proxy, env, 'AIME_ACP_PROXY', 'proxy');
  const spaceId = selectValue(
    values['space-id'],
    env,
    'AIME_ACP_SPACE_ID',
    'space id',
  );
  const model = selectValue(values.model, env, 'AIME_ACP_MODEL', 'model');
  const selectedExecutionMode = executionMode
    ? requiredEnum(executionMode, executionModes, 'fast', 'execution mode')
    : undefined;
  const locale = selectValue(values.locale, env, 'AIME_ACP_LOCALE', 'locale');
  const validatedProxy = proxy ? validateProxy(proxy) : undefined;

  return {
    mode,
    site,
    logLevel,
    argv: [...argv],
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(model === undefined ? {} : { model }),
    ...(selectedExecutionMode === undefined
      ? {}
      : { executionMode: selectedExecutionMode }),
    ...(locale === undefined ? {} : { locale }),
    ...(validatedProxy === undefined ? {} : { proxy: validatedProxy }),
  };
}

export function sanitizePackageEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    const upperName = name.toUpperCase();
    if (
      upperName === 'BYTEDCLI_CLOUD_SITE' ||
      upperName === 'BYTEDCLI_AUTH_SITE' ||
      upperName === 'BYTEDCLI_SOCKS5_PROXY' ||
      upperName.startsWith('BYTEDCLI_HTTP_') ||
      upperName === 'HTTP_PROXY' ||
      upperName === 'HTTPS_PROXY' ||
      upperName === 'ALL_PROXY'
    ) {
      delete env[name];
    }
  }
}
