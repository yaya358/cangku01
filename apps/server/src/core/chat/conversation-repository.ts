import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Conversation,
  CreateConversationInput,
  UpdateConversationInput,
} from '@tavern/shared';

/**
 * 会话仓储。
 *
 * 列表里要显示「角色名 / 消息数 / 最后一句」，但会话表本身不存这些 ——
 * 用子查询一次取回，避免前端为每条会话再发一次请求（N+1）。
 */

interface ConversationRow {
  id: string;
  character_id: string;
  character_name: string;
  title: string;
  active_leaf_id: string | null;
  message_count: number;
  last_content: string | null;
  created_at: string;
  updated_at: string;
}

/** 列表摘要里最后一句的截断长度。 */
const PREVIEW_LENGTH = 80;

function toPreview(content: string | null): string {
  if (!content) return '';
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length <= PREVIEW_LENGTH ? flat : `${flat.slice(0, PREVIEW_LENGTH)}…`;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    characterId: row.character_id,
    characterName: row.character_name,
    title: row.title,
    activeLeafId: row.active_leaf_id,
    messageCount: Number(row.message_count ?? 0),
    preview: toPreview(row.last_content),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ConversationRepository {
  list: (characterId?: string) => Conversation[];
  getById: (id: string) => Conversation | undefined;
  create: (input: CreateConversationInput) => Conversation;
  update: (id: string, patch: UpdateConversationInput) => Conversation | undefined;
  /** 生成完成写消息后调用，把会话顶到列表最前 */
  touch: (id: string, activeLeafId?: string | null) => void;
  remove: (id: string) => boolean;
  count: () => number;
}

export function createConversationRepository(db: DatabaseSync): ConversationRepository {
  const baseSelect = `
    SELECT c.id, c.character_id, ch.name AS character_name, c.title, c.active_leaf_id,
           c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
           (SELECT m.content FROM messages m WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC LIMIT 1) AS last_content
    FROM conversations c
    JOIN characters ch ON ch.id = c.character_id
  `;

  const selectById = db.prepare(`${baseSelect} WHERE c.id = ?`);
  const selectAll = db.prepare(`${baseSelect} ORDER BY c.updated_at DESC`);
  const selectByCharacter = db.prepare(
    `${baseSelect} WHERE c.character_id = ? ORDER BY c.updated_at DESC`,
  );

  function getById(id: string): Conversation | undefined {
    const row = selectById.get(id) as unknown as ConversationRow | undefined;
    return row ? rowToConversation(row) : undefined;
  }

  return {
    list(characterId?: string): Conversation[] {
      const rows = (characterId
        ? selectByCharacter.all(characterId)
        : selectAll.all()) as unknown as ConversationRow[];
      return rows.map(rowToConversation);
    },

    getById,

    create(input: CreateConversationInput): Conversation {
      const id = randomUUID();
      const now = new Date().toISOString();
      const title = input.title?.trim() || '新的对话';

      db.prepare(
        `INSERT INTO conversations (id, character_id, title, active_leaf_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      ).run(id, input.characterId, title, now, now);

      const created = getById(id);
      if (!created) throw new Error(`会话写入后读不回来（id=${id}）`);
      return created;
    },

    update(id: string, patch: UpdateConversationInput): Conversation | undefined {
      const existing = getById(id);
      if (!existing) return undefined;

      const assignments: string[] = [];
      const values: Array<string | null> = [];

      if (patch.title !== undefined) {
        assignments.push('title = ?');
        values.push(patch.title);
      }
      if (patch.activeLeafId !== undefined) {
        assignments.push('active_leaf_id = ?');
        values.push(patch.activeLeafId);
      }
      if (assignments.length === 0) return existing;

      assignments.push('updated_at = ?');
      values.push(new Date().toISOString(), id);
      db.prepare(`UPDATE conversations SET ${assignments.join(', ')} WHERE id = ?`).run(...values);

      return getById(id);
    },

    touch(id: string, activeLeafId?: string | null): void {
      if (activeLeafId === undefined) {
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(
          new Date().toISOString(),
          id,
        );
        return;
      }
      db.prepare('UPDATE conversations SET updated_at = ?, active_leaf_id = ? WHERE id = ?').run(
        new Date().toISOString(),
        activeLeafId,
        id,
      );
    },

    remove(id: string): boolean {
      const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },

    count(): number {
      const row = db.prepare('SELECT COUNT(*) AS total FROM conversations').get() as
        { total?: number } | undefined;
      return Number(row?.total ?? 0);
    },
  };
}
