import type { ScriptEvent } from '@tavern/shared';

/**
 * 剧本事件的触发判定（纯函数，便于测）。
 *
 * 规则很简单但要写清楚：
 *   - 「第 N 轮」= 玩家第 N 次发言那一轮
 *   - 到点的事件（atTurn <= 当前轮）且没触发过的，这一轮全部触发
 *   - 排序按 atTurn 升序，保证同一轮里先发生早该发生的事
 */

export interface PickOptions {
  events: readonly ScriptEvent[];
  /** 已触发过的 id */
  fired: ReadonlySet<string>;
  /** 当前是第几轮（玩家第几次发言，从 1 开始） */
  turn: number;
}

export function pickEventsToFire({ events, fired, turn }: PickOptions): ScriptEvent[] {
  return [...events]
    .filter((event) => event.atTurn <= turn && !fired.has(event.id))
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
