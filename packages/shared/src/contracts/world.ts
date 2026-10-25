import { z } from 'zod';
import { MessageSchema } from './conversation.js';

/**
 * 世界模式契约：存档 → 场景 → 在场者。
 *
 * 与「按角色开会话」的根本区别：说话的地方是**场景**，能不能说上话取决于
 * 这个人此刻在不在场。所以这里除了数据形状，还固定了「可达性」这个概念 ——
 * 前端不需要自己判断，服务端算好并把给玩家看的那句话一起返回。
 */

/** 场景类型：公开场所（同场的人可能听见）还是私聊。 */
export const SCENE_KINDS = ['public', 'private'] as const;
export const SceneKindSchema = z.enum(SCENE_KINDS);
export type SceneKind = z.infer<typeof SceneKindSchema>;

/** 存档：一条世界线，可以有多个场景、多个周目。 */
export const SaveSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 第几章；主线推进时加一 */
  chapter: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Save = z.infer<typeof SaveSchema>;

export const SceneSchema = z.object({
  id: z.string(),
  saveId: z.string(),
  name: z.string(),
  kind: SceneKindSchema,
  /** 0-1，越大越安静（低声说话越容易被人听到）；嘈杂酒馆 0.3，后巷 0.7 */
  closeness: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Scene = z.infer<typeof SceneSchema>;

/**
 * 能不能联系上这个人。
 *
 * available 在场的空闲人 / busy 在场但手上忙 / left 已经走了 / absent 从没来过。
 * 「联系不上就是联系不上」—— 没有绕过去发消息的路，否则在场/离开就没意义了。
 */
export const REACHABILITY_STATES = ['available', 'busy', 'left', 'absent'] as const;
export const ReachabilitySchema = z.enum(REACHABILITY_STATES);
export type Reachability = z.infer<typeof ReachabilitySchema>;

/** 在场者：头像条上的一项。 */
export const ScenePresentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 正在忙什么（擦杯子、巡街）；null = 有空理你 */
  busyWith: z.string().nullable(),
  reachability: ReachabilitySchema,
  /** 点这个头像时给玩家看的一句话（措辞由服务端统一，前端不重复写） */
  hint: z.string(),
});
export type ScenePresent = z.infer<typeof ScenePresentSchema>;

/** 名字对照表：已离开的人说过的话也要能显示是谁说的。 */
export const SceneCastMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type SceneCastMember = z.infer<typeof SceneCastMemberSchema>;

/**
 * 场景详情。
 *
 * conversationId 为 null 表示这个场景还没人开过口（会话在第一次说话时创建），
 * messages 只含当前分支 —— 与 /api/conversations/:id 的口径一致。
 */
export const SceneDetailSchema = z.object({
  scene: SceneSchema,
  present: z.array(ScenePresentSchema),
  cast: z.array(SceneCastMemberSchema),
  conversationId: z.string().nullable(),
  messages: z.array(MessageSchema),
});
export type SceneDetail = z.infer<typeof SceneDetailSchema>;

/** 新建存档：顺带建第一个场景，并把这些人放进去。 */
export const CreateSaveSchema = z.object({
  name: z.string().min(1).max(60),
  sceneName: z.string().min(1).max(60).optional(),
  characterIds: z.array(z.string().min(1)).max(12).optional(),
  player: z
    .object({
      name: z.string().max(40),
      role: z.string().max(200),
      goal: z.string().max(400),
    })
    .partial()
    .optional(),
});
export type CreateSaveInput = z.infer<typeof CreateSaveSchema>;
