import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SERVICE_METHODS,
  type AgentDescriptorPayload,
  type SessionMessagePayload,
  type SessionPayload,
  type WorkspacePayload,
} from '@agent-desktop/app-server-protocol';
import { ProtocolClient } from './protocol-client.js';
import { DirectTransport, ProtocolTransport, type FrameTransport } from './transport.js';

type View = 'agents' | 'workspaces' | 'sessions';

export function App() {
  const clientRef = useRef<ProtocolClient | undefined>(undefined);
  const transportRef = useRef<FrameTransport | undefined>(undefined);

  const [status, setStatus] = useState('连接中…');
  const [agents, setAgents] = useState<AgentDescriptorPayload[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspacePayload[]>([]);
  const [sessions, setSessions] = useState<SessionPayload[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<SessionMessagePayload[]>([]);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<View>('sessions');

  const client = clientRef.current;

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    const boot = async (): Promise<void> => {
      const api = window.runtimeTransportAPI;
      if (!api) {
        setStatus('未检测到预加载接口（预加载脚本未加载？）');
        return;
      }
      const { granted, mode } = await api.requestPort();
      if (disposed) return;

      const transport: FrameTransport =
        mode === 'protocol' || !granted ? new ProtocolTransport() : new DirectTransport(api);
      transportRef.current = transport;

      const protocol = new ProtocolClient(transport);
      clientRef.current = protocol;

      unsubscribe = protocol.onEvent((frame) => {
        const payload = frame.payload as { sessionId?: string; message?: SessionMessagePayload } | undefined;
        if (!payload?.sessionId) return;
        if (payload.sessionId !== activeSessionIdRef.current) return;
        if (frame.topic === 'session/message' && payload.message) {
          const message = payload.message;
          setMessages((prev) => {
            if (message.partial) {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant' && last.partial) {
                return [...prev.slice(0, -1), { ...last, text: last.text + message.text }];
              }
              return [...prev, { ...message }];
            }
            return [...prev.filter((item) => !item.partial), message];
          });
        }
        if (frame.topic === 'session/status') {
          setStatus((payload as { status?: string }).status ?? '空闲');
        }
      });

      try {
        const [agentList, workspaceList, sessionList] = await Promise.all([
          protocol.request<{ agents: AgentDescriptorPayload[] }>(SERVICE_METHODS.agentsList),
          protocol.request<{ workspaces: WorkspacePayload[] }>(SERVICE_METHODS.workspacesList),
          protocol.request<{ sessions: SessionPayload[] }>(SERVICE_METHODS.sessionsList),
        ]);
        setAgents(agentList.agents);
        setWorkspaces(workspaceList.workspaces);
        setSessions(sessionList.sessions);
        setStatus(`已连接 · ${agentList.agents.length} 个 agent`);
      } catch (error) {
        setStatus(`连接失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };

    void boot();
    return () => {
      disposed = true;
      unsubscribe?.();
      transportRef.current?.close();
    };
  }, []);

  // 事件回调里需要读到最新的 activeSessionId，用 ref 避免闭包过期。
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const openSession = useCallback(async (sessionId: string) => {
    setActiveSessionId(sessionId);
    const protocol = clientRef.current;
    if (!protocol) return;
    try {
      const result = await protocol.request<{ messages: SessionMessagePayload[] }>(
        SERVICE_METHODS.sessionsMessages,
        { sessionId },
      );
      setMessages(result.messages);
    } catch {
      setMessages([]);
    }
  }, []);

  const createSession = useCallback(async () => {
    const protocol = clientRef.current;
    const ready = agents.find((agent) => agent.availability === 'ready');
    const workspace = workspaces[0];
    if (!protocol || !ready || !workspace) {
      setStatus('没有可用的 agent 或工作区');
      return;
    }
    try {
      const result = await protocol.request<{ session: SessionPayload }>(SERVICE_METHODS.sessionsCreate, {
        agentId: ready.id,
        workspaceId: workspace.id,
      });
      setSessions((prev) => [result.session, ...prev]);
      await openSession(result.session.id);
    } catch (error) {
      setStatus(`创建会话失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [agents, workspaces, openSession]);

  const send = useCallback(async () => {
    const protocol = clientRef.current;
    const text = draft.trim();
    if (!protocol || !activeSessionId || !text) return;
    setDraft('');
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: 'user', text, createdAt: Date.now() },
    ]);
    try {
      await protocol.request(SERVICE_METHODS.sessionsSend, { sessionId: activeSessionId, text });
    } catch (error) {
      setStatus(`发送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [draft, activeSessionId]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [sessions, activeSessionId],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-tabs">
          {(['sessions', 'agents', 'workspaces'] as View[]).map((item) => (
            <button
              key={item}
              className={view === item ? 'tab active' : 'tab'}
              onClick={() => setView(item)}
              type="button"
            >
              {item === 'sessions' ? '会话' : item === 'agents' ? 'Agent' : '工作区'}
            </button>
          ))}
        </div>

        {view === 'sessions' && (
          <div className="list">
            <button className="primary" onClick={() => void createSession()} type="button">
              新建会话
            </button>
            {sessions.map((session) => (
              <button
                key={session.id}
                className={session.id === activeSessionId ? 'row active' : 'row'}
                onClick={() => void openSession(session.id)}
                type="button"
              >
                <span className="row-title">{session.title}</span>
                <span className="row-meta">
                  {session.agentId} · {session.status}
                </span>
              </button>
            ))}
            {sessions.length === 0 && <p className="empty">还没有会话</p>}
          </div>
        )}

        {view === 'agents' && (
          <div className="list">
            {agents.map((agent) => (
              <div className="row" key={agent.id}>
                <span className="row-title">{agent.displayName}</span>
                <span className="row-meta">
                  {agent.transport} · {agent.availability}
                  {agent.detail ? ` · ${agent.detail}` : ''}
                </span>
              </div>
            ))}
            {agents.length === 0 && <p className="empty">没有可用 agent</p>}
          </div>
        )}

        {view === 'workspaces' && (
          <div className="list">
            <button
              className="primary"
              onClick={() => {
                void window.hostAPI?.pickDirectory();
              }}
              type="button"
            >
              添加工作区
            </button>
            {workspaces.map((workspace) => (
              <div className="row" key={workspace.id}>
                <span className="row-title">{workspace.name}</span>
                <span className="row-meta">{workspace.path}</span>
              </div>
            ))}
            {workspaces.length === 0 && <p className="empty">还没有工作区</p>}
          </div>
        )}
      </aside>

      <main className="main">
        <header className="main-header">
          <div>
            <h1>{activeSession?.title ?? 'Agent Desktop'}</h1>
            <p className="muted">{status}</p>
          </div>
          <div className="header-actions">
            <button
              onClick={() => {
                void window.windowControlsAPI?.toggleMaximize();
              }}
              type="button"
            >
              最大化
            </button>
            <button
              onClick={() => {
                void window.windowControlsAPI?.close();
              }}
              type="button"
            >
              关闭
            </button>
          </div>
        </header>

        <section className="messages">
          {messages.map((message, index) => (
            <div className={message.role === 'user' ? 'bubble user' : 'bubble assistant'} key={message.id || index}>
              {message.text}
            </div>
          ))}
          {messages.length === 0 && <p className="empty">选择或新建一个会话开始</p>}
        </section>

        <footer className="composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={3}
          />
          <button className="primary" disabled={!draft.trim() || !activeSessionId} onClick={() => void send()} type="button">
            发送
          </button>
        </footer>
      </main>
    </div>
  );
}
