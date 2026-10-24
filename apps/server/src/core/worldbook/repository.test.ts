import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../storage/migrations.js';
import { createCharacterRepository } from '../character/repository.js';
import { createWorldbookRepository } from './repository.js';
import type { WorldbookRepository } from './repository.js';
import { scanWorldbook } from './scan.js';

let db: DatabaseSync;
let repo: WorldbookRepository;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  repo = createWorldbookRepository(db);
});

afterEach(() => {
  db.close();
});

describe('世界书仓储', () => {
  it('创建后能读回，数组与布尔正确往返', () => {
    const created = repo.create({
      title: '王都',
      keys: ['王都', '首都'],
      secondaryKeys: ['城'],
      content: '王都是座不夜城。',
      constant: false,
      caseSensitive: true,
      priority: 10,
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.keys).toEqual(['王都', '首都']);
    expect(created.secondaryKeys).toEqual(['城']);
    expect(created.caseSensitive).toBe(true);
    expect(created.enabled).toBe(true);
    expect(repo.getById(created.id)).toEqual(created);
  });

  it('按角色取条目时包含全局条目', () => {
    const characters = createCharacterRepository(db);
    const blank = {
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
    const first = characters.create({ ...blank, name: '角色一' });
    const second = characters.create({ ...blank, name: '角色二' });

    repo.create({ title: '全局规则', keys: ['世界'], content: '魔法世界', characterId: null });
    repo.create({
      title: '专属设定',
      keys: ['秘密'],
      content: '只属于这个角色',
      characterId: first.id,
    });
    repo.create({ title: '别的角色', keys: ['别人'], content: '不该出现', characterId: second.id });

    const forChar = repo.listForCharacter(first.id);
    expect(forChar.map((item) => item.title).sort()).toEqual(['专属设定', '全局规则'].sort());

    // 不指定角色时只有全局条目
    expect(repo.listForCharacter(null).map((item) => item.title)).toEqual(['全局规则']);
    expect(repo.listAll()).toHaveLength(3);
  });

  it('给不存在的角色挂条目会被外键挡住', () => {
    expect(() =>
      repo.create({ title: 'x', keys: ['x'], content: 'y', characterId: 'not-exist' }),
    ).toThrow(/FOREIGN KEY/);
  });

  it('删除角色时它的世界书条目被级联删除', () => {
    const characters = createCharacterRepository(db);
    const character = characters.create({
      name: '月灯老板',
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
    });

    repo.create({ title: '专属', keys: ['x'], content: 'y', characterId: character.id });
    expect(repo.count()).toBe(1);

    characters.remove(character.id);
    expect(repo.count()).toBe(0);
  });

  it('局部更新只改传入字段', () => {
    const created = repo.create({ title: '旧标题', keys: ['a'], content: '旧内容', priority: 5 });

    const updated = repo.update(created.id, { title: '新标题' });
    expect(updated?.title).toBe('新标题');
    expect(updated?.content).toBe('旧内容');
    expect(updated?.keys).toEqual(['a']);
    expect(updated?.priority).toBe(5);
  });

  it('更新 can 关闭与清空次要关键词', () => {
    const created = repo.create({ title: 't', keys: ['a'], content: 'c', secondaryKeys: ['b'] });

    const updated = repo.update(created.id, { enabled: false, secondaryKeys: [] });
    expect(updated?.enabled).toBe(false);
    expect(updated?.secondaryKeys).toEqual([]);

    expect(repo.update('nope', { title: 'x' })).toBeUndefined();
  });

  it('删除后读不到，重复删除返回 false', () => {
    const created = repo.create({ title: 't', keys: ['a'], content: 'c' });
    expect(repo.remove(created.id)).toBe(true);
    expect(repo.remove(created.id)).toBe(false);
    expect(repo.getById(created.id)).toBeUndefined();
  });

  it('损坏的 keys 字段不会让列表崩掉', () => {
    const created = repo.create({ title: 't', keys: ['a'], content: 'c' });
    db.prepare('UPDATE worldbook_entries SET keys = ? WHERE id = ?').run('{坏数据}', created.id);

    expect(repo.getById(created.id)?.keys).toEqual([]);
  });

  it('仓储产出的记录能直接喂给扫描器', () => {
    repo.create({ title: '王都', keys: ['王都'], content: '王都有条黑市街。' });
    repo.create({ title: '黑市', keys: ['黑市'], content: '黑市只在午夜开张。' });

    const entries = repo.listForCharacter(null);
    const result = scanWorldbook(entries, '我们去王都');

    // 王都是第 0 轮命中，黑市来自它内容里的链式触发（第 1 轮）
    expect(result.hits.map((hit) => hit.entry.title)).toEqual(['王都', '黑市']);
    expect(result.passes).toBe(2);
  });
});
