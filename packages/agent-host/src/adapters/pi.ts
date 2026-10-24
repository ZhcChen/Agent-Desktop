import { createId } from '../registry.js';
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
 * pi 适配器。
 *
 * 通过 pi 官方的 **SDK**（`@earendil-works/pi-coding-agent`）在进程内驱动 pi，
 * 不修改 pi 的任何行为，只消费它公开的会话与事件接口。
 *
 * 动态 import：pi 是可选依赖。没装 pi 时应用仍能启动，
 * `probe()` 只会把这个 agent 报成 missing。
 */

export interface PiAdapterOptions {
  /** pi 的全局配置目录（内含 models.json / settings.json）。容器内指向挂载点。 */
  agentDir?: string;
  /** 默认工作目录。 */
  cwd?: string;
  /** 可选的模型覆盖（provider/model）。 */
  model?: string;
  /** 思考等级。 */
  thinkingLevel?: string;
  /** 强制启用工具；留空则用 pi 自己的默认工具集。 */
  tools?: string[];
}

interface PiSessionHandle {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: AgentSessionInfo['status'];
  session: PiAgentSession;
  unsubscribe: () => void;
  messages: AgentMessage[];
}

type PiAgentSession = {
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
  getLastAssistantText(): string | undefined;
  messages?: unknown;
};

type PiSessionEvent =
  | { type: 'message_update'; assistantMessageEvent?: { type?: string; delta?: string } }
  | { type: 'message_end'; message?: PiAssistantMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; isError: boolean }
  | { type: 'agent_settled'; aborted: boolean }
  | { type: 'agent_end'; willRetry: boolean }
  | { type: 'queue_update' }
  | { type: 'compaction_start' }
  | { type: 'compaction_end' }
  | { type: 'turn_start' }
  | { type: 'turn_end' };

type PiAssistantMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string;
};

/** pi 的消息角色 → 我们的角色。 */
function mapRole(role: string | undefined): AgentMessage['role'] {
  switch (role) {
    case 'user':
      return 'user';
    case 'toolResult':
    case 'tool':
      return 'tool';
    case 'system':
      return 'system';
    default:
      return 'assistant';
  }
}

