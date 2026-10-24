import { describe, expect, it } from 'vitest';
import { estimateMessagesTokens, estimateTokens } from './tokens.js';
import { assembleContext, truncateToTokens } from './pipeline.js';
import type { AssembleInput } from './types.js';

function makeInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    character: {
      name: '月灯老板',
      description: '守着一间只在夜里开门的小酒馆，记得每个客人的名字。',
      personality: '话痨、心软',
      scenario: '深夜的酒馆，炉火正旺',
      postHistoryInstructions: '保持简短，不要用网络流行语。',
    },
    history: [],
    userInput: '来一杯最烈的。',
    userName: '旅人',
    ...overrides,
  };
}

describe('token 估算', () => {
  it('空文本为 0，非空至少 1', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
  });

  it('中文比等长英文更费 token', () => {
    const chinese = estimateTokens('酒馆的灯还亮着');
    const english = estimateTokens('the lantern is still on');
    expect(chinese).toBeGreaterThan(english);
  });

  it('随文本长度单调增长', () => {
    const short = estimateTokens('你好');
    const long = estimateTokens('你好'.repeat(50));
    expect(long).toBeGreaterThan(short);
  });

  it('消息数组带结构开销', () => {
    const single = estimateMessagesTokens([{ content: '你好' }]);
    expect(single).toBeGreaterThan(estimateTokens('你好'));
  });
});

describe('truncateToTokens', () => {
  it('不超上限时原样返回', () => {
    expect(truncateToTokens('短文本', 100)).toBe('短文本');
  });

  it('截断后 token 数不超过上限', () => {
    const text = '这是一段很长的设定文字。'.repeat(40);
    const truncated = truncateToTokens(text, 50);
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(50);
    expect(truncated.endsWith('…')).toBe(true);
  });

  it('预算太小时返回空串', () => {
    expect(truncateToTokens('随便什么', 5)).toBe('');
  });
});

describe('上下文组装 · 顺序', () => {
  it('按 系统→人设→场景→世界书→摘要→历史→历史后指令→输入 排列', () => {
    const context = assembleContext(
      makeInput({
        worldbook: [{ id: 'city', title: '王都', content: '王都是座不夜城。', keywords: ['王都'] }],
        summary: '旅人已经来过三次。',
        history: [
          { role: 'user', content: '第一句' },
          { role: 'assistant', content: '第一句回复' },
        ],
      }),
    );

    expect(context.layers.map((layer) => layer.kind)).toEqual([
      'system',
      'persona',
      'scenario',
      'worldbook',
      'summary',
      'history',
      'history',
      'post_history',
      'user_input',
    ]);
  });

  it('系统消息里合并了人设/场景/世界书/摘要，历史与输入单独成条', () => {
    const context = assembleContext(
      makeInput({
        worldbook: [{ id: 'city', title: '王都', content: '王都是座不夜城。' }],
        history: [{ role: 'user', content: '之前说过话' }],
      }),
    );

    const messages = context.messages;
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('【角色】月灯老板');
    expect(messages[0]?.content).toContain('【场景】');
    expect(messages[0]?.content).toContain('王都是座不夜城');

    expect(messages[1]).toMatchObject({ role: 'user', content: '之前说过话' });
    // 历史后指令在历史之后、输入之前
    expect(messages[2]?.role).toBe('system');
    expect(messages[2]?.content).toContain('不要用网络流行语');
    expect(messages[3]).toMatchObject({ role: 'user', content: '来一杯最烈的。' });
  });

  it('{{char}} / {{user}} 会被替换成实际名字', () => {
    const context = assembleContext(
      makeInput({
        character: {
          name: '酒保',
          description: '{{char}} 认识 {{user}}。',
          personality: '',
          scenario: '',
        },
        userInput: '{{char}}，老样子。',
      }),
    );

    const system = context.messages[0]?.content ?? '';
    expect(system).toContain('酒保 认识 旅人');
    expect(context.messages.at(-1)?.content).toBe('酒保，老样子。');
  });

  it('空字段不会在 prompt 里留下空行', () => {
    const context = assembleContext(
      makeInput({
        character: {
          name: '无名',
          description: '',
          personality: '',
          scenario: '',
        },
        userInput: '在吗',
      }),
    );

    expect(context.layers.map((layer) => layer.kind)).toEqual(['system', 'persona', 'user_input']);
    const system = context.messages[0]?.content ?? '';
    expect(system).not.toMatch(/\n{3,}/);
  });

  it('角色自带 systemPrompt 时覆盖全局默认', () => {
    const context = assembleContext(
      makeInput({
        character: {
          name: '冷面守卫',
          description: '话少',
          personality: '',
          scenario: '',
          systemPrompt: '你只能回答一句话。',
        },
      }),
    );

    expect(context.messages[0]?.content).toContain('你只能回答一句话');
    expect(context.messages[0]?.content).not.toContain('沉浸式角色扮演');
  });
});

