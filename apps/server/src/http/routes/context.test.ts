import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatRequest } from '../../core/provider/index.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { AppInstance } from '../../types/fastify.js';
import { defineProvider } from '../../testing/provider-fixture.js';
import { createTestConfig } from '../../testing/test-config.js';

const silentLogger = pino({ level: 'silent' });

interface Harness {
  app: AppInstance;
  /** 假 provider 收到的最后一次请求 */
  lastRequest: () => ChatRequest | null;
}

async function withApp<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-context-'));
  const config = createTestConfig();
  config.storage.path = path.join(dir, 'test.db');

  let captured: ChatRequest | null = null;
  const provider = defineProvider({
    meta: { name: 'capture', version: '1.0.0' },
    capabilities: { streaming: true },
    defaultModel: 'capture-model',
    hasCredentials: true,
    async chat(request) {
      captured = request;
      return {
        text: '收到',
        finishReason: 'stop',
        model: 'capture-model',
        durationMs: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async *stream() {
      yield { type: 'done' as const, finishReason: 'stop', durationMs: 1, firstTokenMs: 1 };
    },
  });

  const app = await buildApp({ config, logger: silentLogger, extensions: [provider] });
  await app.ready();

  try {
    return await run({ app, lastRequest: () => captured });
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 建一个带人设与世界书的角色，返回 id。 */
async function seedCharacter(app: AppInstance): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: {
      name: '月灯老板',
      description: '守着一间只在夜里开门的小酒馆。',
      personality: '话痨、心软',
      scenario: '深夜的酒馆',
      firstMes: '哟，这个点还来？',
      postHistoryInstructions: '不要用网络流行语。',
    },
  });
  const id = created.json().data.id as string;

  app.worldbook().create({
    title: '王都',
    keys: ['王都'],
    content: '王都是座不夜城，城门午夜关闭。',
    characterId: id,
  });
  app.worldbook().create({
    title: '黑市',
    keys: ['黑市'],
    content: '黑市效忠于商会。',
    characterId: id,
  });

  return id;
}

