# Agent-Desktop 架构

本文记录当前实现的分层、协议与边界。**边界**（只增强、不改 agent 行为）见仓库根 `AGENTS.md`。

## 1. 总体分层

```
┌──────────────────────────────────────────────────────────────┐
│ 渲染层  apps/renderer (React + Vite)                        │
│   直接使用 app-server 协议；Electron IPC 只用于宿主能力      │
└───────────────┬──────────────────────────────────────────────┘
                │  direct: MessagePort（默认）
                │  protocol: app://（调试，可在 DevTools 观察）
┌───────────────▼──────────────────────────────────────────────┐
│ 主进程  packages/main (Electron)                              │
│   窗口 / 安全默认 / 宿主能力 IPC / 容器编排 / 协议中转        │
└───────────────┬──────────────────────────────────────────────┘
                │  stdio：换行分隔 JSON（可选二进制帧）
┌───────────────▼──────────────────────────────────────────────┐
│ 容器  agent-desktop-runtime:dev                              │
│   packages/runtime：app-server 服务 + 多 agent 适配层         │
│   agent 进程内嵌入（第一期：pi 的官方 SDK）                   │
└──────────────────────────────────────────────────────────────┘
```

关键取舍：**渲染层直说 agent 协议**。Electron IPC 只承载宿主能力（窗口、目录选择、设置、容器状态、传输端口），不承载 agent 语义。这样换传输方式（本地 / 远程 / SSH）时，服务层不需要改。

## 2. 协议：app-server

`packages/app-server-protocol` 定义两层。

**帧层**（`frames.ts`）：结构化对象，在 MessagePort 上直接传递（Uint8Array 零拷贝）。

| 帧 | 方向 | 用途 |
|---|---|---|
| `request` | 客户端 → 服务端 | 一次服务操作调用 |
| `response` | 服务端 → 客户端 | 操作结果 |
| `event` | 服务端 → 客户端 | 流式增量、状态变化 |

**线级**（`wire.ts` / `binary-frame.ts`）：换行分隔 JSON，可选叠加二进制帧。

- 二进制帧格式：`\x1E` + JSON 头 + `\n` + 裸字节。`\x1E` 不可能是 JSON 首字节，因此两种帧可在同一条流上交错。
- 只有握手时双方都声明支持才启用二进制帧，否则一律 base64（33% 膨胀是带宽受限链路的实打实成本）。

**方法**：`initialize`（握手）、`desktopService/transport`（隧道）。
隧道用**通知**承载（内外层都靠帧自带 id 相关性），一条连接上只有一种请求形态。

**流控**：`streamWindow` / `stream-credit` / `abort`，额度池在运行时侧（`CreditPool`）。

## 3. 多 agent 适配层

`packages/agent-host` 定义 `AgentAdapter` 接口，通用层只认这个接口：

```ts
interface AgentAdapter {
  descriptor: AgentDescriptor;        // id / 传输机制 / 能力 / 可用性
  probe(): Promise<AgentProbeResult>;  // 依赖装好没有、能不能启动
  listWorkspaces() / listSessions() / createSession() / ...
  send(input, sink): Promise<void>;    // 通过 sink 流式回传事件
  abort(sessionId) / dispose()
}
```

第一期实现：

- `pi` —— 通过 pi 官方 SDK（`@earendil-works/pi-coding-agent`）**进程内嵌入**。动态 import，pi 没装时 `probe()` 报 missing，应用照常启动。
- `stub` —— 内置的最小实现，用来跑通协议与事件流（也是「新增一个 agent 要写多少代码」的参考）。

会话到 agent 的路由由运行时的 `DesktopService` 维护，UI 不需要知道会话背后是哪个 agent。

## 4. 容器化

**agent 一律在容器里跑**，宿主不执行任何 agent 动作。

- 镜像：`docker/Dockerfile`（`node:22-slim` + pi 1.4.0 + tini 作 PID 1）。
- 工作区挂载：**宿主与容器同路径**（`-v /host/path:/host/path`），路径零翻译。
- pi 的 agentDir 同时是配置目录与状态目录（要建 `sessions/`），因此挂载**可写**，落盘在宿主 `~/.agent-desktop/pi`。

### 4.1 模型配置搬运

`packages/main/src/runtime/pi-config.ts` 负责把宿主的 pi 配置搬进容器：

1. **网络**：`127.0.0.1:8080` 在容器里指容器自己，改写成 `host.docker.internal:8080`。
2. **凭据**：宿主配置里的 `apiKey` 是 `!<shell 命令>` 形式（运行时现读），容器里没有那个文件。
   做法是**在宿主侧解析一次** → 作为环境变量传给容器 → 容器内配置改写成 `!printenv <VAR>`。
   密钥不落盘、不进镜像、也不出现在 docker 命令行（用 `--env-file`，不用 `-e KEY=VALUE`）。
3. **范围**：去掉扩展与插件包配置（技能 / MCP 包 / 预设扩展暂不接入），保留模型、凭据、思考等级。

## 5. 传输模式

| 模式 | 机制 | 用途 |
|---|---|---|
| `direct`（默认） | MessagePort 转移给渲染层 | 生产 |
| `protocol` | `app://` 自定义协议 | 调试：运行时请求出现在 Chromium DevTools 的 Network 面板 |

切换由 `--runtime-transport=` 或 `MAVIS_RUNTIME_TRANSPORT` 决定，判定集中在 `transport-mode.ts`，主进程解析与菜单开关共用同一函数，避免标准漂移。

## 6. 安全

- `DEFAULT_SECURE_WEB_PREFERENCES`：`nodeIntegration: false`、`contextIsolation: true`、`webSecurity: true`、`allowRunningInsecureContent: false`、`sandbox: true`。
- 渲染层 CSP：默认源 `'self'`，连接源含 `app://agent-desktop`。
- IPC 处理器统一校验发送方（拒绝非主框架）。
- 外部链接交给系统浏览器，不在应用内开窗。

## 7. 当前范围

**已做**：Electron 骨架、协议、适配层、pi 适配器、容器化与配置搬运、主进程、preload、渲染层、测试。

**明确不做**（本阶段）：云端概念、登录模块、定时任务、网站、远程（SSH）、插件、技能。

原因：本项目是多 agent 集合的宿主，这些能力要么依赖账号体系，要么属于单个 agent 的生态，先不绑进来。

## 8. 验证

```bash
pnpm typecheck        # 全 workspace 类型检查
pnpm test             # 协议 / 适配层 / 运行时单测
pnpm build            # 主进程 / preload / 渲染层 / 容器运行时
pnpm docker:build     # 构建运行时镜像
pnpm integration      # 端到端：容器内 pi 经本地网关跑通真实模型
```

`pnpm integration` 不启动 Electron GUI，只在后台起容器。
