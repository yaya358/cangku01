import type { ChatStreamPayload } from '@tavern/shared';

/**
 * SSE 读帧器。
 *
 * 抽出来是因为两个地方要用：试话页的 /chat/stream 和会话页的 /conversations/:id/stream。
 * 分帧规则与后端对称：按 `\n\n` 切事件，未闭合的尾巴留在 buffer 里；
 * TextDecoder 必须用 stream 模式，否则中文被切在 chunk 边界会乱码。
 */
export async function readSseStream(
  response: Response,
  onEvent: (event: ChatStreamPayload) => void,
): Promise<void> {
  if (!response.body) {
    throw new Error('当前浏览器不支持流式响应');
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
            onEvent(JSON.parse(data) as ChatStreamPayload);
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

/** 把「开流前的错误」也套成同一种形态：读 JSON 信封拿 message。 */
export async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;

  const text = await response.text();
  let message = `请求失败（HTTP ${response.status}）`;
  try {
    const envelope = JSON.parse(text) as { error?: { message?: string } };
    if (envelope.error?.message) message = envelope.error.message;
  } catch {
    // 保持默认文案
  }
  throw new Error(message);
}
