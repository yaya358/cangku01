/**
 * 进程级运行时信息。
 *
 * 单独成文件是为了让「进程何时启动」只有一个事实来源：
 * 健康检查、日志、后续的优雅退出都用它，不各算各的。
 */

/** 进程真实启动时刻（用 uptime 反推，比模块加载时刻更准）。 */
export const processStartedAt = new Date(Date.now() - process.uptime() * 1000);

/** 服务运行时参数：监听地址、端口、环境名。 */
export interface ServerRuntime {
  host: string;
  port: number;
  /** development | production | test */
  env: string;
}

/**
 * 从环境变量解析运行时参数。
 *
 * 阶段 0-E 引入 yaml 配置后，这个函数会变成「配置的兜底层」，
 * 优先级变为：环境变量 > config/user.yaml > config/default.yaml。
 */
export function resolveRuntime(): ServerRuntime {
  const rawPort = process.env.TAVERN_PORT ?? process.env.PORT ?? '8787';
  const port = Number.parseInt(rawPort, 10);

  return {
    host: process.env.TAVERN_HOST ?? '127.0.0.1',
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 8787,
    env: process.env.NODE_ENV ?? 'development',
  };
}

/** 当前 RSS 内存占用（MB，保留一位小数）。 */
export function currentMemoryMb(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}
