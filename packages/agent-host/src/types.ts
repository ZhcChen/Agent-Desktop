/**
 * Agent 适配接口。
 *
 * 这一层是「多 agent 集合」的关键：通用层（会话管理、事件分发、UI）
 * 只认这个接口，agent 之间的差异全部收敛在适配器内部。
 *
 * 约束（见仓库根 AGENTS.md）：适配器**不修改**被封装的 agent 行为，
 * 只调用它官方的既有能力（SDK / CLI / 扩展点）。
 */

export type AgentId = string;

export type AgentAvailability = 'ready' | 'missing' | 'disabled';

/** 传输机制：进程内嵌入，还是以子进程方式跑。 */
export type AgentTransport = 'embedded' | 'subprocess';

export interface AgentCapabilities {
  /** 是否支持流式增量输出。 */
  streaming: boolean;
  /** 是否暴露工具调用。 */
  tools: boolean;
  /** 是否支持恢复历史会话。 */
  resume: boolean;
  /** 是否支持从某条消息分叉。 */
  fork: boolean;
}

export interface AgentDescriptor {
  id: AgentId;
  displayName: string;
  transport: AgentTransport;
  availability: AgentAvailability;
  /** availability 非 ready 时给一句人话原因。 */
  detail?: string;
  capabilities: AgentCapabilities;
}

/** 工作区 = agent 运行所在的工作目录。 */
export interface AgentWorkspace {
  id: string;
  path: string;
  name: string;
}

export type AgentSessionStatus = 'idle' | 'running' | 'aborted' | 'error';

export interface AgentSessionInfo {
  id: string;
  agentId: AgentId;
  workspaceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: AgentSessionStatus;
}

export type AgentMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  text: string;
  createdAt: number;
  /** 流式增量消息。 */
  partial?: boolean;
}

export type AgentToolStatus = 'started' | 'completed' | 'failed';

export interface AgentToolEvent {
  toolCallId: string;
  name: string;
  status: AgentToolStatus;
  detail?: string;
}

/** 适配器向通用层发出的事件。 */
export type AgentEvent =
  | { type: 'message'; message: AgentMessage }
  | { type: 'tool'; tool: AgentToolEvent }
  | { type: 'status'; status: AgentSessionStatus; detail?: string }
  | { type: 'error'; message: string };

/**
 * 事件出口。
 *
 * `signal` 在会话被删除或适配器被释放时中止，
 * 适配器必须据此停止正在进行的 run。
 */
export interface AgentEventSink {
  emit(event: AgentEvent): void;
  signal: AbortSignal;
}

export interface CreateSessionInput {
  workspaceId: string;
  title?: string;
}

export interface SendPromptInput {
  sessionId: string;
  text: string;
  /**
   * 会话正在流式输出时的投递方式。
   * 必须显式指定：落到错误的时机比拒绝更糟。
   */
  disposition?: 'steer' | 'followUp';
}

export interface AgentProbeResult {
  available: boolean;
  detail?: string;
}

/**
 * agent 适配器。
 *
 * 一个 agent 一个实现。通用层只通过这个接口驱动它。
 */
export interface AgentAdapter {
  readonly descriptor: AgentDescriptor;

  /** 探测可用性（依赖是否装好、凭据是否齐、能否启动）。 */
  probe(): Promise<AgentProbeResult>;

  listWorkspaces(): Promise<AgentWorkspace[]>;
  listSessions(): Promise<AgentSessionInfo[]>;
  createSession(input: CreateSessionInput): Promise<AgentSessionInfo>;
  getSession(sessionId: string): Promise<AgentSessionInfo | undefined>;
  deleteSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<AgentSessionInfo>;
  listMessages(sessionId: string): Promise<AgentMessage[]>;

  /**
   * 发送一条输入。
   *
   * 实现必须把流式过程通过 sink 发成事件，并在 run 结束后 resolve。
   */
  send(input: SendPromptInput, sink: AgentEventSink): Promise<void>;

  /** 中断当前 run。 */
  abort(sessionId: string): Promise<void>;

  /** 释放资源。 */
  dispose(): Promise<void>;
}
