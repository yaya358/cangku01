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
  /** 每次生成收到的请求，按顺序记录 —— 用来断言「历史真的接上了」 */
  requests: ChatRequest[];
}

async function withApp<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-world-'));
  const config = createTestConfig();
  config.storage.path = path.join(dir, 'test.db');

  const requests: ChatRequest[] = [];
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
      };
    },
    async *stream(request) {
      requests.push(request);
      streamCalls += 1;
      yield { type: 'start' as const, model: 'fake-model', at: Date.now() };
      yield { type: 'delta' as const, text: `第${streamCalls}次` };
      yield { type: 'delta' as const, text: '接话。' };
      yield {
        type: 'done' as const,
        finishReason: 'stop',
        durationMs: 10,
        firstTokenMs: 3,
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
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

async function seedCharacter(app: AppInstance, name: string, extra: object = {}): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: { name, ...extra },
  });
  return created.json().data.id as string;
}

/** 建存档 + 场景，把这些人放进去。 */
async function seedSave(
  app: AppInstance,
  name: string,
  characterIds: string[],
): Promise<{ saveId: string; sceneId: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/world/saves',
    payload: { name, sceneName: '月灯酒馆', characterIds },
  });
  expect(created.statusCode).toBe(200);
  const data = created.json().data;
  return { saveId: data.save.id as string, sceneId: data.scene.id as string };
}

/** 解析 SSE 文本为事件数组。 */
function parseFrames(text: string): Record<string, unknown>[] {
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => JSON.parse(frame.slice(5).trim()) as Record<string, unknown>);
}

async function speak(
  app: AppInstance,
  sceneId: string,
  content: string,
): Promise<Record<string, unknown>[]> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/world/scenes/${sceneId}/stream`,
    payload: { content },
  });
  expect(response.statusCode).toBe(200);
  return parseFrames(response.body);
}

async function sceneDetail(app: AppInstance, sceneId: string): Promise<Record<string, any>> {
  const response = await app.inject({ method: 'GET', url: `/api/world/scenes/${sceneId}` });
  expect(response.statusCode).toBe(200);
  return response.json().data;
}

describe('场景详情', () => {
  it('还没人开口时：在场者齐全、消息为空、没有会话', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const patrol = await seedCharacter(app, '夜巡人');
      const { saveId, sceneId } = await seedSave(app, '月灯镇', [boss, patrol]);

      const detail = await sceneDetail(app, sceneId);
      expect(detail.conversationId).toBeNull();
      expect(detail.messages).toEqual([]);
      expect(detail.scene).toMatchObject({ name: '月灯酒馆', saveId, kind: 'public' });

      // 在场者带可达性判定与一句人话
      expect(detail.present.map((person: any) => person.name)).toEqual(['月灯老板', '夜巡人']);
      expect(detail.present[0]).toMatchObject({ reachability: 'available' });
      expect(detail.present[0].hint).toContain('可以过去说话');

      // 名单里只有场景里在场的人，没出现的人不该被编进来
      expect(detail.cast.map((member: any) => member.id)).toEqual([boss, patrol]);
    });
  });

  it('在忙的人在详情里标成 busy', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { sceneId } = await seedSave(app, '月灯镇', [boss]);

      await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${sceneId}/presence`,
        payload: { characterId: boss, busyWith: '擦杯子' },
      });

      const detail = await sceneDetail(app, sceneId);
      expect(detail.present[0]).toMatchObject({ busyWith: '擦杯子', reachability: 'busy' });
      expect(detail.present[0].hint).toContain('忙着');
    });
  });

  it('场景不存在时给 404，而不是空对象', async () => {
    await withApp(async ({ app }) => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/world/scenes/does-not-exist',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    });
  });

  it('存档下的场景列表带在场者名字', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { saveId } = await seedSave(app, '月灯镇', [boss]);

      const response = await app.inject({
        method: 'GET',
        url: `/api/world/saves/${saveId}/scenes`,
      });
      expect(response.statusCode).toBe(200);
      const scenes = response.json().data;
      expect(scenes).toHaveLength(1);
      expect(scenes[0].present).toEqual([{ id: boss, name: '月灯老板', busyWith: null }]);
    });
  });
});

