import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const INTEGRATION_RUN_ROOT_ENV = 'AIME_ACP_INTEGRATION_RUN_ROOT';
export const INTEGRATION_RUN_OWNER_ENV = 'AIME_ACP_INTEGRATION_RUN_OWNER';

const runPrefix = 'aime-acp-integration-run-';
const sentinelName = '.aime-acp-integration-run.json';
const sentinelKind = 'aime-acp-integration-run';

interface RunSentinel {
  readonly kind: typeof sentinelKind;
  readonly version: 1;
  readonly ownerId: string;
  readonly rootName: string;
}

export interface OwnedIntegrationRunRoot {
  readonly root: string;
  readonly ownerId: string;
}

export function isIntegrationLifecycle(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    environment.npm_lifecycle_event === 'test:integration' ||
    environment.npm_lifecycle_event === 'verify:package'
  );
}

function assertSafeRunRootPath(root: string): void {
  if (root !== resolve(root)) {
    throw new Error('integration run root must be an absolute normalized path');
  }
  const rootName = basename(root);
  if (
    !rootName.startsWith(runPrefix) ||
    rootName.length === runPrefix.length ||
    dirname(root) !== resolve(tmpdir())
  ) {
    throw new Error(
      'integration run root is outside the owned temporary boundary',
    );
  }
  for (const home of [process.env.HOME, process.env.USERPROFILE]) {
    if (home !== undefined && home !== '' && resolve(home) === root) {
      throw new Error('integration run root must never be HOME');
    }
  }
}

function parseSentinel(raw: string): RunSentinel {
  const value = JSON.parse(raw) as Partial<RunSentinel>;
  if (
    value.kind !== sentinelKind ||
    value.version !== 1 ||
    typeof value.ownerId !== 'string' ||
    value.ownerId === '' ||
    typeof value.rootName !== 'string'
  ) {
    throw new Error('integration run root sentinel is invalid');
  }
  return value as RunSentinel;
}

function assertSentinel(
  root: string,
  ownerId: string,
  sentinel: RunSentinel,
): void {
  if (sentinel.ownerId !== ownerId || sentinel.rootName !== basename(root)) {
    throw new Error(
      'integration run root ownership does not match its sentinel',
    );
  }
}

export async function validateOwnedIntegrationRunRoot(
  root: string,
  ownerId: string,
): Promise<void> {
  assertSafeRunRootPath(root);
  const [rootInfo, canonicalRoot, canonicalTemp, rawSentinel] =
    await Promise.all([
      lstat(root),
      realpath(root),
      realpath(tmpdir()),
      readFile(join(root, sentinelName), 'utf8'),
    ]);
  if (!rootInfo.isDirectory() || dirname(canonicalRoot) !== canonicalTemp) {
    throw new Error('integration run root is not an owned temporary directory');
  }
  assertSentinel(root, ownerId, parseSentinel(rawSentinel));
}

export function validateOwnedIntegrationRunRootSync(
  root: string,
  ownerId: string,
): void {
  assertSafeRunRootPath(root);
  const rootInfo = lstatSync(root);
  if (
    !rootInfo.isDirectory() ||
    dirname(realpathSync(root)) !== realpathSync(tmpdir())
  ) {
    throw new Error('integration run root is not an owned temporary directory');
  }
  assertSentinel(
    root,
    ownerId,
    parseSentinel(readFileSync(join(root, sentinelName), 'utf8')),
  );
}

export async function createOwnedIntegrationRunRoot(): Promise<OwnedIntegrationRunRoot> {
  const root = await mkdtemp(join(resolve(tmpdir()), runPrefix));
  const ownerId = randomUUID();
  try {
    const sentinel: RunSentinel = {
      kind: sentinelKind,
      version: 1,
      ownerId,
      rootName: basename(root),
    };
    await writeFile(join(root, sentinelName), `${JSON.stringify(sentinel)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await validateOwnedIntegrationRunRoot(root, ownerId);
    return { root, ownerId };
  } catch (error) {
    assertSafeRunRootPath(root);
    await unlink(join(root, sentinelName)).catch((cleanupError: unknown) => {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw cleanupError;
      }
    });
    await rmdir(root);
    throw error;
  }
}

export async function removeOwnedIntegrationRunRoot(
  owned: OwnedIntegrationRunRoot,
): Promise<void> {
  await validateOwnedIntegrationRunRoot(owned.root, owned.ownerId);
  await rm(owned.root, { recursive: true, force: false });
  if (existsSync(owned.root)) {
    throw new Error('integration run root still exists after cleanup');
  }
}

export function emergencyRemoveOwnedIntegrationRunRoot(
  owned: OwnedIntegrationRunRoot,
): void {
  try {
    validateOwnedIntegrationRunRootSync(owned.root, owned.ownerId);
    rmSync(owned.root, { recursive: true, force: false });
  } catch {
    // Main teardown owns the awaited path; process exit is best-effort only.
  }
}

export async function requireOwnedIntegrationRunRoot(): Promise<OwnedIntegrationRunRoot> {
  const root = process.env[INTEGRATION_RUN_ROOT_ENV];
  const ownerId = process.env[INTEGRATION_RUN_OWNER_ENV];
  if (
    root === undefined ||
    root === '' ||
    ownerId === undefined ||
    ownerId === ''
  ) {
    throw new Error(
      'integration package fixture requires npm run test:integration or npm run verify:package',
    );
  }
  const owned = { root, ownerId };
  await validateOwnedIntegrationRunRoot(owned.root, owned.ownerId);
  return owned;
}

export function requireOwnedIntegrationRunRootSync(): OwnedIntegrationRunRoot {
  const root = process.env[INTEGRATION_RUN_ROOT_ENV];
  const ownerId = process.env[INTEGRATION_RUN_OWNER_ENV];
  if (
    root === undefined ||
    root === '' ||
    ownerId === undefined ||
    ownerId === ''
  ) {
    throw new Error('integration run root ownership is unavailable');
  }
  const owned = { root, ownerId };
  validateOwnedIntegrationRunRootSync(owned.root, owned.ownerId);
  return owned;
}
