import { z } from 'zod';

/**
 * 健康检查契约。
 *
 * 这个 schema 同时被后端（构造响应时做类型约束）和前端（渲染状态卡片时
 * 做类型推导）使用，字段一旦改名两端都会立刻报错。
 */

/** 单项检查的状态。degraded 表示「能用，但某个依赖不健康」。 */
export const CheckStatusSchema = z.enum(['ok', 'degraded', 'failed']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

/** 一条具体的自检项，例如 config / extensions / storage。 */
export const HealthCheckSchema = z.object({
  name: z.string().min(1),
  status: CheckStatusSchema,
  /** 该项检查自身耗时，用于发现「启动越来越慢」的退化。 */
  latencyMs: z.number().nonnegative().optional(),
  message: z.string().optional(),
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

/** 应用元信息。 */
export const HealthAppSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  /** development | production | test */
  env: z.string().min(1),
  startedAt: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
  nodeVersion: z.string().min(1),
});
export type HealthApp = z.infer<typeof HealthAppSchema>;

/** 进程与监听信息。 */
export const HealthServerSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  pid: z.number().int().positive(),
  /** 当前进程内存占用（MB），排查内存泄漏的第一手数据。 */
  memoryMb: z.number().nonnegative(),
});
export type HealthServer = z.infer<typeof HealthServerSchema>;

/** 整体健康载荷：status 为 degraded 时 checks 里必然有非 ok 项。 */
export const HealthPayloadSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  app: HealthAppSchema,
  server: HealthServerSchema,
  checks: z.array(HealthCheckSchema),
});
export type HealthPayload = z.infer<typeof HealthPayloadSchema>;

/** 由多项检查汇总出整体状态。 */
export function summarizeHealth(checks: readonly HealthCheck[]): 'ok' | 'degraded' {
  return checks.every((item) => item.status === 'ok') ? 'ok' : 'degraded';
}
