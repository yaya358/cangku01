import { z } from 'zod';

/**
 * 主线与情报本。
 *
 * 主线是「你现在要弄明白什么」，情报是「你已经弄明白了什么」——
 * 两者共用一套推进规则，写在服务端而不是前端：
 *
 *   拿到足够多的情报 + 有人愿意跟你说真话（好感 ≥ 60）→ 这一章才算过去
 *
 * 刻意不做通用条件解析器（见 docs/design-world.md）：章节需求就是两个数，
 * 好校验、好显示，也不用写一门小语言。
 */

export const QUEST_STATUSES = ['active', 'done'] as const;
export const QuestStatusSchema = z.enum(QUEST_STATUSES);
export type QuestStatus = z.infer<typeof QuestStatusSchema>;

export const QuestSchema = z.object({
  id: z.string(),
  saveId: z.string(),
  /** 第几章 */
  chapter: z.number().int().min(1),
  title: z.string(),
  /** 这一章要弄明白什么（给人看的一句话） */
  goal: z.string(),
  status: QuestStatusSchema,
  /** 关掉这一章需要几条情报 */
  requiredClues: z.number().int().nonnegative(),
  /** 关掉这一章还需要有人的好感达到多少（0 = 不看好感） */
  requiredAffinity: z.number().int().min(0).max(100),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Quest = z.infer<typeof QuestSchema>;

/** 情报：你掌握的一件事，连同它是在哪一轮、谁说的、原话是什么。 */
export const ClueSchema = z.object({
  id: z.string(),
  saveId: z.string(),
  /** 你掌握的内容（一句话） */
  content: z.string(),
  /** 谁说的；你自己看出来的为 null */
  source: z.string().nullable(),
  /** 第几轮听到的 */
  sourceTurn: z.number().int().nonnegative().nullable(),
  /** 原话（展开时看） */
  quote: z.string().nullable(),
  knownAt: z.string(),
});
export type Clue = z.infer<typeof ClueSchema>;

/** 当前这一章的进度（界面上的「2/3」）。 */
export const QuestProgressSchema = z.object({
  clues: z.number().int().nonnegative(),
  needed: z.number().int().nonnegative(),
  /** 存档里最高的一份好感 */
  affinity: z.number().int().min(0).max(100),
  requiredAffinity: z.number().int().min(0).max(100),
});
export type QuestProgress = z.infer<typeof QuestProgressSchema>;

/**
 * 侧栏要的全部东西。
 *
 * 一次返回主线、情报本、好感三块：侧栏本来就是一起显示的，
 * 拆成三个请求只会让它在刷新时先后跳出来。
 */
export const JournalSchema = z.object({
  saveId: z.string(),
  /** 存档当前的章号 */
  chapter: z.number().int().min(1),
  /** 当前进行中的那一章（全部演完就是 null） */
  quest: QuestSchema.nullable(),
  /** 全部章节（含已完成的） */
  quests: z.array(QuestSchema),
  clues: z.array(ClueSchema),
  progress: QuestProgressSchema.nullable(),
});
export type Journal = z.infer<typeof JournalSchema>;
