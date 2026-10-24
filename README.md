# Agent Desktop

基于 Electron 的多 Agent 桌面端。把命令行 Agent（`pi`、`codex cli`、`claude code` 等）封装成可用的桌面应用。

- **第一期**：接入 `pi`
- **运行边界**：agent 跑在 Docker 容器里，宿主只做 GUI 与编排

## 特点

- **只做增强**：不修改被封装的 agent 行为，接入走它官方的 SDK / CLI / 扩展点
- **多 agent 集合**：agent 差异收敛在适配器后面，通用层不感知具体是哪个 agent
- **渲染层直说 agent 协议**：Electron IPC 只承载宿主能力，不承载 agent 语义
- **传输可观测**：默认 MessagePort 直连，另有 `app://` 调试模式，运行时请求出现在 DevTools Network 面板
- **模型配置可搬运**：宿主 pi 的 provider 配置与凭据自动搬进容器

## 快速开始

```bash
pnpm install
pnpm docker:build      # 构建运行时镜像（node + pi）
pnpm dev               # 开发模式
```

首次使用需要在应用里添加工作区目录（容器会以同路径挂载）。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm typecheck` | 全 workspace 类型检查 |
| `pnpm test` | 协议 / 适配层 / 运行时单测 |
| `pnpm build` | 主进程 / preload / 渲染层 / 容器运行时 |
| `pnpm docker:build` | 构建运行时镜像 |
| `pnpm integration` | 端到端：容器内 pi 经本地网关跑通真实模型（不启 GUI） |

## 目录

```
packages/app-server-protocol   协议契约：帧、线级编解码、二进制帧
packages/agent-host            多 agent 适配接口 + 注册表 + pi 适配器 + stub
packages/runtime               容器内 app-server 服务（stdio JSON-RPC）
packages/main                  Electron 主进程：窗口 / 宿主能力 / 容器编排
packages/preload               预加载：contextBridge 暴露面
apps/renderer                  React 渲染层
docker/                        运行时镜像
docs/architecture.md           架构说明
```

详细架构见 [docs/architecture.md](docs/architecture.md)，项目边界见 [AGENTS.md](AGENTS.md)。
