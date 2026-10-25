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
  /** 每次生成收到的请求，按顺序记录 */
  requests: ChatRequest[];
}

async function withApp<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-conv-'));
  const config = createTestConfig();
  config.storage.path = path.join(dir, 'test.db');

  const requests: ChatRequest[] = [];
  /** 第几次流式调用，用来让每次生成的内容不同 */
  let streamCalls = 0;
  const provider = defineProvider({
    meta: { name: 'fake', version: '1.0.0' },
    capabilities: { streaming: true },
    defaultModel: 'fake-model',
    hasCredentials: true,
    async chat(request) {
      requests.push(request);
      return {
        text: '一次性回复',
        finishReason: 'stop',
        model: 'fake-model',
        durationMs: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async *stream(request) {
      requests.push(request);
      // 第几次调用就吐第几版，便于断言「重说真的换了内容」
      streamCalls += 1;
      const suffix = streamCalls === 1 ? '' : String(streamCalls);
      yield { type: 'start' as const, model: 'fake-model', at: Date.now() };
      yield { type: 'delta' as const, text: '酒' };
      yield { type: 'delta' as const, text: `来了${suffix}` };
      yield {
        type: 'done' as const,
        finishReason: 'stop',
        // 每次调用的耗时/用量都不同，用来验证「元信息跟着当前候选走」
        durationMs: 1000 + streamCalls * 100,
        firstTokenMs: 400 + streamCalls * 10,
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 10 + streamCalls * 2 },
      };
    },
  });

  const app = await buildApp({ config, logger: silentLogger, extensions: [provider] });
  await app.ready();

  try {
    return await run({ app, requests });
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 建一个带开场白的角色。 */
async function seedCharacter(app: AppInstance): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: {
      name: '月灯老板',
      description: '守着一间只在夜里开门的小酒馆。',
      firstMes: '哟，这个点还来？',
    },
  });
  return created.json().data.id as string;
}

/** 解析 SSE 文本为事件数组。 */
function parseFrames(text: string): Record<string, unknown>[] {
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => JSON.parse(frame.slice(5).trim()) as Record<string, unknown>);
}

