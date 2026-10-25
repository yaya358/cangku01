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

/**
 * 玩家的输入方式。
 *
 * 为什么要它：同一句「推开门」，当成说话（"推开门"）和当行动（推开门）
 * 交给模型会得到完全不同的结果。分开表达，模型不用猜，前端也能分样式渲染。
 */
export const MESSAGE_KINDS = ['speak', 'act', 'think', 'narrate', 'ooc'] as const;
export const MessageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof MessageKindSchema>;

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
  /** 输入方式：说的 / 做的 / 想的 / 旁白 / 场外 */
  kind: MessageKindSchema,
  /** 大厅里这句是谁说的（一对一为 null） */
  speakerId: z.string().nullable(),
  /** 这句是压低声音说的：同场的人有机会听不到 */
  whisper: z.boolean(),
  /**
   * 这条不是正常接话，是第三者听见私聊之后的反应。
   * 单独标出来的用处：界面上要标「他听见了」，轮转时也不能算作「轮到他说话」。
   */
  eavesdrop: z.boolean(),
  /**
   * 世界插进对话里的旁白：opening = 进门时那一下，chapter = 进入新一章时的局面。
   * 这两种都要在界面上单独渲染（不是谁说的话），所以单独标出来。
   */
  beat: z.enum(['opening', 'chapter']).nullable(),
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

/** 玩家在这一轮里的身份（决定角色怎么对你说话）。 */
export const PlayerSchema = z.object({
  /** 名字，进 prompt 的 {{user}} */
  name: z.string().max(40),
  /** 身份，例如「来讨债的」 */
  role: z.string().max(200),
  /** 你图什么，例如「让他承认十四年前那件事」 */
  goal: z.string().max(400),
});
export type Player = z.infer<typeof PlayerSchema>;

/** 大厅里在场的一个角色。 */
export const ConversationMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type ConversationMember = z.infer<typeof ConversationMemberSchema>;

/** 会话（列表用，带统计信息）。 */
export const ConversationSchema = z.object({
  id: z.string(),
  characterId: z.string(),
  /** 角色名快照，列表里不必再查一次角色 */
  characterName: z.string(),
  title: z.string(),
  /** 当前对话树所在的叶子，恢复上下文时用 */
  activeLeafId: z.string().nullable(),
  /** 在场角色（大厅模式）；一对一为空数组 */
  members: z.array(ConversationMemberSchema),
  /** 玩家身份；三项都为空表示没设定 */
  player: PlayerSchema,
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
  /** 可选：开局就带上身份 */
  player: PlayerSchema.partial().optional(),
  /** 归属场景（世界模式）；一对一会话不填 */
  sceneId: z.string().min(1).optional(),
  /** 传了就开成大厅：这些角色同时在场 */
  memberIds: z.array(z.string().min(1)).max(8).optional(),
});
export type CreateConversationInput = z.infer<typeof CreateConversationSchema>;

/** 改标题 / 切分支 / 改身份。 */
export const UpdateConversationSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  activeLeafId: z.string().nullable().optional(),
  player: PlayerSchema.partial().optional(),
});
export type UpdateConversationInput = z.infer<typeof UpdateConversationSchema>;

/** 追加消息（由服务端在生成完成后写库，也允许手动插入 user 消息）。 */
export const AppendMessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.string().max(200_000),
  /** 不传就是「说话」，老调用方不用改 */
  kind: MessageKindSchema.optional(),
  /** 压低声音说（世界模式里同场的人有机会听不到） */
  whisper: z.boolean().optional(),
  /** 偷听者的反应（由服务端在判定命中后写入，前端不传） */
  eavesdrop: z.boolean().optional(),
  /** 世界插的旁白：进门那一下 / 新一章的局面 */
  beat: z.enum(['opening', 'chapter']).optional(),
  /** 大厅里这条是谁说的 */
  speakerId: z.string().optional(),
  parentId: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  usage: MessageUsageSchema.optional(),
  finishReason: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  firstTokenMs: z.number().int().nonnegative().optional(),
});
export type AppendMessageInput = z.infer<typeof AppendMessageSchema>;

/** 编辑消息正文。 */
export const EditMessageSchema = z.object({
  content: z.string().max(200_000),
});
export type EditMessageInput = z.infer<typeof EditMessageSchema>;

/** 一条分支的摘要（对话树切换器用）。 */
export const BranchSummarySchema = z.object({
  leafId: z.string(),
  messageCount: z.number().int().nonnegative(),
  preview: z.string(),
});
export type BranchSummary = z.infer<typeof BranchSummarySchema>;

/**
 * 会话详情：会话 + 当前分支的消息 + 所有分支。
 *
 * messages 取的是「根 → activeLeafId」这条路径，不是全部消息 ——
 * 否则分叉的两支会混在一起。
 */
export const ConversationDetailSchema = z.object({
  conversation: ConversationSchema,
  messages: z.array(MessageSchema),
  branches: z.array(BranchSummarySchema),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

/**
 * 发一句话（触发一轮生成）。
 *
 * 这一轮会发生：写入 user 消息 → 组装上下文 → 流式生成 → 写入 assistant 消息。
 * 所以前端不需要自己管落库，刷新后记录仍在。
 *
 * `parentId` 指向要接在哪条消息之后：不传就接在当前叶子后面（正常聊天），
 * 传了就是从那条消息分叉出新的一条时间线（原来那支保留）。
 */
export const SendMessageSchema = z.object({
  content: z.string().min(1, '消息不能为空').max(20_000),
  /** 这句是说的还是做的；默认说话 */
  kind: MessageKindSchema.default('speak'),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  userName: z.string().min(1).max(40).optional(),
  parentId: z.string().min(1).optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageSchema>;
