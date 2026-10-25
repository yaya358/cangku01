import { describe, expect, it } from 'vitest';
import {
  buildChapterPrompt,
  buildOpeningPrompt,
  cleanOpening,
  fallbackChapterBeat,
  fallbackOpening,
} from './opening.js';

const base = {
  sceneName: '月灯酒馆',
  kind: 'public' as const,
  present: [
    { name: '夜巡人', busyWith: '擦杯子' },
    { name: '猫', busyWith: null },
  ],
  focusName: '夜巡人',
  chapter: 2,
  playerName: '陈九',
};

describe('开场提示词', () => {
  it('把地点、在场的人、这一章要找的人写进去', () => {
    const [system] = buildOpeningPrompt(base);
    expect(system?.content).toContain('月灯酒馆');
    expect(system?.content).toContain('夜巡人（擦杯子）');
    expect(system?.content).toContain('猫');
    expect(system?.content).toContain('这一章玩家要找的是夜巡人');
    expect(system?.content).toContain('陈九刚走进来');
  });

  it('强调「不替玩家发言、不写长台词」', () => {
    const [system] = buildOpeningPrompt(base);
    expect(system?.content).toContain('不要写玩家的动作');
    expect(system?.content).toContain('不要写长台词');
  });

  it('只发一条 system（两条 system 相邻时上游会只返用量）', () => {
    const messages = buildOpeningPrompt(base);
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(messages.at(-1)?.role).toBe('user');
  });

  it('没有焦点角色时不硬提一个人', () => {
    const [system] = buildOpeningPrompt({ ...base, focusName: null });
    expect(system?.content).not.toContain('这一章玩家要找的是');
  });

  it('没人在场时说明白', () => {
    const [system] = buildOpeningPrompt({ ...base, present: [] });
    expect(system?.content).toContain('一个人也没有');
  });
});

describe('清理模型输出', () => {
  it('去掉「开场：」前缀和引号', () => {
    expect(cleanOpening('开场：“雨还在下，门没关严。”')).toBe('雨还在下，门没关严。');
  });

  it('多行压成一段', () => {
    expect(cleanOpening('门开了。\n\n有人抬头。')).toBe('门开了。 有人抬头。');
  });

  it('太长就在句子边界截断', () => {
    const long = `${'雨顺着屋檐往下淌，'.repeat(10)}店里没有人说话，只有炉子的响动。`;
    const cleaned = cleanOpening(long);
    expect(cleaned.length).toBeLessThanOrEqual(91);
    expect(cleaned.endsWith('…') || /[。！？，]$/.test(cleaned)).toBe(true);
  });

  it('空输出还是空', () => {
    expect(cleanOpening('   ')).toBe('');
  });
});

describe('本章局面的提示词', () => {
  const chapter = {
    sceneName: '月灯酒馆',
    kind: 'public' as const,
    present: [
      { name: '月灯老板', busyWith: '擦杯子' },
      { name: '猫', busyWith: null },
    ],
    chapter: 3,
    title: '第三章 · 名单的最后一笔',
    question: '名单最后一个名字是谁？',
    focusName: '月灯老板',
  };

  it('把谜面和该问的人写进去，并要求出现一件跟谜题有关的实物', () => {
    const [system] = buildChapterPrompt(chapter);
    expect(system?.content).toContain('名单最后一个名字是谁？');
    expect(system?.content).toContain('月灯老板');
    expect(system?.content).toContain('实物或痕迹');
    expect(system?.content).toContain('不要揭晓答案');
  });

  it('同样只发一条 system', () => {
    expect(buildChapterPrompt(chapter).filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('兜底文案也把问题说清楚，不能是一句空话', () => {
    const text = fallbackChapterBeat(chapter);
    expect(text).toContain('第三章');
    expect(text).toContain('名单最后一个名字是谁');
    expect(text).toContain('月灯老板');
  });
});

describe('兜底开场', () => {
  it('公开场所点名在场的人', () => {
    const text = fallbackOpening(base);
    expect(text).toContain('月灯酒馆');
    expect(text).toContain('夜巡人');
  });

  it('私聊只提一个人，且不假装热闹', () => {
    const text = fallbackOpening({ ...base, kind: 'private', present: [{ name: '夜巡人' }] });
    expect(text).toContain('只有你们两个人');
    expect(text).toContain('夜巡人');
  });

  it('一个人都没有时也别写成空话', () => {
    expect(fallbackOpening({ ...base, present: [] })).toContain('一个人也没有');
  });
});
