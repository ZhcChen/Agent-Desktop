import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ServiceFrame } from '@agent-desktop/app-server-protocol';

/**
 * 预加载脚本。
 *
 * 暴露面刻意做小：渲染层只需要「传输口」和「宿主能力」两类东西。
 * agent 语义不在这里——它走 app-server 协议。
 */

const RUNTIME_TRANSPORT_REQUEST_PORT = 'runtime-transport:request-port';
const RUNTIME_TRANSPORT_LOST = 'runtime-transport:lost';

/** 端口就绪通知。 */
let notifyPortReady: (() => void) | undefined;
let runtimePort: MessagePort | undefined;
/** 帧订阅者。端口就绪前后都能注册，避免竞态丢订阅。 */
const frameListeners = new Set<(frame: ServiceFrame) => void>();

ipcRenderer.on(RUNTIME_TRANSPORT_REQUEST_PORT, (event: IpcRendererEvent) => {
  const port = event.ports[0];
  if (!port) return;
  runtimePort?.close();
  runtimePort = port;
  runtimePort.addEventListener('message', (message: MessageEvent) => {
    const frame = message.data as ServiceFrame;
    for (const listener of [...frameListeners]) {
      try {
        listener(frame);
      } catch {
        // 单个订阅者异常不能打断其他订阅者。
      }
    }
  });
  runtimePort.start();
  notifyPortReady?.();
  notifyPortReady = undefined;
});

ipcRenderer.on(RUNTIME_TRANSPORT_LOST, () => {
  runtimePort?.close();
  runtimePort = undefined;
});

const runtimeTransportAPI = {
  /**
   * 申请传输通道。
   *
   * direct 模式返回 MessagePort；protocol 模式不分配端口，
   * 由渲染层改走 app:// 请求。
   */
  requestPort: async (): Promise<{ granted: boolean; mode: 'direct' | 'protocol' }> => {
    const result = (await ipcRenderer.invoke('runtime-transport:request-port')) as {
      granted: boolean;
      mode: 'direct' | 'protocol';
    };
    if (!result.granted) return result;
    if (!runtimePort) {
      await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(runtimePort !== undefined), 10_000);
        notifyPortReady = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
    }
    return result;
  },

  /** 发送一帧。 */
  post: (frame: ServiceFrame): void => {
    if (!runtimePort) throw new Error('runtime transport port unavailable');
    runtimePort.postMessage(frame);
  },

  /** 订阅来自运行时的帧。 */
  subscribe: (listener: (frame: ServiceFrame) => void): (() => void) => {
    frameListeners.add(listener);
    return () => frameListeners.delete(listener);
  },

  /** 订阅通道丢失。 */
  subscribeLost: (listener: () => void): (() => void) => {
    const handler = (): void => listener();
    ipcRenderer.on(RUNTIME_TRANSPORT_LOST, handler);
    return () => ipcRenderer.removeListener(RUNTIME_TRANSPORT_LOST, handler);
  },
};

const hostAPI = {
  pickDirectory: () => ipcRenderer.invoke('host:pick-directory') as Promise<{ canceled: boolean; path?: string }>,
  openPath: (path: string) => ipcRenderer.invoke('host:open-path', path) as Promise<{ ok: boolean }>,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
};

const windowControlsAPI = {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
};

contextBridge.exposeInMainWorld('runtimeTransportAPI', runtimeTransportAPI);
contextBridge.exposeInMainWorld('hostAPI', hostAPI);
contextBridge.exposeInMainWorld('windowControlsAPI', windowControlsAPI);
