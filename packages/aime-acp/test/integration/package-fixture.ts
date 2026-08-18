import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmSync,
  writeFile,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { type ProcessResult, requireSuccess, runProcess } from './process.js';
import {
  requireOwnedIntegrationRunRoot,
  requireOwnedIntegrationRunRootSync,
} from './run-root.js';

const mkdirAsync = promisify(mkdir);
const mkdtempAsync = promisify(mkdtemp);
const readFileAsync = promisify(readFile);
const readdirAsync = promisify(readdir);
const rmAsync = promisify(rm);
const writeFileAsync = promisify(writeFile);

const packageDirectory = dirname(
  fileURLToPath(new URL('../../package.json', import.meta.url)),
);
const fakeLoaderPath = fileURLToPath(
  new URL('../helpers/fake-bytedcli-loader.mjs', import.meta.url),
);

interface PackFile {
  readonly path: string;
}

interface PackResult {
  readonly filename: string;
  readonly files: readonly PackFile[];
}

export interface PackageFixture {
  readonly root: string;
  readonly installRoot: string;
  readonly installedPackageDirectory: string;
  readonly installedBin: string;
  readonly emptyPath: string;
  readonly packFiles: readonly string[];
  readonly dryRunFiles: readonly string[];
  readonly packageRequire: NodeJS.Require;
}

type IntegrationGlobal = typeof globalThis & {
  __aimeAcpPackageFixture?: Promise<PackageFixture>;
};

function parsePackResult(stdout: string): PackResult {
  const lineStarts = [0];
  for (let index = stdout.indexOf('\n'); index !== -1; ) {
    lineStarts.push(index + 1);
    index = stdout.indexOf('\n', index + 1);
  }
  let parsed: readonly PackResult[] | PackResult | undefined;
  for (const start of lineStarts.reverse()) {
    const candidate = stdout.slice(start).trim();
    if (!candidate.startsWith('[') && !candidate.startsWith('{')) continue;
    try {
      parsed = JSON.parse(candidate) as readonly PackResult[] | PackResult;
      break;
    } catch {
      // Lifecycle scripts may write non-JSON before npm's final JSON result.
    }
  }
  if (parsed === undefined)
    throw new Error('npm pack did not emit a JSON result');
  const value = Array.isArray(parsed) ? parsed[0] : parsed;
  if (
    value === undefined ||
    typeof value.filename !== 'string' ||
    !Array.isArray(value.files)
  ) {
    throw new Error('npm pack returned an unexpected JSON contract');
  }
  return value;
}

function npmInvocation(args: readonly string[]): {
  readonly file: string;
  readonly argv: readonly string[];
} {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath === undefined || npmExecPath === ''
    ? { file: 'npm', argv: args }
    : { file: process.execPath, argv: [npmExecPath, ...args] };
}

