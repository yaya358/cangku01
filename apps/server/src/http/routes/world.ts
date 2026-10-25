import type {
  Character,
  ChatMessage,
  ChatStreamPayload,
  Message,
  ScenePresent,
} from '@tavern/shared';
import {
  CreateSaveSchema,
  WORLD_ADVANCE_BUDGET,
  DEFAULT_THEME_ID,
  themeById,
  WORLD_SAVES_ENDPOINT,
  WORLD_SCENES_ENDPOINT,
  WORLD_SNAPSHOTS_ENDPOINT,
} from '@tavern/shared';
import { affinityMood } from '@tavern/shared';
import { z } from 'zod';
import type { ServerResponse } from 'node:http';
import { prepareConversationContext } from '../../core/context/index.js';
import { resolveThread } from '../../core/chat/thread.js';
import {
  buildReactionPrompt,
  isCurious,
  isSensitive,
  rollEavesdrop,
} from '../../core/world/eavesdrop.js';
import type { EavesdropListener } from '../../core/world/eavesdrop.js';
import { describeReachability } from '../../core/world/repository.js';
import { firstSentence } from '../../core/world/journal.js';
import { buildAdvancePrompt, fallbackAdvance } from '../../core/world/advance.js';
import {
  buildChapterPrompt,
  buildOpeningPrompt,
  cleanOpening,
  fallbackChapterBeat,
  fallbackOpening,
} from '../../core/world/opening.js';
import { buildScoringPrompt, parseScore, SCORE_FAILED_REASON } from '../../core/world/scoring.js';
import { contentForSpeaker, whisperAudience } from '../../core/world/whisper.js';
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
 *
 * 第 3 步在这套地基上加了两件事，都是「信息有代价」的具体形态：
 *   - 私密场景：把人带到后巷，外人听不到，但离开会被看见
 *   - 低声与偷听：不换地方、压低声音说，同场的人有概率听见并当场作出反应
 */

/** 写一帧 SSE（与 conversations.ts 里的实现一致）。 */
function writeEvent(raw: ServerResponse, payload: ChatStreamPayload): void {
  try {
    raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // 连接已断
  }
}

