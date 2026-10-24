import { build } from 'esbuild';
import { resolve } from 'node:path';

/**
 * 构建容器内运行时。
 *
 * 与 Electron 主进程分开构建：这份产物是纯 Node 脚本，跑在容器里，
 * 通过 stdio 说 app-server 协议。
 *
 * pi 保持为外部依赖：镜像里单独安装（npm i），运行时就地从
 * /opt/agent-desktop/node_modules 解析——打包进来会带来 wasm 与原生资源问题。
 */
await build({
  entryPoints: [resolve('packages/runtime/src/entry.ts')],
  outfile: resolve('out/runtime/agent-runtime.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  external: ['@earendil-works/pi-coding-agent'],
  alias: {
    '@agent-desktop/app-server-protocol': resolve('packages/app-server-protocol/src/index.ts'),
    '@agent-desktop/agent-host': resolve('packages/agent-host/src/index.ts'),
  },
});
