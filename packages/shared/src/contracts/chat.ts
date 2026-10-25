import { z } from 'zod';

/**
 * 对话接口的契约（请求体 + SSE 事件）。
 *
 * 放在 shared 里的原因：前端要发请求、要解析流，字段一变两端同时报错，
 * 不用靠记忆对齐。
 */

/** 对话角色。 */
export const ChatRoleSchema = z.enum(['system', 'user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

/** 一条消息。 */
export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
  /** 群聊里区分说话人 */
  name: z.string().min(1).max(64).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** 采样参数，全部可选，不传就用上游默认。 */
export const SamplingParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().min(1).max(131_072).optional(),
  stop: z.array(z.string().min(1)).max(8).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
});
export type SamplingParams = z.infer<typeof SamplingParamsSchema>;

/** 上下文预算覆盖（压测与调试用，正常不必传）。 */
export const ContextBudgetOverrideSchema = z
  .object({
    contextWindow: z.number().int().min(256).max(2_000_000),
    reservedForOutput: z.number().int().min(0).max(500_000),
    safetyMargin: z.number().int().min(0).max(100_000),
  })
  .partial();
export type ContextBudgetOverride = z.infer<typeof ContextBudgetOverrideSchema>;

/** 流式/非流式共用的请求体。 */
export const ChatRequestBodySchema = z.object({
  /** provider 名；不传就用注册表里优先级最高的那个 */
  provider: z.string().min(1).optional(),
  /** 模型名；不传就用 provider 的默认模型 */
  model: z.string().min(1).optional(),
  /**
   * 用哪个角色。
   * 传了就走上下文引擎（人设 + 世界书 + 预算裁剪）；
   * 不传就走「裸对话」（messages 原样发给模型），供试话页调试用。
   */
  characterId: z.string().min(1).optional(),
  /** {{user}} 的替换值 */
  userName: z.string().min(1).max(40).optional(),
  /** 覆盖上下文预算 */
  budget: ContextBudgetOverrideSchema.optional(),
  messages: z.array(ChatMessageSchema).min(1, '至少需要一条消息').max(200),
  params: SamplingParamsSchema.optional(),
});
export type ChatRequestBody = z.infer<typeof ChatRequestBodySchema>;

/** token 用量。上游不返回时整体为 undefined。 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * SSE 事件。
 *
 * 服务端把每个事件序列化成 `data: {json}\n\n`，
 * 前端用 fetch + ReadableStream 逐行读即可，不需要 EventSource
 * （EventSource 只支持 GET，发不了 JSON 请求体）。
 */
export type ChatStreamPayload =
  | {
      type: 'start';
      traceId: string;
      provider: string;
      model: string;
      /** 用了哪个角色（走上下文引擎时才有） */
      character?: { id: string; name: string };
      /** 本轮上下文占用的估算 token */
      contextTokens?: number;
      /** 命中的世界书条目数 */
      worldbookHits?: number;
    }
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: ChatUsage }
  | {
      type: 'done';
      finishReason: string | null;
      durationMs: number;
      firstTokenMs: number | null;
      usage?: ChatUsage;
    }
  | {
      /** 会话模式下，一轮结束后落库的消息 id */
      type: 'saved';
      userMessageId: string;
      assistantMessageId: string;
    }
  | {
      /** 重说完成：这条消息多了一个候选并已切过去 */
      type: 'swiped';
      messageId: string;
      swipeIndex: number;
      total: number;
    }
  | {
      /** 剧本事件触发：这一轮发生了什么（前端插一条居中提示） */
      type: 'notice';
      eventId: string;
      title: string;
      content: string;
      atTurn: number;
      /** 这一幕是结局 */
      isEnding: boolean;
    }
  | {
      /**
       * 低声说话的结果：被谁听见了 / 没人注意到。
       *
       * 没听见也发这一帧 —— 玩家需要确定的反馈，否则永远不知道自己安不安全。
       */
      type: 'eavesdrop';
      heard: boolean;
      /** 谁听见了（heard 为 true 时才有） */
      listener?: { id: string; name: string };
      /** 听见后生成的那句反应（已落库，前端插进对话流） */
      messageId?: string;
      /** 给玩家看的那句话（没听见时是「没人注意到」，措辞由服务端统一） */
      text: string;
      /** 听见的内容碰到了他的秘密 */
      sensitive?: boolean;
    }
  | {
      /**
       * 这一轮他对你的好感变化。
       *
       * failed 为 true 表示评分没跑成：不加减、也不骗玩家说是 0 分的变化。
       */
      type: 'affinity';
      characterId: string;
      name: string;
      /** 变化后的数值 */
      value: number;
      delta: number;
      reason: string;
      mood: 'open' | 'neutral' | 'cold';
      failed?: boolean;
    }
  | {
      /** 你拿到了一条新情报（侧栏的情报本要立刻多一条） */
      type: 'clue';
      clueId: string;
      content: string;
      /** 谁说的；你自己看出来的为空 */
      source: string | null;
      sourceTurn: number | null;
      /** 原话（展开看） */
      quote: string | null;
    }
  | {
      /** 这一章过去了，进入下一章（或者全部演完） */
      type: 'quest';
      chapter: number;
      /** 新一章的标题；演完则为 null */
      title: string | null;
      goal: string | null;
      /** 全部章节是否已经演完 */
      finished: boolean;
    }
  | { type: 'error'; code: string; message: string; retryable: boolean };

/** 非流式接口的返回体。 */
export interface ChatResultPayload {
  text: string;
  model: string;
  finishReason: string | null;
  durationMs: number;
  usage?: ChatUsage;
  /** 用了哪个角色（走上下文引擎时才有） */
  character?: { id: string; name: string };
  /** 本轮上下文占用的估算 token */
  contextTokens?: number;
  /** 命中的世界书条目数 */
  worldbookHits?: number;
}

/** provider 列表项（给设置面板用）。 */
export interface ProviderInfo {
  name: string;
  model: string;
  state: string;
  capabilities: string[];
  hasCredentials: boolean;
}
