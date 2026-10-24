import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * pi 配置桥接：把宿主的 pi 配置搬进容器。
 *
 * 要解决三件事：
 * 1. **网络**：`127.0.0.1` 在容器里指容器自己，宿主的本地网关必须改写成
 *    `host.docker.internal`（容器可达的宿主地址）。
 * 2. **凭据**：宿主配置里的 apiKey 是 `!<shell 命令>` 形式（运行时现读），
 *    容器里没有那个文件。做法是**在宿主侧解析一次**，把结果作为环境变量
 *    传给容器，容器内配置改写成 `!printenv <VAR>`——密钥不落盘、不进镜像、
 *    也不出现在容器命令行里。
 * 3. **范围**：按本项目当前范围，去掉扩展与插件包（定时/网站/远程/插件/技能
 *    暂不接入），保留模型、凭据、思考等级等基础能力。
 */

export interface PreparedPiConfig {
  /** 宿主上生成的配置目录（挂载进容器）。 */
  dir: string;
  /** 需要传给容器的环境变量（包含凭据）。 */
  env: Record<string, string>;
  /** 迁移过程中的提示（不影响启动）。 */
  warnings: string[];
  /** 成功迁移的 provider 名。 */
  providers: string[];
}

export interface PreparePiConfigOptions {
  /** 宿主上的 pi 配置目录，默认 `~/.pi/agent`。 */
  hostAgentDir?: string;
  /** 容器可达的宿主地址。 */
  containerHost?: string;
  /** 是否保留宿主的扩展/插件包配置。默认 false。 */
  keepExtensions?: boolean;
  /**
   * 生成配置的落盘目录。
   *
   * pi 的 agentDir 同时是**配置目录与状态目录**（它要在里面建 sessions/），
   * 所以必须是可写且持久的——不能是临时目录，也不能只读挂载。
   */
  stateDir?: string;
}

const DEFAULT_CONTAINER_HOST = 'host.docker.internal';

export function defaultHostAgentDir(): string {
  return join(process.env['HOME'] ?? '', '.pi', 'agent');
}

/** 容器内 pi 的状态目录（宿主侧落盘位置）。 */
export function defaultPiStateDir(): string {
  return join(process.env['HOME'] ?? '', '.agent-desktop', 'pi');
}

/**
 * 把 `http://127.0.0.1:8080` 改写成 `http://host.docker.internal:8080`。
 *
 * 只改写 loopback 主机名；其他主机（远端网关、内网地址）保持原样。
 */
export function rewriteBaseUrl(baseUrl: string, containerHost: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1') {
      url.hostname = containerHost;
      return url.toString();
    }
    return baseUrl;
  } catch {
    return baseUrl;
  }
}

/**
 * 解析宿主的 shell 引用型凭据。
 *
 * pi 的约定是 `!<命令>`——运行时执行该命令取回密钥。
 * 这里在宿主侧执行同一条命令，与 pi 自身行为一致。
 */
async function resolveShellCredential(command: string): Promise<string | undefined> {
  const trimmed = command.startsWith('!') ? command.slice(1) : command;
  if (!trimmed.trim()) return undefined;
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', trimmed], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

interface HostModelsConfig {
  providers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

interface HostSettingsConfig {
  [key: string]: unknown;
}

export async function preparePiConfig(options: PreparePiConfigOptions = {}): Promise<PreparedPiConfig> {
  const hostAgentDir = options.hostAgentDir ?? defaultHostAgentDir();
  const containerHost = options.containerHost ?? DEFAULT_CONTAINER_HOST;
  const warnings: string[] = [];
  const env: Record<string, string> = {};
  const providers: string[] = [];

  const modelsPath = join(hostAgentDir, 'models.json');
  let models: HostModelsConfig = {};
  try {
    models = JSON.parse(readFileSync(modelsPath, 'utf8')) as HostModelsConfig;
  } catch {
    warnings.push(`未找到可读的 ${modelsPath}，将不迁移模型配置`);
  }

  const outProviders: Record<string, Record<string, unknown>> = {};
  for (const [name, provider] of Object.entries(models.providers ?? {})) {
    const next: Record<string, unknown> = { ...provider };

    if (typeof provider['baseUrl'] === 'string') {
      next['baseUrl'] = rewriteBaseUrl(provider['baseUrl'], containerHost);
    }

    const apiKey = provider['apiKey'];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      const envName = `AGENT_DESKTOP_PROVIDER_KEY_${name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
      const secret = apiKey.startsWith('!')
        ? await resolveShellCredential(apiKey)
        : apiKey;
      if (secret) {
        env[envName] = secret;
        // 容器内从环境变量现读，密钥不写入任何文件。
        next['apiKey'] = `!printenv ${envName}`;
      } else {
        warnings.push(`provider ${name} 的凭据解析失败，该 provider 将不可用`);
        continue;
      }
    }

    outProviders[name] = next;
    providers.push(name);
  }

  const settingsPath = join(hostAgentDir, 'settings.json');
  let settings: HostSettingsConfig = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as HostSettingsConfig;
  } catch {
    // 没有 settings 也能跑，用 pi 的默认值。
  }

  const outSettings: HostSettingsConfig = {};
  for (const key of ['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'enabledModels', 'theme']) {
    if (settings[key] !== undefined) outSettings[key] = settings[key];
  }
  if (!options.keepExtensions) {
    // 扩展/插件包（技能、MCP 包、预设扩展）暂不接入：它们属于后续阶段。
    delete outSettings['extensions'];
    delete outSettings['packages'];
  }

  const dir = options.stateDir ?? defaultPiStateDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'models.json'), `${JSON.stringify({ providers: outProviders }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(outSettings, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // 某些文件系统不支持 chmod；不阻断。
  }

  return { dir, env, warnings, providers };
}
