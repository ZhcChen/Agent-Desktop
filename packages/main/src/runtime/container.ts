import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 容器编排。
 *
 * agent 一律跑在容器里，宿主只负责：
 * - 起/停容器；
 * - 挂载工作区（**宿主与容器同路径**，路径零翻译）；
 * - 注入环境变量（含凭据）。
 *
 * 凭据通过 `--env-file` 传递而不是 `-e KEY=VALUE`：
 * 后者会把密钥写进 docker 命令行，任何能读进程列表的人都能看到。
 */

export type ContainerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface ContainerWorkspace {
  /** 宿主路径；容器内使用同一路径。 */
  path: string;
  /** 是否可写。默认只读挂载。 */
  writable?: boolean;
}

export interface ContainerManagerOptions {
  image: string;
  /** 容器内运行时入口。 */
  entry: string;
  /** 宿主 pi 配置目录，挂载到 containerAgentDir。 */
  agentDir: string;
  containerAgentDir: string;
  workspaces: ContainerWorkspace[];
  /** 传给容器的环境变量。 */
  env: Record<string, string>;
  /** docker 可执行文件。 */
  dockerBin?: string;
}

export interface ContainerManagerEvents {
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onStatus?: (status: ContainerStatus, detail?: string) => void;
}

export class ContainerManager {
  private child: ChildProcessWithoutNullStreams | undefined;
  private currentStatus: ContainerStatus = 'stopped';
  private envFileDir: string | undefined;

  constructor(
    private readonly options: ContainerManagerOptions,
    private readonly events: ContainerManagerEvents = {},
  ) {}

  get status(): ContainerStatus {
    return this.currentStatus;
  }

  /** 容器 stdout（协议输入）。 */
  get stdout(): NodeJS.ReadableStream | undefined {
    return this.child?.stdout;
  }

  /** 容器 stdin（协议输出）。 */
  get stdin(): NodeJS.WritableStream | undefined {
    return this.child?.stdin;
  }

  get dockerArgs(): string[] {
    const docker = this.options.dockerBin ?? 'docker';
    const args = [
      'run',
      '--rm',
      '-i',
      // Linux 上需要显式声明；macOS/OrbStack 已有同名解析，重复声明无害。
      '--add-host',
      'host.docker.internal:host-gateway',
    ];

    for (const workspace of this.options.workspaces) {
      const suffix = workspace.writable === false ? ':ro' : '';
      args.push('-v', `${workspace.path}:${workspace.path}${suffix}`);
    }

    // pi 的 agentDir 既是配置目录也是状态目录（它要在里面建 sessions/），
    // 必须可写；只读挂载会让 pi 无法创建会话。
    args.push('-v', `${this.options.agentDir}:${this.options.containerAgentDir}`);

    if (this.envFilePath) {
      args.push('--env-file', this.envFilePath);
    }

    args.push(this.options.image);
    args.push(this.options.entry);
    return args;
  }

  private envFilePath: string | undefined;

  async start(): Promise<void> {
    if (this.child) return;
    this.setStatus('starting');

    this.envFilePath = this.writeEnvFile(this.options.env);
    const docker = this.options.dockerBin ?? 'docker';

    const child = spawn(docker, this.dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.events.onStdout?.(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.events.onStderr?.(chunk));
    child.on('error', (error) => {
      this.setStatus('error', error.message);
      this.cleanup();
    });
    child.on('exit', (code, signal) => {
      this.setStatus(code === 0 ? 'stopped' : 'error', `退出码 ${code ?? 'null'}`);
      this.events.onExit?.(code, signal);
      this.cleanup();
    });
  }

  /** 写容器 stdin。 */
  write(chunk: Buffer | string): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(chunk);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.setStatus('stopped');
    this.cleanup();
  }

  private setStatus(status: ContainerStatus, detail?: string): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.events.onStatus?.(status, detail);
  }

  private writeEnvFile(env: Record<string, string>): string | undefined {
    const entries = Object.entries(env).filter(([, value]) => typeof value === 'string' && value.length > 0);
    if (entries.length === 0) return undefined;
    this.envFileDir = mkdtempSync(join(tmpdir(), 'agent-desktop-env-'));
    const file = join(this.envFileDir, 'runtime.env');
    const body = entries.map(([key, value]) => `${key}=${value}`).join('\n');
    writeFileSync(file, `${body}\n`, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // 不支持 chmod 时不阻断。
    }
    return file;
  }

  private cleanup(): void {
    this.child = undefined;
  }
}
