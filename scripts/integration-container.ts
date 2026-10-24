/**
 * 端到端集成验证：容器内的 pi 通过本地 sub2api 网关跑通一次真实模型调用。
 *
 * 覆盖链路：
 *   宿主 pi 配置 →（凭据解析 + baseUrl 改写）→ 容器内 pi 配置
 *   → 容器内 app-server（stdio JSON-RPC）→ 主进程链路 → 帧
 *   → agents/list → sessions/create → sessions/send → 流式事件
 *
 * 不启动 Electron，不触碰宿主上的 agent 状态。
 *
 * 用法：node scripts/integration-container.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerLink } from '../packages/main/src/runtime/app-server-link.js';
import { ContainerManager } from '../packages/main/src/runtime/container.js';
import { preparePiConfig } from '../packages/main/src/runtime/pi-config.js';
import { SERVICE_METHODS, type ServiceFrame } from '../packages/app-server-protocol/src/index.js';

const IMAGE = process.env['AGENT_DESKTOP_IMAGE'] ?? 'agent-desktop-runtime:dev';
const ENTRY = '/opt/agent-desktop/runtime/agent-runtime.mjs';

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'agent-desktop-ws-'));
  writeFileSync(join(workspace, 'README.md'), '# 集成测试工作区\n\n用于验证容器内 agent 能读写挂载目录。\n');

  const prepared = await preparePiConfig({ containerHost: 'host.docker.internal' });
  console.log('[integration] 迁移的 provider:', prepared.providers.join(', ') || '(无)');
  for (const warning of prepared.warnings) console.warn('[integration] 警告:', warning);
  if (prepared.providers.length === 0) {
    throw new Error('没有可用的 provider，无法进行集成验证');
  }

  const container = new ContainerManager(
    {
      image: IMAGE,
      entry: ENTRY,
      agentDir: prepared.dir,
      containerAgentDir: '/etc/agent-desktop/pi',
      workspaces: [{ path: workspace, writable: true }],
      env: {
        ...prepared.env,
        AGENT_DESKTOP_AGENT_DIR: '/etc/agent-desktop/pi',
        AGENT_DESKTOP_WORKSPACES: JSON.stringify([
          { id: 'ws_test', path: workspace, name: 'integration-ws' },
        ]),
        AGENT_DESKTOP_ENABLE_STUB: '0',
      },
    },
    {
      onStderr: (chunk) => process.stderr.write(`[container] ${chunk.toString('utf8')}`),
      onStatus: (status, detail) => console.log('[integration] 容器状态:', status, detail ?? ''),
    },
  );

  const frames: ServiceFrame[] = [];

  await container.start();

  // 必须在容器起来之后再取 stdout/stdin，否则拿到的是 undefined。
  const link = new AppServerLink({
    input: container.stdout ?? process.stdin,
    output: container.stdin ?? process.stdout,
    onFrame: (frame) => {
      frames.push(frame);
      if (process.env['AGENT_DESKTOP_DEBUG'] === '1') {
        console.log('[debug frame]', JSON.stringify(frame).slice(0, 400));
      }
    },
    onReady: () => console.log('[integration] 握手完成'),
    onError: (error) => console.error('[integration] 链路错误:', error.message),
  });
  link.start();
  await waitFor(() => link.isReady, 30_000, '运行时握手');

  const request = async (method: string, params?: unknown): Promise<unknown> => {
    const result = await link.request(method, params);
    return result;
  };

  const agentList = (await request(SERVICE_METHODS.agentsList)) as {
    agents: Array<{ id: string; availability: string; detail?: string }>;
  };
  console.log('[integration] agent 列表:', JSON.stringify(agentList.agents));

  const pi = agentList.agents.find((agent) => agent.id === 'pi');
  if (!pi) throw new Error('容器内没有注册 pi 适配器');
  if (pi.availability !== 'ready') {
    throw new Error(`pi 适配器不可用: ${pi.detail ?? '未知原因'}`);
  }

  const workspaceList = (await request(SERVICE_METHODS.workspacesList)) as {
    workspaces: Array<{ id: string; path: string }>;
  };
  console.log('[integration] 工作区:', JSON.stringify(workspaceList.workspaces));
  if (!workspaceList.workspaces[0]) throw new Error('容器内没有工作区');

  const created = await request(SERVICE_METHODS.sessionsCreate, {
    agentId: 'pi',
    workspaceId: workspaceList.workspaces[0].id,
    title: '集成测试',
  }).catch((error: unknown) => {
    throw new Error(`sessions/create 失败：${error instanceof Error ? error.message : String(error)}`);
  });
  console.log('[integration] sessions/create 返回:', JSON.stringify(created));
  const sessionId = (created as { session?: { id?: string } })?.session?.id;
  if (!sessionId) throw new Error(`sessions/create 没有返回 session：${JSON.stringify(created)}`);
  console.log('[integration] 会话已创建:', sessionId);

  const collected: string[] = [];
  await request(SERVICE_METHODS.sessionsSend, {
    sessionId,
    text: '用一句话回答：2+2 等于几？',
  });

  // 事件是异步到达的：帧数组只增不减，用游标避免重复累加。
  // 只收 assistant 消息，并等到 run 结束（status 变 idle/aborted/error）才收尾。
  const deadline = Date.now() + 180_000;
  let cursor = 0;
  let finalText = '';
  let settled = false;
  while (Date.now() < deadline) {
    while (cursor < frames.length) {
      const frame = frames[cursor];
      cursor += 1;
      if (frame?.type !== 'event') continue;
      // 帧负载就是 agent 事件本身。
      const event = frame.payload as
        | {
            type?: string;
            message?: { role?: string; text?: string; partial?: boolean };
            status?: string;
          }
        | undefined;
      if (event?.type === 'status' && (event.status === 'idle' || event.status === 'aborted' || event.status === 'error')) {
        settled = true;
      }
      if (event?.type !== 'message') continue;
      const message = event.message;
      if (message?.role !== 'assistant' || !message.text) continue;
      if (message.partial) {
        finalText += message.text;
      } else {
        finalText = message.text;
      }
    }
    if (settled && finalText.trim().length > 0) break;
    await sleep(500);
  }

  const text = finalText.trim();
  console.log('[integration] 模型回复:', text || '(无)');
  if (!text) {
    throw new Error('没有收到任何模型输出');
  }

  await container.stop();
  console.log('[integration] ✅ 通过：容器内 pi 经本地网关完成了一次真实模型调用');
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(200);
  }
  throw new Error(`等待超时：${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error('[integration] ❌ 失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
