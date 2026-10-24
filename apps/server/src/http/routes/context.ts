import type { ContextPreviewPayload } from '@tavern/shared';
import { CONTEXT_PREVIEW_ENDPOINT, ContextPreviewRequestSchema } from '@tavern/shared';
import type { Character } from '@tavern/shared';
import { prepareConversationContext } from '../../core/context/index.js';
import type { PreparedContext } from '../../core/context/index.js';
import type { AppInstance } from '../../types/fastify.js';
import { success } from '../envelope.js';
import { AppError } from '../errors.js';

/**
 * 上下文预览接口。
 *
 * 不调模型，只回答「这一轮会发给模型什么」。做角色扮演时 prompt 组装出错
 * 是最难排查的（模型行为怪，你看不到它看到了什么），所以把组装结果连同
 * 每层 token 数一起暴露出来。
 */
export function registerContextRoutes(app: AppInstance): void {
  app.post(CONTEXT_PREVIEW_ENDPOINT, async (request) => {
    const parsed = ContextPreviewRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw AppError.validation(
        '预览参数不合法',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      );
    }

    const body = parsed.data;
    const character = app.characters().getById(body.characterId);
    if (!character) throw AppError.notFound(`角色不存在: ${body.characterId}`);

    const prepared = prepareConversationContext({
      character,
      entries: app.worldbook().listForCharacter(character.id),
      messages: body.messages,
      userName: body.userName,
      budget: body.budget,
    });

    return success(request.id, toPreviewPayload(character, prepared));
  });
}

/** 把内部结构转成对外契约（顺带算好各层占比）。 */
export function toPreviewPayload(
  character: Character,
  prepared: PreparedContext,
): ContextPreviewPayload {
  const used = Math.max(1, prepared.budget.used);

  const byKind = new Map<string, number>();
  for (const layer of prepared.layers) {
    byKind.set(layer.kind, (byKind.get(layer.kind) ?? 0) + layer.tokens);
  }

  const breakdown = [...byKind.entries()]
    .map(([kind, tokens]) => ({
      kind,
      tokens,
      ratio: Math.round((tokens / used) * 1000) / 1000,
    }))
    .sort((left, right) => right.tokens - left.tokens);

  return {
    character: { id: character.id, name: character.name },
    messages: prepared.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
    })),
    layers: prepared.layers.map((layer) => ({
      id: layer.id,
      kind: layer.kind,
      title: layer.title,
      content: layer.content,
      tokens: layer.tokens,
      priority: layer.priority,
      splittable: layer.splittable,
      ...(layer.meta ? { meta: layer.meta } : {}),
    })),
    dropped: prepared.budget.dropped.map((layer) => ({
      id: layer.id,
      kind: layer.kind,
      title: layer.title,
      content: layer.content,
      tokens: layer.tokens,
      priority: layer.priority,
      splittable: layer.splittable,
    })),
    budget: {
      contextWindow: prepared.budget.contextWindow,
      reservedForOutput: prepared.budget.reservedForOutput,
      safetyMargin: prepared.budget.safetyMargin,
      available: prepared.budget.available,
      used: prepared.budget.used,
      truncated: prepared.budget.truncated,
    },
    worldbook: prepared.worldbook.hits.map((hit) => ({
      id: hit.entry.id,
      title: hit.entry.title,
      keyword: hit.keyword,
    })),
    notes: prepared.notes,
    breakdown,
  };
}
