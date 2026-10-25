import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../storage/migrations.js';
import { mainlineFor, nextStepText, firstSentence, createJournalRepository } from './journal.js';
import type { CastMember, JournalRepository, QuestValues } from './journal.js';

let db: DatabaseSync;
let journal: JournalRepository;
const saveId = 'save-1';

const cast: CastMember[] = [
  { id: 'c-boss', name: '月灯老板' },
  { id: 'c-patrol', name: '夜巡人' },
  { id: 'c-cat', name: '猫' },
];

const values = (focusAffinity: number, maxAffinity = focusAffinity): QuestValues => ({
  focusAffinity,
  maxAffinity,
});

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    'INSERT INTO saves (id, name, chapter, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
  ).run(saveId, '月灯镇', new Date().toISOString(), new Date().toISOString());

  // 名字从传进来的表里取，不给就返回 undefined（测试里也顺便验证兜底）
  const names = new Map(cast.map((member) => [member.id, member.name]));
  journal = createJournalRepository(db, (characterId) => names.get(characterId));
});

afterEach(() => {
  db.close();
});

describe('主线模板：一章指着一个人', () => {
  it('在场三个人就写三章，每章指名一个人、条件递增', () => {
    const chapters = mainlineFor(cast);
    expect(chapters).toHaveLength(3);
    expect(chapters.map((item) => item.focusCharacterId)).toEqual(['c-boss', 'c-patrol', 'c-cat']);
    expect(chapters.map((item) => item.requiredClues)).toEqual([1, 2, 3]);
    expect(chapters.every((item) => item.requiredAffinity === 60)).toBe(true);
    expect(chapters[0]!.title).toContain('月灯老板');
    expect(chapters[0]!.goal).toContain('月灯老板');
  });

  it('只有两个人就两章：别硬凑第三章', () => {
    expect(mainlineFor(cast.slice(0, 2))).toHaveLength(2);
  });

  it('一个人都没有时给一章通用目标，不指定人', () => {
    const chapters = mainlineFor([]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.focusCharacterId).toBeNull();
  });
});

describe('主线', () => {
  it('第一次打开就把整条主线写进库，而且不会重复写', () => {
    journal.ensureMainline(saveId, cast);
    journal.ensureMainline(saveId, cast);

    const quests = journal.listQuests(saveId);
    expect(quests).toHaveLength(3);
    expect(quests[0]).toMatchObject({
      chapter: 1,
      status: 'active',
      focusCharacterId: 'c-boss',
      focusCharacterName: '月灯老板',
    });
    expect(quests[1]!.status).toBe('active');
  });

  it('当前章是章号最小的未完成章', () => {
    journal.ensureMainline(saveId, cast);
    expect(journal.activeQuest(saveId)?.chapter).toBe(1);

    journal.addClue({ saveId, content: '第一条' });
    journal.advance(saveId, values(60));
    expect(journal.activeQuest(saveId)?.chapter).toBe(2);
  });

  it('好感只看焦点角色：别人再高也不算数', () => {
    journal.ensureMainline(saveId, cast);
    journal.addClue({ saveId, content: '第一条' });
    journal.advance(saveId, values(60));

    // 第二章指着夜巡人：他 40 分、月灯老板 90 分，仍然不算过关
    journal.addClue({ saveId, content: '第二条' });
    const blocked = journal.advance(saveId, values(40, 90));
    expect(blocked.advanced).toBe(false);
    expect(journal.activeQuest(saveId)?.chapter).toBe(2);
  });

  it('条件够了就一章一章往下走，最后停在最后一章', () => {
    journal.ensureMainline(saveId, cast);

    journal.addClue({ saveId, content: '第一条' });
    const first = journal.advance(saveId, values(60));
    expect(first).toMatchObject({ advanced: true, chapter: 2 });
    expect(first.next?.focusCharacterName).toBe('夜巡人');

    journal.addClue({ saveId, content: '第二条' });
    const second = journal.advance(saveId, values(60));
    expect(second).toMatchObject({ advanced: true, chapter: 3 });

    journal.addClue({ saveId, content: '第三条' });
    const last = journal.advance(saveId, values(60));
    expect(last.advanced).toBe(true);
    expect(last.next).toBeNull();
    expect(last.chapter).toBe(3);
    expect(journal.activeQuest(saveId)).toBeUndefined();
    expect(journal.listQuests(saveId).every((quest) => quest.status === 'done')).toBe(true);
  });

  it('存档章号跟着推进', () => {
    journal.ensureMainline(saveId, cast);
    expect(journal.chapterOf(saveId)).toBe(1);

    journal.addClue({ saveId, content: '第一条' });
    journal.advance(saveId, values(60));
    expect(journal.chapterOf(saveId)).toBe(2);
  });

  it('情报条数不够时也不动', () => {
    journal.ensureMainline(saveId, cast);
    const blocked = journal.advance(saveId, values(100));
    expect(blocked.advanced).toBe(false);
    expect(journal.activeQuest(saveId)?.chapter).toBe(1);
  });
});

