import type { ApiEnvelope } from '@tavern/shared';

/**
 * 统一的 HTTP 客户端。
 *
 * 职责：拼前缀、超时控制、拆信封、把各种失败收敛成 ApiError。
 * 业务代码只写 `const data = await apiGet<T>('/health')`，
 * 不需要再关心 response.ok / JSON 解析 / 错误码映射。
 */

/** 开发期由 Vite 代理转发，生产期由后端同源提供，所以用相对路径。 */
const API_BASE = '/api';

const DEFAULT_TIMEOUT_MS = 10_000;

/** 请求失败异常，code 与后端 ApiErrorCode 对齐（另有前端自造的 NETWORK_ERROR / TIMEOUT）。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options: { status: number; code: string; traceId?: string; details?: unknown },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.traceId = options.traceId;
    this.details = options.details;
  }

  /** 连不上后端（进程没起、端口不对、代理挂了）时的统一判定。 */
  get isNetworkError(): boolean {
    return this.code === 'NETWORK_ERROR' || this.code === 'TIMEOUT';
  }
}

export interface RequestOptions {
  timeoutMs?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * 发起请求并拆信封。
 *
 * 时序上注意两点：
 * 1. 超时用 AbortController 实现，fetch 本身没有超时参数；
 * 2. 先读 text 再尝试 JSON.parse —— 后端 500 或代理返回 HTML 时，
 *    直接 res.json() 会抛一个「Unexpected token <」的鬼错误，掩盖真正的问题。
 */
async function request<TData>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<TData> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 允许直接传共享常量里的完整路径（/api/xxx），避免各处再手工剥前缀
  const url = path.startsWith(API_BASE) ? path : `${API_BASE}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw new ApiError(`请求超时（${timeoutMs}ms）`, { status: 0, code: 'TIMEOUT' });
    }
    throw new ApiError('无法连接后端服务', { status: 0, code: 'NETWORK_ERROR', details: cause });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  return unwrapEnvelope<TData>(response, text);
}

/**
 * 把「响应 + 已读出的文本」拆成数据。
 *
 * 独立出来是为了让上传（原始 PNG 字节）这类不经过 request() 的调用
 * 也能复用同一套错误处理，不必各写一遍。
 */
export function unwrapEnvelope<TData>(response: Response, text: string): TData {
  let body: ApiEnvelope<TData> | null = null;
  try {
    body = text.length > 0 ? (JSON.parse(text) as ApiEnvelope<TData>) : null;
  } catch {
    // 解析失败就保持 null，交给下面统一报 BAD_RESPONSE，
    // 而不是把「Unexpected token <」这种底层错误直接抛给页面
  }

  if (body === null) {
    throw new ApiError(`接口返回的不是 JSON（HTTP ${response.status}）`, {
      status: response.status,
      code: 'BAD_RESPONSE',
      details: text.slice(0, 300),
    });
  }

  if (!body.ok) {
    throw new ApiError(body.error.message, {
      status: response.status,
      code: body.error.code,
      traceId: body.traceId,
      details: body.error.details,
    });
  }

  return body.data;
}

export function apiGet<TData>(path: string, options?: RequestOptions): Promise<TData> {
  return request<TData>('GET', path, options);
}

export function apiPost<TData>(
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<TData> {
  return request<TData>('POST', path, { ...options, body });
}

export function apiPatch<TData>(path: string, body?: unknown): Promise<TData> {
  return request<TData>('PATCH', path, { body });
}

export function apiDelete<TData>(path: string): Promise<TData> {
  return request<TData>('DELETE', path);
}

/**
 * 直接把原始字节 POST 出去（角色卡 PNG 导入用）。
 *
 * 不走 request()：那里会把 body 当 JSON 序列化，而这里要的是文件字节。
 * 响应仍复用同一套信封拆包逻辑。
 */
export async function postBinary<TData>(
  path: string,
  body: Blob | ArrayBuffer,
  contentType: string,
  options: RequestOptions = {},
): Promise<TData> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = path.startsWith(API_BASE) ? path : `${API_BASE}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { accept: 'application/json', 'content-type': contentType },
      body,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw new ApiError(`上传超时（${timeoutMs}ms）`, { status: 0, code: 'TIMEOUT' });
    }
    throw new ApiError('上传失败，无法连接后端服务', {
      status: 0,
      code: 'NETWORK_ERROR',
      details: cause,
    });
  } finally {
    clearTimeout(timer);
  }

  return unwrapEnvelope<TData>(response, await response.text());
}
