import { z } from 'zod';

/**
 * 好感度契约。
 *
 * 它不是一个越涨越好的分数，而是「他对你的态度」的一把尺：
 *   0 ────── 20 ────────────── 60 ────── 100
 *   冷处理    普通         松口给情报
 *
 * 规则写在这里而不是前端，因为同一组阈值要同时决定：
 * 界面上的刻度、提示词里的语气、以及（第 5 步）什么时候给情报。
 */

/** 初始值：刚认识，不冷不热。 */
export const AFFINITY_INITIAL = 50;

/** 到了这个数，他愿意松口（多说一点、漏一点底）。 */
export const AFFINITY_OPEN = 60;

/** 低于这个数，他冷处理（只答必要的，不主动推进）。 */
export const AFFINITY_COLD = 20;

/** 取值范围：夹在两端，不会溢出成负好感或无限好感。 */
export const AFFINITY_MIN = 0;
export const AFFINITY_MAX = 100;

/** 单轮的加减分上限。 */
export const AFFINITY_DELTA_LIMIT = 5;

/** 此刻的态度。 */
export const AFFINITY_MOODS = ['open', 'neutral', 'cold'] as const;
export const AffinityMoodSchema = z.enum(AFFINITY_MOODS);
export type AffinityMood = z.infer<typeof AffinityMoodSchema>;

export const AffinitySchema = z.object({
  saveId: z.string(),
  characterId: z.string(),
  /** 角色名快照：列表与界面直接用，不必再查一次 */
  characterName: z.string(),
  value: z.number().int().min(AFFINITY_MIN).max(AFFINITY_MAX),
  /** 上一轮为什么加分或减分（一行话，界面显示） */
  lastReason: z.string(),
  /** 已经触发过的阈值点（affinity:open / affinity:cold），不会重复触发 */
  unlocked: z.array(z.string()),
  updatedAt: z.string(),
});
export type Affinity = z.infer<typeof AffinitySchema>;

/** 按数值判断态度。 */
export function affinityMood(value: number): AffinityMood {
  if (value >= AFFINITY_OPEN) return 'open';
  if (value <= AFFINITY_COLD) return 'cold';
  return 'neutral';
}
