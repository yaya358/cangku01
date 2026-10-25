import type { CharacterInput, CharacterList, CharacterPatch } from '@tavern/shared';
import {
  APP_VERSION,
  CHARACTERS_ENDPOINT,
  CHARACTER_IMPORT_ENDPOINT,
  CharacterInputSchema,
  CharacterPatchSchema,
} from '@tavern/shared';
import { AVATAR_MAX_BYTES } from '../../core/character/avatars.js';
import { isPng } from '../../core/character/png.js';
import { CardParseError, parseCardJson, toV2Card } from '../../core/character/card.js';
import { buildCardPng, contentDisposition, safeFileName } from '../../core/character/export.js';
import { extractCardFromPng, PngError } from '../../core/character/png.js';
import type { AppInstance } from '../../types/fastify.js';
import { success } from '../envelope.js';
import { AppError } from '../errors.js';

/**
 * 角色卡接口。
 *
 * 六个入口：
 *   GET    /api/characters              列表（搜索 + 分页）
 *   GET    /api/characters/:id          详情
 *   POST   /api/characters              新建（手填）
 *   PATCH  /api/characters/:id          改一部分字段
 *   DELETE /api/characters/:id          删除（连头像一起清）
 *   POST   /api/characters/import       导入：image/png 走角色卡解析，application/json 直接读卡
 *   GET    /api/characters/:id/avatar   头像二进制
 */