describe('上下文组装 · 预算', () => {
  it('预算充足时不裁剪', () => {
    const context = assembleContext(makeInput());
    expect(context.budget.truncated).toBe(false);
    expect(context.budget.dropped).toEqual([]);
    expect(context.budget.used).toBeGreaterThan(0);
    expect(context.budget.available).toBe(8192 - 1024 - 128);
  });

  it('超预算时优先裁掉最早的历史', () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `这是第 ${index} 轮对话，内容大概有这么长，用来把预算撑爆。`,
    }));

    const context = assembleContext(
      makeInput({
        history,
        budget: { contextWindow: 500, reservedForOutput: 100, safetyMargin: 20 },
      }),
    );

    expect(context.budget.truncated).toBe(true);
    // 保留的必须有最新一条，丢掉的必须是更早的
    const keptHistory = context.layers.filter((layer) => layer.kind === 'history');
    expect(keptHistory.length).toBeLessThan(history.length);
    expect(keptHistory.at(-1)?.content).toContain('第 19 轮');

    const droppedHistory = context.budget.dropped.filter((layer) => layer.kind === 'history');
    expect(droppedHistory.length).toBeGreaterThan(0);
    expect(droppedHistory[0]?.content).toContain('第 0 轮');
    expect(context.notes.join()).toContain('历史被裁掉');
  });

  it('必修层（系统提示与本轮输入）不会被裁掉', () => {
    const context = assembleContext(
      makeInput({
        character: {
          name: '长人设',
          description: '设定'.repeat(500),
          personality: '',
          scenario: '',
        },
        budget: { contextWindow: 300, reservedForOutput: 100, safetyMargin: 20 },
      }),
    );

    const kinds = context.layers.map((layer) => layer.kind);
    expect(kinds).toContain('system');
    expect(kinds).toContain('user_input');
  });

  it('长人设超预算时被截断而不是整段消失', () => {
    const context = assembleContext(
      makeInput({
        character: {
          name: '长人设',
          description: `人设正文。${'细节描述，'.repeat(200)}`,
          personality: '',
          scenario: '',
        },
        budget: { contextWindow: 600, reservedForOutput: 100, safetyMargin: 20 },
      }),
    );

    const persona = context.layers.find((layer) => layer.kind === 'persona');
    expect(persona).toBeDefined();
    expect(persona?.content.endsWith('…')).toBe(true);
    expect(context.notes.join()).toContain('截断');
    expect(context.budget.used).toBeLessThanOrEqual(context.budget.available);
  });

  it('预算被算尽时给出可执行提示', () => {
    const context = assembleContext(
      makeInput({
        userInput: '超长输入'.repeat(500),
        budget: { contextWindow: 200, reservedForOutput: 100, safetyMargin: 10 },
      }),
    );

    expect(context.notes.length).toBeGreaterThan(0);
  });
});
