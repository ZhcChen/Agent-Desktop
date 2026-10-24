import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 应用设置（宿主侧）。
 *
 * 目前只存工作区列表——工作区是宿主的概念（宿主要挂载它们），
 * 运行时会通过环境变量拿到同一份列表。
 */
export interface AppSettings {
  /** 工作区目录（宿主绝对路径）。 */
  workspaces: string[];
  /** 容器镜像名。 */
  image: string;
  /** 容器宿主地址。 */
  containerHost: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  workspaces: [],
  image: 'agent-desktop-runtime:dev',
  containerHost: 'host.docker.internal',
};

export class SettingsStore {
  private cache: AppSettings | undefined;

  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  read(): AppSettings {
    if (this.cache) return this.cache;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        this.cache = {
          workspaces: Array.isArray(record['workspaces'])
            ? record['workspaces'].filter((item): item is string => typeof item === 'string')
            : [],
          image: typeof record['image'] === 'string' ? record['image'] : DEFAULT_SETTINGS.image,
          containerHost:
            typeof record['containerHost'] === 'string' ? record['containerHost'] : DEFAULT_SETTINGS.containerHost,
        };
        return this.cache;
      }
    } catch {
      // 首次启动没有设置文件，用默认值。
    }
    this.cache = { ...DEFAULT_SETTINGS };
    return this.cache;
  }

  write(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = { ...this.read(), ...patch };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    this.cache = next;
    return next;
  }

  addWorkspace(path: string): AppSettings {
    const current = this.read();
    if (current.workspaces.includes(path)) return current;
    return this.write({ workspaces: [...current.workspaces, path] });
  }

  removeWorkspace(path: string): AppSettings {
    const current = this.read();
    return this.write({ workspaces: current.workspaces.filter((item) => item !== path) });
  }
}

export function defaultSettingsPath(userDataDir: string): string {
  return join(userDataDir, 'settings.json');
}

export function settingsExist(path: string): boolean {
  return existsSync(path);
}