/** 私密场景默认的安静程度：后巷比酒馆安静，低声说话更容易被听清。 */
const PRIVATE_SCENE_CLOSENESS = 0.75;

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

  /** 当前是第几轮：这个场景里玩家一共说过几句。 */
  function sceneTurn(conversationId: string | null): number {
    if (!conversationId) return 1;
    const spoken = app
      .messages()
      .listByConversation(conversationId)
      .filter((message) => message.role === 'user').length;
    return spoken + 1;
  }

  /**
   * 这个存档里「出现过的人」，按场景与进场顺序排。
   *
   * 主线现在按人写（一章指着一个人），所以得先知道有哪些人可写；
   * 从没进过场的人不算 —— 世界是有边界的。
   */
  function castOf(saveId: string): { id: string; name: string }[] {
    const seen = new Set<string>();
    const cast: { id: string; name: string }[] = [];
    for (const scene of app.world().listScenes(saveId)) {
      for (const person of describePresent(scene.id)) {
        if (seen.has(person.id)) continue;
        seen.add(person.id);
        cast.push({ id: person.id, name: person.name });
      }
    }
    return cast;
  }

  /** 主线判定要的两个数：焦点角色的好感 + 全存档最高好感（没有焦点时兜底）。 */
  function questValues(saveId: string): { focusAffinity: number; maxAffinity: number } {
    const quest = app.journal().activeQuest(saveId);
    const maxAffinity = app
      .affinity()
      .list(saveId)
      .reduce((max, item) => Math.max(max, item.value), 0);
    const focusAffinity = quest?.focusCharacterId
      ? app.affinity().get(saveId, quest.focusCharacterId).value
      : maxAffinity;
    return { focusAffinity, maxAffinity };
  }

  /**
   * 往场景日志里写一条「不是谁说的话，而是发生了一件事」。
   *
   * 用的是 system 消息：组装上下文时它会被过滤掉（不污染模型的历史），
   * 但刷新页面后仍然在，玩家回头能看到「谁看见了我们离开」。
   */
  function appendSceneLine(conversationId: string | null, content: string): void {
    if (!conversationId) return;
    const conversation = app.conversations().getById(conversationId);
    if (!conversation) return;
    const message = app.messages().append(conversationId, {
      role: 'system',
      content,
      ...(conversation.activeLeafId ? { parentId: conversation.activeLeafId } : {}),
    });
    app.conversations().touch(conversationId, message.id);
  }

  /** 建存档，顺带建一个默认场景（酒馆）。 */
  app.post(WORLD_SAVES_ENDPOINT, async (request) => {
    const body = parseOrThrow(CreateSaveSchema, request.body, '存档参数不合法');
    const theme = themeById(body.theme ?? DEFAULT_THEME_ID);

    const save = app.world().createSave(body.name, theme.id);
    const scene = app.world().createScene(save.id, {
      name: body.sceneName ?? theme.sceneName,
      closeness: theme.closeness,
    });

    /**
     * 带 theme = 走世界包：场景名、在场的人、三章谜题都从包里取。
     * 包里的人按名字找，缺的现建一个 —— 同一题材开第二个存档不会把人建两遍。
     */
    if (body.theme) {
      const known = new Map(
        app
          .characters()
          .list({ limit: 500 })
          .items.map((item) => [item.name, item.id]),
      );

      for (const member of theme.cast) {
        let characterId = known.get(member.name);
        if (!characterId) {
          characterId = app.characters().create({
            name: member.name,
            description: member.excerpt,
            personality: member.personality,
            scenario: member.scenario,
            firstMes: member.firstMes,
            mesExample: '',
            systemPrompt: '',
            postHistoryInstructions: '',
            creatorNotes: '',
            secret: member.secret,
            goal: member.goal,
            tags: member.tags,
            alternateGreetings: [],
          }).id;
          known.set(member.name, characterId);
        }
        app.world().enter(scene.id, characterId, 1, null);
      }

      return success(request.id, { save, scene });
    }

    for (const characterId of body.characterIds ?? []) {
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

  /**
   * 重新开始一个存档。
   *
   * 语义是「同一本故事，从头再演一遍」：名字、玩家、原来酒馆里那几个人都留着，
   * 章节 / 情报 / 好感 / 对话全部清空。实现上直接删掉旧存档再按原样建一个新的 ——
   * 逐表清空容易漏（消息、事实、好感、在场各自成表），删干净再建更不容易留下脏数据。
   */
  app.post(`${WORLD_SAVES_ENDPOINT}/:id/restart`, async (request) => {
    const { id } = request.params as { id: string };
    const save = app.world().getSave(id);
    if (!save) throw AppError.notFound(`存档不存在: ${id}`);

    // 记下原来那个公开场景的名字和在场的人，重开后原样摆回去
    const scenes = app.world().listScenes(id);
    const tavern = scenes.find((scene) => scene.kind === 'public') ?? scenes[0];
    const cast = tavern
      ? app
          .world()
          .present(tavern.id)
          .map((entry) => entry.characterId)
          .filter((characterId) => !!app.characters().getById(characterId))
      : [];

    app.world().deleteSave(id);

    const created = app.world().createSave(save.name);
    const scene = app.world().createScene(created.id, {
      name: tavern?.name ?? '酒馆',
      closeness: tavern?.closeness ?? 0.35,
    });
    for (const characterId of cast) app.world().enter(scene.id, characterId, 1, null);

    return success(request.id, { save: created, scene });
  });

  /**
   * 手动存档：给这本故事拍一张快照。
   *
   * 快照和「多个存档」是两件事：存档分的是世界，快照分的是同一本世界里的时间点。
   */
  app.post(`${WORLD_SAVES_ENDPOINT}/:id/snapshots`, async (request) => {
    const { id } = request.params as { id: string };
    const save = app.world().getSave(id);
    if (!save) throw AppError.notFound(`存档不存在: ${id}`);

    const body = parseOrThrow(
      z.object({ label: z.string().max(60).optional() }),
      request.body ?? {},
      '快照参数不合法',
    );
    const clock = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const label = body.label?.trim() || `第 ${save.chapter} 章 · ${clock}`;

    return success(request.id, app.snapshots().create(id, label));
  });

  /** 快照列表（新的在前）。 */
  app.get(`${WORLD_SAVES_ENDPOINT}/:id/snapshots`, async (request) => {
    const { id } = request.params as { id: string };
    if (!app.world().getSave(id)) throw AppError.notFound(`存档不存在: ${id}`);
    return success(request.id, app.snapshots().list(id));
  });

  /** 读档：回到快照那一刻（当前进度会被覆盖）。 */
  app.post(`${WORLD_SNAPSHOTS_ENDPOINT}/:snapshotId/restore`, async (request) => {
    const { snapshotId } = request.params as { snapshotId: string };
    const restored = app.snapshots().restore(snapshotId);
    if (!restored) throw AppError.notFound(`快照不存在: ${snapshotId}`);
    return success(request.id, restored);
  });

  /** 删掉一张快照。 */
  app.delete(`${WORLD_SNAPSHOTS_ENDPOINT}/:snapshotId`, async (request) => {
    const { snapshotId } = request.params as { snapshotId: string };
    if (!app.snapshots().remove(snapshotId)) throw AppError.notFound(`快照不存在: ${snapshotId}`);
    return success(request.id, { deleted: true, snapshotId });
  });

  /** 删掉一个存档。删了就真没了 —— 对话、场景、主线、好感一起走。 */
  app.delete(`${WORLD_SAVES_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    if (!app.world().getSave(id)) throw AppError.notFound(`存档不存在: ${id}`);
    app.world().deleteSave(id);
    return success(request.id, { deleted: true, saveId: id });
  });

  /**
   * 全世界的场景列表（"对话"页的入口）。
   *
   * 带上是哪个存档、此刻谁在、有几句、最后一句是什么 —— 迁移过来的旧对话
   * 现在也是场景，得让它们在这张表里找得到，否则老内容等于被藏起来了。
   */
  app.get(WORLD_SCENES_ENDPOINT, async (request) => {
    const scenes = [];
    for (const save of app.world().listSaves()) {
      for (const scene of app.world().listScenes(save.id)) {
        const conversation = app.conversations().findByScene(scene.id);
        const messages = conversation ? app.messages().listByConversation(conversation.id) : [];
        const present = describePresent(scene.id);
        const last = messages.at(-1);

        scenes.push({
          ...scene,
          saveName: save.name,
          presentCount: present.length,
          presentNames: present.map((person) => person.name),
          messageCount: messages.length,
          preview: (last?.content ?? '').replace(/\s+/g, ' ').slice(0, 60),
          updatedAt: conversation?.updatedAt ?? scene.updatedAt,
        });
      }
    }

    // 最近有过动静的场景排前面：它不是收藏夹，是「这几天你在哪儿」
    scenes.sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
    return success(request.id, scenes);
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
   * 这个存档里所有人对你的好感（界面的好感条 + 第 5 步的侧栏都用它）。
   *
   * 只列有记录的人：没打过照面的人不该出现在列表里 —— 世界是有边界的。
   */
  app.get(`${WORLD_SAVES_ENDPOINT}/:id/affinity`, async (request) => {
    const { id } = request.params as { id: string };
    if (!app.world().getSave(id)) throw AppError.notFound(`存档不存在: ${id}`);
    return success(request.id, app.affinity().list(id));
  });

  /**
   * 侧栏：主线进度 + 情报本 + 好感，一次给全。
   *
   * 顺手补一次「第一章」：已经有存档是在没有主线的时候建的，
   * 别给玩家留一个空侧栏。
   */
  app.get(`${WORLD_SAVES_ENDPOINT}/:id/journal`, async (request) => {
    const { id } = request.params as { id: string };
    const save = app.world().getSave(id);
    if (!save) throw AppError.notFound(`存档不存在: ${id}`);

    const journal = app.journal();
    // 按在场的人现编主线：一章指着一个人，玩家才知道该去找谁；谜面按题材来
    journal.ensureMainline(id, castOf(id), save.theme);

    return success(request.id, {
      saveId: id,
      chapter: journal.chapterOf(id),
      quest: journal.activeQuest(id) ?? null,
      quests: journal.listQuests(id),
      clues: journal.listClues(id),
      progress: journal.progress(id, questValues(id)),
      advance: journal.advances(id, WORLD_ADVANCE_BUDGET),
    });
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

  /**
   * 「下一步」：主角先不说话，让在场的人自己推一下局面。
   *
   * 两个约束：
   * 1. 每章只有 WORLD_ADVANCE_BUDGET 次 —— 推得到过程，推不到结局；
   * 2. 提示词里写死「不能回答本章的问题」—— 答案只能靠把话说对换来。
   * 这样它就是「不知道问什么时的台阶」，而不是一路点到底的快捷方式。
   */
  app.post(`${WORLD_SCENES_ENDPOINT}/:id/next`, async (request) => {
    const { id } = request.params as { id: string };
    const scene = app.world().getScene(id);
    if (!scene) throw AppError.notFound(`场景不存在: ${id}`);

    const present = describePresent(id);
    if (present.length === 0) throw AppError.validation('这个场景里现在没有人');

    const save = app.world().getSave(scene.saveId);
    app.journal().ensureMainline(scene.saveId, castOf(scene.saveId), save?.theme);
    const quest = app.journal().activeQuest(scene.saveId);
    const budget = app.journal().advances(scene.saveId, WORLD_ADVANCE_BUDGET);
    if (budget.remaining <= 0) {
      throw AppError.validation('这一章的世界已经走过两次了，接下来该你自己开口。');
    }

    const conversation =
      app.conversations().findByScene(id) ??
      app.conversations().create({
        characterId: present[0]!.id,
        title: scene.name,
        sceneId: id,
      });

    // 让「这一章最该被追问的人」出头；他不在场就交给第一个在场的人
    const focus = quest?.focusCharacterName;
    const speaker =
      present.find((person) => person.name === focus) ??
      present[Math.floor(Math.random() * present.length)] ??
      present[0]!;

    const input = {
      sceneName: scene.name,
      kind: scene.kind,
      question: quest?.question ?? '',
      chapterTitle: quest?.title ?? '这一幕',
      focusName: focus ?? null,
      present: present.map((person) => person.name),
      speaker: speaker.name,
      time: budget.used + 1,
      budget: WORLD_ADVANCE_BUDGET,
    };

    let text = '';
    try {
      const provider = resolveProvider(app);
      const generated = await provider.chat(
        {
          model: provider.defaultModel,
          messages: buildAdvancePrompt(input),
          params: { temperature: 0.9 },
        },
        { requestId: request.id },
      );
      text = cleanOpening(generated.text);
    } catch (error) {
      request.log.warn({ err: error }, '「下一步」生成失败，使用兜底');
    }
    if (text.length === 0) text = fallbackAdvance(input);

    const message = app.messages().append(conversation.id, {
      role: 'assistant',
      content: text,
      kind: 'speak',
      speakerId: speaker.id,
      ...(conversation.activeLeafId ? { parentId: conversation.activeLeafId } : {}),
    });
    app.conversations().touch(conversation.id, message.id);
    app.scriptEvents().recordFact(conversation.id, `advance:${message.id}`, `刚才：${text}`);

    const remaining = app.journal().consumeAdvance(scene.saveId, WORLD_ADVANCE_BUDGET);

    return success(request.id, {
      message: {
        id: message.id,
        speakerId: speaker.id,
        speakerName: speaker.name,
        content: text,
        createdAt: message.createdAt,
      },
      remaining,
      budget: WORLD_ADVANCE_BUDGET,
    });
  });

  /**
   * 开场 beat：第一次走进这个场景时，让世界先说一句。
   *
   * 幂等：场景里已经有消息了就直接返回 alreadyStarted —— 刷新页面不该又演一遍。
   * 生成失败也落一条兜底文案：场景必须「响一下」，否则玩家又面对一片空白。
   */
  app.post(`${WORLD_SCENES_ENDPOINT}/:id/opening`, async (request) => {
    const { id } = request.params as { id: string };
    const scene = app.world().getScene(id);
    if (!scene) throw AppError.notFound(`场景不存在: ${id}`);

    const existing = app.conversations().findByScene(id);
    if (existing && app.messages().listByConversation(existing.id).length > 0) {
      return success(request.id, { alreadyStarted: true, beat: null });
    }

    const present = describePresent(id);
    const members = present
      .map((person) => app.characters().getById(person.id))
      .filter((item): item is NonNullable<typeof item> => !!item);

    if (members.length === 0) {
      // 没人的场景不编开场：那会变成一段自说自话
      return success(request.id, { alreadyStarted: false, beat: null });
    }

    const conversation =
      existing ??
      app.conversations().create({
        characterId: members[0]!.id,
        title: scene.name,
        sceneId: id,
      });

    const quest = app.journal().activeQuest(scene.saveId);
    const input = {
      sceneName: scene.name,
      kind: scene.kind,
      present: present.map((person) => ({ name: person.name, busyWith: person.busyWith })),
      focusName: quest?.focusCharacterName ?? null,
      chapter: quest?.chapter,
      playerName: conversation.player.name || undefined,
    };

    let text = '';
    let source: 'model' | 'fallback' = 'fallback';
    try {
      const provider = resolveProvider(app);
      const generated = await provider.chat(
        {
          model: provider.defaultModel,
          messages: buildOpeningPrompt(input),
          params: { temperature: 0.9 },
        },
        { requestId: request.id },
      );
      text = cleanOpening(generated.text);
      if (text.length > 0) source = 'model';
    } catch (error) {
      request.log.warn({ err: error }, '开场生成失败，使用兜底');
    }
    if (text.length === 0) text = fallbackOpening(input);

    // 落成 system + narrate + beat：界面按「开场」块渲染，组装上下文时会被过滤，
    // 所以另外记一条 fact，让第一句回复知道刚进门时发生了什么。
    const message = app.messages().append(conversation.id, {
      role: 'system',
      content: text,
      kind: 'narrate',
      beat: 'opening',
    });
    app.conversations().touch(conversation.id, message.id);
    app.scriptEvents().recordFact(conversation.id, 'opening', `你刚进门时：${text}`);

    return success(request.id, {
      alreadyStarted: false,
      beat: { messageId: message.id, text, source },
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
    app.world().leave(id, characterId, sceneTurn(app.conversations().findByScene(id)?.id ?? null));
    return success(request.id, { left: characterId });
  });

  /**
   * 把在场的人带到私密场景（后巷 / 账房）。
   *
   * 三条硬规则写在这里而不是前端：
   *   1. 联系不上就带不走（不在场、已经走了、手上正忙着，各给各的理由）
   *   2. 离开公共场景会被看见 —— 谁还在场谁就是目击者，写进场景日志
   *   3. 私密场景记得自己是从哪出去的，回来时才有路
   */
  app.post(`${WORLD_SCENES_ENDPOINT}/:id/private`, async (request) => {
    const { id } = request.params as { id: string };
    const scene = app.world().getScene(id);
    if (!scene) throw AppError.notFound(`场景不存在: ${id}`);
    if (scene.kind === 'private') {
      throw AppError.badRequest('已经在一个私密场景里了 —— 先回到原来的地方，再从那儿把人叫走。');
    }

    const body = parseOrThrow(
      z.object({
        characterId: z.string().min(1),
        name: z.string().min(1).max(40).optional(),
        closeness: z.number().min(0).max(1).optional(),
      }),
      request.body,
      '私聊参数不合法',
    );

    const character = app.characters().getById(body.characterId);
    if (!character) throw AppError.notFound(`角色不存在: ${body.characterId}`);

    const reachability = app.world().reachability(id, character.id);
    if (reachability === 'absent') throw AppError.validation(`${character.name}不在这里。`);
    if (reachability === 'left') {
      throw AppError.validation(`${character.name}已经走了 —— 得等下次遇见。`);
    }
    if (reachability === 'busy') {
      throw AppError.validation(`${character.name}手上正忙着，这会儿走不开。`);
    }

    const conversation = app.conversations().findByScene(id);
    const turn = sceneTurn(conversation?.id ?? null);
    const privateScene = app.world().createScene(scene.saveId, {
      name: body.name ?? '后巷',
      kind: 'private',
      closeness: body.closeness ?? PRIVATE_SCENE_CLOSENESS,
      sourceSceneId: scene.id,
    });
    app.world().enter(privateScene.id, character.id, turn);
    app.world().leave(id, character.id, turn, `跟你去了${privateScene.name}`);

    // 判定「谁看见了」要在人走之后算：留下的才是目击者
    const noticed = describePresent(id).map((person) => ({ id: person.id, name: person.name }));
    const seenText =
      noticed.length > 0
        ? `你带着${character.name}离开了${scene.name} —— ${noticed.map((p) => p.name).join('、')}看见了。`
        : `你带着${character.name}离开了${scene.name} —— 没人注意。`;
    appendSceneLine(conversation?.id ?? null, seenText);
    if (conversation) {
      app.scriptEvents().recordFact(conversation.id, `scene-leave:${privateScene.id}`, seenText);
    }

    return success(request.id, { scene: privateScene, noticed });
  });

  /**
   * 从私密场景回到原来那个公开场景，把人也带回去。
   *
   * 不做「随时传送」：这一步是玩家主动结束私聊。回去之后人仍然在场，
   * 但「你们刚从后巷回来」会留在场景日志里，之后可以被人提起。
   */
  app.post(`${WORLD_SCENES_ENDPOINT}/:id/return`, async (request) => {
    const { id } = request.params as { id: string };
    const scene = app.world().getScene(id);
    if (!scene) throw AppError.notFound(`场景不存在: ${id}`);
    if (scene.kind !== 'private' || !scene.sourceSceneId) {
      throw AppError.badRequest('这不是私密场景，没有可回的地方。');
    }

    const source = app.world().getScene(scene.sourceSceneId);
    if (!source) throw AppError.notFound('原来那个场景已经不在了。');

    const conversation = app.conversations().findByScene(source.id);
    const turn = sceneTurn(conversation?.id ?? null);

    const companions: Character[] = [];
    for (const entry of app.world().present(id)) {
      const character = app.characters().getById(entry.characterId);
      if (!character) continue;
      companions.push(character);
      app.world().leave(id, character.id, turn, `回到了${source.name}`);
      app.world().enter(source.id, character.id, turn);
    }

    if (conversation) {
      const names = companions.map((character) => character.name).join('、');
      const line =
        names.length > 0 ? `你和${names}回到了${source.name}。` : `你回到了${source.name}。`;
      appendSceneLine(conversation.id, line);
      app.scriptEvents().recordFact(conversation.id, `scene-return:${scene.id}`, line);
    }

    return success(request.id, { scene: source });
  });

  /**
   * 场景内说一句：由在场者接话。
   *
   * 谁先说：@ 了在场的人就他先说；否则按「已经开口过的次数」轮转 ——
   * 每轮会落两条消息（你 + 他），按消息总数取模会让同一个人一直说，
   * 所以计数只数助手消息，且不把偷听反应算作「轮到他说话」。
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
    /** 这一轮是第几轮：用户消息数 + 1（情报本要记「第几轮听到的」） */
    const turnNumber = all.filter((message) => message.role === 'user').length + 1;
    const spokenTurns = all.filter(
      (message) => message.role === 'assistant' && !message.eavesdrop,
    ).length;

    const speaker =
      members.find((member) => body.content.includes(`@${member.name}`)) ??
      members[spokenTurns % members.length] ??
      members[0]!;

    const thread: Message[] = resolveThread(all, conversation.activeLeafId).filter(
      (message) => message.role !== 'system',
    );

    /**
     * 历史按「这个人知道什么」裁剪。
     *
     * 低声说的话只有正主和听见的人知道：否则压低声音毫无意义 ——
     * 没听见的人照样能在下一轮引用原话。
     */
    const audience = whisperAudience(thread);
    const history: ChatMessage[] = thread.map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: contentForSpeaker(message, speaker.id, audience),
    }));

    // 接在当前叶子后面：不接的话每轮都会各自成一条根链，翻看时只剩最后一句
    const userMessage = app.messages().append(conversation.id, {
      role: 'user',
      content: body.content,
      kind: body.kind,
      whisper: body.whisper,
      ...(conversation.activeLeafId ? { parentId: conversation.activeLeafId } : {}),
    });

    const others = present
      .filter((entry) => entry.characterId !== speaker.id)
      .map((entry) => {
        const character = app.characters().getById(entry.characterId);
        if (!character) return null;
        return {
          character,
          busyWith: entry.busyWith,
          busy: Boolean(entry.busyWith),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const prepared = prepareConversationContext({
      character: speaker,
      entries: app.worldbook().listForCharacter(speaker.id),
      messages: [...history, { role: 'user', content: body.content }],
      userInputKind: body.kind,
      whisper: body.whisper,
      scene: {
        name: scene.name,
        kind: scene.kind,
        others: others.map((other) => ({
          name: other.character.name,
          busyWith: other.busyWith,
        })),
      },
      userName: conversation.player.name || undefined,
      player: conversation.player,
      facts: app.scriptEvents().facts(conversation.id),
      // 他对你的态度会影响语气：这条数据不传下去，好感就只是个画的进度条
      affinity: { value: app.affinity().get(scene.saveId, speaker.id).value },
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

    let assistantId: string | null = null;
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
      assistantId = assistant.id;
      app.conversations().touch(conversation.id, assistant.id);
      writeEvent(raw, {
        type: 'saved',
        userMessageId: userMessage.id,
        assistantMessageId: assistant.id,
      });
    } else {
      app.conversations().touch(conversation.id, userMessage.id);
    }

    /**
     * 给这一轮打分（好感度）。
     *
     * 为什么单独一次请求：在角色台词里塞「（好感 +3）」会毁掉表演；
     * 让同一个模型换旁白视角看「刚才这一轮」，才评得准、也才说得出口。
     *
     * 三条边界：可关闭（features.affinityScoring）、失败不阻塞主回复（已经落库了）、
     * 解析不出来就明说「没评上分」，不假装这一轮没有变化。
     */
    const scoringEnabled = app.config.features['affinityScoring'] !== false;
    if (assistantId && scoringEnabled) {
      const before = app.affinity().get(scene.saveId, speaker.id);
      let score: { delta: number; reason: string } | null = null;

      try {
        const scored = await provider.chat(
          {
            model,
            messages: buildScoringPrompt({
              character: speaker,
              userName: conversation.player.name || '对方',
              playerLine: body.content,
              reply: result.text,
            }),
            params: { temperature: 0.4 },
          },
          { signal: controller.signal, requestId: request.id },
        );
        score = parseScore(scored.text);
      } catch (error) {
        request.log.warn({ err: error }, '好感评分失败');
      }

      if (score) {
        const applied = app.affinity().apply(scene.saveId, speaker.id, score.delta, score.reason);

        // 阈值点只记一次：跨过去就写进事实，之后模型会记得「他已经松口了」
        for (const key of applied.crossed) {
          const fact =
            key === 'affinity:open'
              ? `${speaker.name}已经对你松了口 —— 他愿意多说一点了。`
              : `${speaker.name}开始冷处理 —— 他不再主动往下说了。`;
          app.scriptEvents().recordFact(conversation.id, key, fact);
        }

        writeEvent(raw, {
          type: 'affinity',
          characterId: speaker.id,
          name: speaker.name,
          value: applied.affinity.value,
          delta: score.delta,
          reason: score.reason,
          mood: affinityMood(applied.affinity.value),
        });

        /**
         * 「松口」不是一句提示，而是**给东西**：他藏着的那件事，现在进了你的情报本。
         *
         * 这也是好感度与情报本之间唯一的连接点 —— 没有它，两条数值各转各的，
         * 玩家感受不到「关系变好换来了什么」。
         */
        if (applied.crossed.includes('affinity:open')) {
          const intel = firstSentence(speaker.secret ?? '') || firstSentence(speaker.goal ?? '');
          if (intel.length > 0) {
            const clue = app.journal().addClue({
              saveId: scene.saveId,
              content: intel,
              source: speaker.name,
              sourceTurn: turnNumber,
              quote: result.text.slice(0, 200),
            });
            if (clue) {
              writeEvent(raw, {
                type: 'clue',
                clueId: clue.id,
                content: clue.content,
                source: clue.source,
                sourceTurn: clue.sourceTurn,
                quote: clue.quote,
              });
            }
          }
        }
      } else {
        writeEvent(raw, {
          type: 'affinity',
          characterId: speaker.id,
          name: speaker.name,
          value: before.value,
          delta: 0,
          reason: SCORE_FAILED_REASON,
          mood: affinityMood(before.value),
          failed: true,
        });
      }
    }

    /**
     * 主线推进：情报够了、焦点角色也愿意说真话了，这一章就算过去。
     *
     * 每轮都查一次而不是只在「拿到情报」时查：好感与情报是两个条件，
     * 可能这一轮才凑齐，漏查一次玩家就得多说一句废话。
     */
    // 先把主线补上：没打开过侧栏的存档也得能推进
    app
      .journal()
      .ensureMainline(scene.saveId, castOf(scene.saveId), app.world().getSave(scene.saveId)?.theme);
    const advancedChapter = app.journal().advance(scene.saveId, questValues(scene.saveId));
    if (advancedChapter.advanced) {
      writeEvent(raw, {
        type: 'quest',
        chapter: advancedChapter.chapter,
        title: advancedChapter.next?.title ?? null,
        goal: advancedChapter.next?.goal ?? null,
        finished: advancedChapter.next === null,
      });

      /**
       * 新一章开场：由世界插一段「局面」进当前场景。
       *
       * 只发一句「进入第二章」是没有用的 —— 玩家要的是**这一章该盯住什么**：
       * 一件跟谜题有关的实物、一个露出破绽的人。这段旁白也要记进事实，
       * 下一句回复才知道桌上多了一张纸。
       */
      if (advancedChapter.next) {
        const next = advancedChapter.next;
        const beatInput = {
          sceneName: scene.name,
          kind: scene.kind,
          present: present.map((person) => ({
            name: app.characters().getById(person.characterId)?.name ?? '某人',
            busyWith: person.busyWith,
          })),
          chapter: next.chapter,
          title: next.title,
          question: next.question,
          focusName: next.focusCharacterName,
        };

        let beatText = '';
        try {
          const provider = resolveProvider(app);
          const generated = await provider.chat(
            {
              model: provider.defaultModel,
              messages: buildChapterPrompt(beatInput),
              params: { temperature: 0.85 },
            },
            { requestId: request.id },
          );
          beatText = cleanOpening(generated.text);
        } catch (error) {
          request.log.warn({ err: error }, '章节局面生成失败，使用兜底');
        }
        if (beatText.length === 0) beatText = fallbackChapterBeat(beatInput);

        const beatMessage = app.messages().append(conversation.id, {
          role: 'system',
          content: beatText,
          kind: 'narrate',
          beat: 'chapter',
          ...(conversation.activeLeafId ? { parentId: conversation.activeLeafId } : {}),
        });
        app.conversations().touch(conversation.id, beatMessage.id);
        app
          .scriptEvents()
          .recordFact(
            conversation.id,
            `chapter:${beatMessage.id}`,
            `现在这一章是《${next.title}》，要问出来的事：${next.question}。刚才的局面：${beatText}`,
          );
      }
    }

    /**
     * 低声 + 有第三者在场：判定有没有被听见。
     *
     * 没听见也要给确定反馈 —— 玩家得知道自己安不安全，否则低声就是个摆设。
     * 听见了则生成一句反应插进对话流（不是弹窗），并记进这个场景的「认知」，
     * 之后这个人再开口时是知道这件事的。
     */
    if (assistantId && body.whisper && scene.kind === 'public' && others.length > 0) {
      const spokenTo = conversation.player.name || '那个人';
      const decision = rollEavesdrop({
        whisper: true,
        closeness: scene.closeness,
        listeners: others.map((other): EavesdropListener => ({
          id: other.character.id,
          name: other.character.name,
          curious: isCurious(other.character),
          busy: other.busy,
        })),
      });

      const heard = decision.heard;
      const listener = heard
        ? others.find((other) => other.character.id === heard.listener.id)
        : undefined;

      if (heard && listener) {
        const sensitive = isSensitive(listener.character.secret ?? '', body.content);
        let reaction = '';
        try {
          const generated = await provider.chat(
            {
              model,
              messages: buildReactionPrompt({
                listener: listener.character,
                heardText: body.content,
                sensitive,
                speakerName: spokenTo,
              }),
              /**
               * 故意不设 maxTokens：这个上游会先写一段推理再给正文，
               * 上限给紧（试过 120）时推理就把额度吃光，正文是空的。
               * 长度靠提示词里的「不超过 40 字」约束，而不是靠截断。
               */
              params: { temperature: 0.9 },
            },
            { signal: controller.signal, requestId: request.id },
          );
          reaction = generated.text.trim();
        } catch (error) {
          // 反应生成失败不该让整轮作废：世界继续转，退化成一句确定发生的事
          request.log.warn({ err: error }, '偷听反应生成失败，使用兜底');
        }
        if (reaction.length === 0) {
          reaction = `${listener.character.name}朝这边看了一眼，没说话。`;
        }

        const reactionMessage = app.messages().append(conversation.id, {
          role: 'assistant',
          content: reaction,
          parentId: assistantId,
          speakerId: listener.character.id,
          eavesdrop: true,
          model,
          provider: provider.meta.name,
        });
        app.conversations().touch(conversation.id, reactionMessage.id);
        app
          .scriptEvents()
          .recordFact(
            conversation.id,
            `eavesdrop:${reactionMessage.id}`,
            `${listener.character.name}听见了你压低声音说的话：「${body.content.slice(0, 120)}」` +
              (sensitive ? '——这话碰到了他藏着的事，他记住了。' : ''),
          );

        writeEvent(raw, {
          type: 'eavesdrop',
          heard: true,
          listener: { id: listener.character.id, name: listener.character.name },
          messageId: reactionMessage.id,
          text: reaction,
          sensitive,
        });
      } else {
        const text = '没人注意到你压低了声音。';
        const noticeMessage = app.messages().append(conversation.id, {
          role: 'system',
          content: text,
          parentId: assistantId,
        });
        app.conversations().touch(conversation.id, noticeMessage.id);
        writeEvent(raw, { type: 'eavesdrop', heard: false, text });
      }
    }

    raw.off('close', onClientClose);
    raw.end();
  });
}
