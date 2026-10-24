import { HealthPayloadSchema } from '@tavern/shared';
import type { HealthPayload } from '@tavern/shared';
import { apiGet } from './client';

/**
 * 拉取健康检查。
 *
 * 前端也跑一遍共享 schema：后端字段改名/漏字段时，这里会立刻抛错，
 * 而不是让页面渲染出一片 undefined。健康检查本身很快，多一次校验可以忽略。
 */
export async function fetchHealth(): Promise<HealthPayload> {
  const raw = await apiGet<unknown>('/health', { timeoutMs: 8000 });
  return HealthPayloadSchema.parse(raw);
}
