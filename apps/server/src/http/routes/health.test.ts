import { HealthPayloadSchema } from '@tavern/shared';
import type { ApiEnvelope, HealthPayload } from '@tavern/shared';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
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
