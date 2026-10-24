import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError } from './errors.js';
import { createOpenAiCompatibleProvider } from './openai-compatible.js';
import type { ChatRequest, ChatStreamEvent } from './types.js';

interface CapturedCall {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface Upstream {
  url: string;
  calls: CapturedCall[];
  close: () => Promise<void>;
}

/** 起一个假上游：记录请求、按 handler 决定怎么回。 */
async function startUpstream(
  handler: (call: CapturedCall, res: http.ServerResponse) => void,
): Promise<Upstream> {
  const calls: CapturedCall[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      const call: CapturedCall = {
        path: req.url ?? '',
        headers: req.headers,
        body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      calls.push(call);
      handler(call, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

const upstreams: Upstream[] = [];

afterEach(async () => {
  while (upstreams.length > 0) {
    const upstream = upstreams.pop();
    if (upstream) await upstream.close();
  }
});

async function setup(
  handler: (call: CapturedCall, res: http.ServerResponse) => void,
  options: { apiKey?: string | undefined } = {},
) {
  const upstream = await startUpstream(handler);
  upstreams.push(upstream);
  const provider = createOpenAiCompatibleProvider({
    name: 'test-upstream',
    baseUrl: upstream.url,
    apiKey: 'apiKey' in options ? options.apiKey : 'sk-test',
    defaultModel: 'test-model',
  });
  return { upstream, provider };
}

const basicRequest: ChatRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: '你是一位酒馆老板' },
    { role: 'user', content: '来一杯' },
  ],
  params: { temperature: 0.8, topP: 0.9, maxTokens: 64, stop: ['\n\n'] },
};

describe('OpenAI 兼容适配器 · 非流式', () => {
  it('正常返回时解析文本、结束原因、用量与模型名', async () => {
    const { provider, upstream } = await setup((_call, res) => {
      jsonResponse(res, 200, {
        model: 'test-model-snapshot',
        choices: [
          { message: { role: 'assistant', content: '好嘞，马上来' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      });
    });

    const result = await provider.chat(basicRequest);

    expect(result.text).toBe('好嘞，马上来');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 6, totalTokens: 18 });
    // 上游回报的实际模型名要保留，方便确认是否被映射到快照版本
    expect(result.model).toBe('test-model-snapshot');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const call = upstream.calls[0];
    expect(call?.path).toBe('/v1/chat/completions');
    expect(call?.headers.authorization).toBe('Bearer sk-test');
    expect(call?.body.model).toBe('test-model');
    expect(call?.body.stream).toBe(false);
    expect(call?.body.messages).toEqual([
      { role: 'system', content: '你是一位酒馆老板' },
      { role: 'user', content: '来一杯' },
    ]);
    // 采样参数要按 OpenAI 的下划线命名传出去
    expect(call?.body.temperature).toBe(0.8);
    expect(call?.body.top_p).toBe(0.9);
    expect(call?.body.max_tokens).toBe(64);
    expect(call?.body.stop).toEqual(['\n\n']);
  });

  it('extra 可以透传私有字段，但不能覆盖核心字段', async () => {
    const { provider, upstream } = await setup((_call, res) => {
      jsonResponse(res, 200, { choices: [{ message: { content: 'ok' } }] });
    });

    await provider.chat({
      ...basicRequest,
      extra: { keep_alive: '5m', stream: true, model: 'hacked' },
    });

    const body = upstream.calls[0]?.body;
    expect(body?.keep_alive).toBe('5m');
    // 核心字段以结构化参数为准
    expect(body?.model).toBe('test-model');
    expect(body?.stream).toBe(false);
  });

  it('401 映射成 AUTH_FAILED 且不可重试', async () => {
    const { provider } = await setup((_call, res) => {
      jsonResponse(res, 401, { error: { message: 'Incorrect API key provided' } });
    });

    await expect(provider.chat(basicRequest)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      retryable: false,
    });
  });

  it('429 带上 retry-after 且标记可重试', async () => {
    const { provider } = await setup((_call, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ error: { message: 'rate limit' } }));
    });

    const error = await provider.chat(basicRequest).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('RATE_LIMITED');
    expect((error as ProviderError).retryable).toBe(true);
    expect((error as ProviderError).retryAfterMs).toBe(2000);
  });

