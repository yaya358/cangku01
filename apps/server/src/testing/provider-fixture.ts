import { providerMeta } from '../core/provider/index.js';
import type { ProviderAdapter } from '../core/provider/index.js';

/**
 * 测试用的 provider 构造器。
 *
 * 单独成文件是因为 chat 路由测试与后续的上下文档测试都会用到，
 * 放在某个测试文件里会被 vitest 当成测试模块重复执行。
 */
export function defineProvider(
  provider: Omit<ProviderAdapter, 'meta'> & {
    meta: Omit<ProviderAdapter['meta'], 'kind'> & { kind?: 'provider' };
  },
): ProviderAdapter {
  const { meta, ...rest } = provider;
  return {
    ...rest,
    meta: providerMeta({
      name: meta.name,
      version: meta.version,
      description: meta.description,
      priority: meta.priority,
    }),
  } as ProviderAdapter;
}
