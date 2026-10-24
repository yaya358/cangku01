import { z } from 'zod';

/**
 * 角色卡契约。
 *
 * 字段命名用驼峰（我们的 API），与社区角色卡 V2 规范的下划线字段
 * （first_mes / mes_example / post_history_instructions）在导入导出层做映射，
 * 这样数据库和前端都不必迁就外部格式。
 */

/** 角色来源：手动创建 / 从 PNG 导入 / 从 JSON 导入 */
export const CHARACTER_SOURCES = ['manual', 'png', 'json'] as const;
export type CharacterSource = (typeof CHARACTER_SOURCES)[number];

/** 长文本字段统一上限，防止有人往里塞一整本书。 */
const longText = (max = 40_000) => z.string().max(max).default('');

/** 新建/编辑角色时的可编辑字段。 */
export const CharacterInputSchema = z.strictObject({
  name: z.string().min(1, '角色名不能为空').max(80),
  /** 外貌、身份、性格等主体描述 */
  description: longText(),
  /** 性格摘要（部分卡片单独提供，可与 description 合并使用） */
  personality: longText(),
  scenario: longText(),
  /** 开场白，对应 V2 的 first_mes */
  firstMes: longText(),
  /** 示例对话，对应 V2 的 mes_example */
  mesExample: longText(),
  /** 覆盖默认系统提示 */
  systemPrompt: longText(),
  /** 插在历史之后的指令，用来压制模型跑偏 */
  postHistoryInstructions: longText(),
  /** 给作者自己看的备注，不参与 prompt */
  creatorNotes: longText(),
  tags: z.array(z.string().min(1).max(32)).max(20).default([]),
  /** 备选开场白，用户可切换 */
  alternateGreetings: z.array(z.string().max(20_000)).max(20).default([]),
});

/** 局部更新：所有字段可选。 */
export const CharacterPatchSchema = CharacterInputSchema.partial();
export type CharacterPatch = z.infer<typeof CharacterPatchSchema>;

export type CharacterInput = z.infer<typeof CharacterInputSchema>;

/** 完整角色。 */
export const CharacterSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  personality: z.string(),
  scenario: z.string(),
  firstMes: z.string(),
  mesExample: z.string(),
  systemPrompt: z.string(),
  postHistoryInstructions: z.string(),
  creatorNotes: z.string(),
  tags: z.array(z.string()),
  alternateGreetings: z.array(z.string()),
  /** 头像地址；没有头像时为 null（前端显示首字母占位） */
  avatarUrl: z.string().nullable(),
  source: z.enum(CHARACTER_SOURCES),
  specVersion: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Character = z.infer<typeof CharacterSchema>;

/** 列表用的轻量结构：不把长文本全传给前端。 */
export const CharacterSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** description 的第一段，最长 120 字 */
  excerpt: z.string(),
  tags: z.array(z.string()),
  avatarUrl: z.string().nullable(),
  source: z.enum(CHARACTER_SOURCES),
  /** 开场白是否已具备（没有开场白的角色用起来会怪） */
  hasGreeting: z.boolean(),
  updatedAt: z.string(),
});
export type CharacterSummary = z.infer<typeof CharacterSummarySchema>;

/** 列表响应。 */
export const CharacterListSchema = z.object({
  items: z.array(CharacterSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type CharacterList = z.infer<typeof CharacterListSchema>;
