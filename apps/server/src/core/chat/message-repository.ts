import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppendMessageInput, Message, MessageUsage } from '@tavern/shared';

/**
 * 消息仓储。
 *
 * 两个为后续功能预留的字段：
 *   parent_id —— 消息构成树，支持「从任意一句开新分支」
 *   swipes    —— 同一位置的多个候选回复，支持「重说」翻页
 * 现在就把读写做好，加功能时不用再改表。
 */

interface MessageRow {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: string;
  kind: string;
  content: string;
  swipes: string;
  swipe_index: number;
  model: string | null;
  provider: string | null;
  usage: string | null;
  finish_reason: string | null;
  duration_ms: number | null;
  first_token_ms: number | null;
  created_at: string;
}

function parseSwipes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function parseUsage(raw: string | null): MessageUsage | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MessageUsage>;
    if (typeof parsed?.totalTokens !== 'number') return null;
    return {
      promptTokens: Number(parsed.promptTokens ?? 0),
      completionTokens: Number(parsed.completionTokens ?? 0),
      totalTokens: Number(parsed.totalTokens),
    };
  } catch {
    return null;
  }
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    role: row.role as Message['role'],
    kind: (row.kind as Message['kind']) ?? 'speak',
    content: row.content,
    swipes: parseSwipes(row.swipes),
    swipeIndex: row.swipe_index,
    model: row.model,
    provider: row.provider,
    usage: parseUsage(row.usage),
    finishReason: row.finish_reason,
    durationMs: row.duration_ms,
    firstTokenMs: row.first_token_ms,
    createdAt: row.created_at,
  };
}

export interface MessageRepository {
  /** 按时间升序（线性视图）；对话树视图由上层用 parentId 自行还原 */
  listByConversation: (conversationId: string) => Message[];
  getById: (id: string) => Message | undefined;
  append: (conversationId: string, input: AppendMessageInput) => Message;
  /** 编辑正文（不产生新消息，直接改） */
  updateContent: (id: string, content: string) => Message | undefined;
  /** 重说：追加一个候选并切到它 */
  appendSwipe: (id: string, content: string) => Message | undefined;
  /** 切换候选 */
  selectSwipe: (id: string, index: number) => Message | undefined;
  /** 重说后刷新生成元信息，让展示的耗时/用量与当前候选一致 */
  updateMeta: (
    id: string,
    meta: {
      model?: string;
      provider?: string;
      usage?: MessageUsage;
      finishReason?: string;
      durationMs?: number;
      firstTokenMs?: number;
    },
  ) => Message | undefined;
  remove: (id: string) => boolean;
  count: (conversationId?: string) => number;
}

