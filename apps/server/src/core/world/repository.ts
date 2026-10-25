import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Reachability, Scene, Save } from '@tavern/shared';

/**
 * 世界存档域：存档 → 场景 → 在场者。
 *
 * 设计意图写在 docs/design-world.md，这里只放「数据的形状」与最关键的判定：
 * **这个人现在能不能联系上**。
 *
 * 数据形状本身定义在 @tavern/shared（前端也要用同一份），
 * 这里只负责读写与判定，不重复声明一遍字段。
 *
 * 可达性规则（世界不再退化成通讯录的关键）：
 *   在场且不忙   → 可以直接说话
 *   在场但在忙   → 未必有空
 *   已经离开     → 联系不上，只能等下次遇见
 *   不在该场景   → 列表里根本不该出现
 */

export interface PresenceEntry {
  characterId: string;
  /** 第几轮进来的 */
  enteredTurn: number;
  /** 第几轮走的；null = 还在 */
  leftTurn: number | null;
  /** 正在忙什么（擦杯子、巡街）—— 在忙就未必有空理你 */
  busyWith: string | null;
  /** 为什么走的（巡街去了 / 被你带去后巷）—— 只有 leftTurn 说不清这件事 */
  reason: string | null;
}

/** 存档沿用 shared 的类型；旧名字保留，避免改动面过大。 */
export type WorldSave = Save;
export type { Reachability, Scene };

/** 建场景时的入参。 */
export interface CreateSceneInput {
  name: string;
  kind?: 'public' | 'private';
  closeness?: number;
  /** 私密场景：从哪个公开场景出去的（回来时要知道回哪） */
  sourceSceneId?: string | null;
}

export interface WorldRepository {
  createSave: (name: string, theme?: string) => WorldSave;
  getSave: (id: string) => WorldSave | undefined;
  listSaves: () => WorldSave[];

  /**
   * 删掉整个存档。
   *
   * 场景 / 在场 / 主线 / 情报 / 好感都挂在 save_id 上，外键会跟着删；
   * 但对话（conversations）只挂了 scene_id 且没有外键，必须在这里一起清，
   * 否则消息会变成一堆没有场景的孤儿。
   */
  deleteSave: (id: string) => void;

  createScene: (saveId: string, input: CreateSceneInput) => Scene;
  getScene: (id: string) => Scene | undefined;
  listScenes: (saveId: string) => Scene[];

  /** 让某人进入场景（已在场则只更新忙的状态） */
  enter: (sceneId: string, characterId: string, turn: number, busyWith?: string | null) => void;
  /** 让某人离开；reason 记下为什么走（离开原因也是世界的一部分） */
  leave: (sceneId: string, characterId: string, turn: number, reason?: string | null) => void;
  /** 当前在场者（leftTurn 为 null） */
  present: (sceneId: string) => PresenceEntry[];
  /** 该场景出现过的所有人（含已离开） */
  history: (sceneId: string) => PresenceEntry[];
  /** 可达性判定 */
  reachability: (sceneId: string, characterId: string) => Reachability;
}

interface SaveRow {
  id: string;
  name: string;
  chapter: number;
  theme: string;
  created_at: string;
  updated_at: string;
}

