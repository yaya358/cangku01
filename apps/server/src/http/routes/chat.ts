import type {
  ChatMessage,
  ChatRequestBody,
  ChatResultPayload,
  ChatStreamPayload,
  ProviderInfo,
} from '@tavern/shared';
import {
  CHAT_ENDPOINT,
  CHAT_STREAM_ENDPOINT,
  ChatRequestBodySchema,
  PROVIDERS_ENDPOINT,
} from '@tavern/shared';
import type { ServerResponse } from 'node:http';
import { prepareConversationContext } from '../../core/context/index.js';
import { describeProviders, firstProvider, listProviders } from '../../core/provider/index.js';
import type { ChatStreamEvent, ProviderAdapter } from '../../core/provider/index.js';
import type { AppInstance } from '../../types/fastify.js';
import { success } from '../envelope.js';
import { AppError, toAppError } from '../errors.js';

/**
 * 对话接口。
 *
 * 三个入口：
 *   GET  /api/providers      有哪些模型服务、是否可用
 *   POST /api/chat           一次性返回（方便 curl 与测试）
 *   POST /api/chat/stream    SSE 流式（前端「试话」面板用）
 */

/** 校验请求体，失败时把 zod 的字段级错误交给统一错误处理器。 */
function parseBody(raw: unknown) {
  const parsed = ChatRequestBodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw AppError.validation(
      '请求参数校验失败',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

/** 选 provider：指定名字就精确取，否则用注册表里优先级最高的。 */
function resolveProvider(app: AppInstance, name?: string): ProviderAdapter {
  if (name) {
    const found = app.extensions.get<ProviderAdapter>(name);
    if (!found || found.meta.kind !== 'provider') {
      const available = listProviders(app.extensions)
        .map((item) => item.meta.name)
        .join(', ');
      throw AppError.notFound(
        available.length > 0
          ? `provider 不存在: "${name}"，当前可用: ${available}`
          : `provider 不存在: "${name}"，尚未配置任何模型服务`,
      );
    }
    return found;
  }

  const fallback = firstProvider(app.extensions);
  if (!fallback) {
    throw AppError.notImplemented(
      '尚未配置模型服务：请在 config/user.yaml 的 providers 段里加一个，然后重启后端',
    );
  }
  return fallback;
}

/**
 * 服务端事件转成线上格式（前端契约）。
 *
 * 返回 null 表示「这条由路由层自己发」：适配器的 start 只带模型名，
 * 而前端需要 provider 与 traceId，所以 start 统一由路由发出。
 */
function toWireEvent(event: ChatStreamEvent): ChatStreamPayload | null {
  switch (event.type) {
    case 'start':
      return null;
    case 'delta':
    case 'usage':
    case 'done':
      return event;
    case 'error':
      return { type: 'error', ...event.error };
    default:
      return null;
  }
}

/** 写一帧 SSE。客户端已断开时 write 会抛，这里吞掉即可。 */
function writeEvent(raw: ServerResponse, payload: ChatStreamPayload): void {
  try {
    raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // 连接已断，后续循环会因 abort 自然结束
  }
}

/** 解析后的消息，以及「这轮是怎么来的」元信息。 */
interface ResolvedMessages {
  messages: ChatMessage[];
  /** 走上下文引擎时才有 */
  character?: { id: string; name: string };
  contextTokens?: number;
  worldbookHits?: number;
}

/**
 * 决定这一轮到底发给模型什么。
 *
 * 两条路径：
 *   - 传了 characterId → 走上下文引擎：角色人设 + 世界书（按关键词触发）+ 预算裁剪
 *   - 没传          → 裸对话：messages 原样发出去（试话页调试用）
 */
function resolveMessages(app: AppInstance, body: ChatRequestBody): ResolvedMessages {
  if (!body.characterId) {
    return { messages: [...body.messages] };
  }

  const character = app.characters().getById(body.characterId);
  if (!character) throw AppError.notFound(`角色不存在: ${body.characterId}`);

  const prepared = prepareConversationContext({
    character,
    entries: app.worldbook().listForCharacter(character.id),
    messages: body.messages,
    userName: body.userName,
    budget: body.budget,
  });

  return {
    messages: prepared.messages,
    character: { id: character.id, name: character.name },
    contextTokens: prepared.budget.used,
    worldbookHits: prepared.worldbook.hits.length,
  };
}

export function registerChatRoutes(app: AppInstance): void {
  app.get(PROVIDERS_ENDPOINT, async (request) => {
    const providers: ProviderInfo[] = describeProviders(app.extensions);
    return success(request.id, providers);
  });

  app.post(CHAT_ENDPOINT, async (request) => {
    const body = parseBody(request.body);
    const provider = resolveProvider(app, body.provider);
    const prepared = resolveMessages(app, body);

    const result = await provider.chat(
      {
        model: body.model ?? provider.defaultModel,
        messages: prepared.messages,
        params: body.params,
      },
      { requestId: request.id },
    );

    const payload: ChatResultPayload = {
      text: result.text,
      model: result.model,
      finishReason: result.finishReason,
      durationMs: result.durationMs,
      usage: result.usage,
      ...(prepared.character
        ? {
            character: prepared.character,
            contextTokens: prepared.contextTokens,
            worldbookHits: prepared.worldbookHits,
          }
        : {}),
    };
    return success(request.id, payload);
  });

  app.post(CHAT_STREAM_ENDPOINT, async (request, reply) => {
    // 参数与 provider 的选择必须在 hijack 之前做完：
    // 一旦接管响应，就没法再走统一的错误处理返回 JSON 了。
    const body = parseBody(request.body);
    const provider = resolveProvider(app, body.provider);
    const prepared = resolveMessages(app, body);

    const controller = new AbortController();
    /**
     * 客户端断开要挂在 **response** 的 close 上，不能挂 request。
     * Node 的 `req.on('close')` 在「请求体读完」时就会触发（POST 带 body 时几乎立刻），
     * 挂错对象会导致每次请求刚开流就被判定为「用户取消」。
     */
    const onClientClose = (): void => controller.abort();

    reply.hijack();
    const raw = reply.raw;
    raw.on('close', onClientClose);
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      // no-transform 很重要：某些反向代理会缓冲/压缩 SSE，导致前端一个字都收不到
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx 专用：关闭缓冲
      'x-accel-buffering': 'no',
    });
    raw.write(': connected\n\n');
    raw.on('error', () => controller.abort());

    // start 由路由发：带上前端需要的 provider、traceId 与上下文元信息
    writeEvent(raw, {
      type: 'start',
      traceId: request.id,
      provider: provider.meta.name,
      model: body.model ?? provider.defaultModel,
      ...(prepared.character
        ? {
            character: prepared.character,
            contextTokens: prepared.contextTokens,
            worldbookHits: prepared.worldbookHits,
          }
        : {}),
    });

    try {
      for await (const event of provider.stream(
        {
          model: body.model ?? provider.defaultModel,
          messages: prepared.messages,
          params: body.params,
        },
        { signal: controller.signal, requestId: request.id },
      )) {
        const wire = toWireEvent(event);
        if (wire) writeEvent(raw, wire);
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (error) {
      const appError = toAppError(error);
      request.log.error({ err: error, code: appError.code }, '流式对话异常');
      writeEvent(raw, {
        type: 'error',
        code: appError.code,
        message: appError.message,
        retryable: false,
      });
    } finally {
      raw.off('close', onClientClose);
      raw.end();
      request.log.info(
        {
          provider: provider.meta.name,
          model: body.model ?? provider.defaultModel,
          aborted: controller.signal.aborted,
        },
        'chat stream closed',
      );
    }
  });
}
