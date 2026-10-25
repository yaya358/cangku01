import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AFFINITY_INITIAL, affinityMood } from '@tavern/shared';
import { runMigrations } from '../storage/migrations.js';
import { createCharacterRepository } from '../character/repository.js';
import { createAffinityRepository, describeAffinity } from './affinity.js';
import type { AffinityRepository } from './affinity.js';

let db: DatabaseSync;
let affinity: AffinityRepository;
let saveId: string;
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

  const characters = createCharacterRepository(db);
  characterId = characters.create({ ...BLANK, name: '月灯老板' }).id;
  saveId = 'save-1';
  db.prepare(
    'INSERT INTO saves (id, name, chapter, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
  ).run(saveId, '月灯镇', new Date().toISOString(), new Date().toISOString());

  affinity = createAffinityRepository(db, (id) => characters.getById(id)?.name);
});

afterEach(() => {
  db.close();
});

describe('好感度仓储', () => {
  it('没打过照面时是初始值，而且不写库', () => {
    const entry = affinity.get(saveId, characterId);
    expect(entry.value).toBe(AFFINITY_INITIAL);
    expect(entry.characterName).toBe('月灯老板');
    expect(affinity.list(saveId)).toEqual([]);
  });

  it('加减分写进库，原因也留着', () => {
    const { affinity: updated } = affinity.apply(saveId, characterId, 4, '你替他把话圆了');
    expect(updated.value).toBe(AFFINITY_INITIAL + 4);
    expect(updated.lastReason).toBe('你替他把话圆了');

    const again = affinity.apply(saveId, characterId, -6, '你当众揭了他的短');
    expect(again.affinity.value).toBe(AFFINITY_INITIAL - 2);
    expect(again.affinity.lastReason).toBe('你当众揭了他的短');
    expect(affinity.list(saveId)).toHaveLength(1);
  });

  it('夹在 0~100：好感是尺子不是计数器', () => {
    affinity.apply(saveId, characterId, 999, '夸到天上');
    expect(affinity.get(saveId, characterId).value).toBe(100);

    affinity.apply(saveId, characterId, -999, '翻脸');
    expect(affinity.get(saveId, characterId).value).toBe(0);
  });

  it('阈值点只触发一次', () => {
    const first = affinity.apply(saveId, characterId, 11, '说到点子上');
    expect(first.affinity.value).toBe(61);
    expect(first.crossed).toEqual(['affinity:open']);
    expect(first.affinity.unlocked).toContain('affinity:open');

    // 在同一阈值以上再涨，不该再报一次「刚跨过」
    const second = affinity.apply(saveId, characterId, 3, '又说对了一句');
    expect(second.crossed).toEqual([]);
    expect(second.affinity.unlocked).toEqual(['affinity:open']);
  });

  it('不同存档各自算：同一个角色不是同一段关系', () => {
    db.prepare(
      'INSERT INTO saves (id, name, chapter, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).run('save-2', '另一条世界线', new Date().toISOString(), new Date().toISOString());

    affinity.apply(saveId, characterId, 10, '这一周目聊得好');
    expect(affinity.get('save-2', characterId).value).toBe(AFFINITY_INITIAL);
  });
});

describe('态度判定', () => {
  it('60 以上松口、20 以下冷处理、中间是普通', () => {
    expect(affinityMood(60)).toBe('open');
    expect(affinityMood(59)).toBe('neutral');
    expect(affinityMood(21)).toBe('neutral');
    expect(affinityMood(20)).toBe('cold');
    expect(describeAffinity(75)).toContain('松了口');
    expect(describeAffinity(10)).toContain('冷处理');
  });
});
