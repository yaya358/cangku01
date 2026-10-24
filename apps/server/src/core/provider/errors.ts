/**
 * 模型接入层的错误模型。
 *
 * 与 AppError 的区别：AppError 面向「HTTP 响应应该是什么状态码」，
 * ProviderError 面向「上游到底出了什么问题」。两者在路由层做一次映射，
 * 这样重试逻辑只关心 ProviderError 的 retryable，不必理解 HTTP 语义。
 */

export type ProviderErrorCode =
  /** 没配置 Key */
  | 'NO_CREDENTIALS'
  /** Key 无效 / 无权限 */
  | 'AUTH_FAILED'
  /** 触发限流 */
  | 'RATE_LIMITED'
  /** 请求本身不合法（参数写错） */
  | 'BAD_REQUEST'
  /** 模型不存在 */
  | 'MODEL_NOT_FOUND'
  /** 上游 5xx 或网络故障 */
  | 'UPSTREAM_ERROR'
  /** 超时（含首字超时） */
  | 'TIMEOUT'
  /** 被用户/上层取消 */
  | 'ABORTED'
  /** 返回结构不符合预期（解析失败） */
  | 'INVALID_RESPONSE'
  /** 适配器未实现该能力 */
  | 'NOT_IMPLEMENTED';

/** 可重试的错误码：网络抖动、限流、上游 5xx 值得再试一次。 */
const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'TIMEOUT',
]);

export interface ProviderErrorOptions {
  code: ProviderErrorCode;
  message: string;
  /** 上游 HTTP 状态码（如果有） */
  status?: number;
  /** 哪个 provider 出的问题 */
  provider?: string;
  /** 上游原始报错文本，只进日志不进响应 */
  upstreamMessage?: string;
  /** 上游返回的 retry-after（毫秒），限流时用于退避 */
  retryAfterMs?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly provider?: string;
  readonly upstreamMessage?: string;
  readonly retryAfterMs?: number;

  constructor(options: ProviderErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = options.code;
    this.status = options.status;
    this.provider = options.provider;
    this.upstreamMessage = options.upstreamMessage;
    this.retryAfterMs = options.retryAfterMs;
  }

  /** 是否值得重试。 */
  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  /** 转成流事件里的 error 载荷，避免把上游细节带进前端。 */
  toStreamError(): { code: string; message: string; retryable: boolean } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }

  static noCredentials(provider: string): ProviderError {
    return new ProviderError({
      code: 'NO_CREDENTIALS',
      message: `${provider} 尚未配置 API Key`,
      provider,
    });
  }

  static authFailed(provider: string, upstreamMessage?: string): ProviderError {
    return new ProviderError({
      code: 'AUTH_FAILED',
      message: 'API Key 无效或没有该模型的权限',
      provider,
      status: 401,
      upstreamMessage,
    });
  }

  static rateLimited(provider: string, retryAfterMs?: number): ProviderError {
    return new ProviderError({
      code: 'RATE_LIMITED',
      message: retryAfterMs
        ? `请求过于频繁，建议 ${Math.ceil(retryAfterMs / 1000)} 秒后重试`
        : '请求过于频繁，请稍后重试',
      provider,
      status: 429,
      retryAfterMs,
    });
  }

  static badRequest(message: string, provider?: string, upstreamMessage?: string): ProviderError {
    return new ProviderError({
      code: 'BAD_REQUEST',
      message,
      provider,
      status: 400,
      upstreamMessage,
    });
  }

  static modelNotFound(model: string, provider?: string): ProviderError {
    return new ProviderError({
      code: 'MODEL_NOT_FOUND',
      message: `模型不存在或当前 Key 无权访问: ${model}`,
      provider,
      status: 404,
    });
  }

  static upstream(
    provider: string,
    message: string,
    status?: number,
    cause?: unknown,
  ): ProviderError {
    return new ProviderError({
      code: 'UPSTREAM_ERROR',
      message,
      provider,
      status,
      cause,
    });
  }

  static timeout(provider: string, timeoutMs: number): ProviderError {
    return new ProviderError({
      code: 'TIMEOUT',
      message: `上游响应超时（${timeoutMs}ms）`,
      provider,
    });
  }

  static aborted(provider: string): ProviderError {
    return new ProviderError({ code: 'ABORTED', message: '生成已取消', provider });
  }

  static invalidResponse(provider: string, detail: string): ProviderError {
    return new ProviderError({
      code: 'INVALID_RESPONSE',
      message: `上游返回结构无法解析: ${detail}`,
      provider,
    });
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/**
 * 把随意抛出的异常收敛成 ProviderError。
 *
 * 关键点：AbortError 要区分「用户取消」和「超时」，否则日志里全是同一种错误，
 * 排查时无法判断到底是用户点了停止还是上游挂了。
 */
export function toProviderError(
  error: unknown,
  provider: string,
  timeoutMs?: number,
): ProviderError {
  if (isProviderError(error)) return error;

  if (error instanceof Error && error.name === 'AbortError') {
    // AbortSignal.timeout() 抛的是 TimeoutError，用户取消才是 AbortError
    return ProviderError.aborted(provider);
  }

  if (error instanceof Error && error.name === 'TimeoutError') {
    return ProviderError.timeout(provider, timeoutMs ?? 0);
  }

  if (error instanceof TypeError) {
    // undici 在 DNS 失败/连接被拒时抛 TypeError: fetch failed
    return ProviderError.upstream(provider, `无法连接上游服务: ${error.message}`, undefined, error);
  }

  return ProviderError.upstream(
    provider,
    error instanceof Error ? error.message : String(error),
    undefined,
    error,
  );
}
