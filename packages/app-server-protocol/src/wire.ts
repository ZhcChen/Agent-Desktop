import { APP_SERVER_MAX_MESSAGE_BYTES, APP_SERVER_PROTOCOL_VERSION } from './constants.js';
import { APP_SERVER_BINARY_FRAME_PREFIX, encodeBinaryFrame, readBinaryFrame } from './binary-frame.js';
import { APP_SERVER_ERROR_CODES } from './constants.js';
import { ServiceError } from './errors.js';
import type { ServiceFrame } from './frames.js';

/**
 * 线级编解码。
 *
 * 基线是换行分隔的 JSON；可选叠加二进制帧（两者可同流交错）。
 * 这里的实现刻意只用 Web 标准 API（TextEncoder/TextDecoder + 手写 base64），
 * 因为渲染层会直接打包这个包，不能依赖 `node:buffer`。
 */

/** 线级消息：JSON-RPC 2.0 形状。 */
export type WireMessage =
  | { jsonrpc?: '2.0'; id?: string | number; method: string; params?: unknown }
  | { jsonrpc?: '2.0'; id?: string | number; result?: unknown }
  | { jsonrpc?: '2.0'; id?: string | number; error: { code: number; message: string; data?: unknown } };

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index] as number;
    const byte1 = bytes[index + 1] as number | undefined;
    const byte2 = bytes[index + 2] as number | undefined;
    out += BASE64_ALPHABET[byte0 >> 2];
    out += BASE64_ALPHABET[((byte0 & 0x03) << 4) | ((byte1 ?? 0) >> 4)];
    out += byte1 === undefined ? '=' : BASE64_ALPHABET[((byte1 & 0x0f) << 2) | ((byte2 ?? 0) >> 6)];
    out += byte2 === undefined ? '=' : BASE64_ALPHABET[byte2 & 0x3f];
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  for (let index = 0; index < clean.length; index += 4) {
    const c0 = BASE64_ALPHABET.indexOf(clean[index] as string);
    const c1 = BASE64_ALPHABET.indexOf(clean[index + 1] as string);
    const c2 = BASE64_ALPHABET.indexOf(clean[index + 2] as string);
    const c3 = BASE64_ALPHABET.indexOf(clean[index + 3] as string);
    out[outIndex++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) out[outIndex++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (c3 >= 0) out[outIndex++] = ((c2 & 0x03) << 6) | c3;
  }
  return out.subarray(0, outIndex);
}

/**
 * 转换成可安全 JSON 序列化的值。
 *
 * - bigint → 十进制字符串（JSON 没有 bigint）
 * - Uint8Array → base64 字符串
 * - 循环引用 → '[Circular]'（不能抛错打断整条消息）
 */
export function toJsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));
    if (value instanceof Uint8Array) return encodeBase64(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = toJsonSafe(item, seen);
    return result;
  } finally {
    seen.delete(value);
  }
}

/** 序列化为一条线级消息（带尾随换行）。 */
export function serializeWireMessage(message: unknown): string {
  return `${JSON.stringify(toJsonSafe(message))}\n`;
}

