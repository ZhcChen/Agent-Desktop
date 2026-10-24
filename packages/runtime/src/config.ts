/**
 * 运行时配置。
 *
 * 全部通过环境变量注入，因为运行时装在容器里，
 * 宿主与容器之间只有环境变量和挂载点两条通道。
 */

export interface RuntimeWorkspaceConfig {
  id: string;
  path: string;
  name: string;
}

export interface RuntimeConfig {
  /** pi 的全局配置目录（内含 models.json / settings.json）。 */
  agentDir: string | undefined;
  /** 默认工作目录。 */
  cwd: string | undefined;
  /** 模型覆盖，格式 `provider/model`。 */
  model: string | undefined;
  /** 思考等级。 */
  thinkingLevel: string | undefined;
  /** 可用工作区。 */
  workspaces: RuntimeWorkspaceConfig[];
  /** 是否注册内置 stub agent。 */
  enableStub: boolean;
  /** 是否注册 pi agent。 */
  enablePi: boolean;
}

function readWorkspaces(raw: string | undefined): RuntimeWorkspaceConfig[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const record = item as Record<string, unknown>;
      const path = typeof record['path'] === 'string' ? record['path'] : '';
      if (!path) return [];
      const name = typeof record['name'] === 'string' ? record['name'] : basename(path);
      const id = typeof record['id'] === 'string' ? record['id'] : `ws_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
      return [{ id, path, name }];
    });
  } catch {
    return [];
  }
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    agentDir: env['AGENT_DESKTOP_AGENT_DIR'] || undefined,
    cwd: env['AGENT_DESKTOP_CWD'] || undefined,
    model: env['AGENT_DESKTOP_MODEL'] || undefined,
    thinkingLevel: env['AGENT_DESKTOP_THINKING_LEVEL'] || undefined,
    workspaces: readWorkspaces(env['AGENT_DESKTOP_WORKSPACES']),
    enableStub: env['AGENT_DESKTOP_ENABLE_STUB'] !== '0',
    enablePi: env['AGENT_DESKTOP_ENABLE_PI'] !== '0',
  };
}
