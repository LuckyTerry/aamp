import { writeFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { getCleanInstallFixture } from '../package-fixture.js';

it('records the integration run and package fixture roots', async () => {
  const fixture = await getCleanInstallFixture();
  const statePath = process.env.AIME_ACP_CLEANUP_PROBE_STATE;
  if (statePath === undefined || statePath === '') {
    throw new Error('AIME_ACP_CLEANUP_PROBE_STATE is required');
  }
  await writeFile(
    statePath,
    `${JSON.stringify({
      runRoot: process.env.AIME_ACP_INTEGRATION_RUN_ROOT ?? null,
      fixtureRoot: fixture.root,
    })}\n`,
    { mode: 0o600 },
  );
  expect(process.env.AIME_ACP_CLEANUP_PROBE_FAIL).not.toBe('1');
});
