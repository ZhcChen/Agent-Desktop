/**
 * 应用服务器协议常量。
 *
 * 协议分两层：
 * - **帧层**（frames.ts）：结构化对象，渲染层 ↔ 主进程 / 运行时之间使用；
 * - **线级**（wire.ts / binary-frame.ts）：换行分隔 JSON，可选二进制帧，
 *   用于 stdio（主进程 ↔ utility process）与 SSH 等字节流通道。
 */

/** 当前线级协议版本。 */
export const APP_SERVER_PROTOCOL_VERSION = 1;

/** 单条线级消息上限。超过即拒绝，避免异常载荷耗尽内存。 */
export const APP_SERVER_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** 帧头最大字节数（仅二进制帧）。防止对端永不发送换行导致无界缓冲。 */
export const APP_SERVER_MAX_HEADER_BYTES = 64 * 1024;

/** 握手方法。 */
export const APP_SERVER_INITIALIZE_METHOD = 'initialize';

/**
 * 隧道方法：真正的服务操作都承载在这个方法的帧里。
 *
 * 这样做的收益是：一条连接上只有一种请求形态，流控、二进制载荷、
 * 事件订阅都只需要在隧道内实现一次；未来换传输（MessagePort / app:// / SSH）
 * 不用改服务层。
 */
export const APP_SERVER_TUNNEL_METHOD = 'desktopService/transport';

/** 运行时自描述方法：返回运行时能力，供客户端做特性协商。 */
export const APP_SERVER_DESCRIBE_METHOD = 'runtime/describe';

/** 客户端 → 服务端通知。 */
export const APP_SERVER_CLIENT_NOTIFICATIONS = ['initialized'] as const;

/** 服务端 → 客户端通知。 */
export const APP_SERVER_SERVER_NOTIFICATIONS = ['runtime/ready'] as const;

/**
 * JSON-RPC 2.0 标准错误码 + 本协议扩展码。
 *
 * 扩展码沿用 -32000 段：JSON-RPC 规定 -32000..-32099 为实现自定义区间。
 */
export const APP_SERVER_ERROR_CODES = {
  // JSON-RPC 2.0 标准码
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  // 协议扩展码
  overloaded: -32001,
  notInitialized: -32002,
  alreadyInitialized: -32003,
  unsupportedTransport: -32004,
  unsupportedProtocol: -32005,
  payloadTooLarge: -32006,
  flowControlViolation: -32007,
  agentUnavailable: -32008,
  sessionNotFound: -32009,
} as const;

export type AppServerErrorCode =
  (typeof APP_SERVER_ERROR_CODES)[keyof typeof APP_SERVER_ERROR_CODES];

/** 载荷编码协商结果。 */
export const APP_SERVER_PAYLOAD_ENCODINGS = ['binaryFrame', 'base64'] as const;

export type AppServerPayloadEncoding = (typeof APP_SERVER_PAYLOAD_ENCODINGS)[number];

/** 流控默认值与上限。 */
export const RUNTIME_TRANSPORT_PROTOCOL_VERSION = 1;
export const RUNTIME_TRANSPORT_DEFAULT_STREAM_WINDOW = 64 * 1024;
export const RUNTIME_TRANSPORT_MAX_STREAM_WINDOW = 8 * 1024 * 1024;

/**
 * 握手后协商出的能力描述。
 *
 * `binaryPayloadEncoding` 永远是 'base64'——基线必须让只懂 JSON 的对端仍能读；
 * 实际协商结果单独通过 `binaryPayloadEncoding` 字段在一跳连接内上报。
 */
export const APP_SERVER_CAPABILITIES = {
  contract: 'AgentDesktopService',
  transportMethod: APP_SERVER_TUNNEL_METHOD,
  transportProtocolVersion: RUNTIME_TRANSPORT_PROTOCOL_VERSION,
  requestFrame: 'ServiceRequestFrame',
  responseFrames: ['response-start', 'stream-chunk', 'stream-done', 'stream-error'],
  eventFrame: 'ServiceEventFrame',
  binaryPayloadEncoding: 'base64',
  binaryPayloadEncodings: APP_SERVER_PAYLOAD_ENCODINGS,
  flowControl: ['streamWindow', 'stream-credit', 'abort'],
  defaultStreamWindow: RUNTIME_TRANSPORT_DEFAULT_STREAM_WINDOW,
  maxStreamWindow: RUNTIME_TRANSPORT_MAX_STREAM_WINDOW,
} as const;
