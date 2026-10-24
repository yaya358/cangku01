import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { rowToRecord } from './types.js';
import type { WorldbookInput, WorldbookPatch, WorldbookRecord, WorldbookRow } from './types.js';

/**
 * 世界书仓储（手写 SQL）。
 *
 * 查询形态只有四种：按角色取（含全局）、单查、插入、局部更新、删除。
 * 「按角色取」的语义要特别注意：characterId 为 NULL 的是全局条目，
 * 任何角色都应该命中，所以条件是 `character_id IS NULL OR character_id = ?`。
 */

export interface WorldbookRepository {
  /** 取某个角色可用的条目（全局 + 该角色自己的） */
  listForCharacter: (characterId: string | null) => WorldbookRecord[];
  /** 后台管理用：全部条目 */
  listAll: () => WorldbookRecord[];
  getById: (id: string) => WorldbookRecord | undefined;
  create: (input: WorldbookInput) => WorldbookRecord;
  update: (id: string, patch: WorldbookPatch) => WorldbookRecord | undefined;
  remove: (id: string) => boolean;
  count: () => number;
}

/** 列名映射，更新时只碰传了的字段。 */
const FIELD_TO_COLUMN: Record<keyof WorldbookInput, string> = {
  title: 'title',
  keys: 'keys',
  secondaryKeys: 'secondary_keys',
  content: 'content',
  characterId: 'character_id',
  constant: 'constant',
  caseSensitive: 'case_sensitive',
  priority: 'priority',
  enabled: 'enabled',
};

/** 数组字段要序列化成 JSON，布尔要转 0/1（SQLite 没有布尔类型）。 */
function toColumnValue(field: keyof WorldbookInput, value: unknown): string | number | null {
  if (field === 'keys' || field === 'secondaryKeys') {
    return JSON.stringify(value ?? []);
  }
  if (field === 'constant' || field === 'caseSensitive' || field === 'enabled') {
    return value ? 1 : 0;
  }
  if (field === 'characterId') {
    return (value as string | null | undefined) ?? null;
  }
  if (field === 'priority') {
    return Number(value ?? 0);
  }
  return String(value ?? '');
}

export function createWorldbookRepository(db: DatabaseSync): WorldbookRepository {
  const selectById = db.prepare('SELECT * FROM worldbook_entries WHERE id = ?');
  const selectAll = db.prepare(
    'SELECT * FROM worldbook_entries ORDER BY priority DESC, created_at ASC',
  );
  const selectForCharacter = db.prepare(
    'SELECT * FROM worldbook_entries WHERE character_id IS NULL OR character_id = ? ORDER BY priority DESC, created_at ASC',
  );

  function getById(id: string): WorldbookRecord | undefined {
    const row = selectById.get(id) as unknown as WorldbookRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  return {
    listForCharacter(characterId: string | null): WorldbookRecord[] {
      const rows = selectForCharacter.all(characterId) as unknown as WorldbookRow[];
      return rows.map(rowToRecord);
    },

    listAll(): WorldbookRecord[] {
      const rows = selectAll.all() as unknown as WorldbookRow[];
      return rows.map(rowToRecord);
    },

    getById,

    create(input: WorldbookInput): WorldbookRecord {
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO worldbook_entries (
          id, character_id, title, keys, secondary_keys, content,
          enabled, constant, case_sensitive, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.characterId ?? null,
        input.title,
        JSON.stringify(input.keys),
        JSON.stringify(input.secondaryKeys ?? []),
        input.content,
        input.enabled === false ? 0 : 1,
        input.constant ? 1 : 0,
        input.caseSensitive ? 1 : 0,
        input.priority ?? 0,
        now,
        now,
      );

      const created = getById(id);
      if (!created) throw new Error(`世界书条目写入后读不回来（id=${id}）`);
      return created;
    },

    update(id: string, patch: WorldbookPatch): WorldbookRecord | undefined {
      const existing = getById(id);
      if (!existing) return undefined;

      const assignments: string[] = [];
      const values: Array<string | number | null> = [];

      for (const [field, column] of Object.entries(FIELD_TO_COLUMN) as Array<
        [keyof WorldbookInput, string]
      >) {
        const value = patch[field];
        if (value === undefined) continue;
        assignments.push(`${column} = ?`);
        values.push(toColumnValue(field, value));
      }

      if (assignments.length === 0) return existing;

      assignments.push('updated_at = ?');
      values.push(new Date().toISOString(), id);
      db.prepare(`UPDATE worldbook_entries SET ${assignments.join(', ')} WHERE id = ?`).run(
        ...values,
      );

      return getById(id);
    },

    remove(id: string): boolean {
      const result = db.prepare('DELETE FROM worldbook_entries WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },

    count(): number {
      const row = db.prepare('SELECT COUNT(*) AS total FROM worldbook_entries').get() as
        { total?: number } | undefined;
      return Number(row?.total ?? 0);
    },
  };
}
