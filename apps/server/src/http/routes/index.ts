import { registerHealthRoutes } from './health.js';
import type { ServerRuntime } from '../../lib/runtime.js';
import type { AppInstance } from '../../types/fastify.js';

/**
 * 路由总装。
 *
 * 每个业务模块导出一个 registerXxxRoutes(app, deps)，在这里集中挂载，
 * 好处是「应用有哪些入口」只看这一个文件就够了，不用全局搜 app.get。
 */
export async function registerRoutes(app: AppInstance, runtime: ServerRuntime): Promise<void> {
  registerHealthRoutes(app, runtime);
}
