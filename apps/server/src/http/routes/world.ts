import type { ChatMessage, ChatStreamPayload, ScenePresent } from '@tavern/shared';
import { CreateSaveSchema, WORLD_SAVES_ENDPOINT, WORLD_SCENES_ENDPOINT } from '@tavern/shared';
import { z } from 'zod';
import type { ServerResponse } from 'node:http';
import { prepareConversationContext } from '../../core/context/index.js';
import { resolveThread } from '../../core/chat/thread.js';
import { describeReachability } from '../../core/world/repository.js';
import type { AppInstance } from '../../types/fastify.js';
import { resolveProvider } from '../chat-support.js';
import { success } from '../envelope.js';
import { AppError } from '../errors.js';
import { parseOrThrow, pipeProviderStream } from './conversations.js';

/**
 * 世界接口：存档 → 场景 → 在场者 → 场景内对话。
 *
 * 与旧「按角色开会话」的区别：说话的地方是**场景**，能接话的人由在场者决定。
 * 不在场的人不会开口，@ 他也没用 —— 世界才有"人走了"这回事。
 */
/** 写一帧 SSE（与 conversations.ts 里的实现一致）。 */
function writeEvent(raw: ServerResponse, payload: ChatStreamPayload): void {
  try {
    raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // 连接已断
  }
}

