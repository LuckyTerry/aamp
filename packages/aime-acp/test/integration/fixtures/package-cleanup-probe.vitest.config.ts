import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/integration/global-setup.ts'],
    include: ['test/integration/fixtures/package-cleanup-probe.fixture.ts'],
  },
});
