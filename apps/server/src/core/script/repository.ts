import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ScriptEvent, ScriptEventInput, ScriptEventPatch } from '@tavern/shared';

/**
 * 剧本事件仓储。
 *
 * 三件事：
 *   1. 事件本身的增删改查（按角色）
 *   2. 「这个会话里哪些事件已经发生过」—— 防重复触发
 *   3. 「这个会话里已经成立的事实」—— 剧情状态的持久化
 */

interface ScriptEventRow {
  id: string;
  character_id: string;
  at_turn: number;
  title: string;
  content: string;
  condition: string;
  is_ending: number;
  sets: string;
  created_at: string;
  updated_at: string;
}

function rowToEvent(row: ScriptEventRow): ScriptEvent {
  return {
    id: row.id,
    characterId: row.character_id,
    atTurn: row.at_turn,
    title: row.title,
    content: row.content,
    condition: row.condition ?? '',
    isEnding: row.is_ending === 1,
    sets: row.sets ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ScriptEventRepository {
  listByCharacter: (characterId: string) => ScriptEvent[];
  getById: (id: string) => ScriptEvent | undefined;
  create: (characterId: string, input: ScriptEventInput) => ScriptEvent;
  update: (id: string, patch: ScriptEventPatch) => ScriptEvent | undefined;
  remove: (id: string) => boolean;
  /** 该会话已经触发过的事件 id */
  firedIds: (conversationId: string) => Set<string>;
  /** 记下这次触发 */
  markFired: (conversationId: string, eventId: string) => void;
  /** 写入/覆盖一条剧情事实（同一事件重复触发不会叠加） */
  recordFact: (conversationId: string, eventId: string, content: string) => void;
  /** 该会话已成立的事实，按写入顺序 */
  facts: (conversationId: string) => string[];
}

export function createScriptEventRepository(db: DatabaseSync): ScriptEventRepository {
  const selectById = db.prepare('SELECT * FROM script_events WHERE id = ?');
  const selectByCharacter = db.prepare(
    'SELECT * FROM script_events WHERE character_id = ? ORDER BY at_turn ASC, created_at ASC',
  );

  function getById(id: string): ScriptEvent | undefined {
    const row = selectById.get(id) as unknown as ScriptEventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  return {
    listByCharacter(characterId: string): ScriptEvent[] {
      const rows = selectByCharacter.all(characterId) as unknown as ScriptEventRow[];
      return rows.map(rowToEvent);
    },

    getById,

    create(characterId: string, input: ScriptEventInput): ScriptEvent {
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO script_events (
           id, character_id, at_turn, title, content, condition, is_ending, sets, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        characterId,
        input.atTurn,
        input.title,
        input.content,
        input.condition ?? '',
        input.isEnding ? 1 : 0,
        input.sets ?? '',
        now,
        now,
      );

      const created = getById(id);
      if (!created) throw new Error(`剧本事件写入后读不回来（id=${id}）`);
      return created;
    },

    update(id: string, patch: ScriptEventPatch): ScriptEvent | undefined {
      if (!getById(id)) return undefined;

      const assignments: string[] = [];
      const values: Array<string | number> = [];

      const push = (column: string, value: string | number | undefined): void => {
        if (value === undefined) return;
        assignments.push(`${column} = ?`);
        values.push(value);
      };

      push('at_turn', patch.atTurn);
      push('title', patch.title);
      push('content', patch.content);
      push('condition', patch.condition);
      if (patch.isEnding !== undefined) push('is_ending', patch.isEnding ? 1 : 0);
      push('sets', patch.sets);

      if (assignments.length === 0) return getById(id);

      assignments.push('updated_at = ?');
      values.push(new Date().toISOString(), id);
      db.prepare(`UPDATE script_events SET ${assignments.join(', ')} WHERE id = ?`).run(...values);

      return getById(id);
    },

    remove(id: string): boolean {
      const result = db.prepare('DELETE FROM script_events WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },

    firedIds(conversationId: string): Set<string> {
      const rows = db
        .prepare('SELECT event_id FROM conversation_events WHERE conversation_id = ?')
        .all(conversationId) as unknown as { event_id: string }[];
      return new Set(rows.map((row) => row.event_id));
    },

    markFired(conversationId: string, eventId: string): void {
      db.prepare(
        `INSERT OR IGNORE INTO conversation_events (conversation_id, event_id, fired_at)
         VALUES (?, ?, ?)`,
      ).run(conversationId, eventId, new Date().toISOString());
    },

    recordFact(conversationId: string, eventId: string, content: string): void {
      if (content.trim().length === 0) return;
      db.prepare(
        `INSERT INTO conversation_facts (conversation_id, source_event_id, content, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (conversation_id, source_event_id)
         DO UPDATE SET content = excluded.content`,
      ).run(conversationId, eventId, content.trim(), new Date().toISOString());
    },

    facts(conversationId: string): string[] {
      const rows = db
        .prepare(
          'SELECT content FROM conversation_facts WHERE conversation_id = ? ORDER BY created_at ASC',
        )
        .all(conversationId) as unknown as { content: string }[];
      return rows.map((row) => row.content);
    },
  };
}
