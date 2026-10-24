import { describe, expect, it } from 'vitest';
import { scanWorldbook, toWorldbookLayers } from './scan.js';
import type { WorldbookEntry } from './scan.js';

function entry(overrides: Partial<WorldbookEntry> & { id: string }): WorldbookEntry {
  return {
    title: overrides.id,
    keys: [],
    content: '',
    ...overrides,
  };
}

describe('世界书扫描 · 基础命中', () => {
  it('关键词命中就触发，并记录命中的是哪个词', () => {
    const entries = [
      entry({ id: 'city', title: '王都', keys: ['王都', '首都'], content: '王都是座不夜城。' }),
    ];

    const result = scanWorldbook(entries, '我想去王都看看');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.keyword).toBe('王都');
    expect(result.hits[0]?.entry.title).toBe('王都');
  });

  it('没提到就不触发（这是世界书省 token 的关键）', () => {
    const entries = [entry({ id: 'city', keys: ['王都'], content: '王都是座不夜城。' })];
    expect(scanWorldbook(entries, '今晚喝什么').hits).toEqual([]);
  });

  it('默认忽略大小写，可关闭', () => {
    const entries = [entry({ id: 'npc', keys: ['Aria'], content: 'Aria 是吟游诗人。' })];

    expect(scanWorldbook(entries, 'aria 来了吗').hits).toHaveLength(1);
    expect(
      scanWorldbook(
        [entry({ id: 'npc', keys: ['Aria'], content: 'x', caseSensitive: true })],
        'aria',
      ).hits,
    ).toHaveLength(0);
  });

  it('空关键词不会全量触发', () => {
    const entries = [entry({ id: 'bad', keys: ['', '  '], content: '不该被触发' })];
    expect(scanWorldbook(entries, '任何文本').hits).toEqual([]);
  });

  it('次要关键词要求主次同时命中', () => {
    const entries = [
      entry({
        id: 'black-market',
        title: '黑市',
        keys: ['市场'],
        secondaryKeys: ['黑'],
        content: '黑市只在午夜开张。',
      }),
    ];

    expect(scanWorldbook(entries, '去市场买菜').hits).toHaveLength(0);
    expect(scanWorldbook(entries, '听说有个黑市场').hits).toHaveLength(1);
  });

  it('禁用的条目不参与', () => {
    const entries = [entry({ id: 'off', keys: ['王都'], content: 'x', enabled: false })];
    expect(scanWorldbook(entries, '王都').hits).toEqual([]);
  });

  it('常驻条目不看关键词', () => {
    const entries = [
      entry({
        id: 'rules',
        title: '世界观',
        keys: [],
        content: '这是一个魔法世界。',
        constant: true,
      }),
    ];
    const result = scanWorldbook(entries, '随便说点什么');

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.keyword).toBe('(常驻)');
  });
});

describe('世界书扫描 · 递归链式触发', () => {
  it('条目内容里提到别的关键词会继续触发', () => {
    const entries = [
      entry({ id: 'city', title: '王都', keys: ['王都'], content: '王都有条黑市街。' }),
      entry({ id: 'black', title: '黑市', keys: ['黑市'], content: '黑市卖违禁品。' }),
    ];

    const result = scanWorldbook(entries, '我们进王都吧');

    expect(result.hits.map((hit) => hit.entry.id).sort()).toEqual(['black', 'city']);
    expect(result.passes).toBe(2);
    // 黑市是第二轮才发现的
    expect(result.hits.find((hit) => hit.entry.id === 'black')?.pass).toBe(1);
  });

  it('循环引用不会死循环（A→B→A）', () => {
    const entries = [
      entry({ id: 'a', title: 'A', keys: ['甲'], content: '甲提到乙。' }),
      entry({ id: 'b', title: 'B', keys: ['乙'], content: '乙又提到甲。' }),
    ];

    const result = scanWorldbook(entries, '说说甲');

    expect(result.hits).toHaveLength(2);
    expect(result.passes).toBeLessThanOrEqual(3);
  });

  it('超过轮次上限就停', () => {
    const entries = [
      entry({ id: 'l1', keys: ['一'], content: '继续说二' }),
      entry({ id: 'l2', keys: ['二'], content: '继续说三' }),
      entry({ id: 'l3', keys: ['三'], content: '继续说四' }),
      entry({ id: 'l4', keys: ['四'], content: '结束' }),
    ];

    const result = scanWorldbook(entries, '一开始', { maxPasses: 1 });
    // 只扫 1 轮：命中「一」，其内容触发的「二」不会在这一轮继续扩散
    expect(result.hits.map((hit) => hit.entry.id)).toEqual(['l1']);
  });

  it('条数上限会截断并统计被跳过的数量', () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({ id: `e${index}`, keys: ['关键词'], content: '内容', priority: index }),
    );

    const result = scanWorldbook(entries, '关键词', { maxEntries: 3 });
    expect(result.hits).toHaveLength(3);
    expect(result.skipped).toBe(7);
    // 高优先级的先留下
    expect(result.hits.map((hit) => hit.entry.id)).toEqual(['e9', 'e8', 'e7']);
  });

  it('已经触发过的条目不会重复注入', () => {
    const entries = [entry({ id: 'city', keys: ['王都'], content: '王都' })];
    const result = scanWorldbook(entries, '王都', { alreadyTriggered: ['city'] });

    expect(result.hits).toEqual([]);
  });
});

describe('世界书扫描 · 排序与转换', () => {
  it('按 priority 降序，同优先级按发现顺序', () => {
    const entries = [
      entry({ id: 'low', keys: ['酒'], content: 'x', priority: 1 }),
      entry({ id: 'high', keys: ['酒'], content: 'y', priority: 100 }),
      entry({ id: 'mid', keys: ['酒'], content: 'z', priority: 50 }),
    ];

    const result = scanWorldbook(entries, '来点酒');
    expect(result.hits.map((hit) => hit.entry.id)).toEqual(['high', 'mid', 'low']);
  });

  it('toWorldbookLayers 转成管线要的结构', () => {
    const result = scanWorldbook(
      [entry({ id: 'city', title: '王都', keys: ['王都'], content: '王都是座不夜城。' })],
      '去王都',
    );

    expect(toWorldbookLayers(result.hits)).toEqual([
      { id: 'city', title: '王都', content: '王都是座不夜城。', keywords: ['王都'] },
    ]);
  });
});
