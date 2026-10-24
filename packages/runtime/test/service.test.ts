import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AgentRegistry, StubAgentAdapter } from '@agent-desktop/agent-host';
import { SERVICE_METHODS, type ServiceFrame } from '@agent-desktop/app-server-protocol';
import { DesktopService, startAppServer } from '../src/index.js';

function buildService(): { service: DesktopService; registry: AgentRegistry } {
  const registry = new AgentRegistry();
  registry.register(new StubAgentAdapter());
  return { service: new DesktopService(registry), registry };
}

describe('DesktopService', () => {
  it('列出 agent 并标记可用', async () => {
    const { service } = buildService();
    const result = (await service.handle({
      type: 'request',
      id: '1',
      method: SERVICE_METHODS.agentsList,
    })) as { agents: Array<{ id: string; availability: string }> };
    expect(result.agents[0]).toMatchObject({ id: 'stub', availability: 'ready' });
  });

  it('创建会话后可发送并收到事件', async () => {
    const { service } = buildService();
    const workspaces = (await service.handle({
      type: 'request',
      id: '1',
      method: SERVICE_METHODS.workspacesList,
    })) as { workspaces: Array<{ id: string }> };

    const created = (await service.handle({
      type: 'request',
      id: '2',
      method: SERVICE_METHODS.sessionsCreate,
      params: { agentId: 'stub', workspaceId: workspaces.workspaces[0]!.id },
    })) as { session: { id: string } };

    const seen: string[] = [];
    service.onEvent((event) => seen.push(event.event.type));

    await service.handle({
      type: 'request',
      id: '3',
      method: SERVICE_METHODS.sessionsSend,
      params: { sessionId: created.session.id, text: 'hi' },
    });

    // send 是即发即回，真正的 run 在事件流里。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toContain('message');
    expect(seen).toContain('status');

    const messages = (await service.handle({
      type: 'request',
      id: '4',
      method: SERVICE_METHODS.sessionsMessages,
      params: { sessionId: created.session.id },
    })) as { messages: Array<{ role: string; text: string }> };
    expect(messages.messages.some((message) => message.role === 'assistant')).toBe(true);
  });
});

describe('AppServer（stdio 协议）', () => {
  it('握手后能通过隧道完成一次服务调用', async () => {
    const { service } = buildService();
    const input = new PassThrough();
    const output = new PassThrough();

    const outputText: string[] = [];
    output.on('data', (chunk: Buffer) => outputText.push(chunk.toString('utf8')));

    startAppServer({ input, output, service });

    // 客户端握手。
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'i1', method: 'initialize', params: {} })}\n`);
    input.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 通过隧道发一次 agents/list。
    input.write(
      `${JSON.stringify({
        method: 'desktopService/transport',
        params: { type: 'request', id: 'q1', method: SERVICE_METHODS.agentsList },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const text = outputText.join('');
    const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

    const initResponse = lines.find((line) => line['id'] === 'i1');
    expect(initResponse).toBeDefined();
    expect(initResponse?.['result']).toMatchObject({ protocolVersion: 1 });

    const tunnel = lines.find((line) => line['method'] === 'desktopService/transport');
    expect(tunnel).toBeDefined();
    const params = tunnel?.['params'] as ServiceFrame;
    expect(params.type).toBe('response');
    if (params.type === 'response') {
      expect(params.ok).toBe(true);
      const result = params.result as { agents: Array<{ id: string }> };
      expect(result.agents[0]?.id).toBe('stub');
    }
  });

  it('未握手就发隧道请求会被拒', async () => {
    const { service } = buildService();
    const input = new PassThrough();
    const output = new PassThrough();
    const outputText: string[] = [];
    output.on('data', (chunk: Buffer) => outputText.push(chunk.toString('utf8')));

    startAppServer({ input, output, service });

    input.write(
      `${JSON.stringify({
        method: 'desktopService/transport',
        params: { type: 'request', id: 'q1', method: SERVICE_METHODS.agentsList },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    const lines = outputText
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const error = lines.find((line) => (line['error'] as { code?: number } | undefined)?.code === -32002);
    expect(error).toBeDefined();
  });
});
