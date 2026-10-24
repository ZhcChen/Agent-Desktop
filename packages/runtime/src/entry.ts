import { AgentRegistry, PiAgentAdapter, StubAgentAdapter } from '@agent-desktop/agent-host';
import { loadRuntimeConfig } from './config.js';
import { DesktopService } from './service.js';
import { startAppServer } from './server.js';

/**
 * 容器入口。
 *
 * 运行时进程在容器里跑，宿主通过 stdio 与它说 app-server 协议。
 * stdout 被协议独占，日志一律走 stderr——否则会污染协议流。
 */
async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.env);
  const registry = new AgentRegistry();

  if (config.enableStub) {
    registry.register(new StubAgentAdapter());
  }

  if (config.enablePi) {
    const pi = new PiAgentAdapter({
      ...(config.agentDir ? { agentDir: config.agentDir } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
    });
    for (const workspace of config.workspaces) {
      pi.workspaceCache.set(workspace.id, workspace.path);
    }
    registry.register(pi);
  }

  const service = new DesktopService(registry);
  const server = startAppServer({
    input: process.stdin,
    output: process.stdout,
    service,
    serverName: 'agent-desktop-runtime',
    serverVersion: '0.1.0',
  });

  const shutdown = (): void => {
    void registry.dispose().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.stderr.write(`[agent-desktop-runtime] ready, agents=${registry.list().length}\n`);
  void server;
}

main().catch((error: unknown) => {
  process.stderr.write(`[agent-desktop-runtime] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
