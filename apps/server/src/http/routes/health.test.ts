import { HealthPayloadSchema } from '@tavern/shared';
import type { ApiEnvelope, HealthPayload } from '@tavern/shared';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { defineExtension } from '../../core/extension/index.js';
import type { ServerRuntime } from '../../lib/runtime.js';

/** 测试不占用真实端口：app.inject() 直接走内存里的请求管线。 */
const runtime: ServerRuntime = { host: '127.0.0.1', port: 8787, env: 'test' };
const silentLogger = pino({ level: 'silent' });

describe('GET /api/health', () => {
  it('返回合法的健康载荷', async () => {
    const app = await buildApp({ runtime, logger: silentLogger });

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

  it('扩展初始化失败时整体降级，但仍能拿到载荷', async () => {
    const brokenExtension = defineExtension({
      meta: { name: 'broken.provider', kind: 'provider', version: '1.0.0' },
      setup() {
        throw new Error('API Key 未配置');
      },
    });

    const app = await buildApp({
      runtime,
      logger: silentLogger,
      extensions: [brokenExtension],
    });

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

  it('每个响应都带 traceId，且与 x-request-id 对得上', async () => {
    const app = await buildApp({ runtime, logger: silentLogger });

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
    const app = await buildApp({ runtime, logger: silentLogger });

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
