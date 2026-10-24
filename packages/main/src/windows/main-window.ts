import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import {
  DEFAULT_SECURE_WEB_PREFERENCES,
  MAIN_WINDOW_HEIGHT,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  MAIN_WINDOW_TITLE,
  MAIN_WINDOW_WIDTH,
} from '../config/constants.js';

/**
 * 主窗口。
 *
 * 安全默认集中在一处：nodeIntegration 关、contextIsolation 开、sandbox 开。
 * 渲染层只通过 preload 暴露的最小接口与宿主打交道。
 */
export interface MainWindowOptions {
  preloadPath: string;
  rendererFile: string;
  devServerUrl?: string;
  /** 传输模式：direct 时把端口交给渲染层。 */
  onReady?: (window: BrowserWindow) => void;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: MAIN_WINDOW_WIDTH,
    height: MAIN_WINDOW_HEIGHT,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    title: MAIN_WINDOW_TITLE,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: {
      ...DEFAULT_SECURE_WEB_PREFERENCES,
      preload: options.preloadPath,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // 外部链接一律交给系统浏览器，不在应用内开窗。
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl);
  } else {
    void window.loadFile(options.rendererFile);
  }

  options.onReady?.(window);
  return window;
}

/** 生产环境下渲染层的入口文件。 */
export function resolveRendererFile(): string {
  return join(__dirname, '../renderer/index.html');
}

/** 预加载脚本路径。 */
export function resolvePreloadPath(): string {
  return join(__dirname, '../preload/index.js');
}
