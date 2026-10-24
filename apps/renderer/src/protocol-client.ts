import {
  type ServiceEventFrame,
  type ServiceFrame,
  type ServiceResponseFrame,
} from '@agent-desktop/app-server-protocol';
import type { FrameTransport } from './transport.js';

/**
 * 协议客户端。
 *
 * 渲染层**直接**使用 app-server 协议，不经 Electron IPC 承载 agent 语义。
 */
export class ProtocolClient {
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly eventListeners = new Set<(frame: ServiceEventFrame) => void>();
  private counter = 0;

  constructor(private readonly transport: FrameTransport) {
    transport.onFrame((frame) => this.onFrame(frame));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.counter += 1;
    const id = `r${this.counter}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.transport.send({ type: 'request', id, method, ...(params !== undefined ? { params } : {}) });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Request timed out: ${method}`));
      }, 30_000);
    });
  }

  onEvent(listener: (frame: ServiceEventFrame) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private onFrame(frame: ServiceFrame): void {
    if (frame.type === 'response') {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.result);
      else entry.reject(new Error(frame.error?.message ?? 'Unknown error'));
      return;
    }
    if (frame.type === 'event') {
      for (const listener of [...this.eventListeners]) {
        try {
          listener(frame);
        } catch {
          // 订阅者异常不影响其他订阅者。
        }
      }
    }
  }
}
