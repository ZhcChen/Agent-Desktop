import {
  APP_SERVER_CAPABILITIES,
  APP_SERVER_ERROR_CODES,
  APP_SERVER_INITIALIZE_METHOD,
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_TUNNEL_METHOD,
  type InitializeResult,
  ServiceError,
  toServiceErrorPayload,
  type WireMessage,
  WireDecoder,
  serializeWireMessage,
  type ServiceFrame,
  SERVICE_EVENTS,
  type ServiceEventFrame,
} from '@agent-desktop/app-server-protocol';
import { DesktopService } from './service.js';

/**
 * 应用服务器：以 JSON-RPC 2.0 跑在 stdio 上。
 *
 * 两种方法：
 * - `initialize`：握手，返回能力与协议版本；
 * - `desktopService/transport`：隧道，真正的服务调用与事件都走这里。
 *
 * 隧道用**通知**承载（而不是请求），因为内层帧自带 id，
 * 这样一次连接上只有一种请求形态，换传输层时不用改服务层。
 */
/** 带 method 的线级消息（请求或通知）。 */
type WireMethod = Extract<WireMessage, { method: string }>;

export interface AppServerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  service: DesktopService;
  serverName?: string;
  serverVersion?: string;
  /** 初始流控额度（帧数）。 */
  initialCredit?: number;
}

/** 帧级流控额度池。 */
export class CreditPool {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(initial: number) {
    this.available = Math.max(0, initial);
  }

  async take(): Promise<void> {
    while (this.available <= 0) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.available -= 1;
  }

  grant(count: number): void {
    this.available += Math.max(0, count);
    while (this.available > 0 && this.waiters.length > 0) {
      this.waiters.shift()?.();
    }
  }
}

export class AppServer {
  private readonly decoder: WireDecoder;
  private readonly credit: CreditPool;
  private initialized = false;
  private closed = false;

  constructor(private readonly options: AppServerOptions) {
    this.decoder = new WireDecoder();
    this.credit = new CreditPool(options.initialCredit ?? 256);
  }

  start(): void {
    this.options.input.on('data', (chunk: Buffer) => {
      void this.onChunk(chunk);
    });
    this.options.input.on('end', () => {
      this.closed = true;
    });
    this.options.input.on('error', () => {
      this.closed = true;
    });

    this.options.service.onEvent((event) => {
      void this.publishEvent(event.sessionId, event.event);
    });
  }

  async onChunk(chunk: Buffer): Promise<void> {
    let items;
    try {
      items = this.decoder.push(new Uint8Array(chunk));
    } catch (error) {
      this.writeRaw(serializeWireMessage({ id: null, error: toServiceErrorPayload(error) }));
      return;
    }
    for (const item of items) {
      if (item.message) await this.onMessage(item.message);
    }
  }

  private async onMessage(message: WireMessage): Promise<void> {
    if ('method' in message && typeof message.method === 'string') {
      await this.onMethod(message);
      return;
    }
    // 客户端发来的响应：当前协议没有需要处理的请求-响应对，忽略。
  }

  private async onMethod(message: WireMethod): Promise<void> {
    const { method, id, params } = message;

    if (method === APP_SERVER_INITIALIZE_METHOD) {
      if (this.initialized) {
        this.writeRaw(serializeWireMessage({
          id: id ?? null,
          error: { code: APP_SERVER_ERROR_CODES.alreadyInitialized, message: 'Runtime is already initialized.' },
        }));
        return;
      }
      this.initialized = true;
      const result: InitializeResult = {
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        serverName: this.options.serverName ?? 'agent-desktop-runtime',
        serverVersion: this.options.serverVersion ?? '0.1.0',
        capabilities: APP_SERVER_CAPABILITIES,
      };
      this.writeRaw(serializeWireMessage({ id: id ?? null, result }));
      return;
    }

    if (method === 'initialized') {
      return;
    }

    if (method === APP_SERVER_TUNNEL_METHOD) {
      if (!this.initialized) {
        this.writeRaw(serializeWireMessage({
          id: id ?? null,
          error: { code: APP_SERVER_ERROR_CODES.notInitialized, message: 'Call initialize first.' },
        }));
        return;
      }
      await this.onTunnel(params);
      return;
    }

    this.writeRaw(serializeWireMessage({
      id: id ?? null,
      error: { code: APP_SERVER_ERROR_CODES.methodNotFound, message: `Unknown method: ${method}` },
    }));
  }

  private async onTunnel(params: unknown): Promise<void> {
    const frame = params as ServiceFrame | undefined;
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      return;
    }

    // 流控额度补充：客户端主动加额度。
    if (frame.type === 'request' && frame.method === 'runtime/credit') {
      const count = Number((frame.params as { frames?: unknown })?.frames ?? 0);
      this.credit.grant(Number.isFinite(count) ? count : 0);
      return;
    }

    if (frame.type !== 'request') return;

    try {
      const result = await this.options.service.handle(frame);
      await this.credit.take();
      this.writeRaw(serializeWireMessage({
        method: APP_SERVER_TUNNEL_METHOD,
        params: { type: 'response', id: frame.id, ok: true, result },
      }));
    } catch (error) {
      await this.credit.take();
      this.writeRaw(serializeWireMessage({
        method: APP_SERVER_TUNNEL_METHOD,
        params: {
          type: 'response',
          id: frame.id,
          ok: false,
          error: toServiceErrorPayload(error),
        },
      }));
    }
  }

  private async publishEvent(sessionId: string, event: unknown): Promise<void> {
    if (this.closed) return;
    await this.credit.take();
    const payload: ServiceEventFrame = {
      type: 'event',
      topic: sessionId ? SERVICE_EVENTS.message : SERVICE_EVENTS.status,
      payload: event,
    };
    this.writeRaw(serializeWireMessage({ method: APP_SERVER_TUNNEL_METHOD, params: payload }));
  }

  private writeRaw(text: string): void {
    if (this.closed) return;
    this.options.output.write(text);
  }
}

/** 便捷入口：把 app-server 接到进程的 stdin/stdout 上。 */
export function startAppServer(options: AppServerOptions): AppServer {
  const server = new AppServer(options);
  server.start();
  return server;
}

export { ServiceError };
