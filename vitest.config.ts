import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@agent-desktop/app-server-protocol': resolve('packages/app-server-protocol/src/index.ts'),
      '@agent-desktop/agent-host': resolve('packages/agent-host/src/index.ts'),
      '@agent-desktop/runtime': resolve('packages/runtime/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
