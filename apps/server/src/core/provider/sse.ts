/**
 * Server-Sent Events 解析器。
 *
 * 为什么要自己写：`chat.completions` 的流式响应没有任何库能直接给出「事件」，
 * 而按 `data:` 前缀粗暴 split 会在三种情况下崩掉：
 *   1. 一个事件跨多个 TCP chunk（最常见的坑，中文被切开时尤甚）
 *   2. 一个 chunk 里有多个事件
 *   3. CRLF / 注释行（`:` 开头）/ 多行 data
 * 这里按规范逐行状态机处理，并且用 TextDecoder 的流式模式保证多字节字符不被切断。
 */

/** 一个完整事件。 */
export interface SseEvent {
  /** 默认是 'message' */
  event?: string;
  /** 多行 data 用 \n 拼接后的内容 */
  data: string;
  id?: string;
  /** 服务端建议的重连间隔（毫秒） */
  retry?: number;
}

export interface ParseSseOptions {
  /** 单条事件的 data 上限（字节），防御异常上游无限吐数据 */
  maxEventBytes?: number;
}

const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;

/**
 * 把 fetch 的 response.body 变成字节流迭代器。
 *
 * 直接 `for await (const chunk of response.body)` 在部分运行时不可用，
 * 用 getReader 显式读更稳；提前退出时主动 cancel，避免连接悬挂。
 */
export async function* readStreamBody(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (!body) return;

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    // 上层提前 break 时释放连接
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * 解析 SSE 字节流为事件序列。
 *
 * 行缓冲策略：只按 `\n` 切，未闭合的尾巴留在 buffer 里等下一个 chunk。
 * 流结束时若还有残留事件（上游没补最后的空行），也把它吐出来，避免丢最后一帧。
 */
export async function* parseSseStream(
  source: AsyncIterable<Uint8Array>,
  options: ParseSseOptions = {},
): AsyncGenerator<SseEvent> {
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let eventId: string | undefined;
  let retryMs: number | undefined;
  let eventBytes = 0;

  const resetEvent = (): void => {
    dataLines = [];
    eventName = undefined;
    eventId = undefined;
    retryMs = undefined;
    eventBytes = 0;
  };

  const buildEvent = (): SseEvent | null => {
    if (dataLines.length === 0) {
      resetEvent();
      return null;
    }
    const event: SseEvent = { data: dataLines.join('\n') };
    if (eventName !== undefined) event.event = eventName;
    if (eventId !== undefined) event.id = eventId;
    if (retryMs !== undefined) event.retry = retryMs;
    resetEvent();
    return event;
  };

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      // 兼容 \r\n：把行尾的 \r 去掉
      let line = buffer.slice(0, newlineIndex);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        // 空行 = 事件结束
        const event = buildEvent();
        if (event) yield event;
      } else if (line.startsWith(':')) {
        // 注释/心跳（很多服务用 ': ping' 保活）
      } else {
        const colonIndex = line.indexOf(':');
        const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
        let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
        if (value.startsWith(' ')) value = value.slice(1);

        switch (field) {
          case 'data':
            eventBytes += Buffer.byteLength(value, 'utf8');
            if (eventBytes > maxEventBytes) {
              throw new Error(`SSE 单条事件超过 ${maxEventBytes} 字节上限，疑似上游异常`);
            }
            dataLines.push(value);
            break;
          case 'event':
            eventName = value;
            break;
          case 'id':
            eventId = value;
            break;
          case 'retry': {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed)) retryMs = parsed;
            break;
          }
          default:
            // 未知字段按规范忽略
            break;
        }
      }

      newlineIndex = buffer.indexOf('\n');
    }
  }

  // 流结束：处理没有以空行结尾的最后一帧
  if (buffer.length > 0) {
    const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    if (line.startsWith('data:')) {
      let value = line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      dataLines.push(value);
    }
  }

  const trailing = buildEvent();
  if (trailing) yield trailing;
}
