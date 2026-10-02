import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    env: {
      MESH_ADAPTER: 'mock',
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      ADMIN_TOKEN: 'test-admin',
      EPOCH_CRON: 'off',
      LOG_LEVEL: 'silent',
    },
  },
});
