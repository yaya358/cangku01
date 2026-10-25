import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Clue, Quest, QuestProgress } from '@tavern/shared';

/**
 * 主线与情报本的仓储。
 *
 * 章节推进只有两个条件（情报条数 + 某个人的好感），判定集中在这里，
 * 免得路由与界面各算一遍、算得不一样。
 *
 * 一条贯穿的取舍：**每一章都指名一个人**。
 * 早先的写法是「让在场有人愿意提一句最近的事」这种抽象目标，结果玩家
 * 既不知道找谁、也不知道该聊到什么程度；绑定角色之后，进度条、下一步、
 * 情报本的来源都能落到同一个名字上。
 *
 * 「打开就有一条能玩的主线」是设计里的验收项：存档第一次被打开时
 * 按在场的人现编一条三章主线，而不是让玩家面对一个空侧栏。
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
  focus_character_id: string | null;
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

/** 写主线时要用到的「指着谁」：只要 id 与名字。 */
export interface CastMember {
  id: string;
  name: string;
}

interface QuestTemplate {
  chapter: number;
  title: string;
  goal: string;
  requiredClues: number;
  requiredAffinity: number;
  focusCharacterId: string | null;
}

/**
 * 按在场的人现编一条主线：一章一个人，条件就是「让他松口」。
 *
 * 为什么不做更像样的剧情（通缉令、名单）：那需要 beats 那套条件表，
 * 而情报目前只从「好感跨 60」来 —— 写得再花，玩家还是只能靠聊天推进。
 * 所以先把「每一章都能指着一个人、进度看得懂」做实，比编三段花哨文案有用。
 */
export function mainlineFor(cast: readonly CastMember[]): QuestTemplate[] {
  if (cast.length === 0) {
    return [
      {
        chapter: 1,
        title: '第一章 · 先找个人说话',
        goal: '场景里得先有人 —— 进去说一句，才会有人接',
        requiredClues: 1,
        requiredAffinity: 0,
        focusCharacterId: null,
      },
    ];
  }

  const chapters = cast.slice(0, 3);
  return chapters.map((person, index) => ({
    chapter: index + 1,
    title: `第${['一', '二', '三'][index] ?? index + 1}章 · 让${person.name}开口`,
    goal: `让${person.name}愿意跟你说真话（好感到 60，他会松口）`,
    requiredClues: index + 1,
    requiredAffinity: 60,
    focusCharacterId: person.id,
  }));
}

