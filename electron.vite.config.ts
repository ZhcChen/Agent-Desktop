import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@agent-desktop/app-server-protocol': resolve('packages/app-server-protocol/src/index.ts'),
  '@agent-desktop/agent-host': resolve('packages/agent-host/src/index.ts'),
  '@agent-desktop/runtime': resolve('packages/runtime/src/index.ts'),
};

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve('packages/main/src/index.ts') },
      },
    },
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve('packages/preload/src/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve('apps/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      outDir: resolve('out/renderer'),
      rollupOptions: {
        input: { index: resolve('apps/renderer/index.html') },
      },
    },
  },
});
