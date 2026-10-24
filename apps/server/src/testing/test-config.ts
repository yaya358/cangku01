import { createDefaultConfig } from '../config/index.js';

/**
 * 测试用的基线配置。
 *
 * 两处必须改成测试友好的值，否则用例会污染工作区：
 *   - storage.path = ':memory:'  否则会在仓库里建 data/tavern.db
 *   - staticDir    = 不存在的目录，避免本机 build 过 dist 后静态托管被打开
 */
export function createTestConfig() {
  const config = createDefaultConfig();
  config.storage.path = ':memory:';
  config.server.staticDir = `${process.cwd()}/__no_such_dist__`;
  config.providers = [];
  return config;
}
