import { z } from 'zod';
import { ChatMessageSchema, ContextBudgetOverrideSchema } from './chat.js';

/**
 * 上下文预览接口的契约。
 *
 * 这个接口不调模型，只回答一个问题：**这一轮到底会发给模型什么**。
 * 做角色扮演时 prompt 组装出错是最难排查的（模型行为怪，你根本不知道它看到了什么），
 * 所以把组装结果完整暴露出来，逐层可见。
 */

/** 预览请求：给角色 + 对话，返回组装明细。 */
export const ContextPreviewRequestSchema = z.object({
  characterId: z.string().min(1),
  /** 完整对话（最后一条是本次用户输入） */
  messages: z.array(ChatMessageSchema).min(1).max(200),
  /** {{user}} 的替换值 */
  userName: z.string().min(1).max(40).optional(),
  /** 覆盖默认预算，便于压测裁剪行为 */
  budget: ContextBudgetOverrideSchema.optional(),
});
export type ContextPreviewRequest = z.infer<typeof ContextPreviewRequestSchema>;

/** 预览里的一层。 */
export interface ContextLayerPayload {
  id: string;
  kind: string;
  title: string;
  content: string;
  tokens: number;
  priority: number;
  splittable: boolean;
  meta?: Record<string, unknown>;
}

/** 预览响应。 */
export interface ContextPreviewPayload {
  character: { id: string; name: string };
  /** 最终会发给模型的消息 */
  messages: { role: string; content: string; name?: string }[];
  /** 每一层（含 token 数），便于逐层展开 */
  layers: ContextLayerPayload[];
  /** 被预算裁掉的层 */
  dropped: ContextLayerPayload[];
  budget: {
    contextWindow: number;
    reservedForOutput: number;
    safetyMargin: number;
    available: number;
    used: number;
    truncated: boolean;
  };
  /** 命中的世界书条目 */
  worldbook: { id: string; title: string; keyword: string }[];
  /** 组装提示，例如「历史被裁到最近 6 条」 */
  notes: string[];
  /** 各部分占比，前端画条形图用 */
  breakdown: { kind: string; tokens: number; ratio: number }[];
}
