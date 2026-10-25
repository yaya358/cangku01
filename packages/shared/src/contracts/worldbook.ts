import { z } from 'zod';

/**
 * 世界书契约。
 *
 * 条目分两类：
 *   - 角色专属（characterId 有值）：只在该角色的对话里触发
 *   - 全局（characterId 为 null）：所有角色共享，适合世界观总纲
 *
 * 触发规则由后端 core/worldbook/scan.ts 决定，这里只描述数据结构。
 */

/** 关键词数量上限：太多等于全量触发，反而失去"按需注入"的意义。 */
const MAX_KEYS = 32;
const MAX_KEY_LENGTH = 60;
const MAX_CONTENT = 20_000;

export const WorldbookEntrySchema = z.object({
  id: z.string(),
  /** null = 全局条目 */
  characterId: z.string().nullable(),
  title: z.string(),
  keys: z.array(z.string()),
  /** 次要关键词：非空时要求主次同时命中 */
  secondaryKeys: z.array(z.string()),
  content: z.string(),
  /** 关掉后不再参与触发，但条目保留 */
  enabled: z.boolean(),
  /** 常驻：不看关键词，每轮都注入 */
  constant: z.boolean(),
  caseSensitive: z.boolean(),
  /** 越大越靠前；条数吃满时先保留高优先级 */
  priority: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorldbookEntryDto = z.infer<typeof WorldbookEntrySchema>;

/** 新建条目。 */
export const WorldbookInputSchema = z.object({
  title: z.string().min(1, '标题不能为空').max(120),
  keys: z.array(z.string().min(1).max(MAX_KEY_LENGTH)).max(MAX_KEYS).default([]),
  secondaryKeys: z.array(z.string().min(1).max(MAX_KEY_LENGTH)).max(MAX_KEYS).default([]),
  content: z.string().max(MAX_CONTENT).default(''),
  /** 不传 = 全局条目 */
  characterId: z.string().min(1).nullable().optional(),
  constant: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  priority: z.number().int().min(-1000).max(1000).default(0),
  enabled: z.boolean().default(true),
});
export type WorldbookInput = z.infer<typeof WorldbookInputSchema>;

/** 局部更新（所有字段可选，不带默认值）。 */
export const WorldbookPatchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  keys: z.array(z.string().min(1).max(MAX_KEY_LENGTH)).max(MAX_KEYS).optional(),
  secondaryKeys: z.array(z.string().min(1).max(MAX_KEY_LENGTH)).max(MAX_KEYS).optional(),
  content: z.string().max(MAX_CONTENT).optional(),
  characterId: z.string().min(1).nullable().optional(),
  constant: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  enabled: z.boolean().optional(),
});
export type WorldbookPatch = z.infer<typeof WorldbookPatchSchema>;
