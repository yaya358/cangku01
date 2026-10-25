import type { Character, ChatMessage } from '@tavern/shared';

/**
 * 偷听：低声说话会不会被第三个人听见。
 *
 * 这是世界模式里「信息是有代价的」那一条的落点 —— 如果压低声音就一定安全，
 * 低声就只是换个字体；如果一定被听到，就没人敢说。所以判定要**可预期**：
 * 概率由四个因素算出来，写死在这里，玩家能通过「看谁在场、谁在忙、地方吵不吵」
 * 大致判断风险，而不是撞运气。
 *
 *   低声（对比正常音量）  大幅降低
 *   场景安静程度          越安静越容易听清
 *   偷听者性格            爱打听的人更容易凑过来
 *   偷听者正在忙          更容易漏掉
 *
 * 判定只负责「有没有被听到」，听见之后做什么（生成反应、记进认知、掉好感）
 * 由调用方决定 —— 这里保持纯函数，才测得住。
 */

/** 正常音量说话的基础被听率。 */
const BASE_SPEAK = 0.45;

/** 压低声音：基础概率只剩四分之一不到，这就是低声的全部价值。 */
const BASE_WHISPER = 0.1;

/** 概率下限：再安全也留一点意外。 */
const CHANCE_FLOOR = 0.01;

/** 概率上限：再危险也留一线。 */
const CHANCE_CEIL = 0.95;

/**
 * 性格里出现这些词就当「爱打听」。
 *
 * 角色卡没有 curious 这种专用字段，性格与标签是唯一的线索；
 * 与其加一个没人填的新字段，不如认几个所有人都看得懂的说法。
 */
const CURIOUS_PATTERN = /curious|好奇|多话|话痨|爱打听|好打听|爱追问|多嘴|八卦/i;

/** 从秘密里取特征片段时，这些两字组合太常见，留着会天天误判。 */
const COMMON_BIGRAMS = new Set([
  '一个',
  '这个',
  '那个',
  '自己',
  '我们',
  '他们',
  '你们',
  '什么',
  '怎么',
  '因为',
  '所以',
  '但是',
  '现在',
  '已经',
  '不是',
  '就是',
  '可以',
  '没有',
  '如果',
  '还是',
  '这样',
  '那样',
  '应该',
  '知道',
  '时候',
  '事情',
  '最后',
]);

export interface EavesdropListener {
  id: string;
  name: string;
  /** 爱打听：更容易凑过来 */
  curious: boolean;
  /** 手上正忙：更容易漏掉 */
  busy: boolean;
}

export interface EavesdropChance {
  listener: EavesdropListener;
  chance: number;
}

export interface EavesdropDecision {
  /** 被谁听到了；null = 这次没人听清 */
  heard: EavesdropChance | null;
  /** 每个人的概率，测试与排查用 */
  chances: EavesdropChance[];
}

