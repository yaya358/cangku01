import type { ApiErrorBody, ApiFailure, ApiSuccess } from '@tavern/shared';

/**
 * 响应信封构造器。
 *
 * 所有路由的返回值都必须经过这里，前端 `api/client.ts` 因此只需要处理一种形状。
 * traceId 直接复用 Fastify 的 request.id，日志里能按同一个 id 串起完整请求链路。
 */
export function success<TData>(traceId: string, data: TData): ApiSuccess<TData> {
  return { ok: true, traceId, data };
}

export function failure(traceId: string, error: ApiErrorBody): ApiFailure {
  return { ok: false, traceId, error };
}
