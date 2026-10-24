/**
 * 运行时传输模式。
 *
 * - `direct`：主进程用 MessagePort 把运行时通道直接交给渲染层（默认）。
 * - `protocol`：渲染层改用 `app://` 自定义协议发请求，运行时请求会出现在
 *   Chromium DevTools 的 Network 面板里，便于调试。
 *
 * 两种模式对上层是同一套帧协议，切换不需要改服务层。
 */
export const RUNTIME_TRANSPORT_FLAG = '--runtime-transport=';

export type RuntimeTransportMode = 'direct' | 'protocol';

/**
 * protocol 调试模式的准入门禁。
 *
 * 主进程解析与菜单开关必须共用这个判定，否则两边的标准会漂移。
 */
export function isRuntimeProtocolTransportAllowed(options: {
  buildEnv: string;
  isInternalBuild: boolean;
}): boolean {
  const env = options.buildEnv;
  if (env === 'dev' || env === 'development' || env === 'test' || env === 'staging') return true;
  return env === 'prod' && options.isInternalBuild;
}

export function resolveRuntimeTransportMode(options: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  buildEnv: string;
  isInternalBuild: boolean;
  warn?: (message: string) => void;
}): RuntimeTransportMode {
  const cliValue = options.argv
    .find((arg) => arg.startsWith(RUNTIME_TRANSPORT_FLAG))
    ?.slice(RUNTIME_TRANSPORT_FLAG.length)
    .trim();
  const requested = cliValue ?? options.env['MAVIS_RUNTIME_TRANSPORT']?.trim() ?? 'direct';

  if (requested !== 'direct' && requested !== 'protocol') {
    options.warn?.(`[RuntimeTransport] 无效模式 "${requested}"，回退到 direct`);
    return 'direct';
  }
  if (requested === 'protocol' && !isRuntimeProtocolTransportAllowed(options)) {
    options.warn?.('[RuntimeTransport] 当前构建不允许 protocol 模式，回退到 direct');
    return 'direct';
  }
  return requested;
}
