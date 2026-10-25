import type { Message } from '@tavern/shared';

/**
 * 对话树的操作。
 *
 * 消息不是链表而是树（parent_id）：
 *
 *       开场白 ── 我:来一杯 ── 它:第一版 ── 我:再来
 *            └── 我:换条路 ── 它:另一条路
 *
 * 「当前在聊哪一支」由 conversations.active_leaf_id 指出，
 * 上下文永远只取「从根到该叶子的那条路径」，所以分叉之间互不污染。
 */

/** 稳定排序：先按创建时间，同一毫秒用 id 兜底。 */
function sorted(messages: readonly Message[]): Message[] {
  return [...messages].sort((left, right) => {
    if (left.createdAt === right.createdAt) return left.id < right.id ? -1 : 1;
    return left.createdAt < right.createdAt ? -1 : 1;
  });
}

/**
 * 从叶子沿 parent 链回溯到根，返回**根→叶**顺序。
 *
 * 没指定叶子时取创建时间最晚的那条（新建会话、老数据都适用）。
 * 遇到环（理论上不该有）就停下，不让它把进程转死。
 */
export function resolveThread(messages: readonly Message[], leafId?: string | null): Message[] {
  if (messages.length === 0) return [];

  const byId = new Map(messages.map((message) => [message.id, message]));
  const ordered = sorted(messages);
  let current = leafId ? byId.get(leafId) : undefined;
  if (!current) current = ordered[ordered.length - 1];

  const path: Message[] = [];
  const seen = new Set<string>();

  while (current) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return path.reverse();
}

/** 叶子 = 没有子消息的消息（每条叶子代表一个分支的末端）。 */
export function listLeaves(messages: readonly Message[]): Message[] {
  const parents = new Set<string>();
  for (const message of messages) {
    if (message.parentId) parents.add(message.parentId);
  }
  return sorted(messages).filter((message) => !parents.has(message.id));
}

/** 分支摘要，给前端的切换器用。 */
export interface BranchSummary {
  leafId: string;
  /** 这条分支上有多少条消息 */
  messageCount: number;
  /** 叶子那条消息的正文摘要 */
  preview: string;
}

/** 每个叶子一条摘要。 */
export function summarizeBranches(messages: readonly Message[]): BranchSummary[] {
  return listLeaves(messages).map((leaf) => ({
    leafId: leaf.id,
    messageCount: resolveThread(messages, leaf.id).length,
    preview: leaf.content.replace(/\s+/g, ' ').slice(0, 60),
  }));
}

/** 某条消息的直接子消息（用于判断「这里能不能算分叉点」）。 */
export function childrenOf(messages: readonly Message[], messageId: string): Message[] {
  return messages.filter((message) => message.parentId === messageId);
}
