import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Character,
  CharacterInput,
  CharacterList,
  CharacterPatch,
  CharacterSource,
} from '@tavern/shared';
import { FIELD_TO_COLUMN, rowToCharacter, rowToSummary } from './types.js';
import type { CharacterListOptions, CharacterRow } from './types.js';

/**
 * 角色卡的持久化层（手写 SQL）。
 *
 * 为什么不用 ORM：这里的查询只有五种形态（列表 / 单查 / 插入 / 局部更新 / 删除），
 * 手写 SQL 比配置一个 ORM 更短、更可控，排查时也不会被「它到底生成了什么 SQL」困住。
 */

/** 单页上限，防止前端一次要十万条把内存打爆。 */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export interface CreateCharacterOptions {
  /** 头像文件名（已存到 avatars 目录） */
  avatarFile?: string | null;
  source?: CharacterSource;
  specVersion?: string;
}

export interface CharacterRepository {
  list(options?: CharacterListOptions): CharacterList;
  getById(id: string): Character | undefined;
  /** 头像文件名（不是 URL）；删除角色时要用它清理磁盘文件 */
  getAvatarFile(id: string): string | null;
  create(input: CharacterInput, options?: CreateCharacterOptions): Character;
  update(id: string, patch: CharacterPatch): Character | undefined;
  setAvatar(id: string, avatarFile: string | null): Character | undefined;
  remove(id: string): boolean;
  count(): number;
}

/** LIKE 里的通配符要转义，否则用户搜 "50%" 会变成匹配一切。 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

export function createCharacterRepository(db: DatabaseSync): CharacterRepository {
  const selectById = db.prepare('SELECT * FROM characters WHERE id = ?');

  function getById(id: string): Character | undefined {
    const row = selectById.get(id) as unknown as CharacterRow | undefined;
    return row ? rowToCharacter(row) : undefined;
  }

  return {
    getById,

    getAvatarFile(id: string): string | null {
      const row = db.prepare('SELECT avatar_file FROM characters WHERE id = ?').get(id) as
        { avatar_file?: string | null } | undefined;
      return row?.avatar_file ?? null;
    },

    list(options: CharacterListOptions = {}): CharacterList {
      const limit = clampLimit(options.limit);
      const offset = Math.max(0, Math.trunc(options.offset ?? 0));
      const search = options.search?.trim();

      const params: Array<string | number> = [];
      let where = '';
      if (search && search.length > 0) {
        const pattern = `%${escapeLike(search)}%`;
        where = "WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'";
        params.push(pattern, pattern);
      }

      const rows = db
        .prepare(
          `SELECT * FROM characters ${where} ORDER BY updated_at DESC, name ASC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as unknown as CharacterRow[];

      const counted = db
        .prepare(`SELECT COUNT(*) AS total FROM characters ${where}`)
        .get(...params) as { total?: number } | undefined;

      return {
        items: rows.map(rowToSummary),
        total: Number(counted?.total ?? 0),
        limit,
        offset,
      };
    },

    create(input: CharacterInput, options: CreateCharacterOptions = {}): Character {
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO characters (
          id, name, description, personality, scenario, first_mes, mes_example,
          system_prompt, post_history_instructions, creator_notes, secret, goal,
          tags, alternate_greetings, avatar_file, spec_version, source,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.name,
        input.description,
        input.personality,
        input.scenario,
        input.firstMes,
        input.mesExample,
        input.systemPrompt,
        input.postHistoryInstructions,
        input.creatorNotes,
        input.secret ?? '',
        input.goal ?? '',
        JSON.stringify(input.tags),
        JSON.stringify(input.alternateGreetings),
        options.avatarFile ?? null,
        options.specVersion ?? '2.0',
        options.source ?? 'manual',
        now,
        now,
      );

      const created = getById(id);
      if (!created) throw new Error(`角色写入后读不回来（id=${id}），数据库可能异常`);
      return created;
    },

    update(id: string, patch: CharacterPatch): Character | undefined {
      const existing = getById(id);
      if (!existing) return undefined;

      // 只更新真正传了的字段，避免把未提交的字段清空
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];

      for (const [field, column] of Object.entries(FIELD_TO_COLUMN) as Array<
        [keyof typeof FIELD_TO_COLUMN, string]
      >) {
        const next = patch[field];
        if (next === undefined) continue;

        assignments.push(`${column} = ?`);
        values.push(Array.isArray(next) ? JSON.stringify(next) : next);
      }

      if (assignments.length === 0) return existing;

      assignments.push('updated_at = ?');
      values.push(new Date().toISOString(), id);
      db.prepare(`UPDATE characters SET ${assignments.join(', ')} WHERE id = ?`).run(...values);

      return getById(id);
    },

    setAvatar(id: string, avatarFile: string | null): Character | undefined {
      const result = db
        .prepare('UPDATE characters SET avatar_file = ?, updated_at = ? WHERE id = ?')
        .run(avatarFile, new Date().toISOString(), id);
      if (Number(result.changes) === 0) return undefined;
      return getById(id);
    },

    remove(id: string): boolean {
      const result = db.prepare('DELETE FROM characters WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },

    count(): number {
      const row = db.prepare('SELECT COUNT(*) AS total FROM characters').get() as
        { total?: number } | undefined;
      return Number(row?.total ?? 0);
    },
  };
}
