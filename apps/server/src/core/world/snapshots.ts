import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 存档快照：把一本故事此刻的全部状态拍下来，之后能原样读回去。
 *
 * 为什么不做「每章自动快照」而是手动：自动快照会让玩家以为随时能撤回，
 * 但台词、好感都是「说出去就收不回」的东西 —— 想读档就该付出「我知道我在作弊」的自觉。
 *
 * 实现上是整包 JSON：场景 / 在场 / 对话 / 消息 / 事实 / 主线 / 情报 / 好感。
 * 逐表 diff 太容易漏（新加一张表就少存一样），整包存最不容易坏。
 */

export interface SnapshotMeta {
  id: string;
  saveId: string;
  label: string;
  chapter: number;
  messageCount: number;
  createdAt: string;
}

interface SnapshotRow {
  id: string;
  save_id: string;
  label: string;
  chapter: number;
  message_count: number;
  created_at: string;
  payload: string;
}

interface Payload {
  save: Record<string, unknown>;
  scenes: Record<string, unknown>[];
  presence: Record<string, unknown>[];
  conversations: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  facts: Record<string, unknown>[];
  quests: Record<string, unknown>[];
  clues: Record<string, unknown>[];
  affinity: Record<string, unknown>[];
}

export interface SnapshotRepository {
  create: (saveId: string, label: string) => SnapshotMeta;
  list: (saveId: string) => SnapshotMeta[];
  remove: (snapshotId: string) => boolean;
  restore: (snapshotId: string) => { saveId: string; chapter: number } | undefined;
}

const MAX_SNAPSHOTS = 20;

function toMeta(row: SnapshotRow): SnapshotMeta {
  return {
    id: row.id,
    saveId: row.save_id,
    label: row.label,
    chapter: row.chapter,
    messageCount: row.message_count,
    createdAt: row.created_at,
  };
}

export function createSnapshotRepository(db: DatabaseSync): SnapshotRepository {
  const now = (): string => new Date().toISOString();

  function placeholders(count: number): string {
    return new Array(count).fill('?').join(', ');
  }

  function rows<T>(sql: string, ...params: unknown[]): T[] {
    return db.prepare(sql).all(...(params as never[])) as unknown as T[];
  }

  function capture(saveId: string): Payload {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(saveId) as unknown as
      Record<string, unknown> | undefined;
    if (!save) throw new Error(`存档不存在: ${saveId}`);

    const scenes = rows<Record<string, unknown>>('SELECT * FROM scenes WHERE save_id = ?', saveId);
    const sceneIds = scenes.map((scene) => String(scene.id));
    const conversations = sceneIds.length
      ? rows<Record<string, unknown>>(
          `SELECT * FROM conversations WHERE scene_id IN (${placeholders(sceneIds.length)})`,
          ...sceneIds,
        )
      : [];
    const conversationIds = conversations.map((conversation) => String(conversation.id));

    return {
      save,
      scenes,
      presence: sceneIds.length
        ? rows<Record<string, unknown>>(
            `SELECT * FROM presence WHERE scene_id IN (${placeholders(sceneIds.length)})`,
            ...sceneIds,
          )
        : [],
      conversations,
      messages: conversationIds.length
        ? rows<Record<string, unknown>>(
            `SELECT * FROM messages WHERE conversation_id IN (${placeholders(conversationIds.length)}) ORDER BY created_at ASC, rowid ASC`,
            ...conversationIds,
          )
        : [],
      facts: conversationIds.length
        ? rows<Record<string, unknown>>(
            `SELECT * FROM conversation_facts WHERE conversation_id IN (${placeholders(conversationIds.length)})`,
            ...conversationIds,
          )
        : [],
      quests: rows<Record<string, unknown>>('SELECT * FROM quests WHERE save_id = ?', saveId),
      clues: rows<Record<string, unknown>>('SELECT * FROM clues WHERE save_id = ?', saveId),
      affinity: rows<Record<string, unknown>>('SELECT * FROM affinity WHERE save_id = ?', saveId),
    };
  }

  function insertRow(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders(columns.length)})`;
    db.prepare(sql).run(...(columns.map((column) => row[column]) as never[]));
  }

  return {
    create(saveId: string, label: string): SnapshotMeta {
      const payload = capture(saveId);
      const id = randomUUID();
      const at = now();
      db.prepare(
        `INSERT INTO save_snapshots (id, save_id, label, chapter, message_count, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        saveId,
        label.trim() || '存档',
        Number(payload.save.chapter ?? 1),
        payload.messages.length,
        at,
        JSON.stringify(payload),
      );

      // 只留最近若干条：快照是防手滑用的，不是档案库
      const stale = db
        .prepare(
          `SELECT id FROM save_snapshots WHERE save_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
        )
        .all(saveId, MAX_SNAPSHOTS) as unknown as { id: string }[];
      for (const item of stale) db.prepare('DELETE FROM save_snapshots WHERE id = ?').run(item.id);

      const created = db
        .prepare('SELECT * FROM save_snapshots WHERE id = ?')
        .get(id) as unknown as SnapshotRow;
      return toMeta(created);
    },

    list(saveId: string): SnapshotMeta[] {
      // 同一毫秒存两张时 created_at 一样，用 rowid 兜住顺序（新的在前）
      const found = db
        .prepare(
          'SELECT * FROM save_snapshots WHERE save_id = ? ORDER BY created_at DESC, rowid DESC',
        )
        .all(saveId) as unknown as SnapshotRow[];
      return found.map(toMeta);
    },

    remove(snapshotId: string): boolean {
      return db.prepare('DELETE FROM save_snapshots WHERE id = ?').run(snapshotId).changes > 0;
    },

    restore(snapshotId: string): { saveId: string; chapter: number } | undefined {
      const row = db
        .prepare('SELECT * FROM save_snapshots WHERE id = ?')
        .get(snapshotId) as unknown as SnapshotRow | undefined;
      if (!row) return undefined;

      const payload = JSON.parse(row.payload) as Payload;
      const saveId = String(payload.save.id);

      // 先把这本故事现在的状态清空（顺序：对话 → 场景 → 存档级数据），再照快照铺回去
      db.prepare(
        `DELETE FROM conversations WHERE scene_id IN (SELECT id FROM scenes WHERE save_id = ?)`,
      ).run(saveId);
      db.prepare('DELETE FROM scenes WHERE save_id = ?').run(saveId);
      db.prepare('DELETE FROM quests WHERE save_id = ?').run(saveId);
      db.prepare('DELETE FROM clues WHERE save_id = ?').run(saveId);
      db.prepare('DELETE FROM affinity WHERE save_id = ?').run(saveId);

      for (const scene of payload.scenes) insertRow('scenes', scene);
      for (const entry of payload.presence) insertRow('presence', entry);
      for (const conversation of payload.conversations) insertRow('conversations', conversation);
      for (const message of payload.messages) insertRow('messages', message);
      for (const fact of payload.facts) insertRow('conversation_facts', fact);
      for (const quest of payload.quests) insertRow('quests', quest);
      for (const clue of payload.clues) insertRow('clues', clue);
      for (const entry of payload.affinity) insertRow('affinity', entry);

      db.prepare('UPDATE saves SET chapter = ?, updated_at = ? WHERE id = ?').run(
        Number(payload.save.chapter ?? 1),
        now(),
        saveId,
      );

      return { saveId, chapter: Number(payload.save.chapter ?? 1) };
    },
  };
}
