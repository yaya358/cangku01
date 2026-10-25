import type { ScriptEvent } from '@tavern/shared';

/**
 * 剧本事件的触发判定（纯函数，便于测）。
 *
 * 规则：
 *   1. 「第 N 轮」= 玩家第 N 次发言那一轮
 *   2. 到点（atTurn <= N）且没触发过 —— 基础条件
 *   3. 有 condition 时，还要求本轮扫描文本里出现其中任意一个关键词：
 *        「他信任你才说」这种只能靠关键词近似表达 —— 玩家得先提到那件事
 *   4. 多结局靠 isEnding：哪一幕是结局由作者标，触发后这一场就算演完
 */

export interface PickOptions {
  events: readonly ScriptEvent[];
  /** 已触发过的 id */
  fired: ReadonlySet<string>;
  /** 当前是第几轮（玩家第几次发言，从 1 开始） */
  turn: number;
  /** 用来判断条件的文本（本轮输入 + 最近历史） */
  text?: string;
}

/** 条件关键词是否命中；没有条件视为命中。 */
export function matchesCondition(condition: string, text: string): boolean {
  const keywords = condition
    .split(/[,，、;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (keywords.length === 0) return true;

  const haystack = text.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

export function pickEventsToFire({ events, fired, turn, text = '' }: PickOptions): ScriptEvent[] {
  return [...events]
    .filter((event) => event.atTurn <= turn && !fired.has(event.id))
    .filter((event) => matchesCondition(event.condition, text))
    .sort((left, right) => left.atTurn - right.atTurn);
}

/** 把事件转成上下文管线要的层输入。 */
export function toEventLayers(
  events: readonly ScriptEvent[],
): { id: string; title: string; content: string; turn: number }[] {
  return events.map((event) => ({
    id: event.id,
    title: event.title,
    content: event.content,
    turn: event.atTurn,
  }));
}
