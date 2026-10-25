import { describe, expect, it } from 'vitest';
import type { Character } from '@tavern/shared';
import { buildScoringPrompt, parseScore, SCORE_FAILED_REASON } from './scoring.js';

function character(overrides: Partial<Character> = {}): Character {
  return {
    id: 'c1',
    name: '月灯老板',
    description: '守着一间只在夜里开门的小酒馆。',
    personality: '话痨、爱打听、心软。',
    scenario: '',
    firstMes: '',
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    tags: [],
    alternateGreetings: [],
    avatarFile: null,
    specVersion: '2.0',
    source: 'manual',
    secret: '名单上最后一个人是他自己。',
    goal: '想知道对方是不是来问旧事的。',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Character;
}

describe('打分提示词', () => {
  it('只发一条 system（两条 system 相邻时上游会只返用量）', () => {
    const messages = buildScoringPrompt({
      character: character(),
      userName: '陈九',
      playerLine: '来一杯。',
      reply: '哟，这个点还来？',
    });
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(messages.at(-1)?.role).toBe('user');
    expect(messages.at(-1)?.content).toContain('来一杯');
  });

  it('把「只输出 JSON」「没有变化给 0」写进规则', () => {
    const [system] = buildScoringPrompt({
      character: character(),
      userName: '陈九',
      playerLine: '来一杯。',
      reply: '哟。',
    });
    expect(system?.content).toContain('只输出 JSON');
    expect(system?.content).toContain('没有明显变化就给 0');
    expect(system?.content).toContain('-5 到 5');
  });
});

describe('打分解析', () => {
  it('标准 JSON', () => {
    expect(parseScore('{"delta": 3, "reason": "他把话说到点子上"}')).toEqual({
      delta: 3,
      reason: '他把话说到点子上',
    });
  });

  it('带了 ```json 包裹或前后废话也能认', () => {
    expect(
      parseScore('好的，评分如下：\n```json\n{"delta": -4, "reason": "他当众揭短"}\n```'),
    ).toEqual({ delta: -4, reason: '他当众揭短' });
  });

  it('超出上限的分数被夹回 ±5', () => {
    expect(parseScore('{"delta": 99, "reason": "太夸张"}')?.delta).toBe(5);
    expect(parseScore('{"delta": -99, "reason": "太夸张"}')?.delta).toBe(-5);
  });

  it('JSON 坏了就从文字里捞数字', () => {
    expect(parseScore('delta: -2\n他明显不高兴')).toEqual({ delta: -2, reason: '他明显不高兴' });
  });

  it('什么都没捞到就返回 null：不假装这轮没有变化', () => {
    expect(parseScore('')).toBeNull();
    expect(parseScore('这轮我觉得还行吧')).toBeNull();
  });

  it('没给理由时补一句占位，而不是丢掉整条结果', () => {
    expect(parseScore('{"delta": 2}')).toEqual({ delta: 2, reason: '（没给理由）' });
  });

  it('失败文案说人话', () => {
    expect(SCORE_FAILED_REASON).toContain('没评上分');
  });
});
