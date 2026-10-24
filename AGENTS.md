# Agent-Desktop

## 项目定位

用 Electron 做的 Agent 桌面端，封装命令行 Agent（`pi`、`codex cli`、`claude code` 等）。

- **第一期**：接入 `pi`
- **技术栈**：Electron + React + TypeScript（pnpm monorepo）

## 核心约束：只做增强，不改被封装的 agent

本项目负责的是**桌面 GUI + 用户体验优化**。它不改变任何被封装 agent 的行为。

**做：**

- 桌面端界面、交互与可访问性
- 会话 / 工作区 / 进程生命周期的管理
- 在 agent 既有输出之上的可视化增强（结构化展示、检索、跳转等）

**不做：**

- 修改 agent 自身的逻辑、行为或默认语义
- 绕过 agent 既有的接口与扩展机制去「接管」它
- 让同一个输入在桌面端得到与 CLI 原生**不同**的结果

## 接入原则

封装应建立在 agent 官方的既有能力之上——CLI 通道、公开 SDK、扩展点——以**适配层**的方式接入，而不是改写 agent 本体。

当需求看起来「必须动 agent 才能实现」时，先停下来确认：是否存在纯桌面侧的替代方案？如果没有，那么它可能是超出本项目边界的需求，需要单独提出，而不是在实现中顺手改掉 agent。

## 架构取向

多 agent 目标（pi / codex cli / claude code）意味着集成层必须是**可横向扩展**的：agent 之间的差异由适配器消化，通用层（会话、工作区、进程生命周期、渲染通道）不感知具体是哪个 agent。

## 运行边界：agent 跑在容器里

**agent 的任何动作（读写文件、执行命令）都发生在容器内，宿主不执行。**

- 镜像：`docker/Dockerfile`
- 工作区挂载：宿主与容器**同路径**，路径零翻译
- 模型配置从宿主 pi 配置搬运，baseUrl 改写为容器可达的宿主地址
- 凭据在宿主侧解析一次，经环境变量注入容器（不落盘、不进镜像、不进命令行）

## 当前阶段明确不做

云端概念、登录模块、定时任务、网站、远程（SSH）、插件、技能——它们要么依赖账号体系，要么属于单个 agent 的生态，与「多 agent 集合」的定位不匹配，后续再考虑。

## 参考实现

MCode（MiniMax Code）是一个成熟的同类产品：其 CLI 开源（`MiniMax-AI/minimax-code`，MIT），桌面端闭源但可用 REA 逆向取证。本项目的分层、传输模式、容器化与协议设计参考了它。

- 取用边界：只借鉴**架构与模式**，不复制闭源实现代码
- 开源仓库里可读：TUI / headless CLI / ACP 实现 / `third_party/pi-mono/MINIMAX_CHANGES.md`（把 pi 嵌进桌面宿主还缺哪些 seam 的补丁账本）
- 闭源部分只做黑盒观察，产物不进本仓库

## 开发

```bash
pnpm install
pnpm typecheck        # 全 workspace 类型检查
pnpm test             # 单测
pnpm build            # 主进程 / preload / 渲染层 / 容器运行时
pnpm docker:build     # 构建运行时镜像
pnpm integration      # 端到端：容器内 pi 经本地网关跑通真实模型（不启 GUI）
```

详细架构见 [docs/architecture.md](docs/architecture.md)。
