import {
  APP_SERVER_INITIALIZE_METHOD,
  APP_SERVER_TUNNEL_METHOD,
  type ServiceFrame,
  type WireMessage,
  WireDecoder,
  serializeWireMessage,
} from '@agent-desktop/app-server-protocol';

/**
 * 容器 ↔ 协议 的连接。
 *
 * 主进程在这里做两件事：
 * 1. 终结容器侧的线级协议（JSONL over stdio），把隧道帧解出来；
 * 2. 把渲染层送来的帧重新编码回容器。
 *
 * 也就是说：**主进程是协议感知的中转**，容器与渲染层互相看不到对方的实现。
 */
export interface AppServerLinkOptions {
  /** 容器 stdout。 */
  input: NodeJS.ReadableStream;
  /** 容器 stdin。 */
  output: NodeJS.WritableStream;
  /** 隧道帧出口（转发给渲染层）。 */
  onFrame: (frame: ServiceFrame) => void;
  /** 握手完成。 */
  onReady?: () => void;
  /** 链路错误。 */
  onError?: (error: Error) => void;
}

export class AppServerLink {
  private readonly decoder = new WireDecoder();
  private ready = false;
  private nextRequestId = 0;
  private readonly pending = new Map<string, (result: unknown) => void>();

  constructor(private readonly options: AppServerLinkOptions) {}

  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    this.options.input.on('data', (chunk: Buffer) => {
      this.onChunk(chunk);
    });
    this.options.input.on('error', (error: Error) => {
      this.options.onError?.(error);
    });
    this.sendInitialize();
  }

  /** 喂入容器 stdout 的原始字节。 */
  onChunk(chunk: Buffer): void {
    let items;
    try {
      items = this.decoder.push(new Uint8Array(chunk));
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const item of items) {
      if (item.message) this.onMessage(item.message);
    }
  }

  private onMessage(message: WireMessage): void {
    if ('method' in message && typeof message.method === 'string') {
      if (message.method === APP_SERVER_TUNNEL_METHOD) {
        const frame = message.params as ServiceFrame | undefined;
        if (frame && typeof frame.type === 'string') {
          if (frame.type === 'response') {
            const resolver = this.pending.get(frame.id);
            if (resolver) {
              this.pending.delete(frame.id);
              if (frame.ok) resolver(frame.result);
              else resolver(frame.error ?? { code: -32603, message: 'Unknown error' });
              return;
            }
          }
          this.options.onFrame(frame);
        }
      }
      return;
    }
    // JSON-RPC 响应：握手结果。
    if ('result' in message && !this.ready) {
      this.ready = true;
      this.options.onReady?.();
    }
  }

  private sendInitialize(): void {
    this.nextRequestId += 1;
    this.writeRaw(
      serializeWireMessage({
        jsonrpc: '2.0',
        id: `init_${this.nextRequestId}`,
        method: APP_SERVER_INITIALIZE_METHOD,
        params: { protocolVersion: 1 },
      }),
    );
    this.writeRaw(serializeWireMessage({ method: 'initialized' }));
  }

  /** 把一个服务帧发给容器。 */
  sendFrame(frame: ServiceFrame): void {
    this.writeRaw(serializeWireMessage({ method: APP_SERVER_TUNNEL_METHOD, params: frame }));
  }

  /** 发起一次请求并等待响应。 */
  request(method: string, params?: unknown): Promise<unknown> {
    this.nextRequestId += 1;
    const id = `req_${this.nextRequestId}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, resolve);
      // 隧道调用是**通知**：外层不带 id，相关性由内层帧的 id 承担。
      this.writeRaw(
        serializeWireMessage({
          method: APP_SERVER_TUNNEL_METHOD,
          params: { type: 'request', id, method, params },
        }),
      );
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Request timed out: ${method}`));
        }
      }, 30_000).unref?.();
    });
  }

  private writeRaw(text: string): void {
    this.options.output.write(text);
  }
}