  it('404 映射成 MODEL_NOT_FOUND', async () => {
    const { provider } = await setup((_call, res) => {
      jsonResponse(res, 404, { error: { message: 'model not found' } });
    });

    await expect(provider.chat(basicRequest)).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('400 带出上游的具体原因', async () => {
    const { provider } = await setup((_call, res) => {
      jsonResponse(res, 400, { error: { message: 'temperature must be <= 2' } });
    });

    const error = (await provider
      .chat(basicRequest)
      .catch((caught: unknown) => caught)) as ProviderError;
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toContain('temperature must be <= 2');
  });

  it('响应不是 JSON 时映射成 INVALID_RESPONSE', async () => {
    const { provider } = await setup((_call, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>bad gateway</html>');
    });

    await expect(provider.chat(basicRequest)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('缺少 content 时映射成 INVALID_RESPONSE', async () => {
    const { provider } = await setup((_call, res) => {
      jsonResponse(res, 200, { choices: [{ message: { role: 'assistant' } }] });
    });

    await expect(provider.chat(basicRequest)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('连不上上游时映射成可重试的 UPSTREAM_ERROR', async () => {
    const upstream = await startUpstream((_call, res) => {
      jsonResponse(res, 200, { choices: [{ message: { content: 'ok' } }] });
    });
    const provider = createOpenAiCompatibleProvider({
      name: 'test-upstream',
      baseUrl: upstream.url,
      apiKey: 'sk-test',
      defaultModel: 'test-model',
    });
    // 先关掉，再请求 → 连接被拒
    await upstream.close();

    const error = (await provider
      .chat(basicRequest)
      .catch((caught: unknown) => caught)) as ProviderError;
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.retryable).toBe(true);
  });

  it('没有 API Key 时不发请求，直接抛 NO_CREDENTIALS', async () => {
    const { provider, upstream } = await setup(
      (_call, res) => jsonResponse(res, 200, { choices: [{ message: { content: 'ok' } }] }),
      { apiKey: undefined },
    );

    expect(provider.hasCredentials).toBe(false);
    await expect(provider.chat(basicRequest)).rejects.toMatchObject({ code: 'NO_CREDENTIALS' });
    expect(upstream.calls).toHaveLength(0);
  });

  it('取消信号会中断请求', async () => {
    const { provider } = await setup((_call, res) => {
      // 不响应，等外部取消
      res.writeHead(200, { 'content-type': 'application/json' });
      setTimeout(() => res.end('{}'), 5000);
    });

    const controller = new AbortController();
    const promise = provider.chat(basicRequest, { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
  }, 10_000);
});

/** 开一个 SSE 响应头。 */
function sseHead(res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

/** 写一个 SSE 数据帧。 */
function sseData(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function collectEvents(iterable: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** 把 delta 事件拼成完整文本，便于断言。 */
function joinDeltas(events: ChatStreamEvent[]): string {
  return events
    .filter((event): event is Extract<ChatStreamEvent, { type: 'delta' }> => event.type === 'delta')
    .map((event) => event.text)
    .join('');
}

describe('OpenAI 兼容适配器 · 流式', () => {
  it('按 chunk 吐出 delta，并以 done 收尾（含首字延迟与用量）', async () => {
    const { provider, upstream } = await setup((_call, res) => {
      sseHead(res);
      sseData(res, { model: 'test-model-0613', choices: [{ delta: { role: 'assistant' } }] });
      sseData(res, { choices: [{ delta: { content: '好' } }] });
      sseData(res, { choices: [{ delta: { content: '嘞，' } }] });
      sseData(res, { choices: [{ delta: { content: '马上来' } }] });
      sseData(res, {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      });
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const events = await collectEvents(provider.stream(basicRequest));

    expect(events[0]).toMatchObject({ type: 'start', model: 'test-model' });
    expect(joinDeltas(events)).toBe('好嘞，马上来');

    const usageEvent = events.find((event) => event.type === 'usage');
    expect(usageEvent).toMatchObject({
      type: 'usage',
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
    });

    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'done', finishReason: 'stop' });
    if (done?.type === 'done') {
      expect(done.firstTokenMs).not.toBeNull();
      expect(done.durationMs).toBeGreaterThanOrEqual(0);
      expect(done.usage?.totalTokens).toBe(25);
    }

    // 流式请求必须带 stream:true 与 stream_options
    const body = upstream.calls[0]?.body;
    expect(body?.stream).toBe(true);
    expect(body?.stream_options).toEqual({ include_usage: true });
    expect(upstream.calls[0]?.headers.accept).toBe('text/event-stream');
  });

  it('忽略流里的非 JSON 心跳帧', async () => {
    const { provider } = await setup((_call, res) => {
      sseHead(res);
      res.write('data: not-json\n\n');
      sseData(res, { choices: [{ delta: { content: 'A' } }] });
      res.write(': ping\n\n');
      sseData(res, { choices: [{ delta: { content: 'B' } }] });
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const events = await collectEvents(provider.stream(basicRequest));
    expect(joinDeltas(events)).toBe('AB');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('关闭 include_usage 时不再发 stream_options', async () => {
    const upstream = await startUpstream((_call, res) => {
      sseHead(res);
      sseData(res, { choices: [{ delta: { content: 'x' } }] });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    upstreams.push(upstream);

    const provider = createOpenAiCompatibleProvider({
      name: 'test-upstream',
      baseUrl: upstream.url,
      apiKey: 'sk-test',
      defaultModel: 'test-model',
      requestStreamUsage: false,
    });

    await collectEvents(provider.stream(basicRequest));
    expect(upstream.calls[0]?.body.stream_options).toBeUndefined();
  });

  it('上游 5xx 以 error 事件收尾而不是抛异常', async () => {
    const { provider } = await setup((_call, res) => {
      jsonResponse(res, 503, { error: { message: 'overloaded' } });
    });

    const events = await collectEvents(provider.stream(basicRequest));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: 'UPSTREAM_ERROR', retryable: true },
    });
  });

  it('没有 Key 时立刻返回 error 事件', async () => {
    const { provider, upstream } = await setup((_call, res) => jsonResponse(res, 200, {}), {
      apiKey: undefined,
    });

    const events = await collectEvents(provider.stream(basicRequest));
    expect(events[0]).toMatchObject({ type: 'error', error: { code: 'NO_CREDENTIALS' } });
    expect(upstream.calls).toHaveLength(0);
  });

  it('首字超时判定为 TIMEOUT', async () => {
    const { provider } = await setup(() => {
      // 收到请求但一直不吐字，模拟上游卡死
    });

    const events = await collectEvents(
      provider.stream(basicRequest, { firstTokenTimeoutMs: 80, timeoutMs: 3000 }),
    );

    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'TIMEOUT' } });
  });

  it('外部取消判定为 ABORTED', async () => {
    const { provider } = await setup(() => {
      // 同样不吐字，但这次由外部信号取消
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);

    const events = await collectEvents(
      provider.stream(basicRequest, { signal: controller.signal, timeoutMs: 3000 }),
    );

    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ABORTED' } });
  });

  it('中文被拆成多次 delta 时拼接结果仍然正确', async () => {
    const { provider } = await setup((_call, res) => {
      sseHead(res);
      sseData(res, { choices: [{ delta: { content: '你好' } }] });
      sseData(res, { choices: [{ delta: { content: '世界' } }] });
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const events = await collectEvents(provider.stream(basicRequest));
    expect(joinDeltas(events)).toBe('你好世界');
  });
});
