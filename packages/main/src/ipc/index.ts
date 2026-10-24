import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../config/constants.js';
import type { SettingsStore } from '../config/settings.js';
import type { RuntimeSupervisor } from '../runtime/supervisor.js';
import type { RuntimeTransportMode } from '../runtime/transport-mode.js';

/**
 * IPC 注册。
 *
 * 这里只放**宿主能力**：窗口控制、目录选择、设置、容器状态、传输端口。
 * agent 语义一律不走 Electron IPC。
 */

/**
 * 发送方校验：只接受主框架发来的请求。
 *
 * 渲染层里的 iframe / miniapp 若能调到宿主能力，就是越权。
 */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (frame && frame.parent !== null) {
    throw new Error('IPC request from a non-main frame is rejected.');
  }
}

export interface IpcContext {
  supervisor: RuntimeSupervisor;
  settings: SettingsStore;
  getMode: () => RuntimeTransportMode;
  getWindow: () => BrowserWindow | undefined;
}

export function registerIpcHandlers(context: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.RUNTIME_TRANSPORT_REQUEST_PORT, (event) => {
    assertTrustedSender(event);
    const port = context.supervisor.grantPort();
    if (!port) return { granted: false, mode: context.getMode() };
    event.sender.postMessage(IPC_CHANNELS.RUNTIME_TRANSPORT_REQUEST_PORT, null, [port]);
    return { granted: true, mode: context.getMode() };
  });

  ipcMain.handle(IPC_CHANNELS.RUNTIME_TRANSPORT_GET_CURRENT, (event) => {
    assertTrustedSender(event);
    return { mode: context.getMode(), supported: context.getMode() === 'protocol' };
  });

  ipcMain.handle(IPC_CHANNELS.CONTAINER_STATUS, (event) => {
    assertTrustedSender(event);
    return { status: context.supervisor.status };
  });

  ipcMain.handle(IPC_CHANNELS.CONTAINER_RESTART, async (event) => {
    assertTrustedSender(event);
    const window = context.getWindow();
    if (!window) return { ok: false, error: 'no_window' };
    await context.supervisor.stop();
    await context.supervisor.start(window);
    return { ok: true, status: context.supervisor.status };
  });

  ipcMain.handle(IPC_CHANNELS.HOST_PICK_DIRECTORY, async (event) => {
    assertTrustedSender(event);
    const window = context.getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const path = result.filePaths[0] as string;
    context.settings.addWorkspace(path);
    return { canceled: false, path };
  });

  ipcMain.handle(IPC_CHANNELS.HOST_OPEN_PATH, (event, path: unknown) => {
    assertTrustedSender(event);
    if (typeof path !== 'string' || !path) return { ok: false };
    void import('electron').then(({ shell }) => shell.openPath(path));
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, (event) => {
    assertTrustedSender(event);
    return context.settings.read();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (event, patch: unknown) => {
    assertTrustedSender(event);
    if (!patch || typeof patch !== 'object') return context.settings.read();
    const record = patch as Record<string, unknown>;
    const next: { workspaces?: string[]; image?: string; containerHost?: string } = {};
    if (Array.isArray(record['workspaces'])) {
      next.workspaces = record['workspaces'].filter((item): item is string => typeof item === 'string');
    }
    if (typeof record['image'] === 'string') next.image = record['image'];
    if (typeof record['containerHost'] === 'string') next.containerHost = record['containerHost'];
    return context.settings.write(next);
  });

  ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, (event) => {
    assertTrustedSender(event);
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, (event) => {
    assertTrustedSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, (event) => {
    assertTrustedSender(event);
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, (event) => {
    assertTrustedSender(event);
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
}
