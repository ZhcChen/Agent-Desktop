import { createId, workspaceIdFromPath, workspaceNameFromPath } from '../registry.js';
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentEvent,
  AgentEventSink,
  AgentMessage,
  AgentProbeResult,
  AgentSessionInfo,
  AgentWorkspace,
  CreateSessionInput,
  SendPromptInput,
} from '../types.js';

/**
 * 内置的最小 agent。
 *
 * 作用有三个：
 * 1. 让应用在没有配置任何真实 agent 时也能启动（渲染层有东西可显示）；
 * 2. 作为协议与事件流的端到端测试替身；
 * 3. 作为「新增一个 agent 要写多少代码」的参考实现。
 */
export class StubAgentAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor = {
    id: 'stub',
    displayName: '内置示例 Agent',
    transport: 'embedded',
    availability: 'ready',
    capabilities: { streaming: true, tools: false, resume: true, fork: false },
  };

  private readonly sessions = new Map<string, AgentSessionInfo>();
  private readonly messages = new Map<string, AgentMessage[]>();
  private readonly abortControllers = new Map<string, AbortController>();

  async probe(): Promise<AgentProbeResult> {
    return { available: true, detail: '内置实现，无需外部依赖' };
  }

  async listWorkspaces(): Promise<AgentWorkspace[]> {
    const path = process.cwd();
    return [{ id: workspaceIdFromPath(path), path, name: workspaceNameFromPath(path) }];
  }

  async listSessions(): Promise<AgentSessionInfo[]> {
    return [...this.sessions.values()];
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionInfo> {
    const now = Date.now();
    const session: AgentSessionInfo = {
      id: createId('sess'),
      agentId: this.descriptor.id,
      workspaceId: input.workspaceId,
      title: input.title ?? '新会话',
      createdAt: now,
      updatedAt: now,
      status: 'idle',
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  async getSession(sessionId: string): Promise<AgentSessionInfo | undefined> {
    return this.sessions.get(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.abortControllers.get(sessionId)?.abort();
    this.abortControllers.delete(sessionId);
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
  }

  async renameSession(sessionId: string, title: string): Promise<AgentSessionInfo> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const updated: AgentSessionInfo = { ...session, title, updatedAt: Date.now() };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  async listMessages(sessionId: string): Promise<AgentMessage[]> {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async send(input: SendPromptInput, sink: AgentEventSink): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new Error(`Session not found: ${input.sessionId}`);
    const history = this.messages.get(input.sessionId) ?? [];

    const userMessage: AgentMessage = {
      id: createId('msg'),
      role: 'user',
      text: input.text,
      createdAt: Date.now(),
    };
    history.push(userMessage);
    this.messages.set(input.sessionId, history);
    this.touch(input.sessionId, 'running');
    sink.emit({ type: 'message', message: userMessage });

    const controller = new AbortController();
    this.abortControllers.set(input.sessionId, controller);
    const onAbort = (): void => controller.abort();
    sink.signal.addEventListener('abort', onAbort, { once: true });

    const reply = `已收到：${input.text}`;
    let acc = '';
    try {
      for (const chunk of chunkText(reply)) {
        if (controller.signal.aborted) {
          this.touch(input.sessionId, 'aborted');
          sink.emit({ type: 'status', status: 'aborted' });
          return;
        }
        acc += chunk;
        sink.emit({
          type: 'message',
          message: {
            id: createId('msg'),
            role: 'assistant',
            text: chunk,
            createdAt: Date.now(),
            partial: true,
          },
        });
        await delay(30);
      }
      const final: AgentMessage = {
        id: createId('msg'),
        role: 'assistant',
        text: acc,
        createdAt: Date.now(),
      };
      history.push(final);
      this.messages.set(input.sessionId, history);
      this.touch(input.sessionId, 'idle');
      sink.emit({ type: 'message', message: final });
      sink.emit({ type: 'status', status: 'idle' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.touch(input.sessionId, 'error');
      sink.emit({ type: 'error', message });
    } finally {
      sink.signal.removeEventListener('abort', onAbort);
      this.abortControllers.delete(input.sessionId);
    }
  }

  async abort(sessionId: string): Promise<void> {
    this.abortControllers.get(sessionId)?.abort();
    this.touch(sessionId, 'aborted');
  }

  async dispose(): Promise<void> {
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
    this.sessions.clear();
    this.messages.clear();
  }

  private touch(sessionId: string, status: AgentSessionInfo['status']): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, { ...session, status, updatedAt: Date.now() });
  }
}

function chunkText(text: string, size = 6): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把 agent 事件映射为协议事件负载。 */
export function toEventPayload(event: AgentEvent): { topic: string; payload: unknown } {
  switch (event.type) {
    case 'message':
      return { topic: 'session/message', payload: event.message };
    case 'tool':
      return { topic: 'session/tool', payload: event.tool };
    case 'status':
      return { topic: 'session/status', payload: { status: event.status, detail: event.detail } };
    case 'error':
      return { topic: 'session/error', payload: { message: event.message } };
  }
}
