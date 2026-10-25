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
  /** 世界包 id（题材）：主线谜题、开场场景、在场的人都从它取 */
  theme: z.string(),
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
  /** 私密场景是从哪个公开场景出去的；公开场景为 null */
  sourceSceneId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Scene = z.infer<typeof SceneSchema>;

/** 新建 / 重开存档的返回：一本故事 + 它的第一个场景。 */
export const SaveStartedSchema = z.object({
  save: SaveSchema,
  scene: SceneSchema,
});
export type SaveStarted = z.infer<typeof SaveStartedSchema>;

/** 快照：手动存下来的一刻，可以读回去。 */
export const SnapshotSchema = z.object({
  id: z.string(),
  saveId: z.string(),
  label: z.string(),
  chapter: z.number().int().nonnegative(),
  /** 快照里有多少条对话 —— 界面用来区分「存得早还是晚」 */
  messageCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const SnapshotRestoreResultSchema = z.object({
  saveId: z.string(),
  chapter: z.number().int().nonnegative(),
});
export type SnapshotRestoreResult = z.infer<typeof SnapshotRestoreResultSchema>;

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

/**
 * 把在场的人带到私密场景的结果。
 *
 * noticed 是「看见你们离开的人」—— 空数组的意思是没人注意，这本身也是情报：
 * 换地方不是免费的，但也不一定被抓到。
 */
export const PrivateSceneResultSchema = z.object({
  scene: SceneSchema,
  noticed: z.array(SceneCastMemberSchema),
});
export type PrivateSceneResult = z.infer<typeof PrivateSceneResultSchema>;

/**
 * 开场 beat：第一次走进这个场景时，世界先说一句。
 *
 * 没有它，一进场景是一片空白，玩家得自己编第一句；
 * 有了它，「点进去有事发生」才成立 —— 主线要的那个人也会先动一下。
 */
export const SceneOpeningSchema = z.object({
  /** 已经开过场了（同一场景只开场一次） */
  alreadyStarted: z.boolean(),
  /** 这次生成的开场；已经开过就是 null */
  beat: z
    .object({
      /** 落库的那条消息 id（刷新后还在） */
      messageId: z.string(),
      text: z.string(),
      /** 是模型写的，还是兜底文案 */
      source: z.enum(['model', 'fallback']),
    })
    .nullable(),
});
export type SceneOpening = z.infer<typeof SceneOpeningSchema>;

/**
 * 「下一步」的结果：主角没开口，在场的人自己往前走了一步。
 *
 * remaining = 这一章还能按几次。到 0 就只能自己说话了 ——
 * 它能推过程，但推不到结局（答案只从「把话说对」来）。
 */
export const SceneAdvanceSchema = z.object({
  /** 落库的那条消息（谁说的、说了什么） */
  message: z.object({
    id: z.string(),
    speakerId: z.string().nullable(),
    speakerName: z.string().nullable(),
    content: z.string(),
    createdAt: z.string(),
  }),
  remaining: z.number().int().nonnegative(),
  budget: z.number().int().nonnegative(),
});
export type SceneAdvance = z.infer<typeof SceneAdvanceSchema>;

/** 新建存档：顺带建第一个场景，并把这些人放进去。 */
export const CreateSaveSchema = z.object({
  name: z.string().min(1).max(60),
  sceneName: z.string().min(1).max(60).optional(),
  characterIds: z.array(z.string().min(1)).max(12).optional(),
  /**
   * 世界包 id：带上它就按这个题材建（场景名、在场的人、三章谜题都从包里取），
   * 不带就是默认的月灯镇。
   */
  theme: z.string().min(1).max(40).optional(),
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