/** 解析一条线级消息。 */
export function parseWireMessage(input: string | Uint8Array): WireMessage {
  const text = typeof input === 'string' ? input : utf8Decoder.decode(input);
  const sizeBytes = utf8Encoder.encode(text).length;
  if (sizeBytes > APP_SERVER_MAX_MESSAGE_BYTES) {
    throw new ServiceError(
      APP_SERVER_ERROR_CODES.payloadTooLarge,
      `Message exceeds the ${APP_SERVER_MAX_MESSAGE_BYTES}-byte limit.`,
      { sizeBytes, maxMessageBytes: APP_SERVER_MAX_MESSAGE_BYTES },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ServiceError(APP_SERVER_ERROR_CODES.parseError, 'Invalid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ServiceError(APP_SERVER_ERROR_CODES.invalidRequest, 'Message must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  if (record['jsonrpc'] !== undefined && record['jsonrpc'] !== '2.0') {
    throw new ServiceError(APP_SERVER_ERROR_CODES.invalidRequest, 'Only JSON-RPC 2.0 messages are supported.');
  }
  if (typeof record['method'] === 'string' && record['method'].trim().length > 0) {
    return record as unknown as WireMessage;
  }
  if (record['id'] !== undefined && (record['result'] !== undefined || record['error'] !== undefined)) {
    return record as unknown as WireMessage;
  }
  throw new ServiceError(APP_SERVER_ERROR_CODES.invalidRequest, 'Message must be a request, notification, or response.');
}

/* ------------------------------------------------------------------ *
 * 增量解码器
 * ------------------------------------------------------------------ */

export interface DecodedWireItem {
  /** JSON 消息。 */
  message?: WireMessage;
  /** 二进制帧载荷。 */
  binary?: { header: Record<string, unknown>; bytes: Uint8Array };
}

/**
 * 增量解码器：喂入任意切分的字节，吐出完整消息。
 *
 * stdio 与 SSH 都是字节流，切分位置不保证落在帧边界上，
 * 所以解码必须是有状态的。
 */
export class WireDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(private readonly maxMessageBytes: number = APP_SERVER_MAX_MESSAGE_BYTES) {}

  push(chunk: Uint8Array): DecodedWireItem[] {
    if (chunk.byteLength === 0) return [];
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;

    const items: DecodedWireItem[] = [];
    for (;;) {
      if (this.buffer.byteLength === 0) break;
      if (this.buffer[0] === APP_SERVER_BINARY_FRAME_PREFIX) {
        const result = readBinaryFrame(this.buffer, { maxPayloadBytes: this.maxMessageBytes });
        if (result.status === 'incomplete') break;
        if (result.status === 'invalid') {
          // 无法恢复：丢弃一个字节并继续，避免整条流被一个坏帧卡死。
          this.buffer = this.buffer.subarray(1);
          items.push({ binary: { header: { error: result.reason }, bytes: new Uint8Array(0) } });
          continue;
        }
        items.push({ binary: { header: result.frame.header, bytes: result.frame.bytes } });
        this.buffer = this.buffer.subarray(result.consumed);
        continue;
      }

      const newline = indexOfByte(this.buffer, 0x0a, 0);
      if (newline < 0) {
        if (this.buffer.byteLength > this.maxMessageBytes) {
          throw new ServiceError(
            APP_SERVER_ERROR_CODES.payloadTooLarge,
            `Unterminated message exceeds the ${this.maxMessageBytes}-byte limit.`,
          );
        }
        break;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      items.push({ message: parseWireMessage(line) });
    }
    return items;
  }

  get pendingBytes(): number {
    return this.buffer.byteLength;
  }
}

/** 把服务帧编码成线级字节流。 */
export function encodeServiceFrame(frame: ServiceFrame): Uint8Array {
  return new Uint8Array(utf8Encoder.encode(serializeWireMessage({ method: 'desktopService/transport', params: frame })));
}

/** 把带二进制载荷的响应编码成二进制帧。 */
export function encodeBinaryResponseFrame(id: string, bytes: Uint8Array): Uint8Array {
  return encodeBinaryFrame({ type: 'response', id, ok: true, binary: true }, bytes);
}

/** 从二进制帧还原载荷。 */
export function decodeBinaryPayload(header: Record<string, unknown>, bytes: Uint8Array): unknown {
  if (header['binaryPayloadEncoding'] === 'base64') return decodeBase64(utf8Decoder.decode(bytes));
  return bytes;
}

function indexOfByte(buffer: Uint8Array, byte: number, from: number): number {
  for (let index = from; index < buffer.byteLength; index += 1) {
    if (buffer[index] === byte) return index;
  }
  return -1;
}

/** 握手结果：能力描述。 */
export interface InitializeResult {
  protocolVersion: number;
  serverName: string;
  serverVersion: string;
  capabilities: typeof import('./constants.js').APP_SERVER_CAPABILITIES;
}

export const SERVER_NAME = 'agent-desktop-runtime';
export const DEFAULT_PROTOCOL_VERSION = APP_SERVER_PROTOCOL_VERSION;