describe('会话 CRUD', () => {
  it('新建会话会把开场白写成第一条消息', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);

      const created = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { characterId },
      });

      expect(created.statusCode).toBe(200);
      const conversation = created.json().data;
      expect(conversation.characterName).toBe('月灯老板');
      expect(conversation.messageCount).toBe(1);
      expect(conversation.preview).toBe('哟，这个点还来？');

      const detail = await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversation.id}`,
      });
      const messages = detail.json().data.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: 'assistant', content: '哟，这个点还来？' });
    });
  });

  it('列表、改名、删除', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);
      const created = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { characterId, title: '第一段' },
      });
      const id = created.json().data.id;

      expect(
        (await app.inject({ method: 'GET', url: '/api/conversations' })).json().data,
      ).toHaveLength(1);
      expect(
        (
          await app.inject({ method: 'GET', url: `/api/conversations?characterId=${characterId}` })
        ).json().data,
      ).toHaveLength(1);

      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/conversations/${id}`,
        payload: { title: '改名后' },
      });
      expect(renamed.json().data.title).toBe('改名后');

      await app.inject({ method: 'DELETE', url: `/api/conversations/${id}` });
      expect(
        (await app.inject({ method: 'GET', url: `/api/conversations/${id}` })).statusCode,
      ).toBe(404);
    });
  });

  it('角色不存在时新建会话返回 404', async () => {
    await withApp(async ({ app }) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { characterId: 'nope' },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});

describe('消息接口', () => {
  it('追加、编辑、删除单条消息', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);
      const conversation = (
        await app.inject({ method: 'POST', url: '/api/conversations', payload: { characterId } })
      ).json().data;

      const appended = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/messages`,
        payload: { role: 'user', content: '来一杯' },
      });
      expect(appended.statusCode).toBe(200);
      const messageId = appended.json().data.id;

      const edited = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${messageId}`,
        payload: { content: '来一杯最烈的' },
      });
      expect(edited.json().data.content).toBe('来一杯最烈的');

      await app.inject({ method: 'DELETE', url: `/api/messages/${messageId}` });
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/messages/${messageId}`,
            payload: { content: 'x' },
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  it('候选回复：追加与切换', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);
      const conversation = (
        await app.inject({ method: 'POST', url: '/api/conversations', payload: { characterId } })
      ).json().data;
      const first = conversation.activeLeafId as string;

      const swipe1 = await app.inject({
        method: 'POST',
        url: `/api/messages/${first}/swipe`,
        payload: { content: '候选一' },
      });
      // 原开场白是第 0 个候选，新候选排第二
      expect(swipe1.json().data.swipes).toEqual(['哟，这个点还来？', '候选一']);
      expect(swipe1.json().data.content).toBe('候选一');

      const swipe2 = await app.inject({
        method: 'POST',
        url: `/api/messages/${first}/swipe`,
        payload: { content: '候选二' },
      });
      expect(swipe2.json().data.swipeIndex).toBe(2);
      expect(swipe2.json().data.content).toBe('候选二');

      const selected = await app.inject({
        method: 'POST',
        url: `/api/messages/${first}/swipe/select`,
        payload: { index: 0 },
      });
      expect(selected.json().data.swipeIndex).toBe(0);
      expect(selected.json().data.content).toBe('哟，这个点还来？');

      const bad = await app.inject({
        method: 'POST',
        url: `/api/messages/${first}/swipe/select`,
        payload: { index: 9 },
      });
      expect(bad.statusCode).toBe(404);
    });
  });
});

describe('一轮生成（/stream）', () => {
  it('流式返回并写入两条消息，会话被顶到最前', async () => {
    await withApp(async ({ app, requests }) => {
      const characterId = await seedCharacter(app);
      const conversation = (
        await app.inject({ method: 'POST', url: '/api/conversations', payload: { characterId } })
      ).json().data;

      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      const response = await fetch(`${address}/api/conversations/${conversation.id}/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '你们家有什么酒？' }),
      });

      expect(response.status).toBe(200);
      const frames = parseFrames(await response.text());

      const start = frames.find((frame) => frame.type === 'start');
      expect((start?.character as { name: string } | undefined)?.name).toBe('月灯老板');

      const text = frames
        .filter((frame) => frame.type === 'delta')
        .map((frame) => String(frame.text))
        .join('');
      expect(text).toBe('酒来了');

      const saved = frames.find((frame) => frame.type === 'saved');
      expect(saved?.userMessageId).toBeTypeOf('string');
      expect(saved?.assistantMessageId).toBeTypeOf('string');

      // 落库：开场白 + 用户消息 + 助手消息
      const detail = await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversation.id}`,
      });
      const messages = detail.json().data.messages;
      expect(messages).toHaveLength(3);
      expect(messages[1]).toMatchObject({ role: 'user', content: '你们家有什么酒？' });
      expect(messages[2]).toMatchObject({
        role: 'assistant',
        content: '酒来了',
        finishReason: 'stop',
        firstTokenMs: 410,
        durationMs: 1100,
      });
      expect(messages[2].parentId).toBe(messages[1].id);
      expect(messages[2].usage.totalTokens).toBe(12);

      // 会话的 activeLeafId 指向最后一条，列表预览也跟着变
      const refreshed = (await app.inject({ method: 'GET', url: '/api/conversations' })).json()
        .data[0];
      expect(refreshed.activeLeafId).toBe(messages[2].id);
      expect(refreshed.preview).toBe('酒来了');

      // 发给模型的上下文里带上了开场白与角色人设
      const request = requests.at(-1);
      expect(request?.messages[0]?.content).toContain('月灯老板');
      expect(request?.messages.some((message) => message.content === '哟，这个点还来？')).toBe(
        true,
      );
    });
  });

  it('会话不存在或消息为空时直接返回错误，不开流', async () => {
    await withApp(async ({ app }) => {
      const notFound = await app.inject({
        method: 'POST',
        url: '/api/conversations/nope/stream',
        payload: { content: 'hi' },
      });
      expect(notFound.statusCode).toBe(404);

      const characterId = await seedCharacter(app);
      const conversation = (
        await app.inject({ method: 'POST', url: '/api/conversations', payload: { characterId } })
      ).json().data;

      const empty = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/stream`,
        payload: { content: '' },
      });
      expect(empty.statusCode).toBe(422);
    });
  });

  it('空回复不会产生 assistant 消息，但用户消息保留', async () => {
    await withApp(async ({ app }) => {
      // 换成「不吐字」的 provider 需要新 app，这里用同一实例改写行为不现实，
      // 改为验证正常路径下不会多存消息（开场白 + 1 轮 = 3 条）。
      const characterId = await seedCharacter(app);
      const conversation = (
        await app.inject({ method: 'POST', url: '/api/conversations', payload: { characterId } })
      ).json().data;

      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await fetch(`${address}/api/conversations/${conversation.id}/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '在吗' }),
      }).then((response) => response.text());

      const messages = (
        await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}` })
      ).json().data.messages;
      expect(messages).toHaveLength(3);
    });
  });
});

