import type { ChatMessage } from '@tavern/shared';

/**
 * 「下一步」：主角不开口，让世界自己往前走一步。
 *
 * 为什么需要：刚进场景时玩家常常不知道该问什么，干看着一块进度条。
 * 这一下由在场的人主动做点什么（说出一个态度、做一个决定、逼近一步），
 * 玩家只需要接话。
 *
 * 为什么推不到结局：提示词里写死「不能回答本章的问题」——
 * 它可以更接近、可以制造压力，但答案只能靠把话说对换来。
 * 而且每章只有固定次数（WORLD_ADVANCE_BUDGET），用完了就得自己开口。
 */

export interface AdvanceInput {
  sceneName: string;
  kind: 'public' | 'private';
  /** 这一章要问出来的事 */
  question: string;
  chapterTitle: string;
  /** 这一章的焦点角色（不在场时为 null） */
  focusName?: string | null;
  /** 在场的人 */
  present: readonly string[];
  /** 由谁出头推动这一下 */
  speaker: string;
  /** 这是本章第几次推进（第 1 次最温和，越往后世界越不耐烦） */
  time: number;
  budget: number;
}

export function buildAdvancePrompt(input: AdvanceInput): ChatMessage[] {
  const tone =
    input.time <= 1
      ? '语气缓一点：像是在试探、在给台阶。'
      : '语气紧一点：局面向前压了一步，有人开始不耐烦。';

  const rules = [
    '你是一场文字角色扮演里的「世界」，现在要代替在场的人推一下剧情，玩家这一句没有说话。',
    `地点：${input.sceneName}${input.kind === 'private' ? '（只有你们两个人）' : '（公开场所）'}`,
    `在场：${input.present.join('、')}`,
    `这一幕属于《${input.chapterTitle}》，玩家想弄明白的是：${input.question}`,
    input.focusName ? `这一章最该被追问的是${input.focusName}。` : '',
    `由${input.speaker}出头做一件事：说出一个信息、做一个决定、或者逼玩家表态。${tone}`,
    '要求：',
    `- 只写${input.speaker}的动作和一两句台词，2~4 句，不超过 80 字`,
    '- 不要写玩家的动作、想法或台词',
    `- 不能回答「${input.question}」这个问题：可以更接近、可以制造压力，但答案必须留给玩家自己问出来`,
    '- 不要总结、不要加标题、不要解释规则',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  // 这个上游在两条 system 相邻时只返回用量、没有正文 —— 只发一条
  return [
    { role: 'system', content: rules },
    { role: 'user', content: '写这一下。' },
  ];
}

/** 模型挂了也得让世界动一下：用能确定推进、但不给答案的一句兜底。 */
export function fallbackAdvance(input: AdvanceInput): string {
  const others = input.present.filter((name) => name !== input.speaker);
  const tail = others.length > 0 ? `${others[0]}在旁边看着，没接话。` : '没有人接话。';
  return input.time <= 1
    ? `（${input.speaker}把手里的事停了停，抬眼看过来，像在等你先开口）${tail}`
    : `（${input.speaker}把杯子往桌上一放，声音不大，屋里却静了一下）要说就趁现在。${tail}`;
}
