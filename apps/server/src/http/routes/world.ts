import type { ChatMessage, ChatStreamPayload } from '@tavern/shared';
import { z } from 'zod';
import type { ServerResponse } from 'node:http';
import { prepareConversationContext } from '../../core/context/index.js';
import { resolveThread } from '../../core/chat/thread.js';
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
  /** 建存档，顺带建一个默认场景（酒馆）。 */
  app.post('/api/world/saves', async (request) => {
    const body = parseOrThrow(
      z.object({
        name: z.string().min(1).max(60),
        sceneName: z.string().min(1).max(60).default('酒馆'),
        characterIds: z.array(z.string().min(1)).max(12).default([]),
        player: z
          .object({ name: z.string().max(40), role: z.string().max(200), goal: z.string().max(400) })
          .partial()
          .optional(),
      }),
      request.body,
      '存档参数不合法',
    );

    const save = app.world().createSave(body.name);
    const scene = app.world().createScene(save.id, { name: body.sceneName, closeness: 0.35 });
    body.characterIds.forEach((characterId, index) => {
      const character = app.characters().getById(characterId);
      if (!character) return;
      app.world().enter(scene.id, characterId, 1, null);
      void index;
    });

    return success(request.id, { save, scene });
  });

  /** 列存档。 */
  app.get('/api/world/saves', async (request) => {
    return success(request.id, app.world().listSaves());
  });

  /** 某存档下的场景（含在场者名字，前端直接渲染头像条）。 */
  app.get('/api/world/saves/:id/scenes', async (request) => {
    const { id } = request.params as { id: string };
    if (!app.world().getSave(id)) throw AppError.notFound(`存档不存在: ${id}`);

    const scenes = app.world().listScenes(id).map((scene) => ({
      ...scene,
      present: app
        .world()
        .present(scene.id)
        .map((entry) => {
          const character = app.characters().getById(entry.characterId);
          return character
            ? { id: character.id, name: character.name, busyWith: entry.busyWith }
            : null;
        })
        .filter((item): item is { id: string; name: string; busyWith: string | null } => !!item),
    }));

    return success(request.id, scenes);
  });

  /** 进场 / 离场。 */
  app.post('/api/world/scenes/:id/presence', async (request) => {
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

  app.delete('/api/world/scenes/:id/presence/:characterId', async (request) => {
    const { id, characterId } = request.params as { id: string; characterId: string };
    if (!app.world().getScene(id)) throw AppError.notFound(`场景不存在: ${id}`);
    app.world().leave(id, characterId, 1);
    return success(request.id, { left: characterId });
  });

  /**
   * 场景内说一句：由在场者接话。
   *
   * 谁先说：@ 了在场的人就他先说；否则按进场顺序轮转。
   * 消息仍然落进 conversations/messages（scene_id 指向场景），
   * 这样重说、分支、导出都还能用。
   */
  app.post('/api/world/scenes/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    const scene = app.world().getScene(id);
    if (!scene) throw AppError.notFound(`场景不存在: ${id}`);

    const body = parseOrThrow(
      z.object({
        content: z.string().min(1).max(20_000),
        kind: z.enum(['speak', 'act', 'think', 'narrate', 'ooc']).default('speak'),
        whisper: z.boolean().default(false),
        player: z
          .object({ name: z.string().max(40), role: z.string().max(200), goal: z.string().max(400) })
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

    const speaker =
      members.find((member) => body.content.includes(`@${member.name}`)) ??
      members[app.messages().count(id) % members.length] ??
      members[0];

    if (!speaker) throw AppError.validation('这个场景里现在没有人');

    // 场景 ↔ 会话：一个场景复用一条会话（第一次用时创建）
    const conversation =
      app.conversations().findByScene(id) ??
      app.conversations().create({
        characterId: speaker.id,
        title: scene.name,
        ...(body.player ? { player: body.player } : {}),
        sceneId: id,
      });

    const all = app.messages().listByConversation(conversation.id);
    const history: ChatMessage[] = resolveThread(all, conversation.activeLeafId)
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));

    const userMessage = app.messages().append(conversation.id, {
      role: 'user',
      content: body.content,
      kind: body.kind,
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
