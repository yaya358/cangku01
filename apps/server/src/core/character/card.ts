import { CharacterInputSchema } from '@tavern/shared';
import type { CharacterInput } from '@tavern/shared';

/**
 * 角色卡 JSON 规范化。
 *
 * 社区里同时存在三种形态，导入时都要能吃下：
 *   V1：一组扁平字段（name / description / first_mes ...）
 *   V2：{ spec: 'chara_card_v2', spec_version, data: { ...V1 字段 } }
 *   V3：{ spec: 'chara_card_v3', spec_version, data: { ...V2 字段 + nickname 等 } }
 *
 * 归一化之后统一变成我们的 CharacterInput（驼峰命名），
 * 外部格式的下划线字段名只在这个文件里出现一次。
 */

export type CardFormat = 'v1' | 'v2' | 'v3';

export class CardParseError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`角色卡解析失败：${reason}`);
    this.name = 'CardParseError';
    this.reason = reason;
  }
}

export interface ParsedCard {
  input: CharacterInput;
  format: CardFormat;
  /** 卡片声称的规范版本，缺失时按形态推断 */
  specVersion: string;
  /** 原始 extensions 字段（第三方工具塞的私有数据），暂不落库，留作后续扩展 */
  extensions: Record<string, unknown>;
}

/** 单个字段的长度上限，与 CharacterInputSchema 保持一致。 */
const TEXT_LIMIT = 40_000;

/** 缺名字时用的占位，好过直接拒绝导入。 */
const FALLBACK_NAME = '未命名角色';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 截断超长文本：宁可丢尾巴，也不要让整张卡因为超长被拒。 */
function clip(value: string): string {
  return value.length <= TEXT_LIMIT ? value : value.slice(0, TEXT_LIMIT);
}

/** 从若干候选键里取第一个是字符串的值。 */
function pickText(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') return clip(value);
    if (typeof value === 'number' || typeof value === 'boolean') return clip(String(value));
  }
  return '';
}

/** 字符串数组；过滤掉非字符串与空串。 */
function pickStringArray(source: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, 20);
  }
  return [];
}

/** 判断卡片形态并取出真正装字段的那一层。 */
function unwrap(json: unknown): {
  body: Record<string, unknown>;
  format: CardFormat;
  specVersion: string;
} {
  if (!isRecord(json)) {
    throw new CardParseError('内容不是一个 JSON 对象');
  }

  const spec = typeof json.spec === 'string' ? json.spec : '';
  const declaredVersion = typeof json.spec_version === 'string' ? json.spec_version : '';

  if (spec.includes('v3')) {
    if (!isRecord(json.data)) throw new CardParseError('V3 卡片缺少 data 字段');
    return { body: json.data, format: 'v3', specVersion: declaredVersion || '3.0' };
  }

  if (spec.includes('v2')) {
    if (!isRecord(json.data)) throw new CardParseError('V2 卡片缺少 data 字段');
    return { body: json.data, format: 'v2', specVersion: declaredVersion || '2.0' };
  }

  // 没有 spec 字段：可能是 V1 扁平结构，也可能是被套了 data 但没写 spec
  if (isRecord(json.data) && typeof json.data.name === 'string') {
    return { body: json.data, format: 'v2', specVersion: declaredVersion || '2.0' };
  }

  return { body: json, format: 'v1', specVersion: declaredVersion || '1.0' };
}

/**
 * 把任意形态的角色卡 JSON 归一化成 CharacterInput。
 *
 * 宽进严出：外部字段五花八门，能兼容就兼容；但落库前的结构由 zod 守住。
 */
export function parseCardJson(json: unknown): ParsedCard {
  const { body, format, specVersion } = unwrap(json);

  const rawName = pickText(body, ['name', 'char_name']).trim();
  const name = rawName.length > 0 ? rawName : FALLBACK_NAME;

  /**
   * 秘密与目的不是社区规范里的字段，我们自己放在 extensions.tavern 下
   * （V2 规范允许任意扩展），同时也接受顶层直接写 —— 手写卡片时少一层嵌套。
   */
  const extensions = isRecord(body.extensions) ? body.extensions : {};
  const tavernExt = isRecord(extensions.tavern) ? extensions.tavern : {};

  const candidate = {
    name: name.slice(0, 80),
    description: pickText(body, ['description', 'char_persona', 'persona']),
    personality: pickText(body, ['personality', 'char_personality']),
    scenario: pickText(body, ['scenario', 'world_scenario']),
    firstMes: pickText(body, ['first_mes', 'firstMessage', 'char_greeting', 'greeting']),
    mesExample: pickText(body, ['mes_example', 'example_dialogue', 'exampleMessage']),
    systemPrompt: pickText(body, ['system_prompt', 'systemPrompt']),
    postHistoryInstructions: pickText(body, [
      'post_history_instructions',
      'postHistoryInstructions',
    ]),
    creatorNotes: pickText(body, ['creator_notes', 'creatorNotes', 'creatorcomment']),
    secret: pickText(body, ['secret']) || pickText(tavernExt, ['secret']),
    goal: pickText(body, ['goal']) || pickText(tavernExt, ['goal']),
    tags: pickStringArray(body, ['tags']),
    alternateGreetings: pickStringArray(body, ['alternate_greetings', 'alternateGreetings']).map(
      (item) => clip(item),
    ),
  };

  const parsed = CharacterInputSchema.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new CardParseError(detail);
  }

  return {
    input: parsed.data,
    format,
    specVersion,
    extensions,
  };
}

/**
 * 导出成 V2 JSON（社区通用格式）。
 *
 * 只导出我们自己维护的字段，extensions 里塞一个来源标记，
 * 别的工具读进来时能认出这张卡是从酒馆 AI 出去的。
 */
export function toV2Card(character: CharacterInput, appVersion: string): Record<string, unknown> {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name,
      description: character.description,
      personality: character.personality,
      scenario: character.scenario,
      first_mes: character.firstMes,
      mes_example: character.mesExample,
      system_prompt: character.systemPrompt,
      post_history_instructions: character.postHistoryInstructions,
      creator_notes: character.creatorNotes,
      tags: character.tags,
      alternate_greetings: character.alternateGreetings,
      character_book: undefined,
      extensions: {
        tavern_ai: { exported_by: `tavern-ai/${appVersion}` },
        // 秘密与目的放扩展位：社区工具不认也不影响，我们自己能读回来
        tavern: { secret: character.secret, goal: character.goal },
      },
    },
  };
}
