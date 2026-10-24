import { HealthPayloadSchema } from '@tavern/shared';
import type { ApiEnvelope, HealthPayload } from '@tavern/shared';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { defineExtension } from '../../core/extension/index.js';
import { createTestConfig } from '../../testing/test-config.js';

/** 测试不占用真实端口：app.inject() 直接走内存里的请求管线。 */
const silentLogger = pino({ level: 'silent' });

/** 测试基线配置（内存库 + 关闭静态托管）。 */
function testConfig() {
  return createTestConfig();
}

function buildTestApp(extra: { extensions?: Parameters<typeof buildApp>[0]['extensions'] } = {}) {
  return buildApp({
    config: testConfig(),
    configSources: [`${process.cwd()}/config/default.yaml`],
    configOverrides: ['TAVERN_SERVER__PORT'],
    logger: silentLogger,
    extensions: extra.extensions,
  });
}

describe('GET /api/health', () => {
  it('返回合法的健康载荷', async () => {
    const app = await buildTestApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as ApiEnvelope<HealthPayload>;
      if (!body.ok) throw new Error(`健康检查返回失败: ${body.error.code}`);

      // 用共享 schema 校验，字段缺失/类型漂移会在这里直接报出来
      const payload = HealthPayloadSchema.parse(body.data);
      expect(payload.status).toBe('ok');
      expect(payload.app.name).toBe('酒馆 AI');
      expect(payload.server.port).toBe(8787);
      expect(payload.checks.length).toBeGreaterThan(0);
      expect(payload.checks.every((item) => item.status === 'ok')).toBe(true);
      // 内置扩展里至少包含 storage.sqlite
      expect(payload.extensions.failed).toBe(0);
      expect(payload.extensions.ready).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  it('storage 检查项能报出数据库状态与角色数', async () => {
    const app = await buildTestApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      const body = response.json() as ApiEnvelope<HealthPayload>;
      if (!body.ok) throw new Error('健康检查不应失败');

      const storageCheck = body.data.checks.find((item) => item.name === 'storage');
      expect(storageCheck?.status).toBe('ok');
      expect(storageCheck?.message).toContain('sqlite');
      expect(storageCheck?.message).toContain('0 个角色');
    } finally {
      await app.close();
    }
  });

  it('config 检查项显示配置来源', async () => {
    const app = await buildTestApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      const body = response.json() as ApiEnvelope<HealthPayload>;
      if (!body.ok) throw new Error('健康检查不应失败');

      const configCheck = body.data.checks.find((item) => item.name === 'config');
      expect(configCheck?.status).toBe('ok');
      expect(configCheck?.message).toContain('1 个配置文件');
      expect(configCheck?.message).toContain('1 个环境变量覆盖');
    } finally {
      await app.close();
    }
  });

  it('扩展初始化失败时整体降级，但仍能拿到载荷', async () => {
    const brokenExtension = defineExtension({
      meta: { name: 'broken.provider', kind: 'provider', version: '1.0.0' },
      setup() {
        throw new Error('API Key 未配置');
      },
    });

    const app = await buildTestApp({ extensions: [brokenExtension] });

    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as ApiEnvelope<HealthPayload>;
      if (!body.ok) throw new Error(`健康检查返回失败: ${body.error.code}`);

      const payload = HealthPayloadSchema.parse(body.data);
      expect(payload.status).toBe('degraded');
      // storage 正常 + 这个坏掉的 provider 失败
      expect(payload.extensions.failed).toBe(1);
      expect(payload.extensions.ready).toBeGreaterThanOrEqual(1);

      const extensionCheck = payload.checks.find((item) => item.name === 'extensions');
      expect(extensionCheck?.status).toBe('degraded');
      expect(extensionCheck?.message).toContain('1 个失败');
    } finally {
      await app.close();
    }
  });

  it('每个响应都带 traceId', async () => {
    const app = await buildTestApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      const body = response.json() as ApiEnvelope<HealthPayload>;
      expect(body.traceId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await app.close();
    }
  });
});

describe('未知路由', () => {
  it('返回 404 且信封里有 NOT_FOUND', async () => {
    const app = await buildTestApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
      expect(response.statusCode).toBe(404);

      const body = response.json() as ApiEnvelope<null>;
      expect(body.ok).toBe(false);
      if (!body.ok) {
        expect(body.error.code).toBe('NOT_FOUND');
      }
    } finally {
      await app.close();
    }
  });
});
