import type { ApiErrorBody, ApiErrorCode } from '@tavern/shared';

/** 构造 AppError 的入参。 */
export interface AppErrorOptions {
  /** 机器可读的错误码，前端按它决定提示与重试策略。 */
  code: ApiErrorCode;
  /** HTTP 状态码，与 code 语义保持一致。 */
  statusCode: number;
  /** 面向人的错误描述，可以直接展示给用户。 */
  message: string;
  /** 结构化补充信息，例如 zod 校验明细。 */
  details?: unknown;
  /** 原始异常，仅用于日志，不会出现在响应体里。 */
  cause?: unknown;
}

/**
 * 业务异常。
 *
 * 约定：路由层只抛 AppError（或交给全局兜底），响应格式由 setErrorHandler 统一生成，
 * 这样新增接口时不需要再手写一遍 `reply.code(...).send({ ... })`。
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = options.details;
  }

  /** 转成响应信封里的 error 字段。 */
  toBody(): ApiErrorBody {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  static badRequest(message = '请求格式不正确', details?: unknown): AppError {
    return new AppError({ code: 'BAD_REQUEST', statusCode: 400, message, details });
  }

  static validation(message = '请求参数校验失败', details?: unknown): AppError {
    return new AppError({ code: 'VALIDATION_FAILED', statusCode: 422, message, details });
  }

  static unauthorized(message = '未授权，请先登录'): AppError {
    return new AppError({ code: 'UNAUTHORIZED', statusCode: 401, message });
  }

  static forbidden(message = '没有访问该资源的权限'): AppError {
    return new AppError({ code: 'FORBIDDEN', statusCode: 403, message });
  }

  static notFound(message = '资源不存在'): AppError {
    return new AppError({ code: 'NOT_FOUND', statusCode: 404, message });
  }

  static conflict(message = '资源已存在或状态冲突'): AppError {
    return new AppError({ code: 'CONFLICT', statusCode: 409, message });
  }

  static payloadTooLarge(message = '请求体过大'): AppError {
    return new AppError({ code: 'PAYLOAD_TOO_LARGE', statusCode: 413, message });
  }

  static rateLimited(message = '请求过于频繁，请稍后再试'): AppError {
    return new AppError({ code: 'RATE_LIMITED', statusCode: 429, message });
  }

  static upstream(message = '上游服务返回异常', details?: unknown): AppError {
    return new AppError({ code: 'UPSTREAM_ERROR', statusCode: 502, message, details });
  }

  static timeout(message = '上游服务响应超时'): AppError {
    return new AppError({ code: 'TIMEOUT', statusCode: 504, message });
  }

  static internal(message = '服务内部错误', cause?: unknown): AppError {
    return new AppError({ code: 'INTERNAL_ERROR', statusCode: 500, message, cause });
  }

  static notImplemented(message = '该功能尚未实现'): AppError {
    return new AppError({ code: 'NOT_IMPLEMENTED', statusCode: 501, message });
  }
}

/** 类型守卫。 */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Fastify 自带的 schema 校验失败对象。 */
interface FastifyValidationLike {
  validation?: unknown;
  validationContext?: unknown;
}

function isValidationError(value: unknown): value is FastifyValidationLike {
  return typeof value === 'object' && value !== null && 'validation' in value;
}

/** HTTP 状态码 → 业务错误码。只覆盖需要精确区分的几种，其余落到内部错误。 */
function statusToCode(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'RATE_LIMITED';
    case 501:
      return 'NOT_IMPLEMENTED';
    case 502:
    case 503:
      return 'UPSTREAM_ERROR';
    case 504:
      return 'TIMEOUT';
    default:
      return 'INTERNAL_ERROR';
  }
}

/**
 * 把任意抛出的东西收敛成 AppError。
 *
 * 关键点：未知异常一律转成不含细节的「服务内部错误」，
 * 真实堆栈只进日志。否则一个 SQL 报错就会把表名/路径暴露给前端。
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (isValidationError(error)) {
    return AppError.validation('请求参数校验失败', (error as FastifyValidationLike).validation);
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    if (typeof candidate.statusCode === 'number' && candidate.statusCode >= 400) {
      const status = candidate.statusCode;
      return new AppError({
        code: statusToCode(status),
        statusCode: status,
        message: typeof candidate.message === 'string' ? candidate.message : '请求失败',
      });
    }
  }

  return AppError.internal('服务内部错误', error);
}
