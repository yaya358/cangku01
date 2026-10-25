import { registerAdminRoutes } from './admin.js';
import { registerCharacterRoutes } from './characters.js';
import { registerChatRoutes } from './chat.js';
import { registerContextRoutes } from './context.js';
import { registerConversationRoutes } from './conversations.js';
import { registerHealthRoutes } from './health.js';
import { registerScriptRoutes } from './script.js';
import { registerWorldbookRoutes } from './worldbook.js';
import type { AppInstance } from '../../types/fastify.js';

/**
 * 路由总装。
 *
 * 每个业务模块导出一个 registerXxxRoutes(app)，在这里集中挂载，
 * 好处是「应用有哪些入口」只看这一个文件就够了，不用全局搜 app.get。
 * 依赖（配置、注册表）已经通过 app.decorate 挂在实例上，不必逐个传参。
 */
export async function registerRoutes(app: AppInstance): Promise<void> {
  registerHealthRoutes(app);
  registerAdminRoutes(app);
  registerChatRoutes(app);
  registerCharacterRoutes(app);
  registerContextRoutes(app);
  registerConversationRoutes(app);
  registerWorldbookRoutes(app);
  registerScriptRoutes(app);
}
