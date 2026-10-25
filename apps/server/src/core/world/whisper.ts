import type { Message } from '@tavern/shared';

/**
 * 低声说的话，谁知道它。
 *
 * 这一条是世界模式「信息是有代价的」的底账：同一场对话里，低声说出口的内容
 * 不能默认所有人都知道 —— 否则「有没有被听见」就只影响一条提示，不影响世界。
 *
 * 谁算知道：
 *   - 正主：说完之后紧接着回答的那条助手消息的发言人（你就是在对他低声说）
 *   - 偷听者：之后那条标了 eavesdrop 的助手消息的发言人（他听见了并作出了反应）
 * 其余在场的人，只该知道「有人凑在别人耳边说了几句」。
 *
 * 做成纯函数是因为这段判定完全靠消息关系，跟数据库、模型都无关：
 * 给一串按时间排好的消息，就能算出谁知道什么。
 */

/** whisper 消息 id → 知道它的角色 id 集合。 */
export type WhisperAudience = Map<string, Set<string>>;

/** 没听清时给模型看到的替代文本（保留「有人在私聊」这件事，但不给内容）。 */
export const INAUDIBLE_PLACEHOLDER = '（有人凑在别人耳边低声说了几句，你没听清内容。）';

export function whisperAudience(messages: readonly Message[]): WhisperAudience {
  const audience: WhisperAudience = new Map();

  /** 当前还没被回答的那句低声话 */
  let pending: string | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      // 换了一轮：上一条低声话的偷听反应不会再来晚了
      pending = message.whisper ? message.id : null;
      if (message.whisper) audience.set(message.id, new Set());
      continue;
    }

    if (message.role !== 'assistant' || !pending) continue;
    const known = audience.get(pending);
    if (!known) continue;

    // 正主：回答了这句低声话的人
    if (message.parentId === pending && message.speakerId) known.add(message.speakerId);
    // 偷听者：听见之后插进来的那条反应
    if (message.eavesdrop && message.speakerId) known.add(message.speakerId);
  }

  return audience;
}

/**
 * 给某个发言者看的历史内容。
 *
 * 不是正主、也没听见的人，看到的是占位文本而不是原话。
 * 这不是为了骗玩家：角色确实不知道，让他知道才是不公平的。
 */
export function contentForSpeaker(
  message: Message,
  speakerId: string,
  audience: WhisperAudience,
): string {
  if (!message.whisper) return message.content;
  return audience.get(message.id)?.has(speakerId) ? message.content : INAUDIBLE_PLACEHOLDER;
}
