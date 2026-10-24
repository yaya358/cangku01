/**
 * 进程级运行时信息。
 *
 * 单独成文件是为了让「进程何时启动」只有一个事实来源：
 * 健康检查、日志、优雅退出都用它，不各算各的。
 */

/** 进程真实启动时刻（用 uptime 反推，比模块加载时刻更准）。 */
export const processStartedAt = new Date(Date.now() - process.uptime() * 1000);

/** 当前 RSS 内存占用（MB，保留一位小数）。 */
export function currentMemoryMb(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

/** 秒级保留两位小数，用于 uptime 这类展示型数值。 */
export function roundSeconds(value: number): number {
  return Math.round(value * 100) / 100;
}