export function registerWorldRoutes(app: AppInstance): void {
  /**
   * 在场者 + 给玩家看的那句话。
   *
   * 「能不能联系上」的判定只写在这里：前端拿到的就是结论，
   * 不用自己拼「在场但忙」这种状态组合，措辞也只有一个地方要改。
   */
  function describePresent(sceneId: string): ScenePresent[] {
    return app
      .world()
      .present(sceneId)
      .map((entry) => {
        const character = app.characters().getById(entry.characterId);
        if (!character) return null;
        const reachability = app.world().reachability(sceneId, character.id);
        return {
          id: character.id,
          name: character.name,
          busyWith: entry.busyWith,
          reachability,
          hint: describeReachability(reachability, character.name),
        };
      })
      .filter((item): item is ScenePresent => item !== null);
  }

  /** 建存档，顺带建一个默认场景（酒馆）。 */
  app.post(WORLD_SAVES_ENDPOINT, async (request) => {
    const body = parseOrThrow(CreateSaveSchema, request.body, '存档参数不合法');
    const sceneName = body.sceneName ?? '酒馆';
    const characterIds = body.characterIds ?? [];

    const save = app.world().createSave(body.name);
    const scene = app.world().createScene(save.id, { name: sceneName, closeness: 0.35 });
    for (const characterId of characterIds) {
      const character = app.characters().getById(characterId);
      if (!character) continue;
      app.world().enter(scene.id, characterId, 1, null);
    }

    return success(request.id, { save, scene });
  });

  /** 列存档。 */
  app.get(WORLD_SAVES_ENDPOINT, async (request) => {
    return success(request.id, app.world().listSaves());
  });

  /** 某存档下的场景（含在场者名字，前端直接渲染头像条）。 */
  app.get(`${WORLD_SAVES_ENDPOINT}/:id/scenes`, async (request) => {
    const { id } = request.params as { id: string };
    if (!app.world().getSave(id)) throw AppError.notFound(`存档不存在: ${id}`);

    const scenes = app
      .world()
      .listScenes(id)
      .map((scene) => ({
        ...scene,
        present: describePresent(scene.id).map((person) => ({
          id: person.id,
          name: person.name,
          busyWith: person.busyWith,
        })),
      }));

    return success(request.id, scenes);
  });

  /**
   * 场景详情：顶部头像条、中间消息流都要一次拿到。
   *
   * conversationId 为 null = 这个场景还没有人开过口；
   * cast 是「名字对照表」，说话的人可能已经走了，名字仍然要显示得出来。
   */
  app.get(`${WORLD_SCENES_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const scene = app.world().getScene(id);
    if (!scene) throw AppError.notFound(`场景不存在: ${id}`);

    const present = describePresent(id);
    const conversation = app.conversations().findByScene(id);
    const messages = conversation
      ? resolveThread(app.messages().listByConversation(conversation.id), conversation.activeLeafId)
      : [];

    const castIds = new Set(present.map((person) => person.id));
    for (const message of messages) {
      if (message.speakerId) castIds.add(message.speakerId);
    }
    const cast = [...castIds].map((characterId) => ({
      id: characterId,
      name: app.characters().getById(characterId)?.name ?? '某人',
    }));

    return success(request.id, {
      scene,
      present,
      cast,
      conversationId: conversation?.id ?? null,
      messages,
    });
  });

  /** 进场 / 离场。 */
  app.post(`${WORLD_SCENES_ENDPOINT}/:id/presence`, async (request) => {
    const { id } = request.params as { id: string };
    if (!app.world().getScene(id)) throw AppError.notFound(`场景不存在: ${id}`);

    const body = parseOrThrow(
      z.object({
        characterId: z.string().min(1),
        turn: z.number().int().min(1).default(1),
        busyWith: z.string().max(80).nullable().optional(),
      }),
      request.body,
      '在场参数不合法',
    );

    if (!app.characters().getById(body.characterId)) {
      throw AppError.notFound(`角色不存在: ${body.characterId}`);
    }
    app.world().enter(id, body.characterId, body.turn, body.busyWith ?? null);
    return success(request.id, { entered: body.characterId });
  });

  app.delete(`${WORLD_SCENES_ENDPOINT}/:id/presence/:characterId`, async (request) => {
    const { id, characterId } = request.params as { id: string; characterId: string };
    if (!app.world().getScene(id)) throw AppError.notFound(`场景不存在: ${id}`);
    app.world().leave(id, characterId, 1);
    return success(request.id, { left: characterId });
  });

  /**
   * 场景内说一句：由在场者接话。
   *
   * 谁先说：@ 了在场的人就他先说；否则按「已经开口过的次数」轮转 ——
   * 每轮会落两条消息（你 + 他），按消息总数取模会让同一个人一直说，
   * 所以计数只数助手消息。
   * 消息仍然落进 conversations/messages（scene_id 指向场景），
   * 这样重说、分支、导出都还能用。
   */
  app.post(`${WORLD_SCENES_ENDPOINT}/:id/stream`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const scene = app.world().getScene(id);
    if (!scene) throw AppError.notFound(`场景不存在: ${id}`);

    const body = parseOrThrow(
      z.object({
        content: z.string().min(1).max(20_000),
        kind: z.enum(['speak', 'act', 'think', 'narrate', 'ooc']).default('speak'),
        whisper: z.boolean().default(false),
        player: z
          .object({
            name: z.string().max(40),
            role: z.string().max(200),
            goal: z.string().max(400),
          })
          .partial()
          .optional(),
      }),
      request.body,
      '消息参数不合法',
    );

    const present = app.world().present(id);
    if (present.length === 0) throw AppError.validation('这个场景里现在没有人');

    const members = present
      .map((entry) => app.characters().getById(entry.characterId))
      .filter((item): item is NonNullable<typeof item> => !!item);

    if (members.length === 0) throw AppError.validation('这个场景里现在没有人');

    // 场景 ↔ 会话：一个场景复用一条会话（第一次开口时创建）
    const conversation =
      app.conversations().findByScene(id) ??
      app.conversations().create({
        characterId: members[0]!.id,
        title: scene.name,
        ...(body.player ? { player: body.player } : {}),
        sceneId: id,
      });

    const all = app.messages().listByConversation(conversation.id);
    const spokenTurns = all.filter((message) => message.role === 'assistant').length;

    const speaker =
      members.find((member) => body.content.includes(`@${member.name}`)) ??
      members[spokenTurns % members.length] ??
      members[0]!;

    const history: ChatMessage[] = resolveThread(all, conversation.activeLeafId)
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));

    // 接在当前叶子后面：不接的话每轮都会各自成一条根链，翻看时只剩最后一句
    const userMessage = app.messages().append(conversation.id, {
      role: 'user',
      content: body.content,
      kind: body.kind,
      ...(conversation.activeLeafId ? { parentId: conversation.activeLeafId } : {}),
    });

    const prepared = prepareConversationContext({
      character: speaker,
      entries: app.worldbook().listForCharacter(speaker.id),
      messages: [...history, { role: 'user', content: body.content }],
      userInputKind: body.kind,
      userName: conversation.player.name || undefined,
      player: conversation.player,
      facts: app.scriptEvents().facts(conversation.id),
    });

    const provider = resolveProvider(app);
    const model = provider.defaultModel;
    const controller = new AbortController();
    const onClientClose = (): void => controller.abort();

    reply.hijack();
    const raw = reply.raw;
    raw.on('close', onClientClose);

    const result = await pipeProviderStream({
      raw,
      signal: controller.signal,
      provider,
      model,
      messages: prepared.messages,
      traceId: request.id,
      meta: {
        character: { id: speaker.id, name: speaker.name },
        contextTokens: prepared.budget.used,
        worldbookHits: prepared.worldbook.hits.length,
      },
      onError: (error) => request.log.error({ err: error }, '场景生成异常'),
    });

    if (result.text.length > 0) {
      const assistant = app.messages().append(conversation.id, {
        role: 'assistant',
        content: result.text,
        parentId: userMessage.id,
        speakerId: speaker.id,
        model,
        provider: provider.meta.name,
        ...(result.usage ? { usage: result.usage } : {}),
        durationMs: result.durationMs,
        ...(result.firstTokenMs === null ? {} : { firstTokenMs: result.firstTokenMs }),
      });
      app.conversations().touch(conversation.id, assistant.id);
      writeEvent(raw, {
        type: 'saved',
        userMessageId: userMessage.id,
        assistantMessageId: assistant.id,
      });
    } else {
      app.conversations().touch(conversation.id, userMessage.id);
    }

    raw.off('close', onClientClose);
    raw.end();
  });
}