/** 把 query 里的字符串转成正整数，非法值一律当没传。 */
function parseIntParam(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 把 zod 的校验错误翻译成统一信封里的 details。 */
function validationError(message: string, issues: unknown): AppError {
  return AppError.validation(message, issues);
}

function parseInput(raw: unknown): CharacterInput {
  const parsed = CharacterInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw validationError(
      '角色数据校验失败',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

function parsePatch(raw: unknown): CharacterPatch {
  const parsed = CharacterPatchSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw validationError(
      '要修改的字段校验失败',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

export function registerCharacterRoutes(app: AppInstance): void {
  app.get(CHARACTERS_ENDPOINT, async (request) => {
    const query = request.query as { search?: string; limit?: string; offset?: string };
    const page: CharacterList = app.characters().list({
      search: typeof query.search === 'string' ? query.search : undefined,
      limit: parseIntParam(query.limit),
      offset: parseIntParam(query.offset),
    });
    return success(request.id, page);
  });

  /** 导入必须在 /:id 之前声明语义上更清晰（方法不同，路由不冲突）。 */
  app.post(CHARACTER_IMPORT_ENDPOINT, { bodyLimit: AVATAR_MAX_BYTES }, async (request) => {
    const contentType = String(request.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();

    if (contentType === 'image/png') {
      const buffer = request.body;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw AppError.badRequest('PNG 内容为空');
      }

      const extracted = withCardErrors(() => extractCardFromPng(buffer));
      if (!extracted) {
        throw AppError.validation('这张 PNG 里没有角色卡数据（缺少 chara / ccv3 文本块）', {
          hint: '它可能只是一张普通头像图',
        });
      }

      const parsed = withCardErrors(() => parseCardJson(extracted.json));
      const created = app.characters().create(parsed.input, {
        source: 'png',
        specVersion: parsed.specVersion,
      });

      const fileName = app.avatars.save(created.id, buffer);
      return success(request.id, app.characters().setAvatar(created.id, fileName) ?? created);
    }

    if (contentType === 'application/json') {
      const parsed = withCardErrors(() => parseCardJson(request.body));
      const created = app.characters().create(parsed.input, {
        source: 'json',
        specVersion: parsed.specVersion,
      });
      return success(request.id, created);
    }

    throw AppError.badRequest('导入只支持 image/png（角色卡图）或 application/json（角色卡 JSON）');
  });

  app.get(`${CHARACTERS_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const character = app.characters().getById(id);
    if (!character) throw AppError.notFound(`角色不存在: ${id}`);
    return success(request.id, character);
  });

  app.get(`${CHARACTERS_ENDPOINT}/:id/avatar`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const fileName = app.characters().getAvatarFile(id);
    if (!fileName) throw AppError.notFound('该角色没有头像');

    const buffer = app.avatars.read(fileName);
    if (!buffer) throw AppError.notFound('头像文件丢失（数据库有记录但磁盘上没有）');

    return (
      reply
        .header('content-type', 'image/png')
        // 头像按角色 id 固定，短期内不会变；给个短缓存，刷新页面时不重复下载
        .header('cache-control', 'public, max-age=300')
        .send(buffer)
    );
  });

  /**
   * 上传/替换头像。
   *
   * 手动创建的角色一开始没有图，这里补一条路：直接 POST 一张 PNG。
   * 走的是和导入角色卡完全相同的存储链路（原字节落盘，不重新编码）。
   */
  app.post(
    `${CHARACTERS_ENDPOINT}/:id/avatar`,
    { bodyLimit: AVATAR_MAX_BYTES },
    async (request) => {
      const { id } = request.params as { id: string };
      const character = app.characters().getById(id);
      if (!character) throw AppError.notFound(`角色不存在: ${id}`);

      const buffer = request.body as Buffer;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw AppError.validation('请求体应为图片二进制（content-type: image/png）');
      }
      if (!isPng(buffer)) {
        throw AppError.validation('头像必须是 PNG 格式');
      }

      const fileName = app.avatars.save(character.id, buffer);
      const updated = app.characters().setAvatar(character.id, fileName);
      return success(request.id, updated ?? character);
    },
  );

  /** 导出为 V2 卡片 JSON：前端拿到后自己组装成下载文件。 */
  app.get(`${CHARACTERS_ENDPOINT}/:id/export/json`, async (request) => {
    const { id } = request.params as { id: string };
    const character = app.characters().getById(id);
    if (!character) throw AppError.notFound(`角色不存在: ${id}`);

    return success(request.id, {
      filename: safeFileName(character.name, '.json'),
      card: toV2Card(character, APP_VERSION),
    });
  });

  /** 导出为角色卡 PNG：头像 + 嵌进去的卡片数据，可直接分发或再导入。 */
  app.get(`${CHARACTERS_ENDPOINT}/:id/export/png`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const character = app.characters().getById(id);
    if (!character) throw AppError.notFound(`角色不存在: ${id}`);

    const avatarFile = app.characters().getAvatarFile(id);
    const avatar = avatarFile ? (app.avatars.read(avatarFile) ?? null) : null;
    const png = buildCardPng({ avatar, character, appVersion: APP_VERSION });

    return reply
      .header('content-type', 'image/png')
      .header('content-disposition', contentDisposition(safeFileName(character.name, '.png')))
      .send(png);
  });

  app.post(CHARACTERS_ENDPOINT, async (request) => {
    const input = parseInput(request.body);
    return success(request.id, app.characters().create(input, { source: 'manual' }));
  });

  app.patch(`${CHARACTERS_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const patch = parsePatch(request.body);
    const updated = app.characters().update(id, patch);
    if (!updated) throw AppError.notFound(`角色不存在: ${id}`);
    return success(request.id, updated);
  });

  app.delete(`${CHARACTERS_ENDPOINT}/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const existing = app.characters().getById(id);
    if (!existing) throw AppError.notFound(`角色不存在: ${id}`);

    const avatarFile = app.characters().getAvatarFile(id);
    app.characters().remove(id);
    // 先删库再删文件：反过来一旦删库失败，会留下「有记录没图」的角色
    app.avatars.remove(avatarFile);

    return success(request.id, { id, deleted: true });
  });
}

/** PNG / 卡片解析错误是「输入不对」，应返回 422 而不是 500。 */
function withCardErrors<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PngError) {
      throw AppError.validation(`PNG 解析失败：${error.message}`, { code: error.code });
    }
    if (error instanceof CardParseError) {
      throw AppError.validation(error.message, { reason: error.reason });
    }
    throw error;
  }
}
