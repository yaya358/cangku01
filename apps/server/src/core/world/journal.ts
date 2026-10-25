import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Clue, Quest, QuestProgress } from '@tavern/shared';

/**
 * 主线与情报本的仓储。
 *
 * 章节推进只有两个条件（情报条数 + 好感），判定集中在这里，
 * 免得路由与界面各算一遍、算得不一样。
 *
 * 「打开就有一条能玩的主线」是设计里的验收项：存档第一次被打开时，
 * 如果一章都没有，就按模板写第一章 —— 而不是让玩家面对一个空侧栏。
 */

interface QuestRow {
  id: string;
  save_id: string;
  chapter: number;
  title: string;
  goal: string;
  status: string;
  required_clues: number;
  required_affinity: number;
  created_at: string;
  updated_at: string;
}

interface ClueRow {
  id: string;
  save_id: string;
  content: string;
  source: string | null;
  source_turn: number | null;
  quote: string | null;
  known_at: string;
}

/**
 * 示例主线：三章，够玩一轮，也够演示「情报 + 好感」这两个条件。
 * 用通用措辞写，换一批角色也读得通。
 */
const MAINLINE = [
  {
    chapter: 1,
    title: '第一章 · 夜里的动静',
    goal: '让在场有人愿意提一句最近发生的事',
    requiredClues: 1,
    requiredAffinity: 0,
  },
  {
    chapter: 2,
    title: '第二章 · 那张通缉令',
    goal: '让某个人愿意跟你说真话（好感 60 以上）',
    requiredClues: 2,
    requiredAffinity: 60,
  },
  {
    chapter: 3,
    title: '第三章 · 名单上的最后一行',
    goal: '把听来的说法对上，凑齐三条情报',
    requiredClues: 3,
    requiredAffinity: 0,
  },
] as const;

