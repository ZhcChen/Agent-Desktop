import {
  type AgentDescriptorPayload,
  type CreateSessionParams,
  type SendPromptParams,
  SERVICE_METHODS,
  type ServiceFrame,
  type SessionMessagePayload,
  type SessionPayload,
  type WorkspacePayload,
} from '@agent-desktop/app-server-protocol';
import {
  EventBroadcaster,
  type AgentEvent,
  type AgentEventSink,
  type AgentRegistry,
  type AgentSessionInfo,
} from '@agent-desktop/agent-host';

/**
 * 运行时服务。
 *
 * 对外暴露一组**与 agent 无关**的方法；会话到 agent 的路由由本层维护，
 * 这样通用层（UI、事件分发）不需要知道会话背后是 pi 还是别的 agent。
 */
export interface RuntimeEvent {
  sessionId: string;
  event: AgentEvent;
}

export class DesktopService {
  /** 会话 id → agent id。 */
  private readonly sessionRoutes = new Map<string, string>();
  /** 订阅 id → 会话 id。 */
  private readonly subscriptions = new Map<string, string>();
  private readonly events = new EventBroadcaster<AgentEvent & { sessionId: string }>();
  private subscriptionCounter = 0;

  constructor(private readonly registry: AgentRegistry) {}

  /** 订阅全局事件流（渲染层用）。 */
  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    return this.events.subscribe((event) => {
      const { sessionId, ...rest } = event;
      listener({ sessionId: sessionId ?? '', event: rest as AgentEvent });
    });
  }

  /**
   * 处理一个服务帧。
   *
   * 返回值是「立即应答」；长时间运行的调用（如 send）通过事件流回传。
   */
  async handle(frame: ServiceFrame): Promise<unknown> {
    if (frame.type !== 'request') return undefined;
    const { method, params } = frame;

    switch (method) {
      case SERVICE_METHODS.agentsList: {
        const agents = await this.registry.describe();
        return { agents: agents.map(toDescriptorPayload) };
      }
      case SERVICE_METHODS.workspacesList: {
        const workspaces = await this.collectWorkspaces();
        return { workspaces };
      }
      case SERVICE_METHODS.sessionsList: {
        const sessions = await this.collectSessions();
        return { sessions };
      }
      case SERVICE_METHODS.sessionsCreate:
        return this.createSession(params as CreateSessionParams);
      case SERVICE_METHODS.sessionsGet: {
        const session = await this.getSession(String((params as { sessionId?: string })?.sessionId ?? ''));
        return { session };
      }
      case SERVICE_METHODS.sessionsDelete:
        return this.deleteSession(String((params as { sessionId?: string })?.sessionId ?? ''));
      case SERVICE_METHODS.sessionsRename: {
        const { sessionId, title } = (params ?? {}) as { sessionId?: string; title?: string };
        return this.renameSession(String(sessionId ?? ''), String(title ?? ''));
      }
      case SERVICE_METHODS.sessionsMessages: {
        const sessionId = String((params as { sessionId?: string })?.sessionId ?? '');
        return this.listMessages(sessionId);
      }
      case SERVICE_METHODS.sessionsSend:
        return this.send(params as SendPromptParams);
      case SERVICE_METHODS.sessionsAbort:
        return this.abort(String((params as { sessionId?: string })?.sessionId ?? ''));
      case SERVICE_METHODS.sessionsSubscribe: {
        const sessionId = String((params as { sessionId?: string })?.sessionId ?? '');
        this.subscriptionCounter += 1;
        const subscriptionId = `sub_${this.subscriptionCounter}`;
        this.subscriptions.set(subscriptionId, sessionId);
        return { subscriptionId };
      }
      case SERVICE_METHODS.sessionsUnsubscribe: {
        const subscriptionId = String((params as { subscriptionId?: string })?.subscriptionId ?? '');
        this.subscriptions.delete(subscriptionId);
        return { ok: true };
      }
      default:
        throw new Error(`Unknown service method: ${method}`);
    }
  }

  private async collectWorkspaces(): Promise<WorkspacePayload[]> {
    const seen = new Map<string, WorkspacePayload>();
    for (const adapter of this.registry.list()) {
      for (const workspace of await adapter.listWorkspaces()) {
        seen.set(workspace.id, {
          id: workspace.id,
          path: workspace.path,
          name: workspace.name,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async collectSessions(): Promise<SessionPayload[]> {
    const sessions: SessionPayload[] = [];
    for (const adapter of this.registry.list()) {
      for (const session of await adapter.listSessions()) {
        this.sessionRoutes.set(session.id, session.agentId);
        sessions.push(toSessionPayload(session));
      }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async createSession(params: CreateSessionParams): Promise<{ session: SessionPayload }> {
    const adapter = this.registry.require(params.agentId);
    const session = await adapter.createSession({
      workspaceId: params.workspaceId,
      ...(params.title ? { title: params.title } : {}),
    });
    this.sessionRoutes.set(session.id, session.agentId);
    return { session: toSessionPayload(session) };
  }

  private async getSession(sessionId: string): Promise<SessionPayload | undefined> {
    const agentId = this.sessionRoutes.get(sessionId);
    if (!agentId) return undefined;
    const session = await this.registry.require(agentId).getSession(sessionId);
    return session ? toSessionPayload(session) : undefined;
  }

  private async deleteSession(sessionId: string): Promise<{ ok: boolean }> {
    const agentId = this.sessionRoutes.get(sessionId);
    if (!agentId) return { ok: false };
    await this.registry.require(agentId).deleteSession(sessionId);
    this.sessionRoutes.delete(sessionId);
    for (const [subscriptionId, target] of [...this.subscriptions]) {
      if (target === sessionId) this.subscriptions.delete(subscriptionId);
    }
    return { ok: true };
  }

  private async renameSession(sessionId: string, title: string): Promise<{ session: SessionPayload }> {
    const agentId = this.sessionRoutes.get(sessionId);
    if (!agentId) throw new Error(`Session not found: ${sessionId}`);
    const session = await this.registry.require(agentId).renameSession(sessionId, title);
    return { session: toSessionPayload(session) };
  }

  private async listMessages(sessionId: string): Promise<{ messages: SessionMessagePayload[] }> {
    const agentId = this.sessionRoutes.get(sessionId);
    if (!agentId) return { messages: [] };
    const messages = await this.registry.require(agentId).listMessages(sessionId);
    return { messages: messages.map((message) => ({ ...message })) };
  }

  /**
   * 发送输入。
   *
   * 立即返回受理结果；run 的过程通过事件流回传。
   * 这样 UI 不需要在一个 RPC 调用上挂很久。
   */
  private async send(params: SendPromptParams): Promise<{ accepted: boolean; sessionId: string }> {
    const agentId = this.sessionRoutes.get(params.sessionId);
    if (!agentId) throw new Error(`Session not found: ${params.sessionId}`);
    const adapter = this.registry.require(agentId);

    const controller = new AbortController();
    const sink: AgentEventSink = {
      signal: controller.signal,
      emit: (event) => {
        this.events.publish({ ...event, sessionId: params.sessionId } as AgentEvent & { sessionId: string });
      },
    };

    void adapter
      .send(
        {
          sessionId: params.sessionId,
          text: params.text,
          ...(params.disposition ? { disposition: params.disposition } : {}),
        },
        sink,
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.events.publish({
          type: 'error',
          message,
          sessionId: params.sessionId,
        } as AgentEvent & { sessionId: string });
      });

    return { accepted: true, sessionId: params.sessionId };
  }

  private async abort(sessionId: string): Promise<{ ok: boolean }> {
    const agentId = this.sessionRoutes.get(sessionId);
    if (!agentId) return { ok: false };
    await this.registry.require(agentId).abort(sessionId);
    return { ok: true };
  }
}

function toDescriptorPayload(descriptor: AgentDescriptorPayload): AgentDescriptorPayload {
  return descriptor;
}

function toSessionPayload(session: AgentSessionInfo): SessionPayload {
  return {
    id: session.id,
    agentId: session.agentId,
    workspaceId: session.workspaceId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
  };
}
