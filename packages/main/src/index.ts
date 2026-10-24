import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { registerIpcHandlers } from './ipc/index.js';
import { IPC_CHANNELS } from './config/constants.js';
import { defaultSettingsPath, SettingsStore } from './config/settings.js';
import { RuntimeSupervisor } from './runtime/supervisor.js';
import { resolveRuntimeTransportMode, type RuntimeTransportMode } from './runtime/transport-mode.js';
import { RendererTransport } from './runtime/renderer-transport.js';
import { createMainWindow, resolvePreloadPath, resolveRendererFile } from './windows/main-window.js';

/**
 * 主进程入口。
 *
 * 职责：窗口、宿主能力、容器编排、协议中转。
 * **不执行任何 agent 动作**——agent 一律在容器里跑。
 */

let mainWindow: BrowserWindow | undefined;
let supervisor: RuntimeSupervisor | undefined;
let transportMode: RuntimeTransportMode = 'direct';

const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'];

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function bootstrap(): Promise<void> {
  const settings = new SettingsStore(defaultSettingsPath(app.getPath('userData')));

  transportMode = resolveRuntimeTransportMode({
    argv: process.argv,
    env: process.env,
    buildEnv: app.isPackaged ? 'prod' : 'dev',
    isInternalBuild: false,
    warn: log,
  });

  // protocol 调试模式需要提前注册特权 scheme。
  const probe = new RendererTransport({ mode: transportMode, sendToRuntime: () => undefined, onRuntimeFrame: () => undefined });
  probe.registerProtocolScheme();

  mainWindow = createMainWindow({
    preloadPath: resolvePreloadPath(),
    rendererFile: resolveRendererFile(),
    ...(DEV_SERVER_URL ? { devServerUrl: DEV_SERVER_URL } : {}),
  });

  supervisor = new RuntimeSupervisor({
    settings: settings.read(),
    entry: '/opt/agent-desktop/runtime/agent-runtime.mjs',
    mode: transportMode,
    onLog: log,
    onStatus: (status, detail) => log(`[container] ${status}${detail ? ` ${detail}` : ''}`),
  });

  registerIpcHandlers({
    supervisor,
    settings,
    getMode: () => transportMode,
    getWindow: () => mainWindow,
  });

  if (transportMode === 'protocol') {
    supervisor.rendererTransport?.handleProtocolRequests();
  }

  // 渲染层就绪后再起容器，避免启动顺序竞态。
  mainWindow.webContents.once('did-finish-load', () => {
    void supervisor?.start(mainWindow as BrowserWindow).catch((error: unknown) => {
      log(`[runtime] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow({
        preloadPath: resolvePreloadPath(),
        rendererFile: resolveRendererFile(),
        ...(DEV_SERVER_URL ? { devServerUrl: DEV_SERVER_URL } : {}),
      });
    }
  });
}

app.whenReady().then(bootstrap).catch((error: unknown) => {
  log(`[main] 启动失败: ${error instanceof Error ? error.stack : String(error)}`);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void supervisor?.stop();
});

process.on('uncaughtException', (error) => {
  log(`[main] uncaught: ${error.stack ?? error.message}`);
});

export { IPC_CHANNELS, join };
