import type { ChatMessage, ContextBudgetOverride, ContextPreviewPayload } from '@tavern/shared';
import { CONTEXT_PREVIEW_ENDPOINT } from '@tavern/shared';
import { apiPost } from './client';

/**
 * 上下文预览。
 *
 * 不调模型、不花钱，只是让后端把「这一轮会发给模型什么」摊开。
 * 调试角色扮演时这是最有用的一个接口：模型答得怪，先看它到底看到了什么。
 */
export interface PreviewRequest {
  characterId: string;
  /** 完整对话，最后一条是本轮输入 */
  messages: ChatMessage[];
  userName?: string;
  budget?: ContextBudgetOverride;
}

export function previewContext(body: PreviewRequest): Promise<ContextPreviewPayload> {
  return apiPost<ContextPreviewPayload>(CONTEXT_PREVIEW_ENDPOINT, body, { timeoutMs: 15_000 });
}
