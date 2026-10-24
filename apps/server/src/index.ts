import type { Logger } from 'pino';
import { buildApp } from './app.js';
import { createLogger } from './lib/logger.js';
import { resolveRuntime } from './lib/runtime.js';
import type { AppInstance } from './types/fastify.js';

/** 优雅退出的最长等待时间：超过就强杀，避免容器里卡住不退出。 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

/**
 * 注册进程级兜底与信号处理。
 *
 * 两个目标：
 * 1. Ctrl+C / 容器 SIGTERM 时先关服务器（等在途请求结束），再退出；
 * 2. 未捕获异常必须打进日志再退出，而不是让进程静默消失。
 */
function installProcessGuards(app: AppInstance, logger: Logger): void {
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '收到退出信号，开始优雅关闭');

    const timer = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, '关闭超时，强制退出');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    try {
      await app.close();
      logger.info('HTTP 服务已关闭');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, '关闭过程中出错');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '未处理的 Promise 拒绝');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, '未捕获异常，进程退出');
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const runtime = resolveRuntime();
  const logger = createLogger({
    level: process.env.TAVERN_LOG_LEVEL ?? (runtime.env === 'production' ? 'info' : 'debug'),
    pretty: runtime.env !== 'production',
  });

  const app = await buildApp({ runtime, logger });
  installProcessGuards(app, logger);

  await app.listen({ host: runtime.host, port: runtime.port });

  const address = `http://${runtime.host}:${runtime.port}`;
  logger.info(
    { address, health: `${address}/api/health`, env: runtime.env, node: process.version },
    `酒馆 AI 后端已就绪 → ${address}`,
  );
}

main().catch((error: unknown) => {
  // 启动阶段失败时 app 还没建好，只能用 console 兜底（此时日志器可能都未初始化）
  console.error('[tavern] 启动失败', error);
  process.exit(1);
});