function toQuest(row: QuestRow): Quest {
  return {
    id: row.id,
    saveId: row.save_id,
    chapter: row.chapter,
    title: row.title,
    goal: row.goal,
    status: row.status === 'done' ? 'done' : 'active',
    requiredClues: Number(row.required_clues ?? 1),
    requiredAffinity: Number(row.required_affinity ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toClue(row: ClueRow): Clue {
  return {
    id: row.id,
    saveId: row.save_id,
    content: row.content,
    source: row.source ?? null,
    sourceTurn: row.source_turn === null ? null : Number(row.source_turn),
    quote: row.quote ?? null,
    knownAt: row.known_at,
  };
}

export interface AddClueInput {
  saveId: string;
  content: string;
  source?: string | null;
  sourceTurn?: number | null;
  quote?: string | null;
}

export interface JournalRepository {
  /** 存档第一章的模板（没有就写一章，幂等） */
  ensureMainline: (saveId: string) => void;
  listQuests: (saveId: string) => Quest[];
  /** 当前进行中的那一章（全部演完为 undefined） */
  activeQuest: (saveId: string) => Quest | undefined;
  listClues: (saveId: string) => Clue[];
  /** 记一条情报（同样的内容不重复记） */
  addClue: (input: AddClueInput) => Clue | null;
  /** 这一章够不够关掉 */
  progress: (saveId: string, maxAffinity: number) => QuestProgress | null;
  /**
   * 条件够了就关章并开下一章。
   * 返回新一章（全部演完为 null）与是否刚刚推进过。
   */
  advance: (
    saveId: string,
    maxAffinity: number,
  ) => { advanced: boolean; next: Quest | null; chapter: number };
  /** 存档当前章号 */
  chapterOf: (saveId: string) => number;
}

/**
 * 情报的内容取「他藏着的那件事」的第一句。
 *
 * 不做摘要生成：秘密本来就是他愿意松口时才会说的东西，
 * 第一句通常就是最有信息量的那句，也省一次模型调用。
 */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  const match = flat.match(/^[^。！？!?]{2,60}[。！？!?]?/);
  return (match?.[0] ?? flat.slice(0, 60)).trim();
}

export function createJournalRepository(db: DatabaseSync): JournalRepository {
  const now = (): string => new Date().toISOString();

  function insertQuest(saveId: string, template: (typeof MAINLINE)[number]): Quest {
    const id = randomUUID();
    const at = now();
    db.prepare(
      `INSERT INTO quests (
         id, save_id, chapter, title, goal, status, required_clues, required_affinity,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(
      id,
      saveId,
      template.chapter,
      template.title,
      template.goal,
      template.requiredClues,
      template.requiredAffinity,
      at,
      at,
    );
    const row = db.prepare('SELECT * FROM quests WHERE id = ?').get(id) as unknown as QuestRow;
    return toQuest(row);
  }

  function listQuests(saveId: string): Quest[] {
    const rows = db
      .prepare('SELECT * FROM quests WHERE save_id = ? ORDER BY chapter ASC')
      .all(saveId) as unknown as QuestRow[];
    return rows.map(toQuest);
  }

  function activeQuest(saveId: string): Quest | undefined {
    const row = db
      .prepare(
        "SELECT * FROM quests WHERE save_id = ? AND status = 'active' ORDER BY chapter ASC LIMIT 1",
      )
      .get(saveId) as unknown as QuestRow | undefined;
    return row ? toQuest(row) : undefined;
  }

  function listClues(saveId: string): Clue[] {
    const rows = db
      .prepare('SELECT * FROM clues WHERE save_id = ? ORDER BY known_at ASC, rowid ASC')
      .all(saveId) as unknown as ClueRow[];
    return rows.map(toClue);
  }

  function chapterOf(saveId: string): number {
    const row = db.prepare('SELECT chapter FROM saves WHERE id = ?').get(saveId) as
      { chapter?: number } | undefined;
    return Number(row?.chapter ?? 1);
  }

  function progress(saveId: string, maxAffinity: number): QuestProgress | null {
    const quest = activeQuest(saveId);
    if (!quest) return null;
    return {
      clues: listClues(saveId).length,
      needed: quest.requiredClues,
      affinity: maxAffinity,
      requiredAffinity: quest.requiredAffinity,
    };
  }

  return {
    ensureMainline(saveId: string): void {
      const existing = listQuests(saveId);
      if (existing.length > 0) return;
      insertQuest(saveId, MAINLINE[0]!);
    },

    listQuests,
    activeQuest,
    listClues,
    progress,

    addClue(input: AddClueInput): Clue | null {
      const content = input.content.trim();
      if (content.length === 0) return null;

      // 同一句话不重复记：反复套出来的话不该把情报本撑满
      const existing = db
        .prepare('SELECT * FROM clues WHERE save_id = ? AND content = ?')
        .get(input.saveId, content) as unknown as ClueRow | undefined;
      if (existing) return null;

      const id = randomUUID();
      db.prepare(
        `INSERT INTO clues (id, save_id, content, source, source_turn, quote, known_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.saveId,
        content,
        input.source ?? null,
        input.sourceTurn ?? null,
        input.quote ?? null,
        now(),
      );
      const row = db.prepare('SELECT * FROM clues WHERE id = ?').get(id) as unknown as ClueRow;
      return toClue(row);
    },

    advance(saveId, maxAffinity): { advanced: boolean; next: Quest | null; chapter: number } {
      const quest = activeQuest(saveId);
      if (!quest) {
        return { advanced: false, next: null, chapter: chapterOf(saveId) };
      }

      const clues = listClues(saveId).length;
      const ready = clues >= quest.requiredClues && maxAffinity >= quest.requiredAffinity;
      if (!ready) {
        return { advanced: false, next: null, chapter: quest.chapter };
      }

      const at = now();
      db.prepare("UPDATE quests SET status = 'done', updated_at = ? WHERE id = ?").run(
        at,
        quest.id,
      );

      const template = MAINLINE.find((item) => item.chapter === quest.chapter + 1);
      const chapter = template ? template.chapter : quest.chapter;
      db.prepare('UPDATE saves SET chapter = ?, updated_at = ? WHERE id = ?').run(
        chapter,
        at,
        saveId,
      );

      return {
        advanced: true,
        next: template ? insertQuest(saveId, template) : null,
        chapter,
      };
    },

    chapterOf,
  };
}
