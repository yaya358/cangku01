import type { ChatMessage } from '@tavern/shared';

/**
 * 上下文引擎：把「角色设定 + 记忆 + 历史 + 本轮输入」拼成一次真实请求。
 *
 * 这是酒馆的核心。聊天框谁都能写，但要做到
 *   「提到某个地名就自动注入那段设定、聊了八十轮还记得开头、上下文窗口不爆」
 * 就必须有一层负责组装与预算的东西。
 *
 * 设计要点：
 *   1. 一切皆「层」（Layer），每层带来源、优先级、token 数，可被裁掉
 *   2. 组装结果与「为什么这么组装」一起返回，前端能逐层展开看
 *   3. token 是**估算**的：不引 tiktoken 这种重依赖，但估算规则要写明、可校准
 */

/** 层的来源分类，决定它在 prompt 里的位置与裁剪策略。 */
export type LayerKind =
  | 'system'
  | 'persona'
  | 'scenario'
  /** 秘密与目的：让角色有戏、会主动出招 */
  | 'motive'
  /** 玩家身份：你是谁、你图什么 —— 决定角色怎么对你说话 */
  | 'user_persona'
  /** 剧本事件：这一轮到点了，发生了什么事 */
  | 'event'
  /** 剧情事实：已经发生并成立的事（承认了、走了、死了） */
  | 'fact'
  | 'worldbook'
  | 'summary'
  | 'history'
  | 'post_history'
  | 'user_input';

/** 一层内容。 */
export interface ContextLayer {
  /** 稳定标识，例如 'persona'、'history:12'、'worldbook:王都' */
  id: string;
  kind: LayerKind;
  /** 展示用标题 */
  title: string;
  content: string;
  /** 估算 token 数 */
  tokens: number;
  /**
   * 预算不足时的保留优先级，数值越大越优先保留。
   * 必修层（system / user_input）用 1000 级，几乎不会被裁。
   */
  priority: number;
  /** 能否部分裁剪（历史可以丢掉最早的几条，人设只能整段砍或截断） */
  splittable: boolean;
  /** 附加信息，前端展示用（例如命中了哪个关键词） */
  meta?: Record<string, unknown>;
}

/** 预算信息。 */
export interface ContextBudget {
  /** 模型上下文窗口 */
  contextWindow: number;
  /** 留给输出的 token */
  reservedForOutput: number;
  /** 安全余量（估算误差） */
  safetyMargin: number;
  /** 实际可用于输入的量 */
  available: number;
  /** 组装后占用 */
  used: number;
  /** 被裁掉的层 */
  dropped: ContextLayer[];
  /** 是否发生了裁剪 */
  truncated: boolean;
}

/** 组装结果。 */
export interface AssembledContext {
  /** 最终发给模型的消息 */
  messages: ChatMessage[];
  /** 全部层（含被裁掉的，便于预览） */
  layers: ContextLayer[];
  budget: ContextBudget;
  /** 组装过程中的提示，例如「历史被裁到最近 6 条」 */
  notes: string[];
}

/** 组装输入。 */
export interface AssembleInput {
  /** 角色设定（只取需要的字段，避免耦合完整实体） */
  character: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    systemPrompt?: string;
    postHistoryInstructions?: string;
    mesExample?: string;
    /** 秘密：知道但绝不主动说，玩家试探到足够程度才可能松口 */
    secret?: string;
    /** 目的：它想从玩家这里得到什么，决定它会不会主动出招 */
    goal?: string;
  };
  /** 已有对话（不含本轮输入） */
  history: readonly ChatMessage[];
  /** 本轮用户输入 */
  userInput: string;
  /**
   * 输入方式：说的 / 做的 / 想的 / 旁白 / 场外。
   * 不填按说话处理 —— 老调用方不用改。
   */
  userInputKind?: 'speak' | 'act' | 'think' | 'narrate' | 'ooc';
  /**
   * 玩家身份：你是谁来、你图什么。
   * 不填时角色会把你当陌生人 —— 这是「对谁都客套」的根源。
   */
  player?: {
    /** 名字，默认「旅人」 */
    name?: string;
    /** 身份，例如「来讨债的」 */
    role?: string;
    /** 目的，例如「让他承认十四年前那件事」 */
    goal?: string;
  };
  /** 世界书命中条目（阶段 4 第三个提交接入） */
  worldbook?: readonly { id: string; title: string; content: string; keywords?: string[] }[];
  /**
   * 本轮触发的剧本事件。
   *
   * 与世界书的区别：世界书是「提到才注入的设定」，事件是「到点就发生的事」——
   * 前者是背景，后者是剧情推进。
   */
  events?: readonly { id: string; title: string; content: string; turn?: number }[];
  /**
   * 已经成立的剧情事实。
   *
   * 和事件的区别：事件是「刚刚发生」，事实是「已经算数、之后都不能反悔」——
   * 没有它，角色在你说「你刚才承认了」之后又会变回没事人。
   */
  facts?: readonly string[];
  /** 滚动摘要（阶段 6 接入） */
  summary?: string;
  /** 预算参数 */
  budget?: Partial<Pick<ContextBudget, 'contextWindow' | 'reservedForOutput' | 'safetyMargin'>>;
  /** {{user}} 的替换值 */
  userName?: string;
}

/** 全局默认系统提示；角色自己写了就用角色的。 */
export const DEFAULT_SYSTEM_PROMPT = [
  '你正在扮演一个虚构角色，与用户进行沉浸式角色扮演对话。',
  '始终保持角色一致性：用第一人称、符合角色性格的语气说话。',
  '不要提及自己是 AI、模型或程序，不要跳出角色解释设定。',
  '回复以角色的话语与动作为主，长度适中（通常 2~5 句），避免长篇独白。',
  /**
   * 行动合理性：玩家能宣称任何事，但世界不负责配合。
   *
   * 关键是不让模型"拒绝"玩家（那很扫兴），而是让**世界**不配合 ——
   * 失败、被当吹牛、只产生很小的效果，都比系统口吻的拒绝好。
   */
  '玩家只能做到他这个身份做得到的事。若玩家宣称了不可能的行动',
  '（例如一击毁灭城市、凭空夺走他人性命），不要把世界写崩：',
  '让行动失败、被旁人当成吹牛、或只产生极小的效果，并借周围人的反应说明为什么行不通。',
  '永远不要用系统口吻拒绝或说教，要在故事里让这件事不成立。',
].join('\n');

/** 默认预算：上下文 8K、输出留 1K、余量 128。 */
export const DEFAULT_BUDGET = {
  contextWindow: 8192,
  reservedForOutput: 1024,
  safetyMargin: 128,
} as const;
