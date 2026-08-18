import {
  createOwnedIntegrationRunRoot,
  emergencyRemoveOwnedIntegrationRunRoot,
  INTEGRATION_RUN_OWNER_ENV,
  INTEGRATION_RUN_ROOT_ENV,
  isIntegrationLifecycle,
  removeOwnedIntegrationRunRoot,
} from './run-root.js';

export default async function setupIntegrationRunRoot(): Promise<
  (() => Promise<void>) | undefined
> {
  if (!isIntegrationLifecycle()) return undefined;
  if (
    process.env[INTEGRATION_RUN_ROOT_ENV] !== undefined ||
    process.env[INTEGRATION_RUN_OWNER_ENV] !== undefined
  ) {
    throw new Error('integration run root ownership is already configured');
  }

  const owned = await createOwnedIntegrationRunRoot();
  process.env[INTEGRATION_RUN_ROOT_ENV] = owned.root;
  process.env[INTEGRATION_RUN_OWNER_ENV] = owned.ownerId;
  const emergencyCleanup = (): void => {
    emergencyRemoveOwnedIntegrationRunRoot(owned);
  };
  process.once('exit', emergencyCleanup);

  return async () => {
    await removeOwnedIntegrationRunRoot(owned);
    process.removeListener('exit', emergencyCleanup);
    if (process.env[INTEGRATION_RUN_ROOT_ENV] === owned.root) {
      delete process.env[INTEGRATION_RUN_ROOT_ENV];
    }
    if (process.env[INTEGRATION_RUN_OWNER_ENV] === owned.ownerId) {
      delete process.env[INTEGRATION_RUN_OWNER_ENV];
    }
  };
}
