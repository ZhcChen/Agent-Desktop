import type { ServiceFrame } from '@agent-desktop/app-server-protocol';

/**
 * 渲染层侧的帧传输。
 *
 * 两种实现对应主进程的两种模式：
 * - `DirectTransport`：MessagePort，帧是结构化对象；
 * - `ProtocolTransport`：app:// 请求 + SSE 事件流，可在 DevTools 里观察。
 */
export interface FrameTransport {
  send(frame: ServiceFrame): void;
  onFrame(listener: (frame: ServiceFrame) => void): () => void;
  close(): void;
}

declare global {
  interface Window {
    runtimeTransportAPI?: {
      requestPort(): Promise<{ granted: boolean; mode: 'direct' | 'protocol' }>;
      post(frame: ServiceFrame): void;
      subscribe(listener: (frame: ServiceFrame) => void): () => void;
      subscribeLost(listener: () => void): () => void;
    };
    hostAPI?: {
      pickDirectory(): Promise<{ canceled: boolean; path?: string }>;
      openPath(path: string): Promise<{ ok: boolean }>;
      getSettings(): Promise<{ workspaces: string[]; image: string; containerHost: string }>;
      setSettings(patch: unknown): Promise<unknown>;
    };
    windowControlsAPI?: {
      minimize(): void;
      toggleMaximize(): void;
      close(): void;
      isMaximized(): Promise<boolean>;
    };
  }
}

/** MessagePort 直连（端口由 preload 持有，渲染层只经 API 收发）。 */
export class DirectTransport implements FrameTransport {
  constructor(private readonly api: NonNullable<Window['runtimeTransportAPI']>) {}

  send(frame: ServiceFrame): void {
    this.api.post(frame);
  }

  onFrame(listener: (frame: ServiceFrame) => void): () => void {
    return this.api.subscribe(listener);
  }

  close(): void {
    // 端口生命周期由 preload 管理。
  }
}

/** app:// 协议模式（调试用）。 */
export class ProtocolTransport implements FrameTransport {
  private readonly listeners = new Set<(frame: ServiceFrame) => void>();
  private source: EventSource | undefined;

  constructor() {
    this.source = new EventSource('app://agent-desktop/events');
    this.source.onmessage = (event: MessageEvent<string>): void => {
      try {
        const frame = JSON.parse(event.data) as ServiceFrame;
        for (const listener of [...this.listeners]) listener(frame);
      } catch {
        // 忽略无法解析的事件。
      }
    };
  }

  send(frame: ServiceFrame): void {
    void fetch('app://agent-desktop/runtime', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(frame),
    }).catch(() => undefined);
  }

  onFrame(listener: (frame: ServiceFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.source?.close();
    this.listeners.clear();
  }
}
