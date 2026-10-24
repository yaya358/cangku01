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

/** 流式/非流式共用的请求体。 */
export const ChatRequestBodySchema = z.object({
  /** provider 名；不传就用注册表里优先级最高的那个 */
  provider: z.string().min(1).optional(),
  /** 模型名；不传就用 provider 的默认模型 */
  model: z.string().min(1).optional(),
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
  | { type: 'start'; traceId: string; provider: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: ChatUsage }
  | {
      type: 'done';
      finishReason: string | null;
      durationMs: number;
      firstTokenMs: number | null;
      usage?: ChatUsage;
    }
  | { type: 'error'; code: string; message: string; retryable: boolean };

/** 非流式接口的返回体。 */
export interface ChatResultPayload {
  text: string;
  model: string;
  finishReason: string | null;
  durationMs: number;
  usage?: ChatUsage;
}

/** provider 列表项（给设置面板用）。 */
export interface ProviderInfo {
  name: string;
  model: string;
  state: string;
  capabilities: string[];
  hasCredentials: boolean;
}
