import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatRequest } from '../../core/provider/index.js';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import type { AppInstance } from '../../types/fastify.js';
import { defineProvider } from '../../testing/provider-fixture.js';
import { createTestConfig } from '../../testing/test-config.js';

const silentLogger = pino({ level: 'silent' });

interface Harness {
  app: AppInstance;
  /** 每次流式生成（角色接话）收到的请求，按顺序记录 */
  streamRequests: ChatRequest[];
  /** 每次非流式调用（好感评分 / 偷听反应） */
  chatRequests: ChatRequest[];
  /** 非流式调用分两类计数，断言时不会互相干扰 */
  reactionCalls: () => number;
  scoreCalls: () => number;
}

/** 评分提示词里独有的一句话，用来区分「这次调用是评分还是偷听反应」。 */
const SCORE_MARKER = '给玩家刚才这一轮的表现打分';

interface HarnessOptions {
  /** 覆盖 features 开关（例如关掉好感评分） */
  features?: Record<string, boolean>;
  /** 评分那一次调用返回什么（默认给合法 JSON；传别的可以测解析失败） */
  scoreReply?: string;
}

async function withApp<T>(
  run: (harness: Harness) => Promise<T>,
  options: HarnessOptions = {},
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-world-'));
  const config = createTestConfig();
  config.storage.path = path.join(dir, 'test.db');
  config.features = options.features ?? {};

  const streamRequests: ChatRequest[] = [];
  const chatRequests: ChatRequest[] = [];
  let streamCalls = 0;
  let reactionCalls = 0;
  let scoreCalls = 0;

  const provider = defineProvider({
    meta: { name: 'fake', version: '1.0.0' },
    capabilities: { streaming: true },
    defaultModel: 'fake-model',
    hasCredentials: true,
    async chat(request) {
      chatRequests.push(request);
      const system = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');

      if (system.includes(SCORE_MARKER)) {
        scoreCalls += 1;
        return {
          text: options.scoreReply ?? '{"delta": 3, "reason": "他把话说到点子上"}',
          finishReason: 'stop',
          model: 'fake-model',
          durationMs: 1,
        };
      }

      reactionCalls += 1;
      return {
        text: '他把手上的活停了半拍，没抬头。',
        finishReason: 'stop',
        model: 'fake-model',
        durationMs: 1,
      };
    },
    async *stream(request) {
      streamRequests.push(request);
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
    return await run({
      app,
      streamRequests,
      chatRequests,
      reactionCalls: () => reactionCalls,
      scoreCalls: () => scoreCalls,
    });
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 把最近一次流式请求的提示词拼成一段，方便断言「模型看到了什么」。 */
function lastStreamPrompt(streamRequests: ChatRequest[]): string {
  const request = streamRequests.at(-1);
  return request ? request.messages.map((message) => message.content).join('\n') : '';
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
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/world/scenes/${sceneId}/stream`,
    payload: { content, ...extra },
  });
  expect(response.statusCode).toBe(200);
  return parseFrames(response.body);
}

async function sceneDetail(app: AppInstance, sceneId: string): Promise<Record<string, any>> {
  const response = await app.inject({ method: 'GET', url: `/api/world/scenes/${sceneId}` });
  expect(response.statusCode).toBe(200);
  return response.json().data;
}

/** 从 SSE 事件里找某一类，按任意形状读出（断言用）。 */
function findEvent(
  frames: Record<string, unknown>[],
  type: string,
): Record<string, any> | undefined {
  return frames.find((frame) => frame.type === type) as Record<string, any> | undefined;
}

/** 编造一次偷听掷骰结果：0 = 一定被听见，0.999 = 一定没人听见。 */
function forceRandom(value: number): void {
  vi.spyOn(Math, 'random').mockReturnValue(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

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
    await withApp(async ({ app, streamRequests }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { sceneId } = await seedSave(app, '月灯镇', [boss]);

      await speak(app, sceneId, '第一句');
      await speak(app, sceneId, '第二句');

      const detail = await sceneDetail(app, sceneId);
      expect(detail.messages).toHaveLength(4);

      // 第二轮发给模型的内容里必须含第一轮的回复，否则等于每轮从零开始
      const prompt = lastStreamPrompt(streamRequests);
      expect(prompt).toContain('第1次接话');
      expect(prompt).toContain('第二句');
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

describe('低声与偷听', () => {
  /** 三人场：老板 + 夜巡人 + 猫；低声说话时前两个都可能是偷听者。 */
  async function threePeople(app: AppInstance) {
    const boss = await seedCharacter(app, '月灯老板', {
      personality: '话痨、爱打听、心软。',
      secret: '名单上最后一个人是他自己。他巡夜，是因为不敢睡。',
    });
    const patrol = await seedCharacter(app, '夜巡人', {
      personality: '寡言、克制、守信用。',
      secret: '名单上最后一个人是他自己。',
    });
    const cat = await seedCharacter(app, '猫', { personality: '傲慢、懒、好奇。' });
    const { sceneId } = await seedSave(app, '月灯镇', [boss, patrol, cat]);
    return { boss, patrol, cat, sceneId };
  }

  it('低声这句会记下来，并且提示词里写明是压低了声音', async () => {
    await withApp(async ({ app, streamRequests }) => {
      const { sceneId } = await threePeople(app);
      forceRandom(0.999);

      await speak(app, sceneId, '别声张，我问你一件事。', { whisper: true });

      const detail = await sceneDetail(app, sceneId);
      expect(detail.messages[0]).toMatchObject({ role: 'user', whisper: true });

      const prompt = lastStreamPrompt(streamRequests);
      expect(prompt).toContain('压低声音');
      expect(prompt).toContain('在场的还有');
    });
  });

  it('没人听见时给确定反馈，而不是让玩家猜', async () => {
    await withApp(async ({ app, reactionCalls }) => {
      const { sceneId } = await threePeople(app);
      forceRandom(0.999);

      const frames = await speak(app, sceneId, '那句话你查到了吗？', { whisper: true });
      const eavesdrop = findEvent(frames, 'eavesdrop');
      expect(eavesdrop).toMatchObject({ heard: false });
      expect(String(eavesdrop?.text)).toContain('没人注意到');
      // 没被听见就不该额外生成反应
      expect(reactionCalls()).toBe(0);

      // 这条反馈也留在场景里：刷新之后还能看到自己当时是安全的
      const detail = await sceneDetail(app, sceneId);
      expect(detail.messages.at(-1)).toMatchObject({ role: 'system' });
      expect(detail.messages.at(-1).content).toContain('没人注意到');
    });
  });

  it('被听见时生成偷听者的反应，并插进对话流', async () => {
    await withApp(async ({ app, reactionCalls }) => {
      const { sceneId } = await threePeople(app);
      forceRandom(0);

      // 第一句由老板接（轮转 0），听见的是留下的第一个人：夜巡人
      const frames = await speak(app, sceneId, '名单上还有谁？', { whisper: true });
      const eavesdrop = findEvent(frames, 'eavesdrop');
      expect(eavesdrop).toMatchObject({ heard: true });
      expect(eavesdrop?.listener).toMatchObject({ name: '夜巡人' });
      expect(reactionCalls()).toBe(1);

      const detail = await sceneDetail(app, sceneId);
      const reaction = detail.messages.at(-1);
      expect(reaction).toMatchObject({ role: 'assistant', eavesdrop: true });
      expect(reaction.speakerId).toBe(eavesdrop?.listener?.id);
      expect(reaction.content).toContain('停了半拍');
    });
  });

  it('偷听反应不算作「轮到他说话」，轮转照旧', async () => {
    await withApp(async ({ app }) => {
      const { boss, patrol, sceneId } = await threePeople(app);

      // 第一轮：老板接话（轮转 0）；这轮低声被听见 → 多出一条偷听反应
      forceRandom(0);
      await speak(app, sceneId, '这句只说给你听。', { whisper: true });

      // 第二句：轮转应该给下一个人（夜巡人），而不是被偷听反应顶掉
      forceRandom(0.999);
      await speak(app, sceneId, '另一个问题。');

      const detail = await sceneDetail(app, sceneId);
      const replies = detail.messages.filter(
        (message: any) => message.role === 'assistant' && !message.eavesdrop,
      );
      expect(replies.map((message: any) => message.speakerId)).toEqual([boss, patrol]);
    });
  });

  it('没听见的人不会在之后的发言里知道低声说了什么', async () => {
    await withApp(async ({ app, streamRequests }) => {
      const { cat, sceneId } = await threePeople(app);

      forceRandom(0.999);
      await speak(app, sceneId, '码头那批货有问题。', { whisper: true });

      // 下一个开口的人被指定成猫：他当时没听见，提示词里只能是占位文本
      await speak(app, sceneId, '@猫 你怎么看？');
      const prompt = lastStreamPrompt(streamRequests);
      expect(prompt).not.toContain('码头那批货有问题');
      expect(prompt).toContain('没听清');

      // 而他自己这一句是听得见的，不该被误伤
      expect(cat).toBeTruthy();
      expect(prompt).toContain('你怎么看');
    });
  });

  it('敏感内容会记成「他记住了」', async () => {
    await withApp(async ({ app, chatRequests, streamRequests }) => {
      const { sceneId } = await threePeople(app);
      forceRandom(0);

      const frames = await speak(app, sceneId, '名单上最后一个人到底是谁？', { whisper: true });
      const eavesdrop = findEvent(frames, 'eavesdrop');
      expect(eavesdrop).toMatchObject({ heard: true, sensitive: true });

      // 最后一条非流式请求就是偷听反应的提示词（评分在它之前）
      const reactionPrompt = (chatRequests.at(-1)?.messages ?? [])
        .map((message) => message.content)
        .join('\n');
      expect(reactionPrompt).toContain('名单上最后一个人是他自己');
      expect(reactionPrompt).toContain('你听见的是');

      // 下一轮任何人开口都能看到「他记住了」这条事实
      forceRandom(0.999);
      await speak(app, sceneId, '刚说到哪了？');
      const laterPrompt = lastStreamPrompt(streamRequests);
      expect(laterPrompt).toContain('听见了你压低声音说的话');
    });
  });
});

describe('私密场景', () => {
  it('把在场的人带到后巷：留下的人看见了，公共场景里他不再是「在场」', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const patrol = await seedCharacter(app, '夜巡人');
      const { sceneId } = await seedSave(app, '月灯镇', [boss, patrol]);
      await speak(app, sceneId, '先坐会儿。');

      const response = await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${sceneId}/private`,
        payload: { characterId: boss },
      });
      expect(response.statusCode).toBe(200);
      const result = response.json().data;

      expect(result.scene).toMatchObject({
        kind: 'private',
        name: '后巷',
        sourceSceneId: sceneId,
      });
      // 留下的人就是目击者
      expect(result.noticed).toEqual([{ id: patrol, name: '夜巡人' }]);

      const privateDetail = await sceneDetail(app, result.scene.id);
      expect(privateDetail.present.map((person: any) => person.id)).toEqual([boss]);

      const publicDetail = await sceneDetail(app, sceneId);
      expect(publicDetail.present.map((person: any) => person.id)).toEqual([patrol]);
      // 离开这件事写进场景日志里（system 消息，不进模型历史）
      const log = publicDetail.messages.filter((message: any) => message.role === 'system');
      expect(log.at(-1).content).toContain('你带着月灯老板离开了');
      expect(log.at(-1).content).toContain('夜巡人看见了');
    });
  });

  it('联系不上的人带不走：走了的、在忙的各有各的说法', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const patrol = await seedCharacter(app, '夜巡人');
      const { sceneId } = await seedSave(app, '月灯镇', [boss, patrol]);

      // 在忙：走不开
      await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${sceneId}/presence`,
        payload: { characterId: patrol, busyWith: '巡街' },
      });
      const busy = await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${sceneId}/private`,
        payload: { characterId: patrol },
      });
      expect(busy.statusCode).toBe(422);
      expect(busy.json().error.message).toContain('忙着');

      // 已经走了：等下次遇见
      await app.inject({ method: 'DELETE', url: `/api/world/scenes/${sceneId}/presence/${boss}` });
      const left = await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${sceneId}/private`,
        payload: { characterId: boss },
      });
      expect(left.statusCode).toBe(422);
      expect(left.json().error.message).toContain('已经走了');

      // 从没来过的人：这里没有他
      const stranger = await seedCharacter(app, '过路人');
      const absent = await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${sceneId}/private`,
        payload: { characterId: stranger },
      });
      expect(absent.statusCode).toBe(422);
      expect(absent.json().error.message).toContain('不在这里');
    });
  });

  it('私密场景里没有第三人，低声也不算被偷听', async () => {
    await withApp(async ({ app, reactionCalls }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { sceneId } = await seedSave(app, '月灯镇', [boss]);

      const created = await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${sceneId}/private`,
        payload: { characterId: boss },
      });
      const privateId = created.json().data.scene.id as string;

      const frames = await speak(app, privateId, '在这儿说话没人听得见吧？', { whisper: true });
      expect(frames.some((frame) => frame.type === 'eavesdrop')).toBe(false);
      expect(reactionCalls()).toBe(0);
    });
  });

  it('从后巷回来：人跟着一起回到酒馆，日志里留下「你们回来了」', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { sceneId } = await seedSave(app, '月灯镇', [boss]);
      await speak(app, sceneId, '走，说点别的。');

      const created = await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${sceneId}/private`,
        payload: { characterId: boss },
      });
      const privateId = created.json().data.scene.id as string;

      const back = await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${privateId}/return`,
      });
      expect(back.statusCode).toBe(200);
      expect(back.json().data.scene.id).toBe(sceneId);

      const publicDetail = await sceneDetail(app, sceneId);
      expect(publicDetail.present.map((person: any) => person.id)).toEqual([boss]);
      const log = publicDetail.messages.filter((message: any) => message.role === 'system');
      expect(log.at(-1).content).toContain('回到了');

      // 回来之后还能接着说话
      const frames = await speak(app, sceneId, '刚才说的那件事。');
      expect(frames.some((frame) => frame.type === 'saved')).toBe(true);
    });
  });

  it('公开场景没有可回的地方，私密场景不能再拉一次人', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { sceneId } = await seedSave(app, '月灯镇', [boss]);

      const badReturn = await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${sceneId}/return`,
      });
      expect(badReturn.statusCode).toBe(400);

      const created = await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${sceneId}/private`,
        payload: { characterId: boss },
      });
      const privateId = created.json().data.scene.id as string;

      const again = await app.inject({
        method: 'POST',
        url: `/api/world/scenes/${privateId}/private`,
        payload: { characterId: boss },
      });
      expect(again.statusCode).toBe(400);
      expect(again.json().error.message).toContain('已经在一个私密场景里');
    });
  });
});

describe('好感度', () => {
  it('每轮结束打一次分，并把变化写进库', async () => {
    await withApp(async ({ app, scoreCalls }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { saveId, sceneId } = await seedSave(app, '月灯镇', [boss]);

      const frames = await speak(app, sceneId, '你今天气色不太好。');
      const affinity = findEvent(frames, 'affinity');
      expect(affinity).toMatchObject({
        characterId: boss,
        delta: 3,
        value: 53,
        mood: 'neutral',
      });
      expect(scoreCalls()).toBe(1);

      const list = await app.inject({
        method: 'GET',
        url: `/api/world/saves/${saveId}/affinity`,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().data).toHaveLength(1);
      expect(list.json().data[0]).toMatchObject({
        characterId: boss,
        characterName: '月灯老板',
        value: 53,
        lastReason: '他把话说到点子上',
      });
    });
  });

  it('跨过 60 会松口：写进事实，之后的提示词带上「松了口」', async () => {
    await withApp(async ({ app, streamRequests }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { saveId, sceneId } = await seedSave(app, '月灯镇', [boss]);

      // 把好感摆到 58：这一轮 +3 就跨过 60（直接改库，省掉三轮对话）
      app.affinity().apply(saveId, boss, 8, '（用例安排）');

      const frames = await speak(app, sceneId, '我替你把话圆回来。');
      expect(findEvent(frames, 'affinity')).toMatchObject({ value: 61, mood: 'open' });

      await speak(app, sceneId, '那就说说吧。');
      const prompt = lastStreamPrompt(streamRequests);
      expect(prompt).toContain('松了口');
    });
  });

  it('跌破 20 就冷处理', async () => {
    await withApp(async ({ app, streamRequests }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { saveId, sceneId } = await seedSave(app, '月灯镇', [boss]);

      app.affinity().apply(saveId, boss, -40, '（用例安排）');
      await speak(app, sceneId, '你到底说不说？');

      const prompt = lastStreamPrompt(streamRequests);
      expect(prompt).toContain('你对他很冷');
    });
  });

  it('评分可以关掉：不再多发一次请求，也不发好感事件', async () => {
    await withApp(
      async ({ app, scoreCalls }) => {
        const boss = await seedCharacter(app, '月灯老板');
        const { sceneId } = await seedSave(app, '月灯镇', [boss]);

        const frames = await speak(app, sceneId, '来一杯。');
        expect(findEvent(frames, 'affinity')).toBeUndefined();
        expect(scoreCalls()).toBe(0);
      },
      { features: { affinityScoring: false } },
    );
  });

  it('评分解析不出来时明说「没评上分」，不假装没有变化', async () => {
    await withApp(
      async ({ app }) => {
        const boss = await seedCharacter(app, '月灯老板');
        const { saveId, sceneId } = await seedSave(app, '月灯镇', [boss]);

        const frames = await speak(app, sceneId, '来一杯。');
        const affinity = findEvent(frames, 'affinity');
        expect(affinity).toMatchObject({ failed: true, delta: 0, value: 50 });
        expect(String(affinity?.reason)).toContain('没评上分');

        // 没评上分就不该写库
        const list = await app.inject({
          method: 'GET',
          url: `/api/world/saves/${saveId}/affinity`,
        });
        expect(list.json().data).toEqual([]);
      },
      { scoreReply: '这轮我觉得还行吧' },
    );
  });
});

describe('主线与情报本', () => {
  it('第一次打开就有第一章，情报本是空的', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板');
      const { saveId } = await seedSave(app, '月灯镇', [boss]);

      const response = await app.inject({
        method: 'GET',
        url: `/api/world/saves/${saveId}/journal`,
      });
      expect(response.statusCode).toBe(200);
      const journal = response.json().data;

      expect(journal.chapter).toBe(1);
      expect(journal.quest).toMatchObject({ chapter: 1, status: 'active' });
      expect(journal.quest.title).toContain('第一章');
      expect(journal.clues).toEqual([]);
      expect(journal.progress).toMatchObject({ clues: 0, affinity: 0 });
    });
  });

  it('松口就进情报本：来源、轮次、原话都在，并推进到第二章', async () => {
    await withApp(async ({ app }) => {
      const boss = await seedCharacter(app, '月灯老板', {
        secret: '名单上最后一个人是他自己。他巡夜，是因为不敢睡。',
      });
      const { saveId, sceneId } = await seedSave(app, '月灯镇', [boss]);

      // 先把好感摆到 58：这一轮 +3 就跨过 60（松口）
      app.affinity().apply(saveId, boss, 8, '（用例安排）');

      const frames = await speak(app, sceneId, '我替你把这件事瞒下来。');
      const clue = findEvent(frames, 'clue');
      expect(clue).toMatchObject({ source: '月灯老板' });
      expect(String(clue?.content)).toContain('名单上最后一个人是他自己');
      expect(clue?.quote).toBeTruthy();

      // 第一章只需要一条情报：这一轮就过关，进第二章
      const quest = findEvent(frames, 'quest');
      expect(quest).toMatchObject({ chapter: 2, finished: false });
      expect(String(quest?.title)).toContain('第二章');

      const journal = (
        await app.inject({ method: 'GET', url: `/api/world/saves/${saveId}/journal` })
      ).json().data;
      expect(journal.chapter).toBe(2);
      expect(journal.clues).toHaveLength(1);
      expect(journal.clues[0]).toMatchObject({ source: '月灯老板', sourceTurn: 1 });
      expect(journal.quests).toHaveLength(2);
      expect(journal.quests[0]).toMatchObject({ chapter: 1, status: 'done' });
      expect(journal.progress).toMatchObject({ clues: 1, needed: 2, requiredAffinity: 60 });
    });
  });

  it('没有秘密的人松口也留不下情报，但不会报错', async () => {
    await withApp(async ({ app }) => {
      const stranger = await seedCharacter(app, '过路人', { goal: '想找个人问路。' });
      const { saveId, sceneId } = await seedSave(app, '月灯镇', [stranger]);
      app.affinity().apply(saveId, stranger, 8, '（用例安排）');

      const frames = await speak(app, sceneId, '你要去哪儿？我带你走一段。');
      expect(findEvent(frames, 'affinity')).toMatchObject({ value: 61, mood: 'open' });

      // 没有秘密就从「目的」里取一句：情报本不该因为角色没填 secret 就空着
      const clue = findEvent(frames, 'clue');
      expect(clue).toBeTruthy();
      expect(String(clue?.content)).toContain('问路');
    });
  });
});
