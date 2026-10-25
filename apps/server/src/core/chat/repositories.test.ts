import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, LATEST_VERSION } from '../storage/migrations.js';
import { createCharacterRepository } from '../character/repository.js';
import type { CharacterRepository } from '../character/repository.js';
import { createConversationRepository } from './conversation-repository.js';
import type { ConversationRepository } from './conversation-repository.js';
import { createMessageRepository } from './message-repository.js';
import type { MessageRepository } from './message-repository.js';

let db: DatabaseSync;
let characters: CharacterRepository;
let conversations: ConversationRepository;
let messages: MessageRepository;
let characterId: string;

const BLANK = {
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
  mesExample: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  creatorNotes: '',
  tags: [],
  alternateGreetings: [],
};

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);

  characters = createCharacterRepository(db);
  conversations = createConversationRepository(db);
  messages = createMessageRepository(db);

  characterId = characters.create({ ...BLANK, name: '月灯老板' }).id;
});

afterEach(() => {
  db.close();
});

describe('迁移', () => {
  it('版本推到 3 且幂等', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(3);
    expect(runMigrations(db).applied).toEqual([]);
  });
});

describe('会话仓储', () => {
  it('新建后能读回，默认标题可读', () => {
    const created = conversations.create({ characterId });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.characterName).toBe('月灯老板');
    expect(created.title).toBe('新的对话');
    expect(created.messageCount).toBe(0);
    expect(created.activeLeafId).toBeNull();
    expect(conversations.getById(created.id)).toEqual(created);
  });

  it('列表按更新时间倒序，并统计消息数与最后一句', async () => {
    const first = conversations.create({ characterId, title: '第一段' });
    const second = conversations.create({ characterId, title: '第二段' });

    messages.append(first.id, { role: 'user', content: '第一段的第一句' });
    // 稍微错开时间，避免同毫秒导致排序不稳定
    await new Promise((resolve) => setTimeout(resolve, 5));
    conversations.touch(first.id);

    const list = conversations.list();
    expect(list[0]?.id).toBe(first.id);
    expect(list.find((item) => item.id === second.id)?.messageCount).toBe(0);

    const updated = conversations.getById(first.id);
    expect(updated?.messageCount).toBe(1);
    expect(updated?.preview).toBe('第一段的第一句');
  });

  it('按角色过滤', () => {
    const other = characters.create({ ...BLANK, name: '夜巡人' }).id;
    conversations.create({ characterId });
    conversations.create({ characterId: other });

    expect(conversations.list()).toHaveLength(2);
    expect(conversations.list(characterId)).toHaveLength(1);
  });

  it('改标题与 activeLeafId，空补丁不落库', () => {
    const created = conversations.create({ characterId });

    const renamed = conversations.update(created.id, { title: '改过的标题' });
    expect(renamed?.title).toBe('改过的标题');

    const leaf = conversations.update(created.id, { activeLeafId: 'msg-1' });
    expect(leaf?.activeLeafId).toBe('msg-1');

    expect(conversations.update('nope', { title: 'x' })).toBeUndefined();
  });

  it('删除会话时消息级联删除', () => {
    const conversation = conversations.create({ characterId });
    messages.append(conversation.id, { role: 'user', content: 'a' });
    messages.append(conversation.id, { role: 'assistant', content: 'b' });
    expect(messages.count()).toBe(2);

    conversations.remove(conversation.id);
    expect(messages.count()).toBe(0);
  });

  it('删除角色时会话级联删除', () => {
    conversations.create({ characterId });
    characters.remove(characterId);
    expect(conversations.count()).toBe(0);
  });

  it('预览会被截断并压平空白', () => {
    const conversation = conversations.create({ characterId });
    messages.append(conversation.id, {
      role: 'assistant',
      content: `第一行\n第二行${'很长'.repeat(60)}`,
    });

    const preview = conversations.getById(conversation.id)?.preview ?? '';
    expect(preview).not.toContain('\n');
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(81);
  });
});