export class PiAgentAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor = {
    id: 'pi',
    displayName: 'pi',
    transport: 'embedded',
    availability: 'missing',
    capabilities: { streaming: true, tools: true, resume: true, fork: true },
  };

  private readonly sessions = new Map<string, PiSessionHandle>();
  private readonly abortControllers = new Map<string, AbortController>();
  private modulePromise: Promise<PiModule | undefined> | undefined;

  constructor(private readonly options: PiAdapterOptions = {}) {}

  private async loadModule(): Promise<PiModule | undefined> {
    if (!this.modulePromise) {
      this.modulePromise = import('@earendil-works/pi-coding-agent')
        .then((mod) => mod as unknown as PiModule)
        .catch(() => undefined);
    }
    return this.modulePromise;
  }

  async probe(): Promise<AgentProbeResult> {
    const mod = await this.loadModule();
    if (!mod) {
      return { available: false, detail: '未安装 @earendil-works/pi-coding-agent' };
    }
    if (!this.options.agentDir && !this.options.cwd) {
      return { available: true, detail: '使用 pi 默认配置目录' };
    }
    return { available: true, detail: this.options.agentDir ?? this.options.cwd };
  }

  async listWorkspaces(): Promise<AgentWorkspace[]> {
    // 宿主登记过的工作区优先；没有登记时退回默认 cwd。
    if (this.workspaceCache.size > 0) {
      return [...this.workspaceCache.entries()].map(([id, path]) => ({
        id,
        path,
        name: basename(path),
      }));
    }
    const cwd = this.options.cwd ?? process.cwd();
    return [{ id: `ws_${cwd.replace(/[^a-zA-Z0-9]/g, '_')}`, path: cwd, name: basename(cwd) }];
  }

  async listSessions(): Promise<AgentSessionInfo[]> {
    return [...this.sessions.values()].map((handle) => toInfo(handle));
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionInfo> {
    const mod = await this.loadModule();
    if (!mod) throw new Error('pi 不可用：未安装 @earendil-works/pi-coding-agent');

    const cwd = this.resolveCwd(input.workspaceId);
    const createOptions: Record<string, unknown> = { cwd };
    if (this.options.agentDir) createOptions['agentDir'] = this.options.agentDir;
    if (this.options.model) createOptions['model'] = this.options.model;
    if (this.options.thinkingLevel) createOptions['thinkingLevel'] = this.options.thinkingLevel;
    if (this.options.tools) createOptions['tools'] = this.options.tools;

    const { session } = await mod.createAgentSession(createOptions);
    const id = createId('pi');
    const handle: PiSessionHandle = {
      id,
      workspaceId: input.workspaceId,
      title: input.title ?? '新会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      session: session as unknown as PiAgentSession,
      unsubscribe: () => undefined,
      messages: [],
    };
    this.sessions.set(id, handle);
    return toInfo(handle);
  }

  async getSession(sessionId: string): Promise<AgentSessionInfo | undefined> {
    const handle = this.sessions.get(sessionId);
    return handle ? toInfo(handle) : undefined;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) return;
    this.abortControllers.get(sessionId)?.abort();
    handle.unsubscribe();
    handle.session.dispose();
    this.sessions.delete(sessionId);
    this.abortControllers.delete(sessionId);
  }

  async renameSession(sessionId: string, title: string): Promise<AgentSessionInfo> {
    const handle = this.sessions.get(sessionId);
    if (!handle) throw new Error(`Session not found: ${sessionId}`);
    handle.title = title;
    handle.updatedAt = Date.now();
    return toInfo(handle);
  }

  async listMessages(sessionId: string): Promise<AgentMessage[]> {
    const handle = this.sessions.get(sessionId);
    return handle ? [...handle.messages] : [];
  }

  async send(input: SendPromptInput, sink: AgentEventSink): Promise<void> {
    const handle = this.sessions.get(input.sessionId);
    if (!handle) throw new Error(`Session not found: ${input.sessionId}`);

    const controller = new AbortController();
    this.abortControllers.set(input.sessionId, controller);
    const onAbort = (): void => {
      void handle.session.abort();
    };
    sink.signal.addEventListener('abort', onAbort, { once: true });

    const userMessage: AgentMessage = {
      id: createId('msg'),
      role: 'user',
      text: input.text,
      createdAt: Date.now(),
    };
    handle.messages.push(userMessage);
    handle.updatedAt = Date.now();
    handle.status = 'running';
    sink.emit({ type: 'message', message: userMessage });
    sink.emit({ type: 'status', status: 'running' });

    const unsubscribe = handle.session.subscribe((event) => {
      this.onPiEvent(event, handle, sink);
    });
    handle.unsubscribe = unsubscribe;

    try {
      const promptOptions: { streamingBehavior?: 'steer' | 'followUp' } = {};
      if (input.disposition) promptOptions.streamingBehavior = input.disposition;
      await handle.session.prompt(input.text, promptOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      handle.status = 'error';
      sink.emit({ type: 'error', message });
    } finally {
      unsubscribe();
      handle.unsubscribe = () => undefined;
      sink.signal.removeEventListener('abort', onAbort);
      this.abortControllers.delete(input.sessionId);
      if (handle.status === 'running') {
        handle.status = 'idle';
        sink.emit({ type: 'status', status: 'idle' });
      }
    }
  }

  async abort(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    this.abortControllers.get(sessionId)?.abort();
    if (!handle) return;
    await handle.session.abort();
    handle.status = 'aborted';
  }

  async dispose(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.deleteSession(sessionId);
    }
  }

  private onPiEvent(event: PiSessionEvent, handle: PiSessionHandle, sink: AgentEventSink): void {
    switch (event.type) {
      case 'message_update': {
        const delta = event.assistantMessageEvent?.delta;
        if (typeof delta === 'string' && delta.length > 0) {
          sink.emit({
            type: 'message',
            message: {
              id: createId('msg'),
              role: 'assistant',
              text: delta,
              createdAt: Date.now(),
              partial: true,
            },
          });
        }
        return;
      }
      case 'message_end': {
        const text = extractText(event.message);
        if (text) {
          // role 必须取 pi 的真实角色：pi 的 message_end 同样会带用户消息，
          // 写死成 assistant 会把用户输入当成模型回复。
          const role = mapRole(event.message?.role);
          const message: AgentMessage = {
            id: createId('msg'),
            role,
            text,
            createdAt: Date.now(),
          };
          handle.messages.push(message);
          handle.updatedAt = Date.now();
          sink.emit({ type: 'message', message });
        }
        return;
      }
      case 'tool_execution_start': {
        sink.emit({
          type: 'tool',
          tool: { toolCallId: event.toolCallId, name: event.toolName, status: 'started' },
        });
        return;
      }
      case 'tool_execution_end': {
        sink.emit({
          type: 'tool',
          tool: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            status: event.isError ? 'failed' : 'completed',
          },
        });
        return;
      }
      case 'agent_settled': {
        handle.status = event.aborted ? 'aborted' : 'idle';
        handle.updatedAt = Date.now();
        sink.emit({ type: 'status', status: handle.status });
        return;
      }
      default:
        return;
    }
  }

  private resolveCwd(workspaceId: string): string {
    if (this.options.cwd) return this.options.cwd;
    // 工作区 id 形如 ws_<path 的安全化形式>；无法反推时退回进程 cwd。
    const workspace = this.workspaceCache.get(workspaceId);
    return workspace ?? process.cwd();
  }

  /** 工作区缓存：由运行时在创建会话前登记。 */
  readonly workspaceCache = new Map<string, string>();
}

type PiModule = {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: unknown }>;
};

function toInfo(handle: PiSessionHandle): AgentSessionInfo {
  return {
    id: handle.id,
    agentId: 'pi',
    workspaceId: handle.workspaceId,
    title: handle.title,
    createdAt: handle.createdAt,
    updatedAt: handle.updatedAt,
    status: handle.status,
  };
}

function extractText(message: PiAssistantMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
