/**
 * 统一响应信封。
 *
 * 所有接口（成功或失败）都返回同一层外壳，前端 `api/client.ts` 里
 * 只写一次拆包逻辑，业务代码拿到的永远是「要么有 data、要么抛错」。
 */

/** 业务错误码。前端按 code 决定提示文案与重试策略，不靠 message 匹配。 */
export const ApiErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** 错误体：code 稳定可编程，message 面向人，details 放校验明细等可选信息。 */
export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

/** 成功响应。 */
export interface ApiSuccess<TData> {
  ok: true;
  traceId: string;
  data: TData;
}

/** 失败响应。HTTP 状态码同时表达语义，前端不必只看 body。 */
export interface ApiFailure {
  ok: false;
  traceId: string;
  error: ApiErrorBody;
}

export type ApiEnvelope<TData> = ApiSuccess<TData> | ApiFailure;

/** 类型守卫：把 unknown 收窄成带 code 的失败信封。 */
export function isApiFailure(value: unknown): value is ApiFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { ok?: unknown; error?: unknown };
  return candidate.ok === false && typeof candidate.error === 'object' && candidate.error !== null;
}
