import { z } from 'zod';

/**
 * 会话与消息契约。
 *
 * 设计上比"聊天记录表"多两个东西：
 *   - parentId：消息之间是树而不是链，为「从任意一句开新分支」留位置
 *   - swipes：同一条消息位置上的多个候选回复（重说），index 指向当前选中
 * 一次性把表结构定好，后面加重说/分支就不需要再迁移。
 */

/** 消息角色。 */
export const MESSAGE_ROLES = ['system', 'user', 'assistant'] as const;
export const MessageRoleSchema = z.enum(MESSAGE_ROLES);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/** token 用量（与 chat 契约保持一致，单独定义避免循环依赖）。 */
export const MessageUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type MessageUsage = z.infer<typeof MessageUsageSchema>;

/** 一条消息。 */
export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** 树结构：父消息 id；根消息为 null */
  parentId: z.string().nullable(),
  role: MessageRoleSchema,
  content: z.string(),
  /** 重说的候选内容；空数组表示没有候选（普通消息） */
  swipes: z.array(z.string()),
  /** 当前选中的候选下标 */
  swipeIndex: z.number().int().nonnegative(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  usage: MessageUsageSchema.nullable(),
  finishReason: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  firstTokenMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

/** 会话（列表用，带统计信息）。 */
export const ConversationSchema = z.object({
  id: z.string(),
  characterId: z.string(),
  /** 角色名快照，列表里不必再查一次角色 */
  characterName: z.string(),
  title: z.string(),
  /** 当前对话树所在的叶子，恢复上下文时用 */
  activeLeafId: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
  /** 最后一条消息的摘要，列表里显示 */
  preview: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/** 新建会话。 */
export const CreateConversationSchema = z.object({
  characterId: z.string().min(1),
  title: z.string().max(120).optional(),
});
export type CreateConversationInput = z.infer<typeof CreateConversationSchema>;

/** 改标题。 */
export const UpdateConversationSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  activeLeafId: z.string().nullable().optional(),
});
export type UpdateConversationInput = z.infer<typeof UpdateConversationSchema>;

/** 追加消息（由服务端在生成完成后写库，也允许手动插入 user 消息）。 */
export const AppendMessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.string().max(200_000),
  parentId: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  usage: MessageUsageSchema.optional(),
  finishReason: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  firstTokenMs: z.number().int().nonnegative().optional(),
});
export type AppendMessageInput = z.infer<typeof AppendMessageSchema>;
