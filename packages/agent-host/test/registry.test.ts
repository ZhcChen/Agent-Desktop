import { describe, expect, it } from 'vitest';
import { AgentRegistry, StubAgentAdapter, type AgentEvent } from '../src/index.js';

describe('AgentRegistry', () => {
  it('注册后可按 id 取出，重复注册报错', () => {
    const registry = new AgentRegistry();
    const adapter = new StubAgentAdapter();
    registry.register(adapter);
    expect(registry.get('stub')).toBe(adapter);
    expect(() => registry.register(new StubAgentAdapter())).toThrowError(/already registered/);
  });

  it('describe 汇总可用性', async () => {
    const registry = new AgentRegistry();
    registry.register(new StubAgentAdapter());
    const descriptors = await registry.describe();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({ id: 'stub', availability: 'ready' });
  });
});

describe('StubAgentAdapter', () => {
  it('走完 创建→发送→读消息 的完整链路', async () => {
    const adapter = new StubAgentAdapter();
    const workspace = (await adapter.listWorkspaces())[0];
    expect(workspace).toBeDefined();

    const session = await adapter.createSession({ workspaceId: workspace!.id, title: '测试' });
    expect(session.title).toBe('测试');

    const events: AgentEvent[] = [];
    await adapter.send(
      { sessionId: session.id, text: '你好' },
      { emit: (event) => events.push(event), signal: new AbortController().signal },
    );

    const messages = await adapter.listMessages(session.id);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.text).toContain('你好');

    const types = events.map((event) => event.type);
    expect(types).toContain('message');
    expect(types).toContain('status');
  });

  it('删除会话后消息一并消失', async () => {
    const adapter = new StubAgentAdapter();
    const workspace = (await adapter.listWorkspaces())[0];
    const session = await adapter.createSession({ workspaceId: workspace!.id });
    await adapter.deleteSession(session.id);
    expect(await adapter.getSession(session.id)).toBeUndefined();
    expect(await adapter.listMessages(session.id)).toEqual([]);
  });
});
