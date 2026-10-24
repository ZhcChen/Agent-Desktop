import type { BrowserWindow } from 'electron';
import { Readable, Writable } from 'node:stream';
import type { ServiceFrame } from '@agent-desktop/app-server-protocol';
import { IPC_CHANNELS } from '../config/constants.js';
import type { AppSettings } from '../config/settings.js';
import { AppServerLink } from './app-server-link.js';
import { ContainerManager, type ContainerStatus } from './container.js';
import { preparePiConfig, type PreparedPiConfig } from './pi-config.js';
import { RendererTransport } from './renderer-transport.js';
import type { RuntimeTransportMode } from './transport-mode.js';

/**
 * 运行时监管者：把容器、协议链路与渲染层传输串起来。
 *
 * 职责边界：
 * - 容器：跑 agent（进程内嵌入 pi），宿主不执行任何 agent 动作；
 * - 链路：主进程终结容器侧线级协议；
 * - 传输：把帧交给渲染层（direct 走 MessagePort，protocol 走 app://）。
 */
export interface SupervisorOptions {
  settings: AppSettings;
  /** 容器内运行时入口。 */
  entry: string;
  mode: RuntimeTransportMode;
  /** 宿主 pi 配置目录。 */
  hostAgentDir?: string;
  dockerBin?: string;
  onLog?: (line: string) => void;
  onStatus?: (status: ContainerStatus, detail?: string) => void;
}

export class RuntimeSupervisor {
  private container: ContainerManager | undefined;
  private link: AppServerLink | undefined;
  private transport: RendererTransport | undefined;
  private prepared: PreparedPiConfig | undefined;
  private window: BrowserWindow | undefined;
  private currentStatus: ContainerStatus = 'stopped';

  constructor(private readonly options: SupervisorOptions) {}

  get status(): ContainerStatus {
    return this.currentStatus;
  }

  get rendererTransport(): RendererTransport | undefined {
    return this.transport;
  }

  /** 启动容器并建立链路。 */
  async start(window: BrowserWindow): Promise<void> {
    this.window = window;
    const settings = this.options.settings;

    this.prepared = await preparePiConfig({
      ...(this.options.hostAgentDir ? { hostAgentDir: this.options.hostAgentDir } : {}),
      containerHost: settings.containerHost,
    });
    for (const warning of this.prepared.warnings) {
      this.options.onLog?.(`[pi-config] ${warning}`);
    }

    const transport = new RendererTransport({
      mode: this.options.mode,
      sendToRuntime: (frame) => this.sendFrame(frame),
      onRuntimeFrame: (frame) => this.dispatchFrame(frame),
    });
    this.transport = transport;

    const container = new ContainerManager(
      {
        image: settings.image,
        entry: this.options.entry,
        agentDir: this.prepared.dir,
        containerAgentDir: '/etc/agent-desktop/pi',
        workspaces: settings.workspaces.map((path) => ({ path, writable: true })),
        env: {
          ...this.prepared.env,
          AGENT_DESKTOP_AGENT_DIR: '/etc/agent-desktop/pi',
          AGENT_DESKTOP_WORKSPACES: JSON.stringify(
            settings.workspaces.map((path) => ({
              id: `ws_${path.replace(/[^a-zA-Z0-9]/g, '_')}`,
              path,
              name: path.split('/').filter(Boolean).pop() ?? path,
            })),
          ),
        },
        ...(this.options.dockerBin ? { dockerBin: this.options.dockerBin } : {}),
      },
      {
        onStdout: (chunk) => this.link?.onChunk(chunk),
        onStderr: (chunk) => this.options.onLog?.(`[container] ${chunk.toString('utf8').trimEnd()}`),
        onExit: (code) => {
          this.setStatus(code === 0 ? 'stopped' : 'error', `容器退出码 ${code ?? 'null'}`);
        },
        onStatus: (status, detail) => this.setStatus(status, detail),
      },
    );
    this.container = container;

    await container.start();

    this.link = new AppServerLink({
      input: container.stdout ?? new Readable({ read(): void {} }),
      output: container.stdin ?? new Writable({ write(): boolean { return true; } }),
      onFrame: (frame) => transport.dispatch(frame),
      onReady: () => this.options.onLog?.('[runtime] 握手完成'),
      onError: (error) => this.options.onLog?.(`[runtime] ${error.message}`),
    });
    this.link.start();
  }

  /** 渲染层请求端口：direct 模式把 MessagePort 交给渲染层。 */
  grantPort(): Electron.MessagePortMain | undefined {
    if (!this.transport || this.options.mode !== 'direct') return undefined;
    return this.transport.createPortPair().port;
  }

  async stop(): Promise<void> {
    await this.container?.stop();
    this.container = undefined;
    this.link = undefined;
  }

  private sendFrame(frame: ServiceFrame): void {
    this.link?.sendFrame(frame);
  }

  private dispatchFrame(frame: ServiceFrame): void {
    this.transport?.dispatch(frame);
  }

  private setStatus(status: ContainerStatus, detail?: string): void {
    this.currentStatus = status;
    this.options.onStatus?.(status, detail);
    if (status === 'error') {
      this.window?.webContents.send(IPC_CHANNELS.RUNTIME_TRANSPORT_LOST);
    }
  }
}
