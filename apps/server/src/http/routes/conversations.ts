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

    return success(request.id, {
      conversation,
      messages: app.messages().listByConversation(id),
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

    // 历史（线性视图，跳过 system）
    const history: ChatMessage[] = messagesRepo
      .listByConversation(id)
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));

    // 先把用户这句写库：即使生成失败，也不会丢「我说过什么」
    const userMessage = messagesRepo.append(id, { role: 'user', content: body.content });

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
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.write(': connected\n\n');
    raw.on('error', () => controller.abort());

    writeEvent(raw, {
      type: 'start',
      traceId: request.id,
      provider: provider.meta.name,
      model,
      character: { id: character.id, name: character.name },
      contextTokens: prepared.budget.used,
      worldbookHits: prepared.worldbook.hits.length,
    });

    let text = '';
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    let finishReason: string | null = null;
    let firstTokenMs: number | null = null;
    let durationMs = 0;
    let failed = false;

    try {
      for await (const event of provider.stream(
        { model, messages: prepared.messages },
        { signal: controller.signal, requestId: request.id },
      )) {
        if (event.type === 'start') continue;

        if (event.type === 'delta') {
          text += event.text;
          writeEvent(raw, event);
          continue;
        }
        if (event.type === 'usage') {
          usage = event.usage;
          writeEvent(raw, event);
          continue;
        }
        if (event.type === 'done') {
          finishReason = event.finishReason;
          durationMs = event.durationMs;
          firstTokenMs = event.firstTokenMs;
          usage = event.usage ?? usage;
          writeEvent(raw, event);
          break;
        }
        if (event.type === 'error') {
          failed = true;
          writeEvent(raw, { type: 'error', ...event.error });
          break;
        }
      }
    } catch (error) {
      failed = true;
      const appError = toAppError(error);
      request.log.error({ err: error, code: appError.code }, '会话生成异常');
      writeEvent(raw, {
        type: 'error',
        code: appError.code,
        message: appError.message,
        retryable: false,
      });
    }

    // 落库：有内容就存（包括被取消/出错时已生成的部分，避免用户白等）
    let assistantId: string | null = null;
    if (text.length > 0) {
      const assistant = messagesRepo.append(id, {
        role: 'assistant',
        content: text,
        parentId: userMessage.id,
        model,
        provider: provider.meta.name,
        ...(usage ? { usage } : {}),
        ...(finishReason ? { finishReason } : failed ? { finishReason: 'interrupted' } : {}),
        durationMs,
        ...(firstTokenMs === null ? {} : { firstTokenMs }),
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
        chars: text.length,
        aborted: controller.signal.aborted,
        assistantId,
      },
      'chat turn finished',
    );
  });
}
