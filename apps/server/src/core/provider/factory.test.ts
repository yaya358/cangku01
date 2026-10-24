import { describe, expect, it } from 'vitest';
import { ProviderConfigSchema } from '../../config/schema.js';
import { createProvidersFromConfig, resolveApiKey } from './factory.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return ProviderConfigSchema.parse({
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    ...overrides,
  });
}

describe('resolveApiKey', () => {
  it('环境变量优先于配置文件里的明文 Key', () => {
    const config = makeConfig({ apiKey: 'sk-file', apiKeyEnv: 'TEST_PROVIDER_KEY' });
    expect(resolveApiKey(config, { TEST_PROVIDER_KEY: 'sk-env' })).toBe('sk-env');
  });

  it('环境变量没设置时回落到明文 Key', () => {
    const config = makeConfig({ apiKey: 'sk-file', apiKeyEnv: 'TEST_PROVIDER_KEY' });
    expect(resolveApiKey(config, {})).toBe('sk-file');
  });

  it('两者都没给时返回 undefined（调用时才报 NO_CREDENTIALS）', () => {
    const config = makeConfig();
    expect(resolveApiKey(config, {})).toBeUndefined();
  });
});

describe('createProvidersFromConfig', () => {
  it('按配置生成适配器，并带上默认模型与能力位', () => {
    const providers = createProvidersFromConfig([makeConfig({ apiKey: 'sk-test', priority: 5 })], {
      env: {},
    });

    expect(providers).toHaveLength(1);
    const provider = providers[0];
    expect(provider?.meta.name).toBe('deepseek');
    expect(provider?.meta.kind).toBe('provider');
    expect(provider?.meta.priority).toBe(5);
    expect(provider?.defaultModel).toBe('deepseek-flash');
    expect(provider?.hasCredentials).toBe(true);
    expect(provider?.capabilities.streaming).toBe(true);
  });

  it('没有密钥时仍能创建（只是不可用）', () => {
    const providers = createProvidersFromConfig([makeConfig()], { env: {} });
    expect(providers[0]?.hasCredentials).toBe(false);
  });

  it('重复的 name 直接报错', () => {
    expect(() =>
      createProvidersFromConfig([makeConfig({ apiKey: 'a' }), makeConfig({ apiKey: 'b' })], {
        env: {},
      }),
    ).toThrow(/重复的 name/);
  });

  it('baseUrl 不是合法 URL 时在配置校验阶段就被拦住', () => {
    expect(() => makeConfig({ baseUrl: 'api.deepseek.com' })).toThrow();
  });

  it('name 大小写或字符不合法会被拒绝', () => {
    expect(() => makeConfig({ name: 'DeepSeek' })).toThrow();
  });
});
