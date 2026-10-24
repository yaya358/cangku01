import { DatabaseSync } from 'node:sqlite';
import type { CharacterInput } from '@tavern/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, LATEST_VERSION } from '../storage/migrations.js';
import { createCharacterRepository } from './repository.js';
import type { CharacterRepository } from './repository.js';
import { excerptOf } from './types.js';

let db: DatabaseSync;
let repo: CharacterRepository;

/** 每个用例一套干净的内存库，彼此不干扰。 */
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  repo = createCharacterRepository(db);
});

afterEach(() => {
  db.close();
});

function makeInput(overrides: Partial<CharacterInput> = {}): CharacterInput {
  return {
    name: '月灯老板',
    description: '守着一间只在夜里开门的小酒馆，记得每个客人的名字。\n第二段不该进摘要。',
    personality: '话痨、爱打听、心软',
    scenario: '深夜的酒馆，炉火正旺',
    firstMes: '（擦着杯子）哟，这个点还来？坐吧，杯子里刚好还有热的。',
    mesExample: '<START>\n{{user}}: 有酒吗？\n{{char}}: 有，也有故事。',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '作者备注：不要让她说网络流行语',
    tags: ['酒馆', '日常'],
    alternateGreetings: ['（打了个哈欠）来啦？'],
    ...overrides,
  };
}

describe('迁移', () => {
  it('首次迁移把版本推到最新，重复执行不再应用', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(1);

    const fresh = new DatabaseSync(':memory:');
    const first = runMigrations(fresh);
    expect(first.from).toBe(0);
    expect(first.applied.length).toBeGreaterThan(0);

    const second = runMigrations(fresh);
    expect(second.applied).toEqual([]);
    expect(second.from).toBe(LATEST_VERSION);
    fresh.close();
  });
});

describe('角色仓储', () => {
  it('创建后能按 id 读回，字段一一对应', () => {
    const created = repo.create(makeInput(), { source: 'png', specVersion: '2.0' });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.name).toBe('月灯老板');
    expect(created.tags).toEqual(['酒馆', '日常']);
    expect(created.alternateGreetings).toEqual(['（打了个哈欠）来啦？']);
    expect(created.source).toBe('png');
    expect(created.firstMes).toContain('擦着杯子');
    expect(created.avatarUrl).toBeNull();

    const loaded = repo.getById(created.id);
    expect(loaded).toEqual(created);
  });

  it('列表返回摘要而不是完整长文本', () => {
    repo.create(makeInput());
    repo.create(makeInput({ name: '夜巡人', description: '夜里巡街的人', tags: ['悬疑'] }));

    const page = repo.list();
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);

    const boss = page.items.find((item) => item.name === '月灯老板');
    expect(boss?.excerpt).toBe('守着一间只在夜里开门的小酒馆，记得每个客人的名字。');
    expect(boss?.hasGreeting).toBe(true);
    // 摘要结构里不该出现长文本字段
    expect(Object.keys(boss ?? {})).not.toContain('description');
  });

  it('支持按名称/描述搜索，并转义 LIKE 通配符', () => {
    repo.create(makeInput({ name: '月灯老板', description: '酒馆' }));
    repo.create(makeInput({ name: '夜巡人', description: '街上的人' }));
    repo.create(makeInput({ name: '50%折扣员', description: '促销' }));

    expect(repo.list({ search: '月灯' }).total).toBe(1);
    expect(repo.list({ search: '街上' }).total).toBe(1);
    // 关键：% 不该被当成通配符
    expect(repo.list({ search: '50%' }).total).toBe(1);
    expect(repo.list({ search: '不存在的名字' }).total).toBe(0);
  });

  it('分页参数被夹在合理区间', () => {
    for (let index = 0; index < 5; index += 1) {
      repo.create(makeInput({ name: `角色${index}` }));
    }

    const firstPage = repo.list({ limit: 2, offset: 0 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.limit).toBe(2);
    expect(firstPage.total).toBe(5);

    const secondPage = repo.list({ limit: 2, offset: 2 });
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);

    // 越界参数兜底
    expect(repo.list({ limit: 9999 }).limit).toBe(200);
    expect(repo.list({ limit: 0 }).limit).toBe(50);
    expect(repo.list({ offset: -5 }).offset).toBe(0);
  });

  it('局部更新只改传入的字段', () => {
    const created = repo.create(makeInput());
    const updated = repo.update(created.id, { name: '月灯老板（改）' });

    expect(updated?.name).toBe('月灯老板（改）');
    // 没传的字段必须原样保留
    expect(updated?.personality).toBe(created.personality);
    expect(updated?.tags).toEqual(created.tags);
    expect((updated?.updatedAt ?? '') >= created.updatedAt).toBe(true);
  });

  it('更新数组字段会正确序列化回读', () => {
    const created = repo.create(makeInput());
    const updated = repo.update(created.id, {
      tags: ['酒馆', '群像', '慢热'],
      alternateGreetings: ['早啊', '又是你'],
    });

    expect(repo.getById(created.id)?.tags).toEqual(['酒馆', '群像', '慢热']);
    expect(updated?.alternateGreetings).toEqual(['早啊', '又是你']);
  });

  it('更新不存在的角色返回 undefined，空补丁不落库', () => {
    expect(repo.update('nope', { name: 'x' })).toBeUndefined();

    const created = repo.create(makeInput());
    const unchanged = repo.update(created.id, {});
    expect(unchanged?.updatedAt).toBe(created.updatedAt);
  });

  it('设置与清除头像', () => {
    const created = repo.create(makeInput());
    const withAvatar = repo.setAvatar(created.id, 'abc.png');
    expect(withAvatar?.avatarUrl).toBe(`/api/characters/${created.id}/avatar`);

    const cleared = repo.setAvatar(created.id, null);
    expect(cleared?.avatarUrl).toBeNull();
    expect(repo.setAvatar('nope', 'x.png')).toBeUndefined();
  });

  it('删除后读不到，计数同步', () => {
    const created = repo.create(makeInput());
    expect(repo.count()).toBe(1);
    expect(repo.remove(created.id)).toBe(true);
    expect(repo.remove(created.id)).toBe(false);
    expect(repo.getById(created.id)).toBeUndefined();
    expect(repo.count()).toBe(0);
  });

  it('损坏的 JSON 字段不会让列表崩掉', () => {
    const created = repo.create(makeInput());
    // 模拟历史数据被外部工具写坏
    db.prepare('UPDATE characters SET tags = ?, alternate_greetings = ? WHERE id = ?').run(
      '{不是数组}',
      'null',
      created.id,
    );

    const page = repo.list();
    expect(page.items[0]?.tags).toEqual([]);
    expect(repo.getById(created.id)?.tags).toEqual([]);
    expect(repo.getById(created.id)?.alternateGreetings).toEqual([]);
  });
});

describe('excerptOf', () => {
  it('取第一段并截断', () => {
    expect(excerptOf('第一行\n第二行')).toBe('第一行');
    expect(excerptOf('\n\n  有空行的第一段  \n')).toBe('有空行的第一段');
    expect(excerptOf('')).toBe('');
    expect(excerptOf('啊'.repeat(200)).endsWith('…')).toBe(true);
  });
});