export interface EavesdropInput {
  whisper: boolean;
  closeness: number;
  listeners: readonly EavesdropListener[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 这个人被听到的概率。 */
export function eavesdropChance(input: {
  whisper: boolean;
  closeness: number;
  listener: EavesdropListener;
}): number {
  const base = input.whisper ? BASE_WHISPER : BASE_SPEAK;
  // closeness 0.3（嘈杂酒馆）打八折，0.7（安静后巷）乘 1.2
  const quietness = 0.5 + clamp01(input.closeness);
  const curiosity = input.listener.curious ? 1.4 : 1;
  const distraction = input.listener.busy ? 0.45 : 1;

  return Math.min(CHANCE_CEIL, Math.max(CHANCE_FLOOR, base * quietness * curiosity * distraction));
}

/** 每个人的被听率（顺序与传入顺序一致，前端/日志好对）。 */
export function eavesdropChances(input: EavesdropInput): EavesdropChance[] {
  return input.listeners.map((listener) => ({
    listener,
    chance: eavesdropChance({
      whisper: input.whisper,
      closeness: input.closeness,
      listener,
    }),
  }));
}

/**
 * 掷一次骰子。
 *
 * random 可注入：判定要是随机的就测不了，把随机源交出去才测得准。
 * 多人同时在场时各自独立掷 —— 只要有一个人听到就算被发现，
 * 剩下的人这次没听清（不需要把每个命中都演一遍）。
 */
export function rollEavesdrop(
  input: EavesdropInput,
  random: () => number = Math.random,
): EavesdropDecision {
  const chances = eavesdropChances(input);

  // 正常音量说话本来就是在场所有人都听得到，不存在「偷听」这回事
  if (!input.whisper || chances.length === 0) return { heard: null, chances };

  for (const candidate of chances) {
    if (random() < candidate.chance) return { heard: candidate, chances };
  }
  return { heard: null, chances };
}

/** 这个人是不是爱打听。 */
export function isCurious(character: Pick<Character, 'tags' | 'personality'>): boolean {
  return CURIOUS_PATTERN.test([...character.tags, character.personality].join(' '));
}

/**
 * 从秘密里取特征片段。
 *
 * 角色卡没有敏感词表，只能从「他藏着的那件事」里切出片段去撞。
 * 先按标点切成短句，再补两字组合（去掉过于常见的），
 * 这样「名单」「不敢睡」这种词被提到时能命中，而「一个」「自己」不会。
 */
export function secretKeyphrases(secret: string): string[] {
  const phrases = secret
    .split(/[，。、；：,.;:!?！？「」“”"'（）()\s]+/)
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length >= 2);

  const found = new Set(phrases);
  for (const phrase of phrases) {
    for (let index = 0; index + 2 <= phrase.length; index += 1) {
      const bigram = phrase.slice(index, index + 2);
      if (COMMON_BIGRAMS.has(bigram)) continue;
      found.add(bigram);
    }
  }
  return [...found];
}

/** 这句话有没有戳到他的秘密。 */
export function isSensitive(secret: string, text: string): boolean {
  const trimmed = secret.trim();
  if (trimmed.length === 0 || text.trim().length === 0) return false;
  return secretKeyphrases(trimmed).some((phrase) => text.includes(phrase));
}

export interface ReactionInput {
  listener: Character;
  /** 被听见的那句话 */
  heardText: string;
  /** 内容戳到了他的秘密 */
  sensitive: boolean;
  /** 说话的人叫什么 */
  speakerName: string;
}

/**
 * 生成「偷听者的反应」的提示词。
 *
 * 关键约束：
 *   - 只写一句、写反应不写复述 —— 复述会让玩家以为自己的私聊被公开念了一遍
 *   - 敏感时必须让玩家看得出被刺到，但不许直接把秘密说出来
 */
export function buildReactionPrompt(input: ReactionInput): ChatMessage[] {
  const listener = input.listener;
  const persona = [listener.description.trim(), listener.personality.trim()]
    .filter((part) => part.length > 0)
    .join('\n');

  const rules = [
    `你叫${listener.name}。${persona.length > 0 ? `\n${persona}` : ''}`,
    `${input.speakerName}刚在附近压低声音说话，以为没人听得见 —— 你听见了。`,
  ];

  if (input.sensitive) {
    const secret = listener.secret?.trim() ?? '';
    if (secret.length > 0) {
      rules.push(`你心里的事：${secret}`);
    }
    rules.push(
      '你听到的这句话碰到了你最不想被人提起的事。反应要让人看得出你被刺到了（手上一顿、话变硬、',
      '或者忽然换了个话题），但绝不把这件事说出来，也不要反问他"你怎么知道的"。',
    );
  }

  rules.push(
    '只写你此刻的反应：一句动作、神态或半句话，不超过 40 字。',
    '不要复述听到的内容，不要解释，不要跳出角色，不要写成旁白总结。',
  );
  if (input.sensitive) {
    rules.push('这不是他直接对你说的话 —— 你可以装作没听见，也可以不点破地试探。');
  }

  // 只发一条 system：这个上游在两条 system 相邻时会只返回用量、没有正文
  return [
    { role: 'system', content: rules.join('\n') },
    { role: 'user', content: `你听见的是：「${input.heardText}」` },
  ];
}
