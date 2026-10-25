import type { DatabaseSync } from 'node:sqlite';
import {
  AFFINITY_COLD,
  AFFINITY_INITIAL,
  AFFINITY_MAX,
  AFFINITY_MIN,
  AFFINITY_OPEN,
  affinityMood,
} from '@tavern/shared';
import type { Affinity } from '@tavern/shared';

/**
 * 好感度仓储。
 *
 * 一条记录 = 「某个存档里，某个人对你的态度」。读的时候如果还没有记录，
 * 返回初始值而不是先写一行空数据 —— 没打过照面的人不该在库里占位置。
 *
 * 数值只在 apply() 里变，且永远夹在 0~100：好感是个尺子，不是计数器，
 * 冲过头之后所有阈值都失去意义。
 */

interface AffinityRow {
  save_id: string;
  character_id: string;
  value: number;
  last_reason: string;
  unlocked: string;
  updated_at: string;
}

/** 阈值点：跨过去就记一笔，之后不再重复触发。 */
const THRESHOLD_KEYS: { key: string; crossed: (value: number) => boolean }[] = [
  { key: 'affinity:open', crossed: (value) => value >= AFFINITY_OPEN },
  { key: 'affinity:cold', crossed: (value) => value <= AFFINITY_COLD },
];

export interface AffinityRepository {
  /** 读一个人对你的态度；没有记录时返回初始值（不写库） */
  get: (saveId: string, characterId: string) => Affinity;
  /** 整个存档的好感（界面侧栏用） */
  list: (saveId: string) => Affinity[];
  /**
   * 加减分并记下原因。
   *
   * 返回更新后的好感，以及这一轮**刚刚**跨过的阈值点（已写进 unlocked）。
   * 没有跨过任何阈值时 crossed 为空数组。
   */
  apply: (
    saveId: string,
    characterId: string,
    delta: number,
    reason: string,
  ) => { affinity: Affinity; crossed: string[] };
}

function parseUnlocked(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return AFFINITY_INITIAL;
  return Math.min(AFFINITY_MAX, Math.max(AFFINITY_MIN, Math.round(value)));
}

export function createAffinityRepository(
  db: DatabaseSync,
  nameOf: (characterId: string) => string | undefined,
): AffinityRepository {
  const now = (): string => new Date().toISOString();

  function toAffinity(row: AffinityRow): Affinity {
    return {
      saveId: row.save_id,
      characterId: row.character_id,
      characterName: nameOf(row.character_id) ?? '某人',
      value: clamp(Number(row.value)),
      lastReason: row.last_reason ?? '',
      unlocked: parseUnlocked(row.unlocked),
      updatedAt: row.updated_at,
    };
  }

  function get(saveId: string, characterId: string): Affinity {
    const row = db
      .prepare('SELECT * FROM affinity WHERE save_id = ? AND character_id = ?')
      .get(saveId, characterId) as unknown as AffinityRow | undefined;

    if (row) return toAffinity(row);

    return {
      saveId,
      characterId,
      characterName: nameOf(characterId) ?? '某人',
      value: AFFINITY_INITIAL,
      lastReason: '',
      unlocked: [],
      updatedAt: now(),
    };
  }

  return {
    get,

    list(saveId: string): Affinity[] {
      const rows = db
        .prepare('SELECT * FROM affinity WHERE save_id = ? ORDER BY updated_at DESC')
        .all(saveId) as unknown as AffinityRow[];
      return rows.map(toAffinity);
    },

    apply(saveId, characterId, delta, reason): { affinity: Affinity; crossed: string[] } {
      const current = get(saveId, characterId);
      const next = clamp(current.value + Math.round(delta));
      const unlocked = [...current.unlocked];
      const crossed: string[] = [];

      for (const threshold of THRESHOLD_KEYS) {
        if (!threshold.crossed(next) || unlocked.includes(threshold.key)) continue;
        unlocked.push(threshold.key);
        crossed.push(threshold.key);
      }

      db.prepare(
        `INSERT INTO affinity (save_id, character_id, value, last_reason, unlocked, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (save_id, character_id)
         DO UPDATE SET value = excluded.value, last_reason = excluded.last_reason,
                       unlocked = excluded.unlocked, updated_at = excluded.updated_at`,
      ).run(saveId, characterId, next, reason.trim(), JSON.stringify(unlocked), now());

      return { affinity: get(saveId, characterId), crossed };
    },
  };
}

/** 给界面的语气标注：这三个词决定进度条的颜色与提示词里的态度。 */
export function describeAffinity(value: number): string {
  switch (affinityMood(value)) {
    case 'open':
      return '他松了口';
    case 'cold':
      return '他在冷处理';
    case 'neutral':
      return '还看不出深浅';
  }
}
