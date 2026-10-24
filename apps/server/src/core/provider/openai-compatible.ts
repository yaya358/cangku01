import { ProviderError, toProviderError } from './errors.js';
import { providerMeta } from './helpers.js';
import { parseSseStream, readStreamBody } from './sse.js';
import type {
  ChatCallOptions,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  ProviderAdapter,
  ProviderCapabilities,
  TokenUsage,
} from './types.js';

/**
 * OpenAI 兼容适配器。
 *
 * 覆盖范围比名字听起来大：OpenAI、DeepSeek、Moonshot、通义、各类中转站、
 * 以及本地 Ollama（`/v1` 兼容口）都走同一套 `chat/completions` 协议。
 * 所以只要有这一个适配器 + 一个 baseURL，就能接上绝大部分模型服务。
 */

/** 构造参数。 */
export interface OpenAiCompatibleOptions {
  /** 扩展名，用于日志与配置里引用，例如 'openai' / 'deepseek' / 'ollama' */
  name: string;
  /** 接口根地址，末尾斜杠会自动去掉，例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  /** 为空表示未配置，调用时返回 NO_CREDENTIALS */
  apiKey?: string;
  defaultModel: string;
  /** 额外请求头，例如 OpenRouter 需要的 HTTP-Referer */
  headers?: Record<string, string>;
  capabilities?: ProviderCapabilities;
  /**
   * 是否在流式请求里带 stream_options.include_usage。
   * 有些兼容实现不认这个字段会直接 400，所以做成可关。
   */
  requestStreamUsage?: boolean;
  version?: string;
  description?: string;
  priority?: number;
  /** 注入 fetch 便于测试；默认用全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 默认超时：非流式一次对话 2 分钟，流式整体 5 分钟。 */
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;
/** 首字超时：30 秒内一个字都没吐出来就判定上游卡死。 */
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 30_000;

interface OpenAiChatCompletion {
  model?: string;
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** 流式 chunk：比非流式少了 message、多了 delta。 */
interface OpenAiStreamChunk {
  model?: string;
  choices?: Array<{
    delta?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** OpenAI 的 usage 字段是下划线命名，转成我们的驼峰结构。 */
function mapUsage(usage: OpenAiChatCompletion['usage']): TokenUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
  };
}

/** 消息转上游格式：name 只在有值时才带，避免某些服务因为多余字段报错。 */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.name) wire.name = message.name;
  return wire;
}

