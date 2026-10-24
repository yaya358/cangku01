import type { AddressInfo } from 'node:net';
import type { ChatStreamPayload } from '@tavern/shared';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { ChatStreamEvent } from '../../core/provider/index.js';
import { defineProvider } from '../../testing/provider-fixture.js';
import { createTestConfig } from '../../testing/test-config.js';

const silentLogger = pino({ level: 'silent' });

function testConfig() {
  return createTestConfig();
}

/** 假 provider：可控地吐出固定流。 */
function fakeProvider(events: ChatStreamEvent[] = []) {
  return defineProvider({
    meta: { name: 'fake', version: '1.0.0' },
    capabilities: { streaming: true },
    defaultModel: 'fake-model',
    hasCredentials: true,
    async chat() {
      return {
        text: '你好，我是假模型',
        finishReason: 'stop',
        model: 'fake-model',
        durationMs: 1,
        usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
      };
    },
    async *stream() {
      for (const event of events) yield event;
    },
  });
}

async function buildTestApp(provider = fakeProvider()) {
  return buildApp({ config: testConfig(), logger: silentLogger, extensions: [provider] });
}

describe('GET /api/providers', () => {
  it('列出 provider 及其可用状态', async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/providers' });
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual([
        {
          name: 'fake',
          model: 'fake-model',
          state: 'ready',
          capabilities: ['streaming'],
          hasCredentials: true,
        },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/chat', () => {
  it('返回完整文本与用量', async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { messages: [{ role: 'user', content: '你好' }] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.text).toBe('你好，我是假模型');
      expect(body.data.usage.totalTokens).toBe(8);
    } finally {
      await app.close();
    }
  });

  it('缺少 messages 时返回 422', async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/chat', payload: {} });
      expect(response.statusCode).toBe(422);

      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(body.error.details)).toContain('messages');
    } finally {
      await app.close();
    }
  });

  it('provider 名字不存在时返回 404 且列出可用项', async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { provider: 'nope', messages: [{ role: 'user', content: 'hi' }] },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toContain('fake');
    } finally {
      await app.close();
    }
  });

  it('没有任何 provider 时返回 501 并提示怎么配', async () => {
    const app = await buildApp({ config: testConfig(), logger: silentLogger });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { messages: [{ role: 'user', content: 'hi' }] },
      });

      expect(response.statusCode).toBe(501);
      expect(response.json().error.message).toContain('providers');
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/chat/stream', () => {
  /** 起真实端口用 fetch 读 SSE（inject 对 hijack 的响应支持有限）。 */
  async function withServer<T>(
    provider: ReturnType<typeof fakeProvider>,
    run: (baseUrl: string) => Promise<T>,
  ): Promise<T> {
    const app = await buildTestApp(provider);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    try {
      return await run(`http://127.0.0.1:${port}`);
    } finally {
      await app.close();
    }
  }

  /** 把 SSE 文本拆成对象数组。 */
  function parseFrames(text: string): ChatStreamPayload[] {
    return text
      .split('\n\n')
      .map((frame) => frame.trim())
      .filter((frame) => frame.startsWith('data:'))
      .map((frame) => JSON.parse(frame.slice(5).trim()) as ChatStreamPayload);
  }

  it('按 start → delta → done 顺序吐事件', async () => {
    const provider = fakeProvider([
      { type: 'start', model: 'fake-model', at: 0 },
      { type: 'delta', text: '你' },
      { type: 'delta', text: '好' },
      { type: 'usage', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
      { type: 'done', finishReason: 'stop', durationMs: 12, firstTokenMs: 3 },
    ]);

    const frames = await withServer(provider, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      return parseFrames(await response.text());
    });

    expect(frames[0]).toMatchObject({ type: 'start', provider: 'fake', model: 'fake-model' });
    expect(frames.filter((frame) => frame.type === 'delta')).toHaveLength(2);
    expect(frames.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop', firstTokenMs: 3 });
  });

  it('provider 报错时以 error 事件收尾', async () => {
    const provider = fakeProvider([
      { type: 'error', error: { code: 'RATE_LIMITED', message: '太频繁', retryable: true } },
    ]);

    const frames = await withServer(provider, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
      });
      return parseFrames(await response.text());
    });

    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'RATE_LIMITED', retryable: true });
  });

  it('请求体不合法时在开流之前就返回 422 JSON', async () => {
    const app = await buildTestApp(fakeProvider([]));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/stream',
        payload: { messages: [] },
      });
      expect(response.statusCode).toBe(422);
      expect(response.headers['content-type']).toContain('application/json');
    } finally {
      await app.close();
    }
  });
});
