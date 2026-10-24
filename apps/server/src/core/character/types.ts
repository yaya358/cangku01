import type { Character, CharacterSource, CharacterSummary } from '@tavern/shared';

/**
 * 角色卡在数据库里的行，以及行 ↔ 领域对象的映射。
 *
 * 单独放一个文件的原因：SQL 里是 snake_case，API 里是 camelCase，
 * 这个映射关系必须只有一处，否则某个字段改漏了会非常难查。
 */

/** characters 表的行结构。 */
export interface CharacterRow {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
  creator_notes: string;
  tags: string;
  alternate_greetings: string;
  avatar_file: string | null;
  spec_version: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** 列表查询参数。 */
export interface CharacterListOptions {
  /** 按名字/描述模糊搜索 */
  search?: string;
  limit?: number;
  offset?: number;
}

/** 摘要正文长度上限。 */
const EXCERPT_LENGTH = 120;

/** 从长描述里取第一段能看的话，作为列表卡片文案。 */
export function excerptOf(description: string): string {
  const firstLine =
    description
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';

  if (firstLine.length <= EXCERPT_LENGTH) return firstLine;
  return `${firstLine.slice(0, EXCERPT_LENGTH)}…`;
}

/** 解析 JSON 数组字段；数据损坏时退回空数组而不是让整个列表 500。 */
function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/** 生成头像 URL；没有文件时返回 null。 */
export function avatarUrlOf(id: string, avatarFile: string | null): string | null {
  if (!avatarFile) return null;
  // 带上 updatedAt 之外的稳定路径即可，缓存靠文件名里的随机串控制
  return `/api/characters/${id}/avatar`;
}

/** 行 → 完整角色。 */
export function rowToCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    personality: row.personality,
    scenario: row.scenario,
    firstMes: row.first_mes,
    mesExample: row.mes_example,
    systemPrompt: row.system_prompt,
    postHistoryInstructions: row.post_history_instructions,
    creatorNotes: row.creator_notes,
    tags: parseStringArray(row.tags),
    alternateGreetings: parseStringArray(row.alternate_greetings),
    avatarUrl: avatarUrlOf(row.id, row.avatar_file),
    source: row.source as CharacterSource,
    specVersion: row.spec_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 行 → 列表摘要。 */
export function rowToSummary(row: CharacterRow): CharacterSummary {
  return {
    id: row.id,
    name: row.name,
    excerpt: excerptOf(row.description),
    tags: parseStringArray(row.tags),
    avatarUrl: avatarUrlOf(row.id, row.avatar_file),
    source: row.source as CharacterSource,
    hasGreeting: row.first_mes.trim().length > 0,
    updatedAt: row.updated_at,
  };
}

/** 领域字段 → 数据库列名。新增字段时这里必须同步。 */
export const FIELD_TO_COLUMN = {
  name: 'name',
  description: 'description',
  personality: 'personality',
  scenario: 'scenario',
  firstMes: 'first_mes',
  mesExample: 'mes_example',
  systemPrompt: 'system_prompt',
  postHistoryInstructions: 'post_history_instructions',
  creatorNotes: 'creator_notes',
  tags: 'tags',
  alternateGreetings: 'alternate_greetings',
} as const;

export type CharacterField = keyof typeof FIELD_TO_COLUMN;
