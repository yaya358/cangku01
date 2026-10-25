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

    expect(LATEST_VERSION).toBe(16);

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
