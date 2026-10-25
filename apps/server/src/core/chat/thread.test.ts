import { describe, expect, it } from 'vitest';
import type { Message } from '@tavern/shared';
import { childrenOf, listLeaves, resolveThread, summarizeBranches } from './thread.js';

/** 造一条消息，只需 id/parent/内容，其余字段补默认值。 */
function msg(id: string, parentId: string | null, content: string, at: number): Message {
  return {
    id,
    conversationId: 'conv',
    parentId,
    role: id.startsWith('a') ? 'assistant' : 'user',
    content,
    swipes: [],
    swipeIndex: 0,
    model: null,
    provider: null,
    usage: null,
    finishReason: null,
    durationMs: null,
    firstTokenMs: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString(),
  };
}

/**
 * 场景树：
 *   a1(开场白) → u2 → a3 → u4
 *                  └→ u5 → a6
 */
function sampleTree(): Message[] {
  return [
    msg('a1', null, '开场白', 0),
    msg('u2', 'a1', '来一杯', 1),
    msg('a3', 'u2', '第一版回复', 2),
    msg('u4', 'a3', '继续聊', 3),
    msg('u5', 'u2', '换条路走', 4),
    msg('a6', 'u5', '另一条路的回复', 5),
  ];
}

describe('对话树 · 线程解析', () => {
  it('从叶子回溯到根，返回根→叶顺序', () => {
    const thread = resolveThread(sampleTree(), 'u4');
    expect(thread.map((message) => message.id)).toEqual(['a1', 'u2', 'a3', 'u4']);
  });

  it('同一个分叉点走另一支，只拿到那一支的消息', () => {
    const thread = resolveThread(sampleTree(), 'a6');
    expect(thread.map((message) => message.id)).toEqual(['a1', 'u2', 'u5', 'a6']);
  });

  it('不指定叶子时取最新的一条', () => {
    const thread = resolveThread(sampleTree());
    expect(thread.at(-1)?.id).toBe('a6');
  });

  it('空会话返回空数组', () => {
    expect(resolveThread([])).toEqual([]);
  });

  it('parent 指向不存在的消息时安全停止', () => {
    const broken = [msg('a1', 'ghost', '孤儿消息', 0)];
    expect(resolveThread(broken, 'a1').map((message) => message.id)).toEqual(['a1']);
  });

  it('parent 链成环时不会死循环', () => {
    const looped = [msg('a1', 'u2', 'A', 0), msg('u2', 'a1', 'B', 1)];
    expect(resolveThread(looped, 'a1').length).toBeLessThanOrEqual(2);
  });
});

describe('对话树 · 叶子与分支摘要', () => {
  it('叶子是没有子消息的那些', () => {
    const leaves = listLeaves(sampleTree());
    expect(leaves.map((message) => message.id)).toEqual(['u4', 'a6']);
  });

  it('分支摘要带上每支的消息数与末尾摘要', () => {
    const branches = summarizeBranches(sampleTree());

    expect(branches).toHaveLength(2);
    const first = branches.find((item) => item.leafId === 'u4');
    const second = branches.find((item) => item.leafId === 'a6');
    // a1 → u2 → a3 → u4
    expect(first?.messageCount).toBe(4);
    expect(second?.messageCount).toBe(4);
    expect(first?.preview).toBe('继续聊');
    expect(second?.preview).toBe('另一条路的回复');
  });

  it('childrenOf 给出分叉点上的所有下一句', () => {
    const kids = childrenOf(sampleTree(), 'u2');
    expect(kids.map((message) => message.id)).toEqual(['a3', 'u5']);
  });

  it('线性会话只有一个叶子', () => {
    const linear = [msg('a1', null, '开场白', 0), msg('u2', 'a1', '你好', 1)];
    expect(listLeaves(linear)).toHaveLength(1);
    expect(listLeaves(linear)[0]?.id).toBe('u2');
  });
});