describe('进度与下一步', () => {
  it('进度取焦点角色的好感，下一步说清楚"差什么、找谁"', () => {
    journal.ensureMainline(saveId, cast);

    const progress = journal.progress(saveId, values(52, 90));
    expect(progress).toMatchObject({
      clues: 0,
      needed: 1,
      affinity: 52,
      requiredAffinity: 60,
    });
    expect(progress?.nextStep).toContain('月灯老板');
    expect(progress?.nextStep).toContain('8 点');
    expect(progress?.nextStep).toContain('1 条');
  });

  it('好感够了就只提情报', () => {
    journal.ensureMainline(saveId, cast);
    const progress = journal.progress(saveId, values(65));
    expect(progress?.nextStep).toContain('好感够了');
    expect(progress?.nextStep).not.toContain('点（');
  });

  it('两样都够了就提示说一句话过关', () => {
    journal.ensureMainline(saveId, cast);
    journal.addClue({ saveId, content: '第一条' });
    // 注意：advance 会立刻关章，所以这里在关章前问进度
    const progress = journal.progress(saveId, values(65));
    expect(progress?.nextStep).toContain('再说一句话就过关');
  });

  it('没有焦点角色时回退到全存档最高好感', () => {
    journal.ensureMainline(saveId, []);
    const progress = journal.progress(saveId, values(30, 77));
    expect(progress?.affinity).toBe(77);
  });

  it('全部演完之后没有进度', () => {
    journal.ensureMainline(saveId, cast);
    for (const [index, content] of ['第一条', '第二条', '第三条'].entries()) {
      journal.addClue({ saveId, content });
      journal.advance(saveId, values(60));
      expect(index).toBeLessThan(3);
    }
    expect(journal.progress(saveId, values(60))).toBeNull();
  });
});

describe('下一步文案', () => {
  const base = {
    id: 'q',
    saveId,
    chapter: 1,
    title: '第一章',
    goal: '',
    status: 'active' as const,
    focusCharacterId: 'c-patrol',
    focusCharacterName: '夜巡人',
    requiredClues: 2,
    requiredAffinity: 60,
    createdAt: '',
    updatedAt: '',
  };

  it('差好感也差情报时两样都说', () => {
    const text = nextStepText(base, values(50), 0);
    expect(text).toContain('夜巡人');
    expect(text).toContain('10 点');
    expect(text).toContain('2 条');
  });

  it('只差情报时不再提好感', () => {
    expect(nextStepText(base, values(70), 1)).toContain('还差 1 条情报');
  });

  it('只差好感时不再提情报', () => {
    const text = nextStepText(base, values(55), 2);
    expect(text).toContain('聊高 5 点');
    expect(text).not.toContain('条情报');
  });
});

describe('情报本', () => {
  it('记一条情报，来源、轮次、原话都留着', () => {
    const clue = journal.addClue({
      saveId,
      content: '名单上最后一个人是他自己',
      source: '夜巡人',
      sourceTurn: 7,
      quote: '名单是我写的，谁在上头，我自己清楚。',
    });

    expect(clue).toMatchObject({
      source: '夜巡人',
      sourceTurn: 7,
      quote: '名单是我写的，谁在上头，我自己清楚。',
    });
    expect(journal.listClues(saveId)).toHaveLength(1);
  });

  it('同一句话不重复记：套三次也只算一条', () => {
    const first = journal.addClue({ saveId, content: '名单上最后一个人是他自己' });
    const second = journal.addClue({ saveId, content: '名单上最后一个人是他自己' });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(journal.listClues(saveId)).toHaveLength(1);
  });

  it('空内容不记', () => {
    expect(journal.addClue({ saveId, content: '   ' })).toBeNull();
    expect(journal.listClues(saveId)).toEqual([]);
  });
});

describe('摘要取第一句', () => {
  it('按句号断，太长就截断', () => {
    expect(firstSentence('名单上最后一个人是他自己。他巡夜，是因为不敢睡。')).toBe(
      '名单上最后一个人是他自己。',
    );
    expect(firstSentence('   ')).toBe('');
    expect(firstSentence('一')).toBe('一');
  });
});
