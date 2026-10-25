import { describe, expect, it } from 'vitest';
import { CardParseError, parseCardJson, toV2Card } from './card.js';

/** 一张典型的 V2 卡片。 */
const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '月灯老板',
    description: '守着一间只在夜里开门的小酒馆。',
    personality: '话痨、心软',
    scenario: '深夜的酒馆',
    first_mes: '（擦着杯子）哟，这个点还来？',
    mes_example: '<START>\n{{user}}: 有酒吗？\n{{char}}: 有，也有故事。',
    system_prompt: '保持简短',
    post_history_instructions: '不要用网络流行语',
    creator_notes: '作者备注',
    tags: ['酒馆', '日常'],
    alternate_greetings: ['（打了个哈欠）来啦？'],
    extensions: { talkativeness: '0.5' },
    character_book: { entries: [] },
  },
};

describe('parseCardJson · V2', () => {
  it('下划线字段映射成驼峰，标签与备选开场白保留', () => {
    const parsed = parseCardJson(V2_CARD);

    expect(parsed.format).toBe('v2');
    expect(parsed.specVersion).toBe('2.0');
    expect(parsed.input).toMatchObject({
      name: '月灯老板',
      firstMes: '（擦着杯子）哟，这个点还来？',
      mesExample: expect.stringContaining('{{char}}'),
      systemPrompt: '保持简短',
      postHistoryInstructions: '不要用网络流行语',
      creatorNotes: '作者备注',
      tags: ['酒馆', '日常'],
      alternateGreetings: ['（打了个哈欠）来啦？'],
    });
    // extensions 单独留给上层，不塞进角色字段
    expect(parsed.extensions).toEqual({ talkativeness: '0.5' });
  });

  it('缺失字段补空串/空数组，不会 undefined', () => {
    const parsed = parseCardJson({ spec: 'chara_card_v2', data: { name: '空壳' } });

    expect(parsed.input.description).toBe('');
    expect(parsed.input.personality).toBe('');
    expect(parsed.input.tags).toEqual([]);
    expect(parsed.input.alternateGreetings).toEqual([]);
  });
});

describe('parseCardJson · V1 与 V3', () => {
  it('V1 扁平结构也能导入', () => {
    const parsed = parseCardJson({
      name: '老式卡',
      description: '老的格式',
      first_mes: '你好',
      mes_example: '示例',
      tags: ['怀旧'],
    });

    expect(parsed.format).toBe('v1');
    expect(parsed.input.name).toBe('老式卡');
    expect(parsed.input.firstMes).toBe('你好');
  });

  it('V3 规范按 v3 记录版本', () => {
    const parsed = parseCardJson({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { name: 'V3 卡', nickname: '小灯', description: '新格式' },
    });

    expect(parsed.format).toBe('v3');
    expect(parsed.specVersion).toBe('3.0');
    expect(parsed.input.name).toBe('V3 卡');
  });

  it('有 data 但没写 spec 时按 V2 处理', () => {
    const parsed = parseCardJson({ data: { name: '裸 data', description: 'x' } });
    expect(parsed.format).toBe('v2');
    expect(parsed.input.name).toBe('裸 data');
  });

  it('兼容其它工具的别名字段', () => {
    const parsed = parseCardJson({
      name: '别名卡',
      char_persona: '外向',
      world_scenario: '酒馆',
      char_greeting: '欢迎',
      example_dialogue: '对话',
      creatorcomment: '备注',
    });

    // V1 的 char_persona 就是「人设大段文本」，对应我们的 description
    expect(parsed.input.description).toBe('外向');
    expect(parsed.input.scenario).toBe('酒馆');
    expect(parsed.input.firstMes).toBe('欢迎');
    expect(parsed.input.mesExample).toBe('对话');
    expect(parsed.input.creatorNotes).toBe('备注');
  });
});

describe('parseCardJson · 容错', () => {
  it('没有名字时用占位名而不是拒绝导入', () => {
    expect(parseCardJson({ description: '无名氏' }).input.name).toBe('未命名角色');
  });

  it('超长文本被截断而不是整卡失败', () => {
    const parsed = parseCardJson({ name: '长文卡', description: '啊'.repeat(60_000) });
    expect(parsed.input.description.length).toBe(40_000);
  });

  it('标签里的非字符串被过滤', () => {
    const parsed = parseCardJson({ name: '污标签', tags: ['正常', 123, null, '  ', '也行'] });
    expect(parsed.input.tags).toEqual(['正常', '也行']);
  });

  it('不是对象时抛出可读错误', () => {
    expect(() => parseCardJson('字符串')).toThrow(CardParseError);
    expect(() => parseCardJson([1, 2, 3])).toThrow(/不是一个 JSON 对象/);
  });

  it('V2 缺少 data 时给出明确原因', () => {
    expect(() => parseCardJson({ spec: 'chara_card_v2' })).toThrow(/缺少 data/);
  });
});

describe('toV2Card', () => {
  it('导出结构符合 V2，并带来源标记', () => {
    const parsed = parseCardJson(V2_CARD);
    const exported = toV2Card(parsed.input, '0.1.0') as {
      spec: string;
      data: Record<string, unknown>;
    };

    expect(exported.spec).toBe('chara_card_v2');
    expect(exported.data.first_mes).toBe(parsed.input.firstMes);
    expect(exported.data.tags).toEqual(['酒馆', '日常']);
    expect(exported.data.extensions).toEqual({
      tavern_ai: { exported_by: 'tavern-ai/0.1.0' },
      // 秘密与目的放在扩展位：社区工具不认也不影响，我们自己能读回来
      tavern: { secret: '', goal: '' },
    });
  });

  it('导出再导入能还原关键字段（往返一致）', () => {
    const first = parseCardJson(V2_CARD);
    const roundTrip = parseCardJson(toV2Card(first.input, '0.1.0'));

    expect(roundTrip.input.name).toBe(first.input.name);
    expect(roundTrip.input.firstMes).toBe(first.input.firstMes);
    expect(roundTrip.input.tags).toEqual(first.input.tags);
  });
});
