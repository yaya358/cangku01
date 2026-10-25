import { z } from 'zod';

/**
 * 剧本事件契约。
 *
 * 一个角色的「小剧本」= 若干条按轮次触发的事件：
 *   第 3 轮：一个客人推门进来，看见老板就愣住了
 *   第 6 轮：那人掏出一张旧通缉令
 *
 * 事件由服务端在每一轮开始时判定并注入上下文，
 * 玩家不需要自己推动剧情 —— 戏会往前走。
 */

const MAX_CONTENT = 4_000;

export const ScriptEventSchema = z.object({
  id: z.string(),
  characterId: z.string(),
  /** 在第几轮触发（按用户发言次数计，从 1 开始） */
  atTurn: z.number().int().min(1).max(500),
  title: z.string(),
  /** 注入上下文的描述：发生了什么 */
  content: z.string(),
  /** 条件关键词（逗号分隔）：非空时还要求玩家说过其中某个词 */
  condition: z.string(),
  /** 这一幕是结局 */
  isEnding: z.boolean(),
  /** 触发后写入的剧情事实（会一直注入后续对话） */
  sets: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScriptEvent = z.infer<typeof ScriptEventSchema>;

export const ScriptEventInputSchema = z.object({
  atTurn: z.number().int().min(1).max(500),
  title: z.string().min(1, '标题不能为空').max(80),
  content: z.string().min(1, '内容不能为空').max(MAX_CONTENT),
  condition: z.string().max(200).default(''),
  isEnding: z.boolean().default(false),
  sets: z.string().max(400).default(''),
});
export type ScriptEventInput = z.infer<typeof ScriptEventInputSchema>;

export const ScriptEventPatchSchema = ScriptEventInputSchema.partial();
export type ScriptEventPatch = z.infer<typeof ScriptEventPatchSchema>;

/** 聊天里给玩家看的事件提示（SSE）。 */
export const EventNoticeSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  atTurn: z.number().int(),
  /** 这一幕是结局 */
  isEnding: z.boolean(),
});
export type EventNotice = z.infer<typeof EventNoticeSchema>;

/** 会话里已经成立的剧情事实。 */
export const ConversationFactSchema = z.object({
  content: z.string(),
  sourceEventId: z.string(),
  createdAt: z.string(),
});
export type ConversationFact = z.infer<typeof ConversationFactSchema>;

/**
 * 一份可分享的剧本。
 *
 * 导出它就能把整场戏发给别人，导入后一幕不差地重演 ——
 * 「人人能写戏」的最后一步就是把剧本变成可流通的文件。
 */
export const ScriptBundleSchema = z.object({
  /** 文件格式版本，将来改结构时好判断 */
  format: z.literal('tavern-ai-script'),
  version: z.literal(1),
  characterName: z.string().default(''),
  events: z.array(ScriptEventInputSchema).min(1).max(50),
});
export type ScriptBundle = z.infer<typeof ScriptBundleSchema>;

/** 不带 format 版本的宽松输入：允许用户手写只有 events 的文件。 */
export const ScriptImportSchema = z.object({
  events: z.array(ScriptEventInputSchema).min(1).max(50),
});
export type ScriptImport = z.infer<typeof ScriptImportSchema>;
