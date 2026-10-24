import type { ServiceErrorPayload } from './errors.js';

/**
 * 帧契约。
 *
 * 帧是结构化对象，在 MessagePort 上直接传递（支持 Uint8Array），
 * 在 app:// 或 stdio 上序列化为线级消息。
 */

/** 客户端 → 服务端：一次服务操作调用。 */
export interface ServiceRequestFrame {
  type: 'request';
  id: string;
  method: string;
  params?: unknown;
}

/** 服务端 → 客户端：一次服务操作的最终结果。 */
export interface ServiceResponseFrame {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ServiceErrorPayload;
  /** 结果为二进制时置位，载荷走二进制帧，避免 base64 膨胀。 */
  binary?: boolean;
}

/** 服务端 → 客户端：主动事件（流式增量、状态变化等）。 */
export interface ServiceEventFrame {
  type: 'event';
  topic: string;
  payload?: unknown;
  /** 事件序号，供客户端检测乱序与丢帧。 */
  seq?: number;
}

export type ServiceFrame = ServiceRequestFrame | ServiceResponseFrame | ServiceEventFrame;

/* ------------------------------------------------------------------ *
 * 服务方法
 * ------------------------------------------------------------------ */

/** 服务层方法名。通用层只认这些方法，不感知具体 agent。 */
export const SERVICE_METHODS = {
  /** 列出已注册 agent（多 agent 集合的入口）。 */
  agentsList: 'agents/list',
  /** 列出工作区（= agent 的工作目录集合）。 */
  workspacesList: 'workspaces/list',
  /** 列出会话。 */
  sessionsList: 'sessions/list',
  /** 创建会话。 */
  sessionsCreate: 'sessions/create',
  /** 读取单个会话。 */
  sessionsGet: 'sessions/get',
  /** 删除会话。 */
  sessionsDelete: 'sessions/delete',
  /** 重命名会话。 */
  sessionsRename: 'sessions/rename',
  /** 发送一条用户输入（可能触发一次 run）。 */
  sessionsSend: 'sessions/send',
  /** 中断当前 run。 */
  sessionsAbort: 'sessions/abort',
  /** 读取会话历史消息。 */
  sessionsMessages: 'sessions/messages',
  /** 订阅会话事件（返回订阅 id）。 */
  sessionsSubscribe: 'sessions/subscribe',
  /** 取消订阅。 */
  sessionsUnsubscribe: 'sessions/unsubscribe',
} as const;

export type ServiceMethod = (typeof SERVICE_METHODS)[keyof typeof SERVICE_METHODS];

/** 服务端主动事件主题。 */
export const SERVICE_EVENTS = {
  /** 流式消息增量。 */
  message: 'session/message',
  /** 工具调用状态。 */
  tool: 'session/tool',
  /** 运行状态（started / settled / aborted / error）。 */
  status: 'session/status',
  /** 会话级错误。 */
  error: 'session/error',
  /** 流控额度更新。 */
  credit: 'runtime/credit',
} as const;

export type ServiceEventTopic = (typeof SERVICE_EVENTS)[keyof typeof SERVICE_EVENTS];

/* ------------------------------------------------------------------ *
 * 服务载荷
 * ------------------------------------------------------------------ */

/** agent 描述。通用层用它渲染切换器，不关心 agent 内部实现。 */
export interface AgentDescriptorPayload {
  id: string;
  displayName: string;
  /** 传输机制：进程内嵌入还是子进程。 */
  transport: 'embedded' | 'subprocess';
  availability: 'ready' | 'missing' | 'disabled';
  detail?: string;
  capabilities: {
    streaming: boolean;
    tools: boolean;
    resume: boolean;
    fork: boolean;
  };
}

export interface WorkspacePayload {
  id: string;
  path: string;
  name: string;
}

export interface SessionPayload {
  id: string;
  agentId: string;
  workspaceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: 'idle' | 'running' | 'aborted' | 'error';
}

export interface SessionMessagePayload {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  createdAt: number;
  /** 流式增量时为 true。 */
  partial?: boolean;
}

export interface SendPromptParams {
  sessionId: string;
  text: string;
  /**
   * 会话正在流式输出时的投递方式。
   * 必须显式指定：猜测会导致消息落在错误的时机。
   */
  disposition?: 'steer' | 'followUp';
}

export interface CreateSessionParams {
  agentId: string;
  workspaceId: string;
  title?: string;
}

export interface AgentListResult {
  agents: AgentDescriptorPayload[];
}

export interface SessionListResult {
  sessions: SessionPayload[];
}

export interface MessageListResult {
  messages: SessionMessagePayload[];
}

/* ------------------------------------------------------------------ *
 * 帧辅助
 * ------------------------------------------------------------------ */

export function isRequestFrame(frame: ServiceFrame): frame is ServiceRequestFrame {
  return frame.type === 'request';
}

export function isResponseFrame(frame: ServiceFrame): frame is ServiceResponseFrame {
  return frame.type === 'response';
}

export function isEventFrame(frame: ServiceFrame): frame is ServiceEventFrame {
  return frame.type === 'event';
}

/** 构造一个成功响应。 */
export function okResponse(id: string, result?: unknown): ServiceResponseFrame {
  return result === undefined ? { type: 'response', id, ok: true } : { type: 'response', id, ok: true, result };
}

/** 构造一个失败响应。 */
export function errorResponse(id: string, error: ServiceErrorPayload): ServiceResponseFrame {
  return { type: 'response', id, ok: false, error };
}