describe('上下文预览接口', () => {
  it('返回分层明细、预算与世界书命中', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);

      const response = await app.inject({
        method: 'POST',
        url: '/api/context/preview',
        payload: {
          characterId,
          userName: '旅人',
          messages: [
            { role: 'user', content: '之前来过一次' },
            { role: 'assistant', content: '记得你' },
            { role: 'user', content: '听说王都有个黑市？' },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const preview = response.json().data;

      expect(preview.character.name).toBe('月灯老板');
      // 层顺序：系统 → 人设 → 场景 → 世界书 → 历史 → 历史后指令 → 输入
      expect(preview.layers.map((layer: { kind: string }) => layer.kind)).toEqual([
        'system',
        'persona',
        'scenario',
        'worldbook',
        'worldbook',
        'history',
        'history',
        'post_history',
        'user_input',
      ]);

      // 用户提到「王都」和「黑市」，两条都该命中
      expect(preview.worldbook.map((hit: { title: string }) => hit.title).sort()).toEqual([
        '王都',
        '黑市',
      ]);

      expect(preview.budget.available).toBe(8192 - 1024 - 128);
      expect(preview.budget.used).toBeGreaterThan(0);
      expect(preview.budget.truncated).toBe(false);
      expect(preview.messages.at(-1)).toMatchObject({ role: 'user' });
      expect(preview.messages[0]?.content).toContain('月灯老板');
      expect(preview.messages[0]?.content).toContain('王都是座不夜城');
      expect(preview.breakdown.length).toBeGreaterThan(0);
    });
  });

  it('世界书链式触发：只提「王都」也能带出「黑市」', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);
      // 让王都条目里提到黑市（模拟真实设定之间的引用）
      const entries = app.worldbook().listForCharacter(characterId);
      const city = entries.find((entry) => entry.title === '王都');
      if (!city) throw new Error('缺少王都条目');
      app.worldbook().update(city.id, { content: '王都有一条黑市街，黑市效忠于商会。' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/context/preview',
        payload: { characterId, messages: [{ role: 'user', content: '我们进王都吧' }] },
      });

      const titles = response.json().data.worldbook.map((hit: { title: string }) => hit.title);
      expect(titles).toContain('王都');
      expect(titles).toContain('黑市');
    });
  });

  it('预算紧张时会裁剪并给出说明', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);
      const longHistory = Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `第 ${index} 轮：聊了些有的没的，内容挺长的，用来撑爆预算。`,
      }));

      const response = await app.inject({
        method: 'POST',
        url: '/api/context/preview',
        payload: {
          characterId,
          messages: [...longHistory, { role: 'user', content: '继续' }],
          // 可用预算 500-120-40=340，历史总量远超它
          budget: { contextWindow: 500, reservedForOutput: 120, safetyMargin: 40 },
        },
      });

      const preview = response.json().data;
      expect(preview.budget.truncated).toBe(true);
      expect(preview.dropped.length).toBeGreaterThan(0);
      // 丢掉的应该是历史，而不是人设或本轮输入
      expect(preview.dropped.some((layer: { kind: string }) => layer.kind === 'history')).toBe(
        true,
      );
      expect(preview.layers.some((layer: { kind: string }) => layer.kind === 'user_input')).toBe(
        true,
      );
      expect(preview.notes.join()).toMatch(/裁|截断/);
    });
  });

  it('角色不存在返回 404，参数不合法返回 422', async () => {
    await withApp(async ({ app }) => {
      const notFound = await app.inject({
        method: 'POST',
        url: '/api/context/preview',
        payload: { characterId: 'nope', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(notFound.statusCode).toBe(404);

      const invalid = await app.inject({
        method: 'POST',
        url: '/api/context/preview',
        payload: { characterId: '', messages: [] },
      });
      expect(invalid.statusCode).toBe(422);
    });
  });
});

describe('对话接入上下文引擎', () => {
  it('带 characterId 时发给模型的是组装后的消息', async () => {
    await withApp(async ({ app, lastRequest }) => {
      const characterId = await seedCharacter(app);

      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: {
          characterId,
          userName: '旅人',
          messages: [
            { role: 'user', content: '在吗' },
            { role: 'assistant', content: '在的' },
            { role: 'user', content: '王都怎么走？' },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.character.name).toBe('月灯老板');
      expect(response.json().data.worldbookHits).toBeGreaterThanOrEqual(1);
      expect(response.json().data.contextTokens).toBeGreaterThan(0);

      const request = lastRequest();
      expect(request).not.toBeNull();
      const messages = request?.messages ?? [];

      // 第一条是 system，里面必有角色人设与世界书内容
      expect(messages[0]?.role).toBe('system');
      expect(messages[0]?.content).toContain('月灯老板');
      expect(messages[0]?.content).toContain('王都是座不夜城');
      // 历史两条 + 本轮输入
      expect(messages.filter((message) => message.role === 'user')).toHaveLength(2);
      expect(messages.at(-1)?.content).toBe('王都怎么走？');
      // 历史后指令也进来了
      expect(messages.some((message) => message.content.includes('不要用网络流行语'))).toBe(true);
    });
  });

  it('不带 characterId 时保持裸对话（原样透传）', async () => {
    await withApp(async ({ app, lastRequest }) => {
      const payload = {
        provider: 'capture',
        messages: [
          { role: 'system', content: '你是测试助手' },
          { role: 'user', content: '你好' },
        ],
      };

      const response = await app.inject({ method: 'POST', url: '/api/chat', payload });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.character).toBeUndefined();

      const request = lastRequest();
      expect(request?.messages).toEqual(payload.messages);
    });
  });

  it('characterId 不存在时返回 404', async () => {
    await withApp(async ({ app }) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { characterId: 'nope', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it('流式接口的 start 事件带上角色与上下文信息', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      try {
        const response = await fetch(`${address}/api/chat/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            characterId,
            messages: [{ role: 'user', content: '王都的城门几点关？' }],
          }),
        });

        const text = await response.text();
        const frames = text
          .split('\n\n')
          .map((frame) => frame.trim())
          .filter((frame) => frame.startsWith('data:'))
          .map((frame) => JSON.parse(frame.slice(5).trim()) as Record<string, unknown>);

        const start = frames.find((frame) => frame.type === 'start');
        expect(start).toMatchObject({ type: 'start' });
        expect((start?.character as { name: string } | undefined)?.name).toBe('月灯老板');
        expect(Number(start?.contextTokens)).toBeGreaterThan(0);
        expect(Number(start?.worldbookHits)).toBeGreaterThanOrEqual(1);
      } finally {
        await app.close();
      }
    });
  });
});
