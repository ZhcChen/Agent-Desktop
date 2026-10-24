import type { AgentAdapter, AgentDescriptor, AgentEvent, AgentEventSink, AgentMessage, AgentSessionInfo, AgentWorkspace } from './types.js';

/**
 * Agent 注册表。
 *
 * 通用层只通过它拿到 agent 列表；注册顺序即展示顺序。
 */
export class AgentRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.descriptor.id)) {
      throw new Error(`Agent already registered: ${adapter.descriptor.id}`);
    }
    this.adapters.set(adapter.descriptor.id, adapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown agent: ${id}`);
    return adapter;
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  /** 探测所有 agent 的可用性，产出可直接渲染的描述。 */
  async describe(): Promise<AgentDescriptor[]> {
    const descriptors: AgentDescriptor[] = [];
    for (const adapter of this.adapters.values()) {
      const descriptor = adapter.descriptor;
      try {
        const probe = await adapter.probe();
        descriptors.push({
          ...descriptor,
          availability: probe.available ? 'ready' : 'missing',
          detail: probe.detail ?? descriptor.detail,
        });
      } catch (error) {
        descriptors.push({
          ...descriptor,
          availability: 'missing',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return descriptors;
  }

  async dispose(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.dispose();
      } catch {
        // 释放失败不应阻断其他 agent 的回收。
      }
    }
    this.adapters.clear();
  }
}

/** 事件汇流：把 agent 事件转成带序号的增量事件，供协议层分发。 */
export class EventBroadcaster<TPayload = AgentEvent> {
  private seq = 0;
  private readonly listeners = new Set<(event: TPayload & { seq: number }) => void>();

  subscribe(listener: (event: TPayload & { seq: number }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: TPayload): void {
    this.seq += 1;
    const payload = { ...event, seq: this.seq } as TPayload & { seq: number };
    for (const listener of [...this.listeners]) {
      try {
        listener(payload);
      } catch {
        // 订阅者异常不能打断其他订阅者。
      }
    }
  }
}

/** 生成一个短 id。 */
export function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/** 从路径派生一个稳定的工作区 id。 */
export function workspaceIdFromPath(path: string): string {
  return `ws_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/** 从路径派生展示名。 */
export function workspaceNameFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 归一化消息列表（供适配器复用）。 */
export function sortMessages(messages: AgentMessage[]): AgentMessage[] {
  return [...messages].sort((a, b) => a.createdAt - b.createdAt);
}

/** 归一化会话列表。 */
export function sortSessions(sessions: AgentSessionInfo[]): AgentSessionInfo[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 把工作区列表按 id 归一化。 */
export function normalizeWorkspaces(workspaces: AgentWorkspace[]): AgentWorkspace[] {
  return [...workspaces].sort((a, b) => a.name.localeCompare(b.name));
}

/** 构造一个事件出口，用于测试与转发。 */
export function createEventSink(
  emit: (event: AgentEvent) => void,
  signal: AbortSignal,
): AgentEventSink {
  return { emit, signal };
}
