import { APP_SERVER_MAX_HEADER_BYTES } from './constants.js';

/**
 * 二进制帧。
 *
 * 线级基线是换行分隔的 JSON，二进制载荷只能以 base64 塞进 JSON 字符串，
 * 固定膨胀 33%。二进制帧保留 JSON 头（可扩展）但把字节移出 JSON 文档：
 *
 * ```text
 * \x1E{"type":"response","id":"r7","binary":true,"byteLength":786432}\n<786432 raw bytes>
 * ```
 *
 * `\x1E`（ASCII record separator）不可能是 JSON 值的首字节，
 * 因此读方能靠第一个字节区分两种帧，两者可以在同一条流上交错。
 * 只有在握手时双方都声明支持后才会启用；否则一律退回 base64。
 */

/** 二进制帧首字节。 */
export const APP_SERVER_BINARY_FRAME_PREFIX = 0x1e;

export interface BinaryFrameHeader {
  [key: string]: unknown;
  byteLength: number;
}

export interface BinaryFrame {
  header: BinaryFrameHeader;
  bytes: Uint8Array;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/** 序列化一个二进制帧。`header.byteLength` 由 `bytes` 覆盖。 */
export function encodeBinaryFrame(header: Omit<BinaryFrameHeader, 'byteLength'>, bytes: Uint8Array): Uint8Array {
  const headerJson = JSON.stringify({ ...header, byteLength: bytes.byteLength });
  const headerBytes = utf8Encoder.encode(headerJson);
  const out = new Uint8Array(1 + headerBytes.byteLength + 1 + bytes.byteLength);
  out[0] = APP_SERVER_BINARY_FRAME_PREFIX;
  out.set(headerBytes, 1);
  out[1 + headerBytes.byteLength] = 0x0a;
  out.set(bytes, 1 + headerBytes.byteLength + 1);
  return out;
}

export type BinaryFrameReadResult =
  | { status: 'incomplete' }
  | { status: 'invalid'; reason: string }
  | { status: 'frame'; frame: BinaryFrame; consumed: number };

/**
 * 从缓冲区开头尝试读一个二进制帧。
 *
 * 调用方负责先确认 `buffer[0]` 是二进制帧前缀。
 * `maxHeaderBytes` 限制头部扫描范围，避免对端靠不发换行来逼出无界缓冲。
 */
export function readBinaryFrame(buffer: Uint8Array, options: { maxHeaderBytes?: number; maxPayloadBytes?: number } = {}): BinaryFrameReadResult {
  if (buffer.byteLength === 0) return { status: 'incomplete' };
  if (buffer[0] !== APP_SERVER_BINARY_FRAME_PREFIX) {
    return { status: 'invalid', reason: 'Frame does not start with the binary prefix.' };
  }

  const maxHeaderBytes = options.maxHeaderBytes ?? APP_SERVER_MAX_HEADER_BYTES;
  const newline = indexOfByte(buffer, 0x0a, 1);
  if (newline < 0) {
    return buffer.byteLength > maxHeaderBytes + 1
      ? { status: 'invalid', reason: 'Binary frame header exceeds the size limit.' }
      : { status: 'incomplete' };
  }
  if (newline - 1 > maxHeaderBytes) {
    return { status: 'invalid', reason: 'Binary frame header exceeds the size limit.' };
  }

  let header: unknown;
  try {
    header = JSON.parse(utf8Decoder.decode(buffer.subarray(1, newline)));
  } catch {
    return { status: 'invalid', reason: 'Binary frame header is not valid JSON.' };
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    return { status: 'invalid', reason: 'Binary frame header must be a JSON object.' };
  }

  const byteLength = (header as { byteLength?: unknown }).byteLength;
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    return { status: 'invalid', reason: 'Binary frame header must carry a byteLength.' };
  }
  if (options.maxPayloadBytes !== undefined && byteLength > options.maxPayloadBytes) {
    return { status: 'invalid', reason: 'Binary frame payload exceeds the size limit.' };
  }

  const payloadStart = newline + 1;
  const consumed = payloadStart + byteLength;
  if (buffer.byteLength < consumed) return { status: 'incomplete' };

  return {
    status: 'frame',
    frame: {
      header: header as BinaryFrameHeader,
      // 复制成普通 Uint8Array：调用方会复用累积缓冲区，
      // 直接给视图会让后续写入覆盖已交付的字节；Node Buffer 也会把子类泄漏给消费者。
      bytes: new Uint8Array(buffer.subarray(payloadStart, consumed)),
    },
    consumed,
  };
}

function indexOfByte(buffer: Uint8Array, byte: number, from: number): number {
  for (let index = from; index < buffer.byteLength; index += 1) {
    if (buffer[index] === byte) return index;
  }
  return -1;
}
