import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    globalSetup: ['./test/integration/global-setup.ts'],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
