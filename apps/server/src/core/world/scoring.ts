import { AFFINITY_DELTA_LIMIT } from '@tavern/shared';
import type { Character, ChatMessage } from '@tavern/shared';

/**
 * 每轮结束给玩家的表现打分。
 *
 * 单独一次小请求的理由：让**同一个模型**以旁白视角看「刚才这一轮」，
 * 比在角色回复里塞一句「（好感 +3）」自然得多 —— 后者会污染台词。
 *
 * 三类约束写在提示词里（不是靠代码兜）：
 *   - 只输出 JSON，字段固定
 *   - 加减分有理由，理由要具体到这一句话
 *   - 没有明显变化就给 0：好感不是「聊一句涨一分」的签到表
 *
 * 解析这端必须宽容（模型偶尔带 ```json 包裹或前后加话），
 * 因为这是「锦上添花」的一步：解析不出来就不加分，绝不能反过来弄坏主回复。
 */

export interface ScoreResult {
  delta: number;
  reason: string;
}

export interface ScoreInput {
  character: Character;
  /** 玩家的称呼 */
  userName: string;
  /** 玩家这一轮说的话 */
  playerLine: string;
  /** 他的回复 */
  reply: string;
}

/** 兜底文案：评分没跑成时告诉玩家，不装作无变化。 */
export const SCORE_FAILED_REASON = '这次没评上分（不影响对话）';

export function buildScoringPrompt(input: ScoreInput): ChatMessage[] {
  const { character } = input;
  const rules = [
    '你是一场角色扮演的旁白，只做一件事：给玩家刚才这一轮的表现打分。',
    `角色：${character.name}`,
    character.personality.trim().length > 0 ? `性格：${character.personality.trim()}` : '',
    character.goal.trim().length > 0 ? `他想要的：${character.goal.trim()}` : '',
    `他对玩家的态度：目前还没有明显倾向。`,
    '',
    '打分规则：',
    `- 只输出 JSON，形如 {"delta": 3, "reason": "他说中了我担心的事"}`,
    `- delta 是 -${AFFINITY_DELTA_LIMIT} 到 ${AFFINITY_DELTA_LIMIT} 的整数`,
    '- reason 一句话，不超过 30 字，要具体到刚才那句话，不要空泛',
    '- 加分：说到点子上、给足面子、有分寸地逼近他在意的事、兑现承诺',
    '- 减分：冒犯、当众揭短、空话套话、逼问、把他当工具',
    '- 没有明显变化就给 0（好感不是聊一句涨一分）',
    '- 不要解释，不要输出 JSON 以外的任何内容',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const exchange = [
    `${input.userName}说：${input.playerLine}`,
    `${character.name}的反应：${input.reply}`,
  ].join('\n');

  // 只发一条 system：这个上游在两条 system 相邻时会只返回用量、没有正文
  return [
    { role: 'system', content: rules },
    { role: 'user', content: exchange },
  ];
}

/** 从模型输出里抠出第一段 {...}（有的模型会包 ```json 或者前后加一句废话）。 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function clampDelta(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(AFFINITY_DELTA_LIMIT, Math.max(-AFFINITY_DELTA_LIMIT, Math.round(value)));
}

/**
 * 解析打分结果。
 *
 * 解析失败返回 null（调用方据此走「没评上分」的提示），
 * 而不是硬编一个 0 分 —— 那会让玩家以为「这轮确实没有变化」。
 */
export function parseScore(text: string): ScoreResult | null {
  const raw = text.trim();
  if (raw.length === 0) return null;

  const json = firstJsonObject(raw);
  if (json) {
    try {
      const parsed = JSON.parse(json) as { delta?: unknown; reason?: unknown };
      const delta = typeof parsed.delta === 'string' ? Number(parsed.delta) : parsed.delta;
      if (typeof delta === 'number' && Number.isFinite(delta)) {
        const reason =
          typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
            ? parsed.reason.trim().slice(0, 60)
            : '（没给理由）';
        return { delta: clampDelta(delta), reason };
      }
    } catch {
      // 不是合法 JSON，往下走正则兜底
    }
  }

  // 兜底：从「delta: -3」「-3 分」这种写法里捞一个数字出来。
  // 注意非数字部分要排除负号，否则「delta: -2」里的 - 会被当成间隔符吃掉。
  const deltaMatch =
    raw.match(/(?:delta|好感|分数)[^0-9-]{0,6}(-?\d+)/i) ?? raw.match(/(-?\d+)\s*分/);
  if (!deltaMatch) return null;
  const delta = Number(deltaMatch[1]);
  if (!Number.isFinite(delta)) return null;

  const reasonLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !line.includes('{') &&
        !line.includes('}') &&
        !/^(delta|好感|分数)/i.test(line) &&
        !/^-?\d+\s*分?$/.test(line),
    );
  return {
    delta: clampDelta(delta),
    reason: (reasonLine ?? '（没给理由）').slice(0, 60),
  };
}
