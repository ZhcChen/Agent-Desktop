import { MessageChannelMain, type BrowserWindow, protocol, net } from 'electron';
import { Readable } from 'node:stream';
import type { ServiceFrame, ServiceRequestFrame, ServiceResponseFrame } from '@agent-desktop/app-server-protocol';
import { IPC_CHANNELS } from '../config/constants.js';
import type { RuntimeTransportMode } from './transport-mode.js';

/**
 * 渲染层传输。
 *
 * - `direct`（默认）：主进程用 MessageChannel 把端口直接交给渲染层，
 *   帧是结构化对象，Uint8Array 零拷贝。
 * - `protocol`（调试）：渲染层改用 `app://` 发请求，运行时请求会出现在
 *   Chromium DevTools 的 Network 面板里。
 *
 * 两种模式对上层是同一套帧协议。
 */

export interface RendererTransportOptions {
  mode: RuntimeTransportMode;
  /** 把帧发给容器。 */
  sendToRuntime: (frame: ServiceFrame) => void;
  /** 容器来的帧，广播给渲染层。 */
  onRuntimeFrame: (frame: ServiceFrame) => void;
}

export class RendererTransport {
  private readonly pending = new Map<string, (frame: ServiceResponseFrame) => void>();
  private readonly eventClients = new Set<Readable>();
  private counter = 0;

  constructor(private readonly options: RendererTransportOptions) {}

  /** 渲染层请求端口（direct 模式）。 */
  createPortPair(): { port: Electron.MessagePortMain } {
    const { port1, port2 } = new MessageChannelMain();
    port1.on('message', (event: { data: ServiceFrame }) => {
      this.options.sendToRuntime(event.data);
    });
    return { port: port2 };
  }

  /** 把容器来的帧分发给渲染层。 */
  dispatch(frame: ServiceFrame): void {
    if (frame.type === 'response') {
      const resolver = this.pending.get(frame.id);
      if (resolver) {
        this.pending.delete(frame.id);
        resolver(frame);
        return;
      }
    }
    this.options.onRuntimeFrame(frame);
    this.broadcastEvent(frame);
  }

  /* ---------------- protocol 调试模式 ---------------- */

  /** 注册 app:// 协议处理。 */
  registerProtocolScheme(): void {
    if (!protocol.isProtocolHandled('app')) {
      protocol.registerSchemesAsPrivileged([
        { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
      ]);
    }
  }

  handleProtocolRequests(): void {
    protocol.handle('app', (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'agent-desktop') return new Response('Not found', { status: 404 });
      if (url.pathname === '/runtime') return this.handleRuntimeRequest(request);
      if (url.pathname === '/events') return this.handleEventStream();
      return new Response('Not found', { status: 404 });
    });
  }

  private handleRuntimeRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Promise.resolve(new Response('Method not allowed', { status: 405 }));
    }
    const frame: ServiceRequestFrame = {
      type: 'request',
      id: `app_${(this.counter += 1)}`,
      method: '',
    };

    return new Promise<Response>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pending.delete(frame.id);
        resolve(
          new Response(
            JSON.stringify({
              type: 'response',
              id: frame.id,
              ok: false,
              error: { code: -32001, message: 'Runtime request timed out.' },
            }),
            { status: 504, headers: { 'content-type': 'application/json' } },
          ),
        );
      }, 30_000);

      this.pending.set(frame.id, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(
          new Response(JSON.stringify(response), {
            status: response.ok ? 200 : 500,
            headers: { 'content-type': 'application/json' },
          }),
        );
      });

      void request
        .text()
        .then((body) => {
          const parsed = JSON.parse(body) as { method?: string; params?: unknown; id?: string };
          frame.method = parsed.method ?? '';
          if (parsed.params !== undefined) frame.params = parsed.params;
          if (parsed.id) frame.id = parsed.id;
          this.options.sendToRuntime(frame);
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pending.delete(frame.id);
          resolve(new Response(String(error), { status: 400 }));
        });
    });
  }

  private handleEventStream(): Response {
    const stream = new Readable({
      read(): void {
        // 数据由 broadcastEvent 推送。
      },
    });
    this.eventClients.add(stream);
    stream.on('close', () => {
      this.eventClients.delete(stream);
    });
    return new Response(stream as unknown as BodyInit, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  private broadcastEvent(frame: ServiceFrame): void {
    if (this.eventClients.size === 0) return;
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const client of this.eventClients) {
      try {
        client.push(payload);
      } catch {
        this.eventClients.delete(client);
      }
    }
  }

  /** 通知渲染层端口已丢失。 */
  notifyPortLost(window: BrowserWindow): void {
    window.webContents.send(IPC_CHANNELS.RUNTIME_TRANSPORT_LOST);
  }

  /** 供调试使用：走 Chromium 网络栈发请求（可被 DevTools 观察）。 */
  static async fetchOverProtocol(url: string, body: unknown): Promise<unknown> {
    const response = await net.fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    return response.json();
  }
}