function toQuest(row: QuestRow, nameOf: (id: string) => string | undefined): Quest {
  return {
    id: row.id,
    saveId: row.save_id,
    chapter: row.chapter,
    title: row.title,
    goal: row.goal,
    status: row.status === 'done' ? 'done' : 'active',
    requiredClues: Number(row.required_clues ?? 1),
    requiredAffinity: Number(row.required_affinity ?? 0),
    focusCharacterId: row.focus_character_id ?? null,
    focusCharacterName: row.focus_character_id ? (nameOf(row.focus_character_id) ?? '某人') : null,
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

/** 判定一章是否过关要的两个数。 */
export interface QuestValues {
  /** 焦点角色对你的好感（这一章指着的那个人） */
  focusAffinity: number;
  /** 存档里最高的一份好感（没有焦点时兜底） */
  maxAffinity: number;
}

export interface JournalRepository {
  /** 按在场的人现编一条主线（已经有一章就什么都不做，幂等） */
  ensureMainline: (saveId: string, cast: readonly CastMember[]) => void;
  listQuests: (saveId: string) => Quest[];
  /** 当前进行中的那一章（全部演完为 undefined） */
  activeQuest: (saveId: string) => Quest | undefined;
  listClues: (saveId: string) => Clue[];
  /** 记一条情报（同样的内容不重复记） */
  addClue: (input: AddClueInput) => Clue | null;
  /** 这一章的进度：差几条情报、差多少好感、下一步该干嘛 */
  progress: (saveId: string, values: QuestValues) => QuestProgress | null;
  /**
   * 条件够了就关章，进下一章。
   * 返回新一章（全部演完为 null）与是否刚刚推进过。
   */
  advance: (
    saveId: string,
    values: QuestValues,
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

/**
 * 「下一步」那句话。
 *
 * 写在这里而不是前端：它要同时说清「差什么」和「找谁」，
 * 换个地方写就很容易跟判定逻辑走散（这正是主线之前显得不明确的原因）。
 */
export function nextStepText(quest: Quest, values: QuestValues, clues: number): string {
  const who = quest.focusCharacterName ?? '在场的人';
  const missingClues = Math.max(0, quest.requiredClues - clues);
  const affinity = quest.focusCharacterId ? values.focusAffinity : values.maxAffinity;
  const missingAffinity = Math.max(0, quest.requiredAffinity - affinity);

  if (missingClues === 0 && missingAffinity === 0) {
    return '条件够了 —— 再说一句话就过关。';
  }
  if (missingClues === 0) {
    return `情报够了，再把${who}的好感聊高 ${missingAffinity} 点（现在 ${affinity}/${quest.requiredAffinity}）。`;
  }
  if (missingAffinity === 0) {
    return `好感够了，还差 ${missingClues} 条情报 —— 找${who}接着说。`;
  }
  return `找${who}聊：好感还差 ${missingAffinity} 点（${affinity}/${quest.requiredAffinity}），情报还差 ${missingClues} 条。`;
}

export function createJournalRepository(
  db: DatabaseSync,
  nameOf: (characterId: string) => string | undefined,
): JournalRepository {
  const now = (): string => new Date().toISOString();

  function insertQuest(saveId: string, template: QuestTemplate): Quest {
    const id = randomUUID();
    const at = now();
    db.prepare(
      `INSERT INTO quests (
         id, save_id, chapter, title, goal, status, required_clues, required_affinity,
         focus_character_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      saveId,
      template.chapter,
      template.title,
      template.goal,
      template.requiredClues,
      template.requiredAffinity,
      template.focusCharacterId,
      at,
      at,
    );
    const row = db.prepare('SELECT * FROM quests WHERE id = ?').get(id) as unknown as QuestRow;
    return toQuest(row, nameOf);
  }

  function listQuests(saveId: string): Quest[] {
    const rows = db
      .prepare('SELECT * FROM quests WHERE save_id = ? ORDER BY chapter ASC')
      .all(saveId) as unknown as QuestRow[];
    return rows.map((row) => toQuest(row, nameOf));
  }

  /**
   * 当前那一章 = 章号最小的未完成章。
   *
   * 主线在第一次打开时就整条写进库（后面的章先躺着），
   * 这样推进只需要把当前章标成 done —— 不必在 advance 时再回头找模板，
   * 也就不会出现「模板变了、存档里的主线跟着变」这种事。
   */
  function activeQuest(saveId: string): Quest | undefined {
    const row = db
      .prepare(
        "SELECT * FROM quests WHERE save_id = ? AND status != 'done' ORDER BY chapter ASC LIMIT 1",
      )
      .get(saveId) as unknown as QuestRow | undefined;
    return row ? toQuest(row, nameOf) : undefined;
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

  return {
    ensureMainline(saveId: string, cast: readonly CastMember[]): void {
      if (listQuests(saveId).length > 0) return;
      for (const template of mainlineFor(cast)) insertQuest(saveId, template);
    },

    listQuests,
    activeQuest,
    listClues,
    chapterOf,

    progress(saveId: string, values: QuestValues): QuestProgress | null {
      const quest = activeQuest(saveId);
      if (!quest) return null;
      const clues = listClues(saveId).length;
      return {
        clues,
        needed: quest.requiredClues,
        affinity: quest.focusCharacterId ? values.focusAffinity : values.maxAffinity,
        requiredAffinity: quest.requiredAffinity,
        nextStep: nextStepText(quest, values, clues),
      };
    },

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

    advance(saveId, values): { advanced: boolean; next: Quest | null; chapter: number } {
      const quest = activeQuest(saveId);
      if (!quest) {
        return { advanced: false, next: null, chapter: chapterOf(saveId) };
      }

      const clues = listClues(saveId).length;
      const affinity = quest.focusCharacterId ? values.focusAffinity : values.maxAffinity;
      const ready = clues >= quest.requiredClues && affinity >= quest.requiredAffinity;
      if (!ready) {
        return { advanced: false, next: null, chapter: quest.chapter };
      }

      const at = now();
      db.prepare("UPDATE quests SET status = 'done', updated_at = ? WHERE id = ?").run(
        at,
        quest.id,
      );

      const next = activeQuest(saveId) ?? null;
      const chapter = next ? next.chapter : quest.chapter;
      db.prepare('UPDATE saves SET chapter = ?, updated_at = ? WHERE id = ?').run(
        chapter,
        at,
        saveId,
      );

      return { advanced: true, next, chapter };
    },
  };
}