async function runNpm(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<ProcessResult> {
  const invocation = npmInvocation(args);
  const result = await runProcess(invocation.file, invocation.argv, {
    cwd,
    env,
    timeoutMs: 300_000,
  });
  requireSuccess(result, label);
  return result;
}

async function buildFixture(): Promise<PackageFixture> {
  const ownedRun = await requireOwnedIntegrationRunRoot();
  const root = await mkdtempAsync(join(ownedRun.root, 'clean-install-'));
  const assertOwnedFixtureRoot = (): void => {
    const currentRun = requireOwnedIntegrationRunRootSync();
    if (
      currentRun.root !== ownedRun.root ||
      dirname(resolve(root)) !== resolve(ownedRun.root) ||
      !basename(root).startsWith('clean-install-')
    ) {
      throw new Error(
        'package fixture is outside the owned integration run root',
      );
    }
  };
  const emergencyCleanup = (): void => {
    try {
      assertOwnedFixtureRoot();
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Main-process teardown owns normal cleanup; worker exit is best-effort.
    }
  };
  process.once('exit', emergencyCleanup);
  try {
    const packDirectory = join(root, 'pack');
    const installRoot = join(root, 'install');
    const npmHome = join(root, 'npm-home');
    const npmCache = join(root, 'npm-cache');
    const emptyPath = join(root, 'empty-path');
    const userConfig = join(root, 'empty-npmrc');
    await Promise.all(
      [packDirectory, installRoot, npmHome, npmCache, emptyPath].map((path) =>
        mkdirAsync(path, { recursive: true }),
      ),
    );
    await Promise.all([
      writeFileAsync(userConfig, '', { mode: 0o600 }),
      writeFileAsync(
        join(installRoot, 'package.json'),
        '{"name":"aime-acp-install-proof","private":true}\n',
        { mode: 0o600 },
      ),
    ]);
    const npmEnvironment: NodeJS.ProcessEnv = {
      HOME: npmHome,
      USERPROFILE: npmHome,
      LANG: 'C.UTF-8',
      PATH: process.env.PATH,
      TMPDIR: root,
      NPM_CONFIG_CACHE: npmCache,
      NPM_CONFIG_USERCONFIG: userConfig,
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      PUPPETEER_SKIP_DOWNLOAD: 'true',
    };

    const packed = parsePackResult(
      (
        await runNpm(
          [
            'pack',
            '--json',
            '--loglevel=error',
            '--pack-destination',
            packDirectory,
          ],
          packageDirectory,
          npmEnvironment,
          'npm pack',
        )
      ).stdout,
    );
    const dryRun = parsePackResult(
      (
        await runNpm(
          [
            'pack',
            '--dry-run',
            '--json',
            '--ignore-scripts',
            '--loglevel=error',
          ],
          packageDirectory,
          npmEnvironment,
          'npm pack --dry-run',
        )
      ).stdout,
    );
    const tarball = resolve(packDirectory, packed.filename);
    await runNpm(
      [
        'install',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        '--registry=https://bnpm.byted.org',
        tarball,
      ],
      installRoot,
      npmEnvironment,
      'clean tarball install',
    );

    const installedPackageDirectory = join(
      installRoot,
      'node_modules',
      'aime-acp',
    );
    const installedBin = join(installedPackageDirectory, 'dist', 'bin.js');
    return {
      root,
      installRoot,
      installedPackageDirectory,
      installedBin,
      emptyPath,
      packFiles: packed.files.map((file) => file.path),
      dryRunFiles: dryRun.files.map((file) => file.path),
      packageRequire: createRequire(join(installRoot, 'package.json')),
    };
  } catch (error) {
    process.removeListener('exit', emergencyCleanup);
    await requireOwnedIntegrationRunRoot();
    assertOwnedFixtureRoot();
    await rmAsync(root, { recursive: true, force: true });
    throw error;
  }
}

export function getCleanInstallFixture(): Promise<PackageFixture> {
  const integrationGlobal = globalThis as IntegrationGlobal;
  integrationGlobal.__aimeAcpPackageFixture ??= buildFixture();
  return integrationGlobal.__aimeAcpPackageFixture;
}

export async function isolatedRuntime(
  fixture: PackageFixture,
  label: string,
): Promise<{ readonly home: string; readonly env: NodeJS.ProcessEnv }> {
  const home = await mkdtempAsync(join(fixture.root, `${label}-home-`));
  const temporaryDirectory = join(home, 'tmp');
  const xdgDirectory = join(home, '.xdg');
  await Promise.all([
    mkdirAsync(temporaryDirectory, { recursive: true }),
    mkdirAsync(xdgDirectory, { recursive: true }),
  ]);
  return {
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: join(xdgDirectory, 'cache'),
      XDG_CONFIG_HOME: join(xdgDirectory, 'config'),
      XDG_DATA_HOME: join(xdgDirectory, 'data'),
      XDG_STATE_HOME: join(xdgDirectory, 'state'),
      LANG: 'C.UTF-8',
      PATH: fixture.emptyPath,
      TMPDIR: temporaryDirectory,
    },
  };
}

export async function runInstalled(
  fixture: PackageFixture,
  argv: readonly string[],
  options: {
    readonly label: string;
    readonly fakeScenario?: unknown;
    readonly stdin?: string;
    readonly timeoutMs?: number;
  },
): Promise<ProcessResult> {
  const runtime = await isolatedRuntime(fixture, options.label);
  const nodeArguments =
    options.fakeScenario === undefined
      ? [fixture.installedBin, ...argv]
      : [
          '--experimental-loader',
          fakeLoaderPath,
          fixture.installedBin,
          ...argv,
        ];
  return runProcess(process.execPath, nodeArguments, {
    cwd: runtime.home,
    env: runtime.env,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.fakeScenario === undefined
      ? {}
      : { fd3: JSON.stringify(options.fakeScenario) }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });
}

export async function installedEntries(
  fixture: PackageFixture,
): Promise<readonly string[]> {
  return readdirAsync(fixture.installedPackageDirectory);
}

export async function installedJson(
  fixture: PackageFixture,
  packageName: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (packageName === 'aime-acp') {
    return JSON.parse(
      await readFileAsync(
        join(fixture.installedPackageDirectory, 'package.json'),
        'utf8',
      ),
    ) as Readonly<Record<string, unknown>>;
  }
  fixture.packageRequire.resolve(packageName);
  return JSON.parse(
    await readFileAsync(
      join(
        fixture.installRoot,
        'node_modules',
        ...packageName.split('/'),
        'package.json',
      ),
      'utf8',
    ),
  ) as Readonly<Record<string, unknown>>;
}

export { packageDirectory };