/** 从上游错误体里尽量挖出人能看懂的一句话。 */
function extractUpstreamMessage(body: string): string {
  if (body.length === 0) return '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

/** 429 时读 Retry-After（秒或 HTTP 日期），转成毫秒。 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** 把 HTTP 失败映射成带语义的 ProviderError。 */
async function toHttpError(
  response: Response,
  provider: string,
  model: string,
): Promise<ProviderError> {
  const body = await response.text().catch(() => '');
  const detail = extractUpstreamMessage(body);

  switch (response.status) {
    case 401:
    case 403:
      return ProviderError.authFailed(provider, detail || undefined);
    case 404:
      return ProviderError.modelNotFound(model, provider);
    case 429:
      return ProviderError.rateLimited(
        provider,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    case 400:
    case 422:
      return ProviderError.badRequest(
        detail || '上游拒绝了请求参数',
        provider,
        detail || undefined,
      );
    default:
      return ProviderError.upstream(
        provider,
        `上游返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`,
        response.status,
      );
  }
}

/** 组合外部取消信号与超时信号。 */
function combineSignals(
  options: ChatCallOptions | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  return { signal, timedOut: () => timeoutSignal.aborted };
}

/**
 * 创建适配器实例。
 *
 * 返回对象同时满足 Extension 与 ProviderAdapter：注册表可以直接管理它的
 * 初始化顺序与释放，不需要为 provider 单独造一套生命周期。
 */
export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): ProviderAdapter {
  const { name } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultModel = options.defaultModel;
  const requestStreamUsage = options.requestStreamUsage ?? true;

  const capabilities: ProviderCapabilities = {
    streaming: true,
    usageInStream: requestStreamUsage,
    ...options.capabilities,
  };

  function buildHeaders(stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
    };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    return { ...headers, ...options.headers };
  }

  /**
   * 组装请求体。
   *
   * 顺序有讲究：extra 先铺（用户私有字段），核心字段随后覆盖（不允许被 extra 破坏），
   * 最后是结构化采样参数。这样既保留逃生通道，又不会出现「extra 里写了 stream:false
   * 导致上层以为在流式」这种灾难。
   */
  function buildPayload(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const params = request.params ?? {};
    const payload: Record<string, unknown> = {
      ...request.extra,
      model: request.model || defaultModel,
      messages: request.messages.map(toWireMessage),
      stream,
    };

    if (stream && capabilities.usageInStream) {
      payload.stream_options = { include_usage: true };
    }
    if (params.temperature !== undefined) payload.temperature = params.temperature;
    if (params.topP !== undefined) payload.top_p = params.topP;
    if (params.maxTokens !== undefined) payload.max_tokens = params.maxTokens;
    if (params.stop !== undefined && params.stop.length > 0) payload.stop = params.stop;
    if (params.presencePenalty !== undefined) payload.presence_penalty = params.presencePenalty;
    if (params.frequencyPenalty !== undefined) payload.frequency_penalty = params.frequencyPenalty;
    if (params.seed !== undefined) payload.seed = params.seed;

    return payload;
  }

  /** 发请求 + 把网络异常/HTTP 错误统一成 ProviderError。 */
  async function postChat(
    payload: Record<string, unknown>,
    signal: AbortSignal,
    model: string,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(payload.stream === true),
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      // AbortError / TimeoutError / 连接失败都在这里归一
      throw toProviderError(error, name);
    }

    if (!response.ok) throw await toHttpError(response, name, model);
    return response;
  }

  const adapter: ProviderAdapter = {
    meta: providerMeta({
      name,
      version: options.version ?? '1.0.0',
      description: options.description ?? `OpenAI 兼容接口：${baseUrl}`,
      priority: options.priority,
    }),

    capabilities,
    defaultModel,
    hasCredentials: Boolean(options.apiKey),

    /** 初始化只做「空 Key 提醒」，不做网络探测：启动阶段不该依赖外网。 */
    setup({ logger }) {
      if (!options.apiKey) {
        logger.warn(
          { provider: name },
          '未配置 API Key，该 provider 暂不可用（配置后重启即可生效）',
        );
      }
    },

    async chat(request, callOptions): Promise<ChatResult> {
      if (!options.apiKey) throw ProviderError.noCredentials(name);

      const model = request.model || defaultModel;
      const timeoutMs = callOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const { signal } = combineSignals(callOptions, timeoutMs);
      const startedAt = performance.now();

      const response = await postChat(buildPayload(request, false), signal, model);

      let json: OpenAiChatCompletion;
      try {
        json = (await response.json()) as OpenAiChatCompletion;
      } catch (error) {
        throw ProviderError.invalidResponse(name, '响应不是合法 JSON');
      }

      const choice = json.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string') {
        throw ProviderError.invalidResponse(name, '缺少 choices[0].message.content');
      }

      return {
        text: content,
        finishReason: choice?.finish_reason ?? null,
        usage: mapUsage(json.usage),
        model: json.model ?? model,
        durationMs: Math.round(performance.now() - startedAt),
      };
    },

    async *stream(request, callOptions): AsyncGenerator<ChatStreamEvent> {
      if (!options.apiKey) {
        yield { type: 'error', error: ProviderError.noCredentials(name).toStreamError() };
        return;
      }

      const requestedModel = request.model || defaultModel;
      const timeoutMs = callOptions?.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
      const firstTokenTimeoutMs =
        callOptions?.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
      const { signal } = combineSignals(callOptions, timeoutMs);

      // 首字超时单独计时：整体超时可能给到 5 分钟，但 30 秒还没第一个字基本就是卡死
      const firstTokenController = new AbortController();
      const firstTokenTimer = setTimeout(
        () => firstTokenController.abort(new Error('first-token-timeout')),
        firstTokenTimeoutMs,
      );
      firstTokenTimer.unref?.();

      const startedAt = performance.now();
      let usage: TokenUsage | undefined;
      let finishReason: string | null = null;
      let firstTokenMs: number | null = null;

      try {
        const response = await postChat(
          buildPayload(request, true),
          AbortSignal.any([signal, firstTokenController.signal]),
          requestedModel,
        );

        yield { type: 'start', model: requestedModel, at: Date.now() };

        for await (const event of parseSseStream(readStreamBody(response.body))) {
          const data = event.data.trim();
          if (data.length === 0) continue;
          if (data === '[DONE]') break;

          let chunk: OpenAiStreamChunk;
          try {
            chunk = JSON.parse(data) as OpenAiStreamChunk;
          } catch {
            // 有些兼容实现会在流里插非 JSON 的心跳帧，跳过而不是让整个流失败
            continue;
          }

          // 流式里不追踪上游回报的模型名：start 事件已经告诉调用方请求的是哪个模型，
          // 中途被映射成快照版本对上层没有决策价值，反而多一个要维护的字段。
          const choice = chunk.choices?.[0];
          const delta = choice?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            if (firstTokenMs === null) {
              firstTokenMs = Math.round(performance.now() - startedAt);
              clearTimeout(firstTokenTimer);
            }
            yield { type: 'delta', text: delta };
          }

          if (choice?.finish_reason) finishReason = choice.finish_reason;

          if (chunk.usage) {
            usage = mapUsage(chunk.usage);
            if (usage) yield { type: 'usage', usage };
          }
        }

        yield {
          type: 'done',
          finishReason,
          usage,
          durationMs: Math.round(performance.now() - startedAt),
          firstTokenMs,
        };
      } catch (error) {
        // 约定：出错也走 error 事件而不 throw，上层只需处理事件流一条路径
        const isFirstTokenTimeout = firstTokenController.signal.aborted;
        const providerError = isFirstTokenTimeout
          ? ProviderError.timeout(name, firstTokenTimeoutMs)
          : toProviderError(error, name, timeoutMs);
        yield { type: 'error', error: providerError.toStreamError() };
      } finally {
        clearTimeout(firstTokenTimer);
      }
    },
  };

  return adapter;
}

/** 供流式/非流式共用，避免两处各写一套默认值。 */
export const OPENAI_COMPATIBLE_DEFAULTS = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  streamTimeoutMs: DEFAULT_STREAM_TIMEOUT_MS,
  firstTokenTimeoutMs: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
} as const;
