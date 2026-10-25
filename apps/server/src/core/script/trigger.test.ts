import { describe, expect, it } from 'vitest';
import type { ScriptEvent } from '@tavern/shared';
import { pickEventsToFire, toEventLayers } from './trigger.js';

function event(id: string, atTurn: number, title = id): ScriptEvent {
  return {
    id,
    characterId: 'char-1',
    atTurn,
    title,
    content: `${title}的内容`,
    condition: '',
    isEnding: false,
    sets: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('剧本事件 · 触发判定', () => {
  it('到点的事件才触发', () => {
    const events = [event('e3', 3), event('e6', 6)];

    expect(pickEventsToFire({ events, fired: new Set(), turn: 1 })).toEqual([]);
    expect(pickEventsToFire({ events, fired: new Set(), turn: 2 })).toEqual([]);
    expect(pickEventsToFire({ events, fired: new Set(), turn: 3 }).map((item) => item.id)).toEqual([
      'e3',
    ]);
  });

  it('已经触发过的不再触发（防重复）', () => {
    const events = [event('e3', 3)];
    const fired = new Set(['e3']);
    expect(pickEventsToFire({ events, fired, turn: 10 })).toEqual([]);
  });

  it('跳轮时补上错过的事件，并按轮次排序', () => {
    const events = [event('e6', 6), event('e3', 3)];
    // 直接到第 7 轮：e3 与 e6 都该触发，且先 e3 后 e6
    expect(pickEventsToFire({ events, fired: new Set(), turn: 7 }).map((item) => item.id)).toEqual([
      'e3',
      'e6',
    ]);
  });

  it('同一轮里多个事件全部触发', () => {
    const events = [event('a', 2), event('b', 2)];
    expect(pickEventsToFire({ events, fired: new Set(), turn: 2 })).toHaveLength(2);
  });

  it('没有事件时返回空数组', () => {
    expect(pickEventsToFire({ events: [], fired: new Set(), turn: 5 })).toEqual([]);
  });
});

describe('剧本事件 · 条件触发', () => {
  it('没有条件时到点就触发', () => {
    const events = [event('e3', 3)];
    expect(pickEventsToFire({ events, fired: new Set(), turn: 3 })).toHaveLength(1);
  });

  it('有条件时要求文本里出现关键词', () => {
    const conditional = { ...event('e3', 3), condition: '那晚, 灯' };

    expect(
      pickEventsToFire({ events: [conditional], fired: new Set(), turn: 3, text: '今天天气' }),
    ).toEqual([]);
    expect(
      pickEventsToFire({
        events: [conditional],
        fired: new Set(),
        turn: 3,
        text: '我想问那晚的事',
      }),
    ).toHaveLength(1);
    expect(
      pickEventsToFire({ events: [conditional], fired: new Set(), turn: 3, text: '那盏灯没亮吧' }),
    ).toHaveLength(1);
  });

  it('关键词忽略大小写', () => {
    const conditional = { ...event('e3', 3), condition: 'Lighthouse' };
    expect(
      pickEventsToFire({
        events: [conditional],
        fired: new Set(),
        turn: 3,
        text: 'the lighthouse',
      }),
    ).toHaveLength(1);
  });

  it('轮次没到即使命中关键词也不触发', () => {
    const conditional = { ...event('e3', 3), condition: '那晚' };
    expect(
      pickEventsToFire({ events: [conditional], fired: new Set(), turn: 1, text: '那晚' }),
    ).toEqual([]);
  });
});

describe('剧本事件 · 转成上下文层', () => {
  it('保留标题、内容与触发轮次', () => {
    const layers = toEventLayers([event('e3', 3, '有人推门进来')]);
    expect(layers).toEqual([
      { id: 'e3', title: '有人推门进来', content: '有人推门进来的内容', turn: 3 },
    ]);
  });
});