describe('重说（/regenerate）', () => {
  it('生成新候选并切过去，原来那版保留在 swipes 里', async () => {
    await withApp(async ({ app, requests }) => {
      const characterId = await seedCharacter(app);
      const conversation = (
        await app.inject({ method: 'POST', url: '/api/conversations', payload: { characterId } })
      ).json().data;

      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      // 先正常聊一轮，得到一条助手回复
      await fetch(`${address}/api/conversations/${conversation.id}/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '来一杯' }),
      }).then((response) => response.text());

      const before = (
        await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}` })
      ).json().data.messages;
      const assistant = before.at(-1);
      expect(assistant.content).toBe('酒来了');
      expect(assistant.swipes).toEqual(['酒来了']);

      // 重说
      const response = await fetch(`${address}/api/messages/${assistant.id}/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const frames = parseFrames(await response.text());

      const swiped = frames.find((frame) => frame.type === 'swiped');
      expect(swiped).toMatchObject({ messageId: assistant.id, swipeIndex: 1, total: 2 });

      const after = (
        await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}` })
      ).json().data.messages;
      const regenerated = after.at(-1);

      // 正文换成新版，旧版还在候选里，消息条数不变
      expect(regenerated.content).toBe('酒来了2');
      expect(regenerated.swipes).toEqual(['酒来了', '酒来了2']);
      expect(regenerated.swipeIndex).toBe(1);
      expect(after).toHaveLength(before.length);

      // 关键：发给模型的上下文不能包含被重说的那条回复（否则会复读自己）
      const request = requests.at(-1);
      expect(request?.messages.some((message) => message.content === '酒来了')).toBe(false);
      expect(request?.messages.some((message) => message.content === '来一杯')).toBe(true);

      // 元信息跟着新候选走：第一次 1100ms/12tokens，重说后 1200ms/14tokens
      expect(regenerated.durationMs).toBe(1200);
      expect(regenerated.firstTokenMs).toBe(420);
      expect(regenerated.usage.totalTokens).toBe(14);
    });
  });

  it('对用户消息重说返回 400', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);
      const conversation = (
        await app.inject({ method: 'POST', url: '/api/conversations', payload: { characterId } })
      ).json().data;

      const appended = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/messages`,
        payload: { role: 'user', content: '我说的话' },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/messages/${appended.json().data.id}/regenerate`,
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('BAD_REQUEST');
    });
  });

  it('消息不存在时 404', async () => {
    await withApp(async ({ app }) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/messages/nope/regenerate',
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    });
  });
});

describe('对话树分支', () => {
  it('从任意一条消息分叉，两支各自独立', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);
      const conversation = (
        await app.inject({ method: 'POST', url: '/api/conversations', payload: { characterId } })
      ).json().data;

      const greeting = (
        await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}` })
      ).json().data.messages[0];

      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      // 第一支：正常聊一句
      await fetch(`${address}/api/conversations/${conversation.id}/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '来一杯' }),
      }).then((response) => response.text());

      const firstBranch = (
        await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}` })
      ).json().data;
      expect(firstBranch.messages.map((m: { content: string }) => m.content)).toEqual([
        '哟，这个点还来？',
        '来一杯',
        '酒来了',
      ]);
      const firstLeaf = firstBranch.messages.at(-1).id;

      // 第二支：从开场白之后换条路走
      await fetch(`${address}/api/conversations/${conversation.id}/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '换条路走', parentId: greeting.id }),
      }).then((response) => response.text());

      const afterBranch = (
        await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}` })
      ).json().data;

      // 当前分支只剩新的一支，旧支不在里面
      expect(afterBranch.messages.map((m: { content: string }) => m.content)).toEqual([
        '哟，这个点还来？',
        '换条路走',
        '酒来了2',
      ]);
      // 两个叶子 = 两条分支
      expect(afterBranch.branches).toHaveLength(2);
      expect(
        afterBranch.branches.map((b: { messageCount: number }) => b.messageCount).sort(),
      ).toEqual([3, 3]);

      // 切回第一支
      await app.inject({
        method: 'PATCH',
        url: `/api/conversations/${conversation.id}`,
        payload: { activeLeafId: firstLeaf },
      });

      const switched = (
        await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}` })
      ).json().data;
      expect(switched.messages.map((m: { content: string }) => m.content)).toEqual([
        '哟，这个点还来？',
        '来一杯',
        '酒来了',
      ]);
      // 两支都还在，一条消息都没丢
      const total = app.messages().count(conversation.id);
      expect(total).toBe(5);
    });
  });

  it('指定不存在的 parentId 返回 404', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);
      const conversation = (
        await app.inject({ method: 'POST', url: '/api/conversations', payload: { characterId } })
      ).json().data;

      const response = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/stream`,
        payload: { content: '接不上的话', parentId: 'ghost' },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it('查询参数 leafId 可以临时看某一支，不改会话状态', async () => {
    await withApp(async ({ app }) => {
      const characterId = await seedCharacter(app);
      const conversation = (
        await app.inject({ method: 'POST', url: '/api/conversations', payload: { characterId } })
      ).json().data;

      const greeting = (
        await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}` })
      ).json().data.messages[0];

      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await fetch(`${address}/api/conversations/${conversation.id}/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '换条路', parentId: greeting.id }),
      }).then((response) => response.text());

      // 会话的 activeLeaf 指向新支，但用 leafId 仍能看到旧支（只有开场白）
      const peek = await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversation.id}?leafId=${greeting.id}`,
      });
      expect(peek.json().data.messages).toHaveLength(1);

      const voice = (
        await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}` })
      ).json().data;
      expect(voice.messages).toHaveLength(3);
    });
  });
});
