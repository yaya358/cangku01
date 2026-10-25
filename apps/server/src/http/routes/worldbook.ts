import { WORLDBOOK_ENDPOINT, WorldbookInputSchema, WorldbookPatchSchema } from '@tavern/shared';
import type { ZodType } from 'zod';
import type { AppInstance } from '../../types/fastify.js';
import { success } from '../envelope.js';
import { AppError } from '../errors.js';

/**
 * 世界书管理接口。
 *
 * 为什么需要它：触发引擎（core/worldbook/scan.ts）早就写好了，
 * 但没有入口就只能靠脚本往库里塞条目 —— 用户自己加不了设定，
 * 这个功能等于「只有开发者能用」。
 *
 * 查询语义：传 characterId 时返回「全局条目 + 该角色专属条目」，
 * 因为对话里两者都会生效，管理时也应该一起看到。
 */
export function registerWorldbookRoutes(app: AppInstance): void {
  const repo = (): ReturnType<AppInstance['worldbook']> => app.worldbook();

  /** 列表。 */
  app.get(WORLDBOOK_ENDPOINT, async (request) => {
    const query = request.query as { characterId?: string };
    const characterId =
      typeof query.characterId === 'string' && query.characterId.length > 0
        ? query.characterId
        : null;

    const entries = characterId ? repo().listForCharacter(characterId) : repo().listAll();
    return success(request.id, entries);
  });

  /** 新建。 */
  app.post(WORLDBOOK_ENDPOINT, async (request) => {
    const body = parseOrThrow(WorldbookInputSchema, request.body, '世界书条目参数不合法');

    const characterId = body.characterId ?? null;
    if (characterId && !app.characters().getById(characterId)) {
      throw AppError.notFound(`角色不存在: ${characterId}`);
    }

    const created = repo().create({
      title: body.title,
      keys: body.keys,
      secondaryKeys: body.secondaryKeys,
      content: body.content,
      characterId,
      constant: body.constant,
      caseSensitive: body.caseSensitive,
      priority: body.priority,
      enabled: body.enabled,
    });

    return success(request.id, created);
  });

  /** 局部更新。 */
  app.patch(`${WORLDBOOK_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(WorldbookPatchSchema, request.body, '世界书条目参数不合法');

    if (body.characterId && !app.characters().getById(body.characterId)) {
      throw AppError.notFound(`角色不存在: ${body.characterId}`);
    }

    const updated = repo().update(id, body);
    if (!updated) throw AppError.notFound(`世界书条目不存在: ${id}`);
    return success(request.id, updated);
  });

  /** 删除。 */
  app.delete(`${WORLDBOOK_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    if (!repo().remove(id)) throw AppError.notFound(`世界书条目不存在: ${id}`);
    return success(request.id, { id, deleted: true });
  });
}

/** zod 校验失败统一转 422，并给出字段级错误。 */
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
