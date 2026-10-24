import type { ExtensionEntry, ExtensionMeta, ExtensionRegistry } from '../extension/index.js';
import type { ProviderAdapter } from './types.js';

/**
 * 构造 provider 的 meta。
 *
 * 存在的意义：`kind` 写成 'provider' 这件事不该由每个适配器自己记，
 * 写错一次就会变成「注册成功但 registry.list('provider') 里找不到」的诡异 bug。
 */
export function providerMeta(input: {
  name: string;
  version: string;
  description?: string;
  priority?: number;
}): ExtensionMeta & { kind: 'provider' } {
  return { kind: 'provider', ...input };
}

/** 取出注册表里所有 provider，已按 priority 排好序。 */
export function listProviders(registry: ExtensionRegistry): ProviderAdapter[] {
  return registry
    .list('provider')
    .map((entry) => entry.extension as ProviderAdapter)
    .filter((adapter) => typeof adapter.chat === 'function');
}

/** 取一个 provider；取不到时抛 registry 的标准错误，带上「有哪些可用」的提示。 */
export function requireProvider(registry: ExtensionRegistry, name: string): ProviderAdapter {
  const adapter = registry.get<ProviderAdapter>(name);
  if (!adapter || adapter.meta.kind !== 'provider') {
    const available = listProviders(registry)
      .map((item) => item.meta.name)
      .join(', ');
    throw new Error(
      available.length > 0
        ? `provider 不存在: "${name}"，当前可用: ${available}`
        : `provider 不存在: "${name}"，尚未注册任何 provider`,
    );
  }
  return adapter;
}

/** 取第一个可用的 provider（未指定名字时的兜底）。 */
export function firstProvider(registry: ExtensionRegistry): ProviderAdapter | undefined {
  return listProviders(registry)[0];
}

/** 把 provider 的初始化状态整理成可展示的列表，供 /api/providers 之类的接口用。 */
export function describeProviders(
  registry: ExtensionRegistry,
): Array<{ name: string; model: string; state: ExtensionEntry['state']; capabilities: string[] }> {
  return registry.list('provider').map((entry) => {
    const adapter = entry.extension as ProviderAdapter;
    const capabilities: string[] = [];
    if (adapter.capabilities?.streaming) capabilities.push('streaming');
    if (adapter.capabilities?.jsonMode) capabilities.push('json');
    if (adapter.capabilities?.usageInStream) capabilities.push('usage');

    return {
      name: adapter.meta.name,
      model: adapter.defaultModel,
      state: entry.state,
      capabilities,
    };
  });
}
