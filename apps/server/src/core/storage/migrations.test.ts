import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from './migrations.js';
import { createCharacterRepository } from '../character/repository.js';

/**
 * 第 15 版迁移：旧对话搬进世界模式。
 *
 * 这版是**数据迁移**，不是加字段，所以单独测：用「只跑到 14 版」的库
 * 造好旧数据，再跑完整迁移，看场景是不是真的建出来、消息有没有被动过。
 */

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

let db: DatabaseSync;
let bossId: string;
let patrolId: string;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  // 先到第 14 版：模拟「还没迁移」的旧库
  runMigrations(
    db,
    MIGRATIONS.filter((migration) => migration.version <= 14),
  );

  const characters = createCharacterRepository(db);
  bossId = characters.create({ ...BLANK, name: '月灯老板' }).id;
  patrolId = characters.create({ ...BLANK, name: '夜巡人' }).id;
});

afterEach(() => {
  db.close();
});

function insertConversation(input: {
  id: string;
  characterId: string;
  title: string;
  members?: { id: string; name: string }[];
}): void {
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO conversations (id, character_id, title, created_at, updated_at, hall_members)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.id, input.characterId, input.title, at, at, JSON.stringify(input.members ?? []));
}

function insertMessage(conversationId: string, role: string, content: string): void {
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`m-${Math.random().toString(36).slice(2)}`, conversationId, role, content, at);
}

function count(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total?: number };
  return Number(row?.total ?? 0);
}

describe('迁移 15：旧对话 → 场景', () => {
  it('一对一的旧对话变成私聊场景，消息一条不少', () => {
    insertConversation({ id: 'c1', characterId: bossId, title: '月灯老板的对话' });
    insertMessage('c1', 'assistant', '哟，这个点还来？');
    insertMessage('c1', 'user', '来一杯。');

    runMigrations(db);

    expect(LATEST_VERSION).toBe(18);

    const conversation = db
      .prepare('SELECT scene_id FROM conversations WHERE id = ?')
      .get('c1') as { scene_id: string | null };
    expect(conversation.scene_id).toBeTruthy();

    const scene = db
      .prepare('SELECT * FROM scenes WHERE id = ?')
      .get(conversation.scene_id) as Record<string, unknown>;
    expect(scene).toMatchObject({ name: '月灯老板的对话', kind: 'private' });

    // 人在场，消息还挂在同一条会话上
    const presence = db
      .prepare('SELECT character_id FROM presence WHERE scene_id = ?')
      .all(conversation.scene_id) as { character_id: string }[];
    expect(presence.map((row) => row.character_id)).toEqual([bossId]);
    expect(count('messages')).toBe(2);
  });

  it('酒馆大厅那种多人在场的做成公开场景', () => {
    insertConversation({
      id: 'hall',
      characterId: bossId,
      title: '酒馆大厅',
      members: [
        { id: bossId, name: '月灯老板' },
        { id: patrolId, name: '夜巡人' },
      ],
    });

    runMigrations(db);

    const sceneId = (
      db.prepare('SELECT scene_id FROM conversations WHERE id = ?').get('hall') as {
        scene_id: string;
      }
    ).scene_id;
    const scene = db.prepare('SELECT kind FROM scenes WHERE id = ?').get(sceneId) as {
      kind: string;
    };
    // 把三个人塞进「只有你们两个人」的私聊里，界面就在说假话
    expect(scene.kind).toBe('public');

    const present = db
      .prepare('SELECT character_id FROM presence WHERE scene_id = ?')
      .all(sceneId) as { character_id: string }[];
    expect(present).toHaveLength(2);
  });

  it('没有存档就先建一个：场景不能凭空飘着', () => {
    insertConversation({ id: 'c1', characterId: bossId, title: '' });

    runMigrations(db);

    const saves = db.prepare('SELECT id, name FROM saves').all() as {
      id: string;
      name: string;
    }[];
    expect(saves).toHaveLength(1);

    const scene = db.prepare('SELECT name, save_id FROM scenes').get() as {
      name: string;
      save_id: string;
    };
    // 标题为空时用角色名兜底，不留一个没名字的场景
    expect(scene.name).toContain('月灯老板');
    expect(scene.save_id).toBe(saves[0]!.id);
  });

  it('已经是场景会话的不动，也没有旧对话时什么都不做', () => {
    insertConversation({ id: 'c1', characterId: bossId, title: '旧对话' });
    runMigrations(db);

    const sceneCount = count('scenes');
    // 再跑一次：没有待迁移的了，场景数不该变多
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(count('scenes')).toBe(sceneCount);
  });

  it('顺手接上断掉的 parent 链：早期场景对话每轮都成了新根', () => {
    insertConversation({ id: 'c1', characterId: bossId, title: '酒馆' });
    // 模拟第 1 步的 bug：用户消息没有 parent，助手消息挂在它下面
    const at = (second: number): string =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const insert = (id: string, role: string, parentId: string | null, at_: string): void => {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, 'c1', parentId, role, id, at_);
    };
    insert('u1', 'user', null, at(1));
    insert('a1', 'assistant', 'u1', at(2));
    insert('u2', 'user', null, at(3));
    insert('a2', 'assistant', 'u2', at(4));
    db.prepare('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run('a2', 'c1');

    runMigrations(db);

    const parents = db
      .prepare('SELECT id, parent_id FROM messages ORDER BY created_at ASC')
      .all() as { id: string; parent_id: string | null }[];
    expect(parents).toEqual([
      { id: 'u1', parent_id: null },
      { id: 'a1', parent_id: 'u1' },
      // 这一条以前是 NULL：从叶子回溯的话，u1/a1 就整段看不到了
      { id: 'u2', parent_id: 'a1' },
      { id: 'a2', parent_id: 'u2' },
    ]);
  });
});

