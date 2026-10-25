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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScriptEvent = z.infer<typeof ScriptEventSchema>;

export const ScriptEventInputSchema = z.object({
  atTurn: z.number().int().min(1).max(500),
  title: z.string().min(1, '标题不能为空').max(80),
  content: z.string().min(1, '内容不能为空').max(MAX_CONTENT),
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
});
export type EventNotice = z.infer<typeof EventNoticeSchema>;
