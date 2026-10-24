import type { WorldbookEntry } from './scan.js';

/**
 * 世界书条目的持久化表示。
 *
 * 领域对象（WorldbookEntry）只关心「触发」需要的字段；
 * 这里补上归属与时间戳。characterId 为 null 表示全局设定（所有角色共享）。
 */
export interface WorldbookRecord extends WorldbookEntry {
  characterId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 修改时接收的字段。 */
export interface WorldbookInput {
  title: string;
  keys: readonly string[];
  secondaryKeys?: readonly string[];
  content: string;
  /** 归属角色；null / 不传 = 全局 */
  characterId?: string | null;
  constant?: boolean;
  caseSensitive?: boolean;
  priority?: number;
  enabled?: boolean;
}

/** 局部更新：所有字段可选。 */
export type WorldbookPatch = Partial<WorldbookInput>;

/** 数据库行结构（snake_case）。 */
export interface WorldbookRow {
  id: string;
  character_id: string | null;
  title: string;
  keys: string;
  secondary_keys: string;
  content: string;
  enabled: number;
  constant: number;
  case_sensitive: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

/** 解析 JSON 字符串数组；坏数据退回空数组而不是让整个列表 500。 */
export function parseKeys(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

/** 行 → 领域对象。 */
export function rowToRecord(row: WorldbookRow): WorldbookRecord {
  return {
    id: row.id,
    characterId: row.character_id,
    title: row.title,
    keys: parseKeys(row.keys),
    secondaryKeys: parseKeys(row.secondary_keys),
    content: row.content,
    enabled: row.enabled === 1,
    constant: row.constant === 1,
    caseSensitive: row.case_sensitive === 1,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