describe('迁移 18：章节谜面与世界旁白', () => {
  it('给每章补上谜面，未完成的章节顺着新谜面改名', () => {
    const at = new Date().toISOString();
    const saveId = 'save-mystery';
    db.prepare(
      'INSERT INTO saves (id, name, chapter, created_at, updated_at) VALUES (?, ?, 2, ?, ?)',
    ).run(saveId, '月灯镇', at, at);
    const insertQuest = (id: string, chapter: number, status: string, title: string): void => {
      db.prepare(
        `INSERT INTO quests (id, save_id, chapter, title, goal, status, required_clues, required_affinity, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', ?, 1, 60, ?, ?)`,
      ).run(id, saveId, chapter, title, status, at, at);
    };
    insertQuest('q1', 1, 'done', '第一章 · 夜里的动静');
    insertQuest('q2', 2, 'active', '第二章 · 让夜巡人开口');

    runMigrations(db);

    const rows = db
      .prepare('SELECT id, chapter, title, question FROM quests ORDER BY chapter ASC')
      .all() as { id: string; chapter: number; title: string; question: string }[];

    expect(rows[0]!.question).toContain('那晚');
    expect(rows[1]!.question).toContain('通缉令');
    // 没演完的那章换成谜面名；已经过去的历史不动
    expect(rows[0]!.title).toBe('第一章 · 夜里的动静');
    expect(rows[1]!.title).toBe('第二章 · 那张通缉令');
  });

  it('老的开场旁白补上 beat 标记', () => {
    const at = new Date().toISOString();
    db.prepare(
      'INSERT INTO saves (id, name, chapter, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).run('save-beat', '月灯镇', at, at);
    db.prepare(
      "INSERT INTO conversations (id, character_id, title, created_at, updated_at) VALUES ('c1', ?, '酒馆', ?, ?)",
    ).run(patrolId, at, at);
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, kind, content, created_at)
       VALUES ('m1', 'c1', 'system', 'narrate', '你推门进了酒馆。', ?)`,
    ).run(at);

    runMigrations(db);

    const row = db.prepare("SELECT beat FROM messages WHERE id = 'm1'").get() as {
      beat: string | null;
    };
    expect(row.beat).toBe('opening');
  });
});

describe('迁移 17：主线指名到人', () => {
  /** 造一个已有存档：三个人都在场，只有夜巡人给过情报，两章旧主线。 */
  function seedLegacyMainline(): { saveId: string; catId: string } {
    const at = new Date().toISOString();
    const characters = createCharacterRepository(db);
    const catId = characters.create({ ...BLANK, name: '猫' }).id;
    const saveId = 'save-legacy';
    db.prepare(
      'INSERT INTO saves (id, name, chapter, created_at, updated_at) VALUES (?, ?, 2, ?, ?)',
    ).run(saveId, '月灯镇', at, at);
    const sceneId = 'scene-legacy';
    db.prepare(
      `INSERT INTO scenes (id, save_id, name, kind, closeness, created_at, updated_at)
       VALUES (?, ?, '酒馆', 'public', 0.35, ?, ?)`,
    ).run(sceneId, saveId, at, at);

    // 进场顺序：夜巡人 → 月灯老板 → 猫（entered_turn 全是 1，真实的乱象）
    for (const characterId of [patrolId, bossId, catId]) {
      db.prepare(
        `INSERT INTO presence (scene_id, character_id, entered_turn, left_turn, busy_with, reason)
         VALUES (?, ?, 1, NULL, NULL, NULL)`,
      ).run(sceneId, characterId);
    }

    // 夜巡人已经松过口（情报来源里就是他）—— 再把他当焦点没用
    db.prepare(
      "INSERT INTO clues (id, save_id, content, source, source_turn, quote, known_at) VALUES ('clue-1', ?, '名单上最后一个人是他自己', '夜巡人', 3, '原话', ?)",
    ).run(saveId, at);

    for (const chapter of [1, 2]) {
      db.prepare(
        `INSERT INTO quests (id, save_id, chapter, title, goal, status, required_clues, required_affinity, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', ?, ?, 60, ?, ?)`,
      ).run(
        `quest-${chapter}`,
        saveId,
        chapter,
        `第 ${chapter} 章`,
        chapter === 1 ? 'done' : 'active',
        chapter,
        at,
        at,
      );
    }

    return { saveId, catId };
  }

  it('焦点跳过「已经给过情报的人」，按进场顺序往下排', () => {
    seedLegacyMainline();
    runMigrations(db);

    const rows = db
      .prepare('SELECT id, focus_character_id FROM quests ORDER BY chapter ASC')
      .all() as { id: string; focus_character_id: string | null }[];

    // 夜巡人已经松过口 → 第一章给月灯老板；第二章再往下一个，给猫
    expect(rows[0]!.focus_character_id).toBe(bossId);
    expect(rows[1]!.focus_character_id).not.toBe(patrolId);
    expect(rows[1]!.focus_character_id).not.toBeNull();
  });

  it('没人在场时留空，回退到「全存档最高好感」', () => {
    const saveId = 'save-empty';
    const at = new Date().toISOString();
    db.prepare(
      'INSERT INTO saves (id, name, chapter, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).run(saveId, '空存档', at, at);
    db.prepare(
      `INSERT INTO quests (id, save_id, chapter, title, goal, status, required_clues, required_affinity, created_at, updated_at)
       VALUES ('q-empty', ?, 1, '第一章', '', 'active', 1, 0, ?, ?)`,
    ).run(saveId, at, at);

    runMigrations(db);

    const row = db.prepare("SELECT focus_character_id FROM quests WHERE id = 'q-empty'").get() as {
      focus_character_id: string | null;
    };
    expect(row.focus_character_id).toBeNull();
  });
});
