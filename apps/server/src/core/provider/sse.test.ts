import { describe, expect, it } from 'vitest';
import { parseSseStream } from './sse.js';
import type { SseEvent } from './sse.js';

/** 把若干字符串块喂给解析器（模拟 TCP 分片）。 */
async function collect(chunks: string[]): Promise<SseEvent[]> {
  const encoder = new TextEncoder();
  async function* source(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield encoder.encode(chunk);
  }

  const events: SseEvent[] = [];
  for await (const event of parseSseStream(source())) events.push(event);
  return events;
}

describe('parseSseStream', () => {
  it('解析基本事件', async () => {
    const events = await collect(['data: hello\n\n', 'data: world\n\n']);
    expect(events).toEqual([{ data: 'hello' }, { data: 'world' }]);
  });

  it('多行 data 用换行拼接', async () => {
    const events = await collect(['data: line1\ndata: line2\n\n']);
    expect(events).toEqual([{ data: 'line1\nline2' }]);
  });

  it('支持 event / id / retry 字段', async () => {
    const events = await collect(['event: delta\nid: 42\nretry: 3000\ndata: x\n\n']);
    expect(events).toEqual([{ data: 'x', event: 'delta', id: '42', retry: 3000 }]);
  });

  it('忽略注释行与心跳', async () => {
    const events = await collect([': ping\n\n', ': keep-alive\n', 'data: real\n\n']);
    expect(events).toEqual([{ data: 'real' }]);
  });

  it('容忍 CRLF 换行', async () => {
    const events = await collect(['data: a\r\n\r\ndata: b\r\n\r\n']);
    expect(events).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('一个事件跨多个 chunk', async () => {
    const events = await collect(['data: he', 'llo wo', 'rld\n', '\n']);
    expect(events).toEqual([{ data: 'hello world' }]);
  });

  it('一个 chunk 里包含多个事件', async () => {
    const events = await collect(['data: 1\n\ndata: 2\n\ndata: 3\n\n']);
    expect(events.map((event) => event.data)).toEqual(['1', '2', '3']);
  });

  it('中文被按字节切开也不乱码', async () => {
    const encoder = new TextEncoder();
    const payload = encoder.encode('data: 你好世界\n\n');
    // 故意从多字节字符中间切一刀
    const first = payload.slice(0, 9);
    const second = payload.slice(9);

    async function* source(): AsyncGenerator<Uint8Array> {
      yield first;
      yield second;
    }

    const events: SseEvent[] = [];
    for await (const event of parseSseStream(source())) events.push(event);
    expect(events).toEqual([{ data: '你好世界' }]);
  });

  it('流结束时补齐没有空行收尾的最后一帧', async () => {
    const events = await collect(['data: 1\n\ndata: tail']);
    expect(events.map((event) => event.data)).toEqual(['1', 'tail']);
  });

  it('data: [DONE] 原样透出，由上层决定语义', async () => {
    const events = await collect(['data: [DONE]\n\n']);
    expect(events).toEqual([{ data: '[DONE]' }]);
  });

  it('超过大小上限时抛错，防止异常上游撑爆内存', async () => {
    const huge = `data: ${'x'.repeat(64)}\n\n`;
    await expect(
      (async () => {
        const encoder = new TextEncoder();
        async function* source(): AsyncGenerator<Uint8Array> {
          yield encoder.encode(huge);
        }
        for await (const _event of parseSseStream(source(), { maxEventBytes: 32 })) {
          // 只等它抛错
        }
      })(),
    ).rejects.toThrow(/上限/);
  });
});
