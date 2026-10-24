import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { ExtensionError } from './errors.js';
import { ExtensionRegistry } from './registry.js';
import type { ExtensionRegistryOptions } from './registry.js';
import { defineExtension } from './types.js';
import type { Extension } from './types.js';

const silentLogger = pino({ level: 'silent' });

function makeRegistry(overrides: Partial<ExtensionRegistryOptions> = {}): ExtensionRegistry {
  return new ExtensionRegistry({
    logger: silentLogger,
    env: 'test',
    appVersion: '0.1.0',
    ...overrides,
  });
}

/** 造一个会把自己被调用的顺序记进 calls 数组的扩展。 */
function makeExtension(
  name: string,
  calls: string[],
  options: { priority?: number; kind?: Extension['meta']['kind'] } = {},
) {
  return defineExtension({
    meta: {
      name,
      kind: options.kind ?? 'integration',
      version: '1.0.0',
      priority: options.priority,
    },
    setup() {
      calls.push(`setup:${name}`);
    },
    dispose() {
      calls.push(`dispose:${name}`);
    },
  });
}

describe('ExtensionRegistry 注册', () => {
  it('注册后可查询，并按 kind 过滤', () => {
    const registry = makeRegistry();
    registry.register(makeExtension('openai', [], { kind: 'provider' }));
    registry.register(makeExtension('ctx.basic', [], { kind: 'context' }));

    expect(registry.size).toBe(2);
    expect(registry.has('openai')).toBe(true);
    expect(registry.list('provider')).toHaveLength(1);
    expect(registry.list('provider')[0]?.extension.meta.name).toBe('openai');
  });

  it('非法扩展名被拒绝', () => {
    const registry = makeRegistry();
    expect(() => registry.register(makeExtension('-bad-name', []))).toThrow(ExtensionError);
    expect(() => registry.register(makeExtension('空间 名字', []))).toThrow(/扩展名不合法/);
    expect(registry.size).toBe(0);
  });

  it('重名（同批或与已有）被拒绝，且整批不生效', () => {
    const registry = makeRegistry();
    registry.register(makeExtension('openai', []));

    expect(() => registry.register(makeExtension('openai', []))).toThrow(/扩展名重复/);

    // 一批里第二个重名 → 第一个也不能注册进去
    expect(() =>
      registry.register(makeExtension('claude', []), makeExtension('openai', [])),
    ).toThrow(/扩展名重复/);
    expect(registry.has('claude')).toBe(false);
  });

  it('已初始化的扩展不允许直接注销', async () => {
    const registry = makeRegistry();
    registry.register(makeExtension('openai', []));
    await registry.setupAll();

    expect(registry.unregister('openai')).toBe(false);
    expect(registry.has('openai')).toBe(true);
  });
});

describe('ExtensionRegistry 生命周期', () => {
  it('setup 按 priority 降序执行，dispose 逆序执行', async () => {
    const calls: string[] = [];
    const registry = makeRegistry();
    registry.register(
      makeExtension('low', calls, { priority: 1 }),
      makeExtension('high', calls, { priority: 100 }),
      makeExtension('mid', calls, { priority: 50 }),
    );

    await registry.setupAll();
    expect(calls).toEqual(['setup:high', 'setup:mid', 'setup:low']);

    calls.length = 0;
    await registry.disposeAll();
    expect(calls).toEqual(['dispose:low', 'dispose:mid', 'dispose:high']);
  });

  it('单个扩展 setup 失败被隔离，其余照常就绪', async () => {
    const registry = makeRegistry();
    registry.register(
      defineExtension({
        meta: { name: 'broken', kind: 'provider', version: '1.0.0', priority: 10 },
        setup() {
          throw new Error('API Key 没填');
        },
      }),
      makeExtension('healthy', []),
    );

    await expect(registry.setupAll()).resolves.toBeUndefined();

    const summary = registry.summary();
    expect(summary.total).toBe(2);
    expect(summary.ready).toBe(1);
    expect(summary.failed).toBe(1);
    expect(registry.getEntry('broken')?.state).toBe('failed');
    expect(registry.getEntry('broken')?.error).toBeInstanceOf(Error);
  });

  it('strict 模式下 setup 失败会中断启动', async () => {
    const registry = makeRegistry({ strict: true });
    registry.register(
      defineExtension({
        meta: { name: 'broken', kind: 'provider', version: '1.0.0' },
        setup() {
          throw new Error('boom');
        },
      }),
    );

    await expect(registry.setupAll()).rejects.toThrow(/初始化失败/);
  });

  it('setup 期间注册的子扩展也会被初始化', async () => {
    const calls: string[] = [];
    const registry = makeRegistry();

    registry.register(
      defineExtension({
        meta: { name: 'parent', kind: 'provider', version: '1.0.0' },
        setup({ registry: inner }) {
          calls.push('setup:parent');
          inner.register(makeExtension('child', calls));
        },
      }),
    );

    await registry.setupAll();
    expect(calls).toEqual(['setup:parent', 'setup:child']);
    expect(registry.summary().ready).toBe(2);
  });

  it('重复调用 setupAll 不会重复初始化', async () => {
    const setupSpy: string[] = [];
    const registry = makeRegistry();
    registry.register(makeExtension('once', setupSpy));

    await registry.setupAll();
    await registry.setupAll();

    expect(setupSpy).toEqual(['setup:once']);
    expect(registry.summary().ready).toBe(1);
  });
});
