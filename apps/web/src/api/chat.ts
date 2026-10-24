import type {
  ChatRequestBody,
  ChatResultPayload,
  ChatStreamPayload,
  ProviderInfo,
} from '@tavern/shared';
import { CHAT_ENDPOINT, CHAT_STREAM_ENDPOINT, PROVIDERS_ENDPOINT } from '@tavern/shared';
import { ApiError, apiGet, apiPost } from './client';

/** 拉取可用的模型服务。 */
export function fetchProviders(): Promise<ProviderInfo[]> {
  return apiGet<ProviderInfo[]>(PROVIDERS_ENDPOINT, { timeoutMs: 8000 });
}

/** 一次性对话（不流式），用于对比与排查。 */
export function chatOnce(body: ChatRequestBody): Promise<ChatResultPayload> {
  return apiPost<ChatResultPayload>(CHAT_ENDPOINT, body, { timeoutMs: 120_000 });
}

export interface StreamChatHandlers {
  signal?: AbortSignal;
  onEvent: (event: ChatStreamPayload) => void;
}

/**
 * 流式对话。
 *
 * 为什么不用 EventSource：EventSource 只支持 GET，发不了 JSON 请求体，
 * 也没法带自定义头。所以用 fetch + ReadableStream 自己解 SSE 帧。
 *
 * 分帧策略与后端对称：按 `\n\n` 切事件，未闭合的尾巴留在 buffer 里。
 * 注意 TextDecoder 必须用 stream 模式，否则中文被切在 chunk 边界会乱码。
 */
export async function streamChat(
  body: ChatRequestBody,
  handlers: StreamChatHandlers,
): Promise<void> {
  const response = await fetch(CHAT_STREAM_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });

  if (!response.ok) {
    // 开流之前的错误仍是标准 JSON 信封
    const text = await response.text();
    let message = `请求失败（HTTP ${response.status}）`;
    let code = 'BAD_RESPONSE';
    try {
      const envelope = JSON.parse(text) as {
        ok?: boolean;
        error?: { code?: string; message?: string };
      };
      if (envelope.error?.message) message = envelope.error.message;
      if (envelope.error?.code) code = envelope.error.code;
    } catch {
      // 保持默认文案
    }
    throw new ApiError(message, { status: response.status, code });
  }

  if (!response.body) {
    throw new ApiError('当前浏览器不支持流式响应', { status: 0, code: 'NO_STREAM' });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data.length === 0) continue;
          try {
            handlers.onEvent(JSON.parse(data) as ChatStreamPayload);
          } catch {
            // 单帧解析失败不该打断整段生成
          }
        }

        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