interface SceneRow {
  id: string;
  save_id: string;
  name: string;
  kind: string;
  closeness: number;
  source_scene_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PresenceRow {
  character_id: string;
  entered_turn: number;
  left_turn: number | null;
  busy_with: string | null;
  reason: string | null;
}

function toSave(row: SaveRow): WorldSave {
  return {
    id: row.id,
    name: row.name,
    chapter: row.chapter,
    theme: row.theme ?? 'moonlight',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toScene(row: SceneRow): Scene {
  return {
    id: row.id,
    saveId: row.save_id,
    name: row.name,
    kind: row.kind === 'private' ? 'private' : 'public',
    closeness: Number(row.closeness ?? 0.3),
    sourceSceneId: row.source_scene_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPresence(row: PresenceRow): PresenceEntry {
  return {
    characterId: row.character_id,
    enteredTurn: row.entered_turn,
    leftTurn: row.left_turn,
    busyWith: row.busy_with,
    reason: row.reason ?? null,
  };
}

export function createWorldRepository(db: DatabaseSync): WorldRepository {
  const now = (): string => new Date().toISOString();

  return {
    createSave(name: string, theme = 'moonlight'): WorldSave {
      const id = randomUUID();
      const at = now();
      db.prepare(
        'INSERT INTO saves (id, name, chapter, theme, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)',
      ).run(id, name.trim() || '新的世界', theme, at, at);
      const row = db.prepare('SELECT * FROM saves WHERE id = ?').get(id) as unknown as SaveRow;
      return toSave(row);
    },

    getSave(id: string): WorldSave | undefined {
      const row = db.prepare('SELECT * FROM saves WHERE id = ?').get(id) as unknown as
        SaveRow | undefined;
      return row ? toSave(row) : undefined;
    },

    listSaves(): WorldSave[] {
      const rows = db
        .prepare('SELECT * FROM saves ORDER BY updated_at DESC')
        .all() as unknown as SaveRow[];
      return rows.map(toSave);
    },

    deleteSave(id: string): void {
      // 先清这个存档里所有场景的对话（连消息一起），再删存档本身
      db.prepare(
        `DELETE FROM conversations
         WHERE scene_id IN (SELECT id FROM scenes WHERE save_id = ?)`,
      ).run(id);
      db.prepare('DELETE FROM saves WHERE id = ?').run(id);
    },

    createScene(saveId, input): Scene {
      const id = randomUUID();
      const at = now();
      db.prepare(
        `INSERT INTO scenes (id, save_id, name, kind, closeness, source_scene_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        saveId,
        input.name.trim() || '未命名场景',
        input.kind ?? 'public',
        input.closeness ?? 0.3,
        input.sourceSceneId ?? null,
        at,
        at,
      );
      const row = db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as unknown as SceneRow;
      return toScene(row);
    },

    getScene(id: string): Scene | undefined {
      const row = db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as unknown as
        SceneRow | undefined;
      return row ? toScene(row) : undefined;
    },

    listScenes(saveId: string): Scene[] {
      const rows = db
        .prepare('SELECT * FROM scenes WHERE save_id = ? ORDER BY created_at ASC')
        .all(saveId) as unknown as SceneRow[];
      return rows.map(toScene);
    },

    enter(sceneId, characterId, turn, busyWith = null): void {
      // 已经在场：只更新忙的状态，不重置进场的轮次；回来的人顺手把离开原因清掉
      db.prepare(
        `INSERT INTO presence (scene_id, character_id, entered_turn, left_turn, busy_with, reason)
         VALUES (?, ?, ?, NULL, ?, NULL)
         ON CONFLICT (scene_id, character_id)
         DO UPDATE SET left_turn = NULL, busy_with = excluded.busy_with, reason = NULL`,
      ).run(sceneId, characterId, turn, busyWith);
    },

    leave(sceneId, characterId, turn, reason = null): void {
      db.prepare(
        'UPDATE presence SET left_turn = ?, reason = ? WHERE scene_id = ? AND character_id = ?',
      ).run(turn, reason, sceneId, characterId);
    },

    present(sceneId: string): PresenceEntry[] {
      const rows = db
        .prepare(
          'SELECT * FROM presence WHERE scene_id = ? AND left_turn IS NULL ORDER BY entered_turn ASC',
        )
        .all(sceneId) as unknown as PresenceRow[];
      return rows.map(toPresence);
    },

    history(sceneId: string): PresenceEntry[] {
      const rows = db
        .prepare('SELECT * FROM presence WHERE scene_id = ? ORDER BY entered_turn ASC')
        .all(sceneId) as unknown as PresenceRow[];
      return rows.map(toPresence);
    },

    reachability(sceneId, characterId): Reachability {
      const row = db
        .prepare('SELECT * FROM presence WHERE scene_id = ? AND character_id = ?')
        .get(sceneId, characterId) as unknown as PresenceRow | undefined;

      if (!row) return 'absent';
      if (row.left_turn !== null) return 'left';
      if (row.busy_with && row.busy_with.length > 0) return 'busy';
      return 'available';
    },
  };
}

/** 给前端的提示文案：联系不上时到底为什么。 */
export function describeReachability(state: Reachability, name: string): string {
  switch (state) {
    case 'available':
      return `${name}就在这儿，可以过去说话。`;
    case 'busy':
      return `${name}手上正忙着，未必有空理你。`;
    case 'left':
      return `${name}已经走了 —— 得等下次遇见。`;
    case 'absent':
      return `这里没有${name}。`;
  }
}
