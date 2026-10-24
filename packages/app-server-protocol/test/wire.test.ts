import { describe, expect, it } from 'vitest';
import {
  APP_SERVER_BINARY_FRAME_PREFIX,
  decodeBase64,
  encodeBase64,
  encodeBinaryFrame,
  parseWireMessage,
  readBinaryFrame,
  serializeWireMessage,
  toJsonSafe,
  WireDecoder,
} from '../src/index.js';

describe('base64', () => {
  it('往返一致', () => {
    for (const length of [0, 1, 2, 3, 5, 16, 255]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37) % 256;
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }
  });
});

describe('toJsonSafe', () => {
  it('bigint 转字符串', () => {
    expect(toJsonSafe({ big: 10n })).toEqual({ big: '10' });
  });

  it('Uint8Array 转 base64', () => {
    expect(toJsonSafe(new Uint8Array([1, 2, 3]))).toBe('AQID');
  });

  it('循环引用不会抛错', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;
    expect(toJsonSafe(node)).toEqual({ name: 'a', self: '[Circular]' });
  });
});

describe('线级消息', () => {
  it('序列化后以换行结尾且可解析', () => {
    const text = serializeWireMessage({ method: 'ping', params: { a: 1 } });
    expect(text.endsWith('\n')).toBe(true);
    expect(parseWireMessage(text.trim())).toMatchObject({ method: 'ping' });
  });

  it('非法 JSON 抛协议错误', () => {
    expect(() => parseWireMessage('{ not json')).toThrowError(/Invalid JSON/);
  });

  it('非 JSON-RPC 形状被拒', () => {
    expect(() => parseWireMessage('{"foo":1}')).toThrowError(/request, notification, or response/);
  });
});

describe('WireDecoder', () => {
  it('按切分点重组消息', () => {
    const decoder = new WireDecoder();
    const payload = serializeWireMessage({ method: 'a', params: { v: 'x'.repeat(50) } });
    const bytes = new TextEncoder().encode(payload);
    const collected: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 7) {
      for (const item of decoder.push(bytes.slice(i, i + 7))) {
        if (item.message) collected.push(item.message);
      }
    }
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ method: 'a' });
    expect(decoder.pendingBytes).toBe(0);
  });

  it('跳过空行', () => {
    const decoder = new WireDecoder();
    const items = decoder.push(new TextEncoder().encode('\n\n{"method":"x"}\n'));
    expect(items.filter((item) => item.message)).toHaveLength(1);
  });
});

describe('二进制帧', () => {
  it('编码后可原样读回', () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const encoded = encodeBinaryFrame({ type: 'response', id: 'r1' }, bytes);
    expect(encoded[0]).toBe(APP_SERVER_BINARY_FRAME_PREFIX);

    const result = readBinaryFrame(encoded);
    expect(result.status).toBe('frame');
    if (result.status !== 'frame') return;
    expect(result.frame.bytes).toEqual(bytes);
    expect(result.consumed).toBe(encoded.byteLength);
  });

  it('数据不全时返回 incomplete', () => {
    const bytes = new Uint8Array(100);
    const encoded = encodeBinaryFrame({ type: 'response', id: 'r1' }, bytes);
    const result = readBinaryFrame(encoded.slice(0, 40));
    expect(result.status).toBe('incomplete');
  });

  it('头里没有 byteLength 判为 invalid', () => {
    const header = new TextEncoder().encode('{"type":"response"}');
    const buffer = new Uint8Array(1 + header.byteLength + 1);
    buffer[0] = APP_SERVER_BINARY_FRAME_PREFIX;
    buffer.set(header, 1);
    buffer[1 + header.byteLength] = 0x0a;
    expect(readBinaryFrame(buffer).status).toBe('invalid');
  });

  it('与 JSON 帧可以在同一条流上交错', () => {
    const decoder = new WireDecoder();
    const json = new TextEncoder().encode(serializeWireMessage({ method: 'x' }));
    const bin = encodeBinaryFrame({ type: 'response', id: 'r1' }, new Uint8Array([1, 2, 3]));
    const stream = new Uint8Array(json.byteLength + bin.byteLength);
    stream.set(json, 0);
    stream.set(bin, json.byteLength);

    const items = decoder.push(stream);
    expect(items).toHaveLength(2);
    expect(items[0]?.message).toMatchObject({ method: 'x' });
    expect(items[1]?.binary?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
