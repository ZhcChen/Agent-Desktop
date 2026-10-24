/**
 * 主进程常量。
 *
 * IPC 通道一律 `namespace:action` 命名，便于按域检索与授权审计。
 * 注意：Electron IPC 只承载**宿主能力**（窗口、文件、容器、设置），
 * 不承载 agent 语义——agent 语义走 app-server 协议。
 */
export const IPC_CHANNELS = {
  // 运行时传输
  RUNTIME_TRANSPORT_REQUEST_PORT: 'runtime-transport:request-port',
  RUNTIME_TRANSPORT_GET_CURRENT: 'runtime-transport:get-current',
  RUNTIME_TRANSPORT_REQUEST_SWITCH: 'runtime-transport:request-switch',
  RUNTIME_TRANSPORT_LOST: 'runtime-transport:lost',

  // 容器编排
  CONTAINER_STATUS: 'container:status',
  CONTAINER_RESTART: 'container:restart',
  CONTAINER_LOGS: 'container:logs',

  // 宿主能力
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',

  HOST_PICK_DIRECTORY: 'host:pick-directory',
  HOST_OPEN_PATH: 'host:open-path',

  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * 窗口安全默认。
 *
 * 集中成常量，避免每个窗口各写一份而慢慢漂移。
 */
export const DEFAULT_SECURE_WEB_PREFERENCES = {
  nodeIntegration: false,
  contextIsolation: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  sandbox: true,
} as const;

export const MAIN_WINDOW_TITLE = 'Agent Desktop';
export const MAIN_WINDOW_WIDTH = 1280;
export const MAIN_WINDOW_HEIGHT = 840;
export const MAIN_WINDOW_MIN_WIDTH = 960;
export const MAIN_WINDOW_MIN_HEIGHT = 600;
