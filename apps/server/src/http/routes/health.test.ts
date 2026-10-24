import { HealthPayloadSchema } from '@tavern/shared';
import type { ApiEnvelope, HealthPayload } from '@tavern/shared';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createDefaultConfig } from '../../config/index.js';
import { defineExtension } from '../../core/extension/index.js';

/** 测试不占用真实端口：app.inject() 直接走内存里的请求管线。 */
const silentLogger = pino({ level: 'silent' });

/** 用 schema 默认值当测试基线，避免手写一份会过期的配置。 */
function testConfig() {
  const config = createDefaultConfig();
  // 固定指向一个不存在的目录：避免本机执行过 pnpm build 之后，
  // 静态托管被自动打开而影响用例（这里只测 API）
  config.server.staticDir = path.join(os.tmpdir(), 'tavern-test-no-dist');
  return config;
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
      expect(payload.extensions.total).toBe(0);
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
      expect(payload.extensions).toEqual({ total: 1, ready: 0, failed: 1, pending: 0 });

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