describe('消息仓储', () => {
  it('追加消息带生成元信息', () => {
    const conversation = conversations.create({ characterId });

    const message = messages.append(conversation.id, {
      role: 'assistant',
      content: '哟，来了',
      model: 'deepseek-flash',
      provider: 'deepseek',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
      durationMs: 1999,
      firstTokenMs: 1305,
    });

    expect(message.model).toBe('deepseek-flash');
    expect(message.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(message.firstTokenMs).toBe(1305);
    expect(messages.getById(message.id)).toEqual(message);
  });

  it('按时间升序返回，用于拼上下文', () => {
    const conversation = conversations.create({ characterId });
    messages.append(conversation.id, { role: 'user', content: '第一句' });
    messages.append(conversation.id, { role: 'assistant', content: '第二句' });
    messages.append(conversation.id, { role: 'user', content: '第三句' });

    const list = messages.listByConversation(conversation.id);
    expect(list.map((item) => item.content)).toEqual(['第一句', '第二句', '第三句']);
  });

  it('parentId 构成树，根消息为 null', () => {
    const conversation = conversations.create({ characterId });
    const root = messages.append(conversation.id, { role: 'user', content: '根' });
    const child = messages.append(conversation.id, {
      role: 'assistant',
      content: '子',
      parentId: root.id,
    });

    expect(root.parentId).toBeNull();
    expect(child.parentId).toBe(root.id);
  });

  it('编辑正文不产生新消息', () => {
    const conversation = conversations.create({ characterId });
    const message = messages.append(conversation.id, { role: 'user', content: '原话' });

    const edited = messages.updateContent(message.id, '改过的话');
    expect(edited?.content).toBe('改过的话');
    expect(messages.count(conversation.id)).toBe(1);
    expect(messages.updateContent('nope', 'x')).toBeUndefined();
  });

  it('重说：追加候选并切到最新，可选择任意候选', () => {
    const conversation = conversations.create({ characterId });
    const message = messages.append(conversation.id, { role: 'assistant', content: '第一版' });

    // 助手消息天生就是第 0 个候选，重说不会把原来那版弄丢
    expect(message.swipes).toEqual(['第一版']);
    expect(message.swipeIndex).toBe(0);

    const second = messages.appendSwipe(message.id, '第二版');
    expect(second?.swipes).toEqual(['第一版', '第二版']);
    expect(second?.swipeIndex).toBe(1);
    expect(second?.content).toBe('第二版');

    const third = messages.appendSwipe(message.id, '第三版');
    expect(third?.swipes).toEqual(['第一版', '第二版', '第三版']);
    expect(third?.content).toBe('第三版');

    // 切回第一个候选：正文必须跟着走，否则「展示的」和「参与上下文的」会不一致
    const back = messages.selectSwipe(message.id, 0);
    expect(back?.swipeIndex).toBe(0);
    expect(back?.content).toBe('第一版');

    // 越界下标不改动
    expect(messages.selectSwipe(message.id, 99)).toBeUndefined();
  });

  it('用户消息不带候选', () => {
    const conversation = conversations.create({ characterId });
    const message = messages.append(conversation.id, { role: 'user', content: '我说的话' });

    expect(message.swipes).toEqual([]);
    expect(message.swipeIndex).toBe(0);
  });

  it('编辑有候选的消息会同步改当前候选', () => {
    const conversation = conversations.create({ characterId });
    const message = messages.append(conversation.id, { role: 'assistant', content: '原始' });
    messages.appendSwipe(message.id, '第二版');

    // 当前是第二版，编辑它
    const edited = messages.updateContent(message.id, '第二版（改过）');
    expect(edited?.content).toBe('第二版（改过）');
    expect(edited?.swipes[1]).toBe('第二版（改过）');

    // 切回第一版再切回来，改动还在
    messages.selectSwipe(message.id, 0);
    const back = messages.selectSwipe(message.id, 1);
    expect(back?.content).toBe('第二版（改过）');
  });

  it('删除会话后消息计数归零，单条删除可用', () => {
    const conversation = conversations.create({ characterId });
    const first = messages.append(conversation.id, { role: 'user', content: 'a' });
    messages.append(conversation.id, { role: 'assistant', content: 'b' });

    expect(messages.remove(first.id)).toBe(true);
    expect(messages.remove(first.id)).toBe(false);
    expect(messages.count(conversation.id)).toBe(1);
  });

  it('usage 损坏时退回 null 而不是让整条消息读不出来', () => {
    const conversation = conversations.create({ characterId });
    const message = messages.append(conversation.id, { role: 'assistant', content: 'x' });
    db.prepare('UPDATE messages SET usage = ? WHERE id = ?').run('{坏数据}', message.id);

    expect(messages.getById(message.id)?.usage).toBeNull();
    expect(messages.getById(message.id)?.content).toBe('x');
  });
});
