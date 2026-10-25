import type { ChatMessage } from '@tavern/shared';

/**
 * 开场 beat：「你推门进去的那一下，世界里发生了什么」。
 *
 * 为什么要它：主线侧栏告诉你「找谁、差多少」，但一进场景还是一片空白，
 * 玩家得自己编第一句。世界先动一下（有人抬头、门没关严、通缉令被压在杯子底下），
 * 「点进去有事发生」这件事才成立 —— 也让主线要的那个人站到台前。
 *
 * 只写一段旁白，不替玩家发言、不写角色的长台词：这是世界的动作，不是抢戏。
 */

export interface OpeningInput {
  /** 场景名，例如「月灯酒馆」「后巷」 */
  sceneName: string;
  kind: 'public' | 'private';
  /** 在场的人 */
  present: readonly { name: string; busyWith?: string | null }[];
  /** 这一章要玩家去找的那个人（可能没有） */
  focusName?: string | null;
  /** 第几章，用来让开场别千篇一律 */
  chapter?: number;
  /** 玩家称呼 */
  playerName?: string;
}

const MAX_OPENING_LENGTH = 90;

/** 兜底开场：模型挂了也得让场景「响」一下。 */
export function fallbackOpening(input: OpeningInput): string {
  const names = input.present.map((person) => person.name);
  if (input.kind === 'private') {
    return names.length > 0
      ? `${input.sceneName}里只有你们两个人。${names[0]}停下手里的事，等你开口。`
      : `${input.sceneName}里空着，没有人来。`;
  }
  if (names.length === 0) {
    return `${input.sceneName}里此刻一个人也没有 —— 门口的灯还亮着。`;
  }
  return `你推门进了${input.sceneName}。${names.join('、')}都在，有人抬头看了你一眼。`;
}

export function buildOpeningPrompt(input: OpeningInput): ChatMessage[] {
  const place = [
    `地点：${input.sceneName}`,
    input.kind === 'private' ? '（只有你们两个人的私密场所）' : '（公开场所，人来人往）',
  ].join('');

  const present =
    input.present.length > 0
      ? `在场：${input.present
          .map((person) => (person.busyWith ? `${person.name}（${person.busyWith}）` : person.name))
          .join('、')}`
      : '在场：一个人也没有';

  const focus = input.focusName
    ? `这一章玩家要找的是${input.focusName}：让${input.focusName}在这段里做点什么，给玩家一个开口的由头。`
    : '';

  const rules = [
    '你是一场文字角色扮演里的「世界」，只负责写开场这一小段。',
    place,
    present,
    focus,
    `${input.playerName ? `${input.playerName}` : '玩家'}刚走进来，还没有说话。`,
    '要求：',
    '- 写 1~2 句，总共不超过 60 字，第三人称，只写看得见、听得见的事',
    '- 不要写玩家的动作、想法或台词（玩家还没动）',
    '- 不要写长台词；某个人最多一句极短的话',
    '- 给玩家留一个口子：有人在看他、有人停下手里的活、门还没关严',
    '- 不要总结剧情、不要解释规则、不要加标题',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  // 只发一条 system：这个上游在两条 system 相邻时会只返回用量、没有正文
  return [
    { role: 'system', content: rules },
    { role: 'user', content: '写这一段开场。' },
  ];
}

/**
 * 清理模型输出。
 *
 * 常见的跑偏：加「开场：」前缀、包引号、写成一整页。
 * 这里只留正文并把长度收住 —— 一段旁白变长就会盖过玩家的第一句。
 */
export function cleanOpening(raw: string): string {
  let text = raw.trim();
  if (text.length === 0) return '';

  text = text.replace(/^(开场|旁白|场景)[:：]\s*/u, '');
  text = text.replace(/^["'「『“]+|["'」』”]+$/gu, '').trim();
  text = text.replace(/\s*\n+\s*/gu, ' ');

  if (text.length > MAX_OPENING_LENGTH) {
    const cut = text.slice(0, MAX_OPENING_LENGTH);
    const boundary = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('！'),
      cut.lastIndexOf('？'),
      cut.lastIndexOf('，'),
    );
    text = boundary > MAX_OPENING_LENGTH * 0.5 ? cut.slice(0, boundary + 1) : `${cut}…`;
  }

  return text.trim();
}

/* ------------------------------------------------------------------ *
 * 新一章的「局面」：章节推进时由世界插进当前场景
 * ------------------------------------------------------------------ */

export interface ChapterBeatInput {
  sceneName: string;
  kind: 'public' | 'private';
  present: readonly { name: string; busyWith?: string | null }[];
  /** 刚翻过去的那一章 */
  chapter: number;
  title: string;
  /** 这一章要问出来的问题 */
  question: string;
  /** 这一章要问的人 */
  focusName?: string | null;
}

export function fallbackChapterBeat(input: ChapterBeatInput): string {
  const who = input.focusName ?? input.present[0]?.name ?? '有人';
  return `${input.title}。你要问出来的事是：${input.question}据说${who}知道其中一段。`;
}

export function buildChapterPrompt(input: ChapterBeatInput): ChatMessage[] {
  const present =
    input.present.length > 0
      ? input.present
          .map((person) => (person.busyWith ? `${person.name}（${person.busyWith}）` : person.name))
          .join('、')
      : '一个人也没有';

  const rules = [
    '你是一场文字角色扮演里的「世界」，只负责写一小段局面，不写任何人的台词。',
    `地点：${input.sceneName}${input.kind === 'private' ? '（只有你们两个人）' : '（公开场所）'}`,
    `在场：${present}`,
    `玩家刚刚进入《${input.title}》，这一章他要问出来的事是：${input.question}`,
    input.focusName
      ? `他最该问的人是${input.focusName}：让${input.focusName}在这段里露出一点「我知道点什么」的痕迹。`
      : '',
    '写 1~2 句、不超过 60 字，第三人称，只写看得见听得见的事。',
    '必须出现一样**跟这个问题有关的实物或痕迹**（一张纸、一道旧疤、被划掉的名字、烧焦的木梁），',
    '但不要揭晓答案，也不要写玩家的动作和台词。',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  // 只发一条 system：这个上游在两条 system 相邻时会只返回用量、没有正文
  return [
    { role: 'system', content: rules },
    { role: 'user', content: '写这一小段局面。' },
  ];
}
