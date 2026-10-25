import type { ChatMessage, ChatStreamPayload } from '@tavern/shared';
import {
  AppendMessageSchema,
  CONVERSATIONS_ENDPOINT,
  CreateConversationSchema,
  EditMessageSchema,
  MESSAGES_ENDPOINT,
  SendMessageSchema,
  UpdateConversationSchema,
} from '@tavern/shared';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { prepareConversationContext } from '../../core/context/index.js';
import { resolveThread, summarizeBranches } from '../../core/chat/thread.js';
import type { ProviderAdapter } from '../../core/provider/index.js';
import type { AppInstance } from '../../types/fastify.js';
import { resolveProvider } from '../chat-support.js';
import { success } from '../envelope.js';
import { AppError, toAppError } from '../errors.js';

/**
 * 会话与消息接口。
 *
 * 核心是 `/conversations/:id/stream`：一次调用完成
 *   写 user 消息 → 组装上下文（角色+世界书+预算）→ 流式生成 → 写 assistant 消息
 * 也就是说前端不需要自己管"存不存"，刷新后记录一定还在。
 *
 * 其余都是薄接口：会话 CRUD、消息编辑/删除、候选回复（重说的存储层）。
 */

/** 切换候选回复的下标。 */
const SwipeSelectSchema = z.object({
  index: z.number().int().min(0).max(50),
});