export function createMessageRepository(db: DatabaseSync): MessageRepository {
  const selectById = db.prepare('SELECT * FROM messages WHERE id = ?');
  const selectByConversation = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC',
  );

  function getById(id: string): Message | undefined {
    const row = selectById.get(id) as unknown as MessageRow | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  return {
    listByConversation(conversationId: string): Message[] {
      const rows = selectByConversation.all(conversationId) as unknown as MessageRow[];
      return rows.map(rowToMessage);
    },

    getById,

    append(conversationId: string, input: AppendMessageInput): Message {
      const id = randomUUID();
      const now = new Date().toISOString();
      // 助手消息天然就是第 0 个候选（这样「重说」追加第二个时不丢原来那条）
      const swipes = input.role === 'assistant' ? JSON.stringify([input.content]) : '[]';

      db.prepare(
        `INSERT INTO messages (
          id, conversation_id, parent_id, role, kind, content, swipes, swipe_index,
          model, provider, usage, finish_reason, duration_ms, first_token_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        conversationId,
        input.parentId ?? null,
        input.role,
        input.kind ?? 'speak',
        input.content,
        swipes,
        input.model ?? null,
        input.provider ?? null,
        input.usage ? JSON.stringify(input.usage) : null,
        input.finishReason ?? null,
        input.durationMs ?? null,
        input.firstTokenMs ?? null,
        now,
      );

      const created = getById(id);
      if (!created) throw new Error(`消息写入后读不回来（id=${id}）`);
      return created;
    },

    /**
     * 编辑正文。
     *
     * 如果这条消息有候选（重说过），编辑要同步改当前候选 ——
     * 否则切到别的候选再切回来，刚才改的字就没了。
     */
    updateContent(id: string, content: string): Message | undefined {
      const existing = getById(id);
      if (!existing) return undefined;

      const swipes = [...existing.swipes];
      if (swipes.length > 0) swipes[existing.swipeIndex] = content;

      db.prepare('UPDATE messages SET content = ?, swipes = ? WHERE id = ?').run(
        content,
        JSON.stringify(swipes),
        id,
      );
      return getById(id);
    },

    /** 追加一个候选并切到它（content 与 swipeIndex 同步）。 */
    appendSwipe(id: string, content: string): Message | undefined {
      const existing = getById(id);
      if (!existing) return undefined;

      // 老数据可能没有候选（swipes 为空）：把当前正文补成第 0 个候选
      const swipes = existing.swipes.length > 0 ? [...existing.swipes] : [existing.content];
      swipes.push(content);

      db.prepare('UPDATE messages SET content = ?, swipes = ?, swipe_index = ? WHERE id = ?').run(
        content,
        JSON.stringify(swipes),
        swipes.length - 1,
        id,
      );
      return getById(id);
    },

    /** 切换候选：正文跟着候选走，保证「展示的」和「参与上下文的」是同一条。 */
    selectSwipe(id: string, index: number): Message | undefined {
      const existing = getById(id);
      if (!existing) return undefined;
      if (existing.swipes.length === 0) return existing;
      if (index < 0 || index >= existing.swipes.length) return undefined;

      const content = existing.swipes[index] ?? existing.content;
      db.prepare('UPDATE messages SET content = ?, swipe_index = ? WHERE id = ?').run(
        content,
        index,
        id,
      );
      return getById(id);
    },

    /** 重说后刷新元信息：否则界面显示的耗时/用量还停在上一版。 */
    updateMeta(
      id,
      meta: {
        model?: string;
        provider?: string;
        usage?: MessageUsage;
        finishReason?: string;
        durationMs?: number;
        firstTokenMs?: number;
      },
    ): Message | undefined {
      const existing = getById(id);
      if (!existing) return undefined;

      const assignments: string[] = [];
      const values: Array<string | number | null> = [];

      if (meta.model !== undefined) {
        assignments.push('model = ?');
        values.push(meta.model);
      }
      if (meta.provider !== undefined) {
        assignments.push('provider = ?');
        values.push(meta.provider);
      }
      if (meta.usage !== undefined) {
        assignments.push('usage = ?');
        values.push(JSON.stringify(meta.usage));
      }
      if (meta.finishReason !== undefined) {
        assignments.push('finish_reason = ?');
        values.push(meta.finishReason);
      }
      if (meta.durationMs !== undefined) {
        assignments.push('duration_ms = ?');
        values.push(meta.durationMs);
      }
      if (meta.firstTokenMs !== undefined) {
        assignments.push('first_token_ms = ?');
        values.push(meta.firstTokenMs);
      }
      if (assignments.length === 0) return existing;

      values.push(id);
      db.prepare(`UPDATE messages SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
      return getById(id);
    },

    remove(id: string): boolean {
      const result = db.prepare('DELETE FROM messages WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },

    count(conversationId?: string): number {
      const row = (
        conversationId
          ? db
              .prepare('SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?')
              .get(conversationId)
          : db.prepare('SELECT COUNT(*) AS total FROM messages').get()
      ) as { total?: number } | undefined;
      return Number(row?.total ?? 0);
    },
  };
}
