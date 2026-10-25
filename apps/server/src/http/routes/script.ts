import {
  SCRIPT_EVENT_ENDPOINT,
  ScriptEventInputSchema,
  ScriptEventPatchSchema,
  ScriptImportSchema,
} from '@tavern/shared';
import type { ZodType } from 'zod';
import type { AppInstance } from '../../types/fastify.js';
import { success } from '../envelope.js';
import { AppError } from '../errors.js';

/**
 * 剧本事件接口。
 *
 * 挂在角色下（`/characters/:id/events`）而不是平铺：事件天然属于某个角色的小剧本，
 * 查的时候也不需要额外传 characterId。
 */
export function registerScriptRoutes(app: AppInstance): void {
  /** 列出某个角色的全部事件（按触发轮次排序）。 */
  app.get(`${SCRIPT_EVENT_ENDPOINT}/by-character/:characterId`, async (request) => {
    const { characterId } = request.params as { characterId: string };
    if (!app.characters().getById(characterId)) {
      throw AppError.notFound(`角色不存在: ${characterId}`);
    }
    return success(request.id, app.scriptEvents().listByCharacter(characterId));
  });

  /** 新建事件。 */
  app.post(`${SCRIPT_EVENT_ENDPOINT}/by-character/:characterId`, async (request) => {
    const { characterId } = request.params as { characterId: string };
    if (!app.characters().getById(characterId)) {
      throw AppError.notFound(`角色不存在: ${characterId}`);
    }

    const body = parseOrThrow(ScriptEventInputSchema, request.body, '剧本事件参数不合法');
    return success(request.id, app.scriptEvents().create(characterId, body));
  });

  /** 局部更新。 */
  app.patch(`${SCRIPT_EVENT_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(ScriptEventPatchSchema, request.body, '剧本事件参数不合法');

    const updated = app.scriptEvents().update(id, body);
    if (!updated) throw AppError.notFound(`剧本事件不存在: ${id}`);
    return success(request.id, updated);
  });

  /** 删除。 */
  app.delete(`${SCRIPT_EVENT_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    if (!app.scriptEvents().remove(id)) throw AppError.notFound(`剧本事件不存在: ${id}`);
    return success(request.id, { id, deleted: true });
  });

  /**
   * 导出整份剧本。
   *
   * 导出的东西要能「发给别人、别人导进去就能演」，
   * 所以只带剧本本身（不含角色卡与对话），并且带上 format/version 便于将来升级。
   */
  app.get(`${SCRIPT_EVENT_ENDPOINT}/by-character/:characterId/export`, async (request) => {
    const { characterId } = request.params as { characterId: string };
    const character = app.characters().getById(characterId);
    if (!character) throw AppError.notFound(`角色不存在: ${characterId}`);

    const events = app.scriptEvents().listByCharacter(characterId);
    if (events.length === 0) {
      throw AppError.validation('这个角色还没有剧本，没什么可导出的');
    }

    return success(request.id, {
      filename: `${character.name}-剧本.json`,
      bundle: {
        format: 'tavern-ai-script',
        version: 1,
        characterName: character.name,
        events: events.map((event) => ({
          atTurn: event.atTurn,
          title: event.title,
          content: event.content,
          condition: event.condition,
          isEnding: event.isEnding,
          sets: event.sets,
        })),
      },
    });
  });

  /**
   * 导入一份剧本。
   *
   * 默认「追加」而不是覆盖：导入前用户可能已经写了自己的几幕，
   * 覆盖掉太粗暴。想清空重来，先自己删。
   */
  app.post(`${SCRIPT_EVENT_ENDPOINT}/by-character/:characterId/import`, async (request) => {
    const { characterId } = request.params as { characterId: string };
    if (!app.characters().getById(characterId)) {
      throw AppError.notFound(`角色不存在: ${characterId}`);
    }

    const body = parseOrThrow(ScriptImportSchema, request.body, '剧本文件格式不对');
    const created = body.events.map((event) => app.scriptEvents().create(characterId, event));

    return success(request.id, { imported: created.length });
  });
}

/** zod 校验失败统一转 422。 */
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
