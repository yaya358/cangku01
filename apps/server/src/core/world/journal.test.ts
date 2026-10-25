import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../storage/migrations.js';
import { createJournalRepository, firstSentence } from './journal.js';
import type { JournalRepository } from './journal.js';

let db: DatabaseSync;
let journal: JournalRepository;
const saveId = 'save-1';

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    'INSERT INTO saves (id, name, chapter, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
  ).run(saveId, '月灯镇', new Date().toISOString(), new Date().toISOString());
  journal = createJournalRepository(db);
});

afterEach(() => {
  db.close();
});

describe('主线', () => {
  it('第一次打开就有第一章，而且不会重复写', () => {
    journal.ensureMainline(saveId);
    journal.ensureMainline(saveId);

    const quests = journal.listQuests(saveId);
    expect(quests).toHaveLength(1);
    expect(quests[0]).toMatchObject({ chapter: 1, status: 'active' });
    expect(quests[0]!.title).toContain('第一章');
  });

  it('条件不够时不动：情报或好感差一个都不行', () => {
    journal.ensureMainline(saveId);

    const noClue = journal.advance(saveId, 100);
    expect(noClue.advanced).toBe(false);
    expect(journal.activeQuest(saveId)?.chapter).toBe(1);

    // 第一章只要一条情报：有了就过
    journal.addClue({ saveId, content: '名单上最后一个人是他自己' });
    const first = journal.advance(saveId, 0);
    expect(first.advanced).toBe(true);
    expect(first.chapter).toBe(2);
    expect(first.next?.title).toContain('第二章');
  });

  it('第二章同时要两条情报和 60 好感', () => {
    journal.ensureMainline(saveId);
    journal.addClue({ saveId, content: '第一条' });
    journal.advance(saveId, 0);

    journal.addClue({ saveId, content: '第二条' });
    const lowAffinity = journal.advance(saveId, 59);
    expect(lowAffinity.advanced).toBe(false);
    expect(journal.activeQuest(saveId)?.chapter).toBe(2);

    const ready = journal.advance(saveId, 60);
    expect(ready.advanced).toBe(true);
    expect(ready.chapter).toBe(3);
  });

  it('全部演完之后没有下一章，章号停在最后一章', () => {
    journal.ensureMainline(saveId);
    journal.addClue({ saveId, content: '第一条' });
    journal.advance(saveId, 0);
    journal.addClue({ saveId, content: '第二条' });
    journal.advance(saveId, 60);
    journal.addClue({ saveId, content: '第三条' });

    const last = journal.advance(saveId, 60);
    expect(last.advanced).toBe(true);
    expect(last.next).toBeNull();
    expect(last.chapter).toBe(3);
    expect(journal.activeQuest(saveId)).toBeUndefined();
    expect(journal.listQuests(saveId)).toHaveLength(3);
    expect(journal.listQuests(saveId).every((quest) => quest.status === 'done')).toBe(true);
  });

  it('存档章号跟着推进', () => {
    journal.ensureMainline(saveId);
    expect(journal.chapterOf(saveId)).toBe(1);

    journal.addClue({ saveId, content: '第一条' });
    journal.advance(saveId, 0);
    expect(journal.chapterOf(saveId)).toBe(2);
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

  it('进度把「情报几条、好感多少」一起算出来', () => {
    journal.ensureMainline(saveId);
    journal.addClue({ saveId, content: '第一条' });

    expect(journal.progress(saveId, 40)).toEqual({
      clues: 1,
      needed: 1,
      affinity: 40,
      requiredAffinity: 0,
    });
    // 全部演完之后没有进度可言
    journal.advance(saveId, 40);
    journal.addClue({ saveId, content: '第二条' });
    journal.advance(saveId, 60);
    journal.addClue({ saveId, content: '第三条' });
    journal.advance(saveId, 60);
    expect(journal.progress(saveId, 60)).toBeNull();
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