/** zod 校验失败统一转成 422，并把字段级错误放进 details。 */
function parseOrThrow<T>(schema: ZodType<T>, raw: unknown, message: string): T {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw AppError.validation(
      message,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

/** 写一帧 SSE；客户端断开时 write 会抛，吞掉即可。 */
function writeEvent(raw: ServerResponse, payload: ChatStreamPayload): void {
  try {
    raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // 连接已断，循环会因 abort 自然结束
  }
}

export function registerConversationRoutes(app: AppInstance): void {
  // ---------- 会话 ----------

  app.get(CONVERSATIONS_ENDPOINT, async (request) => {
    const query = request.query as { characterId?: string };
    const list = app
      .conversations()
      .list(typeof query.characterId === 'string' ? query.characterId : undefined);
    return success(request.id, list);
  });

  app.post(CONVERSATIONS_ENDPOINT, async (request) => {
    const body = parseOrThrow(CreateConversationSchema, request.body, '新建会话参数不合法');

    const character = app.characters().getById(body.characterId);
    if (!character) throw AppError.notFound(`角色不存在: ${body.characterId}`);

    const conversation = app.conversations().create({
      characterId: body.characterId,
      title: body.title?.trim() || `${character.name}的对话`,
    });

    // 开场白直接落成第一条消息：新会话打开就有内容，不用等用户先说
    const greeting = character.firstMes.trim();
    if (greeting.length > 0) {
      const message = app.messages().append(conversation.id, {
        role: 'assistant',
        content: greeting,
      });
      app.conversations().touch(conversation.id, message.id);
    }

    return success(request.id, app.conversations().getById(conversation.id) ?? conversation);
  });

  app.get(`${CONVERSATIONS_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const conversation = app.conversations().getById(id);
    if (!conversation) throw AppError.notFound(`会话不存在: ${id}`);

    const query = request.query as { leafId?: string };
    const all = app.messages().listByConversation(id);
    const leafId =
      typeof query.leafId === 'string' && query.leafId.length > 0
        ? query.leafId
        : conversation.activeLeafId;

    return success(request.id, {
      conversation,
      // 只返回当前分支：分叉的两支不能混在一起
      messages: resolveThread(all, leafId),
      branches: summarizeBranches(all),
    });
  });

  app.patch(`${CONVERSATIONS_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(UpdateConversationSchema, request.body, '会话参数不合法');

    const updated = app.conversations().update(id, body);
    if (!updated) throw AppError.notFound(`会话不存在: ${id}`);
    return success(request.id, updated);
  });

  app.delete(`${CONVERSATIONS_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    if (!app.conversations().remove(id)) throw AppError.notFound(`会话不存在: ${id}`);
    return success(request.id, { id, deleted: true });
  });

  // ---------- 消息 ----------

  app.post(`${CONVERSATIONS_ENDPOINT}/:id/messages`, async (request) => {
    const { id } = request.params as { id: string };
    if (!app.conversations().getById(id)) throw AppError.notFound(`会话不存在: ${id}`);

    const body = parseOrThrow(AppendMessageSchema, request.body, '消息参数不合法');
    const message = app.messages().append(id, body);
    app.conversations().touch(id, message.id);

    return success(request.id, message);
  });

  app.patch(`${MESSAGES_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(EditMessageSchema, request.body, '消息内容不合法');

    const updated = app.messages().updateContent(id, body.content);
    if (!updated) throw AppError.notFound(`消息不存在: ${id}`);
    return success(request.id, updated);
  });

  app.delete(`${MESSAGES_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    if (!app.messages().remove(id)) throw AppError.notFound(`消息不存在: ${id}`);
    return success(request.id, { id, deleted: true });
  });

  /** 追加一个候选回复（重说的存储层；生成逻辑在 regenerate 接口里）。 */
  app.post(`${MESSAGES_ENDPOINT}/:id/swipe`, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(EditMessageSchema, request.body, '候选内容不合法');

    const updated = app.messages().appendSwipe(id, body.content);
    if (!updated) throw AppError.notFound(`消息不存在: ${id}`);
    return success(request.id, updated);
  });

  /** 切换候选回复。 */
  app.post(`${MESSAGES_ENDPOINT}/:id/swipe/select`, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(SwipeSelectSchema, request.body, '候选下标不合法');

    const updated = app.messages().selectSwipe(id, body.index);
    if (!updated) throw AppError.notFound(`消息不存在或下标越界: ${id}`);
    return success(request.id, updated);
  });

  // ---------- 一轮生成 ----------

  app.post(`${CONVERSATIONS_ENDPOINT}/:id/stream`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = app.conversations().getById(id);
    if (!conversation) throw AppError.notFound(`会话不存在: ${id}`);

    const body = parseOrThrow(SendMessageSchema, request.body, '消息参数不合法');
    const character = app.characters().getById(conversation.characterId);
    if (!character) throw AppError.notFound('该会话关联的角色已被删除');

    const provider = resolveProvider(app, body.provider);
    const model = body.model ?? provider.defaultModel;
    const conversationsRepo = app.conversations();
    const messagesRepo = app.messages();

    const all = messagesRepo.listByConversation(id);

    /**
     * 接在哪条消息之后：
     *   - 传了 parentId → 从那条消息分叉（原来那一支保留，形成新分支）
     *   - 没传         → 接在当前叶子后面（正常聊天）
     */
    const parentId = body.parentId ?? conversation.activeLeafId;
    if (parentId) {
      const parent = all.find((message) => message.id === parentId);
      if (!parent) throw AppError.notFound(`要接续的消息不存在: ${parentId}`);
    }

    // 历史 = 从根到 parent 的那条路径（跳过 system）；分叉时自然只带一条支线
    const history: ChatMessage[] = resolveThread(all, parentId)
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));

    // 先把用户这句写库：即使生成失败，也不会丢「我说过什么」
    const userMessage = messagesRepo.append(id, {
      role: 'user',
      content: body.content,
      ...(parentId ? { parentId } : {}),
    });

    const prepared = prepareConversationContext({
      character,
      entries: app.worldbook().listForCharacter(character.id),
      messages: [...history, { role: 'user', content: body.content }],
      userName: body.userName,
    });

    const controller = new AbortController();
    /** 断开要挂在 response 上：request 的 close 在读完 body 时就触发。 */
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
        character: { id: character.id, name: character.name },
        contextTokens: prepared.budget.used,
        worldbookHits: prepared.worldbook.hits.length,
      },
      onError: (error) => {
        request.log.error({ err: error }, '会话生成异常');
      },
    });

    // 落库：有内容就存（包括被取消/出错时已生成的部分，避免用户白等）
    let assistantId: string | null = null;
    if (result.text.length > 0) {
      const assistant = messagesRepo.append(id, {
        role: 'assistant',
        content: result.text,
        parentId: userMessage.id,
        model,
        provider: provider.meta.name,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.finishReason
          ? { finishReason: result.finishReason }
          : result.failed
            ? { finishReason: 'interrupted' }
            : {}),
        durationMs: result.durationMs,
        ...(result.firstTokenMs === null ? {} : { firstTokenMs: result.firstTokenMs }),
      });
      assistantId = assistant.id;
      conversationsRepo.touch(id, assistant.id);
      writeEvent(raw, {
        type: 'saved',
        userMessageId: userMessage.id,
        assistantMessageId: assistant.id,
      });
    } else {
      conversationsRepo.touch(id, userMessage.id);
    }

    raw.off('close', onClientClose);
    raw.end();

    request.log.info(
      {
        conversationId: id,
        provider: provider.meta.name,
        model,
        chars: result.text.length,
        aborted: result.aborted,
        assistantId,
      },
      'chat turn finished',
    );
  });

  // ---------- 重说 ----------

  /**
   * 让模型重新生成这条助手回复。
   *
   * 关键点：历史要**截到这条消息之前**，否则模型会看到自己刚才那版，
   * 生成出来往往只是换个说法复读。生成完追加成一个新候选并切过去。
   */
  app.post(`${MESSAGES_ENDPOINT}/:id/regenerate`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = app.messages().getById(id);
    if (!target) throw AppError.notFound(`消息不存在: ${id}`);
    if (target.role !== 'assistant') throw AppError.badRequest('只能对助手的回复重说');

    const conversation = app.conversations().getById(target.conversationId);
    if (!conversation) throw AppError.notFound('该消息所属会话已不存在');

    const character = app.characters().getById(conversation.characterId);
    if (!character) throw AppError.notFound('该会话关联的角色已被删除');

    const messagesRepo = app.messages();
    const all = messagesRepo.listByConversation(target.conversationId);
    const position = all.findIndex((message) => message.id === id);

    const before = all
      .slice(0, Math.max(0, position))
      .filter((message) => message.role !== 'system');

    const lastUserIndex = before.map((message) => message.role).lastIndexOf('user');
    if (lastUserIndex < 0) {
      throw AppError.badRequest('这条回复之前没有用户发言，无法重说');
    }

    const userInput = before[lastUserIndex]?.content ?? '';
    const historyBefore = before
      .slice(0, lastUserIndex)
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));

    const provider = resolveProvider(app, undefined);
    const model = provider.defaultModel;

    const prepared = prepareConversationContext({
      character,
      entries: app.worldbook().listForCharacter(character.id),
      messages: [...historyBefore, { role: 'user', content: userInput }],
    });

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
        character: { id: character.id, name: character.name },
        contextTokens: prepared.budget.used,
        worldbookHits: prepared.worldbook.hits.length,
      },
      onError: (error) => {
        request.log.error({ err: error }, '重说生成异常');
      },
    });

    if (result.text.length > 0) {
      // appendSwipe 会：把旧正文补成第 0 个候选 → 追加新文本 → 切到新候选
      const updated = messagesRepo.appendSwipe(id, result.text);
      if (updated) {
        // 元信息换成这一版的，界面上的耗时/用量才不会停在上一版
        messagesRepo.updateMeta(id, {
          model,
          provider: provider.meta.name,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.finishReason ? { finishReason: result.finishReason } : {}),
          durationMs: result.durationMs,
          ...(result.firstTokenMs === null ? {} : { firstTokenMs: result.firstTokenMs }),
        });

        writeEvent(raw, {
          type: 'swiped',
          messageId: id,
          swipeIndex: updated.swipeIndex,
          total: updated.swipes.length,
        });
      }
      app.conversations().touch(conversation.id, id);
    }

    raw.off('close', onClientClose);
    raw.end();

    request.log.info(
      {
        conversationId: conversation.id,
        messageId: id,
        chars: result.text.length,
        aborted: result.aborted,
      },
      'regenerate finished',
    );
  });
}

/** 流式结果聚合。 */
interface PipeResult {
  text: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string | null;
  durationMs: number;
  firstTokenMs: number | null;
  failed: boolean;
  aborted: boolean;
}

interface PipeOptions {
  raw: ServerResponse;
  signal: AbortSignal;
  provider: ProviderAdapter;
  model: string;
  messages: ChatMessage[];
  traceId: string;
  meta?: {
    character?: { id: string; name: string };
    contextTokens?: number;
    worldbookHits?: number;
  };
  onError?: (error: unknown) => void;
}

/**
 * 把 provider 的流搬进 SSE 响应。
 *
 * 抽出来是因为「一轮生成」和「重说」的流式部分是同一套：
 * 写头 → 写 start → 转发 delta/usage/done → 出错写 error。
 * 差异只在最后怎么落库，那部分留给各自的调用方。
 */
async function pipeProviderStream(options: PipeOptions): Promise<PipeResult> {
  const { raw, signal, provider, model, messages, traceId, meta } = options;

  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    // no-transform + x-accel-buffering:no 防止反代缓冲，否则前端一个字都收不到
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.write(': connected\n\n');
  raw.on('error', () => {
    // 连接坏了就尽快收尾，别继续占用上游
  });

  writeEvent(raw, {
    type: 'start',
    traceId,
    provider: provider.meta.name,
    model,
    ...(meta?.character ? { character: meta.character } : {}),
    ...(meta?.contextTokens === undefined ? {} : { contextTokens: meta.contextTokens }),
    ...(meta?.worldbookHits === undefined ? {} : { worldbookHits: meta.worldbookHits }),
  });

  const result: PipeResult = {
    text: '',
    finishReason: null,
    durationMs: 0,
    firstTokenMs: null,
    failed: false,
    aborted: signal.aborted,
  };

  try {
    for await (const event of provider.stream(
      { model, messages },
      { signal, requestId: traceId },
    )) {
      if (event.type === 'start') continue;

      if (event.type === 'delta') {
        result.text += event.text;
        writeEvent(raw, event);
        continue;
      }
      if (event.type === 'usage') {
        result.usage = event.usage;
        writeEvent(raw, event);
        continue;
      }
      if (event.type === 'done') {
        result.finishReason = event.finishReason;
        result.durationMs = event.durationMs;
        result.firstTokenMs = event.firstTokenMs;
        result.usage = event.usage ?? result.usage;
        result.aborted = signal.aborted;
        writeEvent(raw, event);
        break;
      }
      if (event.type === 'error') {
        result.failed = true;
        writeEvent(raw, { type: 'error', ...event.error });
        break;
      }
    }
  } catch (error) {
    result.failed = true;
    options.onError?.(error);
    const appError = toAppError(error);
    writeEvent(raw, {
      type: 'error',
      code: appError.code,
      message: appError.message,
      retryable: false,
    });
  }

  return result;
}
