import type { ChatMessage, ChatRequestBody } from '@tavern/shared';
import { prepareConversationContext } from '../core/context/index.js';
import { firstProvider, listProviders } from '../core/provider/index.js';
import type { ProviderAdapter } from '../core/provider/index.js';
import type { AppInstance } from '../types/fastify.js';
import { AppError } from './errors.js';

/**
 * 对话类路由共用的解析逻辑。
 *
 * 单独抽出来是因为 /chat 与 /conversations/:id/stream 都要「选 provider」和
 * 「决定发什么消息给模型」，两处实现必须完全一致，否则调试时会对不上。
 */

/** 选 provider：指定名字就精确取，否则用注册表里优先级最高的。 */
export function resolveProvider(app: AppInstance, name?: string): ProviderAdapter {
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

/** 解析后的消息，以及「这轮是怎么来的」元信息。 */
export interface ResolvedMessages {
  messages: ChatMessage[];
  character?: { id: string; name: string };
  contextTokens?: number;
  worldbookHits?: number;
}

/**
 * 无状态对话（/api/chat）的消息决定逻辑。
 *
 * 传了 characterId 就走上下文引擎；不传就原样透传（调试用）。
 */
export function resolveMessages(app: AppInstance, body: ChatRequestBody): ResolvedMessages {
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
