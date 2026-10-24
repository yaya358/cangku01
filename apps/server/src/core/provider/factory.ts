import type { ProviderConfig } from '../../config/schema.js';
import { ProviderError } from './errors.js';
import { createOpenAiCompatibleProvider } from './openai-compatible.js';
import type { ProviderAdapter } from './types.js';

/**
 * 由配置生成 provider 实例。
 *
 * 放在 core/provider 而不是 config 里：配置模块只负责「校验形状」，
 * 不 import 具体适配器，否则以后加厂商就要改配置层，违背分层。
 */

export interface ProviderFactoryOptions {
  /** 环境变量来源，默认 process.env；测试可注入 */
  env?: Record<string, string | undefined>;
}

/**
 * 解析密钥：环境变量优先于配置文件。
 *
 * 理由：部署时密钥应该只存在于环境里；如果本地 yaml 里残留旧 Key，
 * 让它覆盖生产环境会非常危险（用错账号、额度、甚至泄露）。
 */
export function resolveApiKey(
  config: ProviderConfig,
  env: Record<string, string | undefined>,
): string | undefined {
  if (config.apiKeyEnv) {
    const fromEnv = env[config.apiKeyEnv];
    if (fromEnv && fromEnv.length > 0) return fromEnv;
  }
  return config.apiKey;
}

/** 把配置数组映射成适配器数组；遇到不支持的类型立刻报错，不静默跳过。 */
export function createProvidersFromConfig(
  configs: readonly ProviderConfig[],
  options: ProviderFactoryOptions = {},
): ProviderAdapter[] {
  const env = options.env ?? process.env;
  const nameSet = new Set<string>();

  return configs.map((config) => {
    if (nameSet.has(config.name)) {
      throw new ProviderError({
        code: 'BAD_REQUEST',
        message: `providers 里出现重复的 name: "${config.name}"，每个模型服务必须有唯一 id`,
        provider: config.name,
      });
    }
    nameSet.add(config.name);

    switch (config.type) {
      case 'openai-compatible':
        return createOpenAiCompatibleProvider({
          name: config.name,
          baseUrl: config.baseUrl,
          apiKey: resolveApiKey(config, env),
          defaultModel: config.model,
          headers: config.headers,
          requestStreamUsage: config.requestStreamUsage,
          priority: config.priority,
        });
      default:
        // 枚举值被 schema 限制住，走到这里说明代码与 schema 不同步
        throw new ProviderError({
          code: 'NOT_IMPLEMENTED',
          message: `不支持的 provider 类型: ${String(config.type)}`,
          provider: config.name,
        });
    }
  });
}
