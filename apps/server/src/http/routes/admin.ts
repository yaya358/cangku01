import { ADMIN_SEED_ENDPOINT } from '@tavern/shared';
import { seedSampleCharacters } from '../../core/samples/index.js';
import type { AppInstance } from '../../types/fastify.js';
import { success } from '../envelope.js';

/**
 * 管理接口。
 *
 * 目前只有一条：重新播种内置示例角色。
 *
 * 为什么需要它：首次启动会自动播种（见 app.ts），但如果用户把示例删了、或者
 * 想在一个已有数据的库里补回示例，就得有个手动入口，而不是删库重来。
 * 它天然幂等：按名字去重，已存在的只补头像，不覆盖用户改过的设定。
 *
 * 注意：这个项目没有账号体系，所以也没有鉴权 —— 它和所有接口一样只应监听在本机
 * 或可信内网。真要公网部署，请在前面加一层反向代理做访问控制。
 */
export function registerAdminRoutes(app: AppInstance): void {
  app.post(ADMIN_SEED_ENDPOINT, async (request) => {
    const result = seedSampleCharacters(app);
    return success(request.id, {
      ...result,
      total: app.characters().count(),
    });
  });
}