describe('场景内说话', () => {
  it('说完之后消息落库，发言者名字能对上', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { sceneId } = await seedSave(app, '月灯镇', [boss]);

      const frames = await speak(app, sceneId, '晚上还开着吗？');
      expect(frames.some((frame) => frame.type === 'saved')).toBe(true);

      const detail = await sceneDetail(app, sceneId);
      expect(detail.conversationId).toBeTruthy();
      expect(detail.messages).toHaveLength(2);
      expect(detail.messages[0]).toMatchObject({ role: 'user', content: '晚上还开着吗？' });
      expect(detail.messages[1]).toMatchObject({ role: 'assistant', speakerId: boss });
      expect(detail.messages[1].content).toContain('接话');

      // 名字对照表：气泡上要显示是谁在说
      expect(detail.cast.find((member: any) => member.id === boss)?.name).toBe('月灯老板');
    });
  });

  it('@ 在场的谁，谁先接话', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const patrol = await seedCharacter(app, '夜巡人');
      const { sceneId } = await seedSave(app, '月灯镇', [boss, patrol]);

      await speak(app, sceneId, '@夜巡人 今晚街上怎么样？');

      const detail = await sceneDetail(app, sceneId);
      expect(detail.messages[1].speakerId).toBe(patrol);
    });
  });

  it('没 @ 谁时按轮转：两个角色交替接话', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const patrol = await seedCharacter(app, '夜巡人');
      const { sceneId } = await seedSave(app, '月灯镇', [boss, patrol]);

      await speak(app, sceneId, '第一句');
      await speak(app, sceneId, '第二句');
      await speak(app, sceneId, '第三句');

      const detail = await sceneDetail(app, sceneId);
      const speakers = detail.messages
        .filter((message: any) => message.role === 'assistant')
        .map((message: any) => message.speakerId);

      // 三轮三个人次：老板 → 夜巡人 → 老板，而不是一直同一个人说
      expect(speakers).toEqual([boss, patrol, boss]);
    });
  });

  it('每轮接在上一条后面，历史能看到前一轮', async () => {
    await withApp(async ({ app, requests }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { sceneId } = await seedSave(app, '月灯镇', [boss]);

      await speak(app, sceneId, '第一句');
      await speak(app, sceneId, '第二句');

      const detail = await sceneDetail(app, sceneId);
      expect(detail.messages).toHaveLength(4);

      // 第二轮发给模型的内容里必须含第一轮的回复，否则等于每轮从零开始
      const second = requests.at(-1)!;
      const flat = second.messages.map((message) => message.content).join('\n');
      expect(flat).toContain('第1次接话');
      expect(flat).toContain('第二句');
    });
  });

  it('场景会话不会混进「按角色的旧对话」列表', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { sceneId } = await seedSave(app, '月灯镇', [boss]);
      await speak(app, sceneId, '来一杯');

      // 场景里说的话属于场景；列到旧对话里会被当成一个人私聊，还能点进去乱说
      const list = await app.inject({ method: 'GET', url: '/api/conversations' });
      expect(list.json().data).toEqual([]);

      const detail = await sceneDetail(app, sceneId);
      expect(detail.messages).toHaveLength(2);
    });
  });

  it('场景里一个人都没有时拒绝发言', async () => {
    await withApp(async ({ app }) => {
      const { sceneId } = await seedSave(app, '空场景', []);

      const response = await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${sceneId}/stream`,
        payload: { content: '有人吗？' },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.message).toContain('没有人');
    });
  });

  it('离开的人不再接话', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const patrol = await seedCharacter(app, '夜巡人');
      const { sceneId } = await seedSave(app, '月灯镇', [boss, patrol]);

      await app.inject({
        method: 'DELETE',
        url: `/api/world/scenes/${sceneId}/presence/${boss}`,
      });

      await speak(app, sceneId, '老板走了，你呢？');
      const detail = await sceneDetail(app, sceneId);

      // 只剩夜巡人在场，接话的只能是他
      expect(detail.present.map((person: any) => person.id)).toEqual([patrol]);
      expect(detail.messages[1].speakerId).toBe(patrol);
    });
  });
});
