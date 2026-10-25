import { describe, expect, it } from 'vitest';
import {
  buildReactionPrompt,
  eavesdropChance,
  eavesdropChances,
  isCurious,
  isSensitive,
  rollEavesdrop,
  secretKeyphrases,
} from './eavesdrop.js';
import type { EavesdropListener } from './eavesdrop.js';

const curiousListener: EavesdropListener = {
  id: 'c1',
  name: '月灯老板',
  curious: true,
  busy: false,
};
const quietListener: EavesdropListener = { id: 'c2', name: '夜巡人', curious: false, busy: false };

function chanceOf(listener: EavesdropListener, whisper: boolean, closeness: number): number {
  return eavesdropChance({ whisper, closeness, listener });
}

describe('偷听概率', () => {
  it('低声比正常音量低一个数量级', () => {
    expect(chanceOf(quietListener, true, 0.35)).toBeLessThan(chanceOf(quietListener, false, 0.35));
    expect(chanceOf(quietListener, true, 0.35)).toBeLessThan(0.1);
  });

  it('越安静越容易被听清', () => {
    expect(chanceOf(quietListener, true, 0.7)).toBeGreaterThan(chanceOf(quietListener, true, 0.3));
  });

  it('爱打听的人更容易凑过来，手上忙着的人更容易漏掉', () => {
    expect(chanceOf(curiousListener, true, 0.3)).toBeGreaterThan(
      chanceOf(quietListener, true, 0.3),
    );
    expect(chanceOf({ ...quietListener, busy: true }, true, 0.3)).toBeLessThan(
      chanceOf(quietListener, true, 0.3),
    );
  });

  it('概率始终落在 0.01~0.95：既没有绝对安全，也没有必然被听到', () => {
    const extreme = eavesdropChance({
      whisper: false,
      closeness: 1,
      listener: { ...curiousListener, busy: false },
    });
    expect(extreme).toBeLessThanOrEqual(0.95);
    expect(
      eavesdropChance({
        whisper: true,
        closeness: 0,
        listener: { ...quietListener, busy: true },
      }),
    ).toBeGreaterThanOrEqual(0.01);
  });

  it('每人一个概率，顺序与传入一致', () => {
    const chances = eavesdropChances({
      whisper: true,
      closeness: 0.3,
      listeners: [curiousListener, quietListener],
    });
    expect(chances.map((item) => item.listener.id)).toEqual(['c1', 'c2']);
    expect(chances[0]!.chance).toBeGreaterThan(chances[1]!.chance);
  });
});

describe('掷骰子', () => {
  it('正常音量说话不存在偷听判定', () => {
    const decision = rollEavesdrop(
      { whisper: false, closeness: 0.3, listeners: [quietListener] },
      () => 0,
    );
    expect(decision.heard).toBeNull();
  });

  it('没有第三者在场时永远不算被听到', () => {
    const decision = rollEavesdrop({ whisper: true, closeness: 0.3, listeners: [] }, () => 0);
    expect(decision.heard).toBeNull();
    expect(decision.chances).toEqual([]);
  });

  it('骰子小就命中，骰子大就没听见', () => {
    const input = { whisper: true, closeness: 0.7, listeners: [curiousListener] };
    expect(rollEavesdrop(input, () => 0).heard?.listener.id).toBe('c1');
    expect(rollEavesdrop(input, () => 0.999).heard).toBeNull();
  });

  it('多人时按顺序掷，第一个命中的人就是听见的人', () => {
    // 第一个（夜巡人，安静处 0.12）掷出 0.9 没听见；第二个（老板，0.168）掷出 0 听见了
    const rolls = [0.9, 0.0];
    let index = 0;
    const random = (): number => rolls[index++] ?? 1;
    const decision = rollEavesdrop(
      { whisper: true, closeness: 0.7, listeners: [quietListener, curiousListener] },
      random,
    );
    expect(decision.heard?.listener.id).toBe('c1');
  });
});

describe('性格判定', () => {
  it('话痨 / 爱打听 / 好奇 都算爱打听', () => {
    expect(isCurious({ tags: ['酒馆'], personality: '话痨、爱打听、心软。' })).toBe(true);
    expect(isCurious({ tags: ['好奇'], personality: '傲慢、懒。' })).toBe(true);
    expect(isCurious({ tags: ['悬疑'], personality: '寡言、克制、守信用。' })).toBe(false);
  });
});

describe('敏感内容', () => {
  const secret = '名单上最后一个人是他自己。他巡夜，是因为不敢睡。';

  it('秘密里的特征片段被提到就算戳到了', () => {
    expect(isSensitive(secret, '那份名单还在你手里吧？')).toBe(true);
    expect(isSensitive(secret, '你到底敢不敢睡')).toBe(true);
  });

  it('无关的话不算', () => {
    expect(isSensitive(secret, '今晚街上没什么人。')).toBe(false);
  });

  it('没有秘密的人永远不算敏感', () => {
    expect(isSensitive('', '名单')).toBe(false);
    expect(isSensitive('   ', '名单')).toBe(false);
  });

  it('取片段时不会把「一个」「自己」这类常用词当成关键词', () => {
    const phrases = secretKeyphrases(secret);
    expect(phrases).not.toContain('一个');
    expect(phrases).not.toContain('自己');
    expect(phrases).toContain('名单');
  });
});

describe('偷听反应提示词', () => {
  const listener = {
    id: 'c2',
    name: '夜巡人',
    description: '总在雨里巡街。',
    personality: '寡言、克制。',
    secret: '名单上最后一个人是他自己。',
    tags: [],
  } as unknown as Parameters<typeof buildReactionPrompt>[0]['listener'];

  it('只发一条 system（两条 system 相邻时上游会只返用量）', () => {
    const messages = buildReactionPrompt({
      listener,
      heardText: '那份名单还在你手里吧？',
      sensitive: true,
      speakerName: '陈九',
    });
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ role: 'user' });
  });

  it('敏感时要求看得出被刺到但不许说破', () => {
    const [system] = buildReactionPrompt({
      listener,
      heardText: '那份名单还在你手里吧？',
      sensitive: true,
      speakerName: '陈九',
    });
    expect(system!.content).toContain('最不想被人提起');
    expect(system!.content).toContain('绝不把这件事说出来');
  });

  it('不敏感时不把秘密塞进提示词', () => {
    const [system] = buildReactionPrompt({
      listener,
      heardText: '今晚下雨。',
      sensitive: false,
      speakerName: '陈九',
    });
    expect(system!.content).not.toContain('名单');
    expect(system!.content).toContain('不超过 40 字');
  });
});
