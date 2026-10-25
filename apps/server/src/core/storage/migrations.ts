import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 数据库迁移。
 *
 * 用 PRAGMA user_version 记录已执行到第几版，而不是引入迁移框架：
 * 一个本地单机应用，版本号 + 一个顺序数组就够了，出问题还能直接看 sqlite 文件。
 *
 * 铁律：已经发布过的迁移不能再改，只能追加新版本。
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'characters',
    up: (db) => {
      db.exec(`
        CREATE TABLE characters (
          id                        TEXT PRIMARY KEY,
          name                      TEXT NOT NULL,
          description               TEXT NOT NULL DEFAULT '',
          personality               TEXT NOT NULL DEFAULT '',
          scenario                  TEXT NOT NULL DEFAULT '',
          first_mes                 TEXT NOT NULL DEFAULT '',
          mes_example               TEXT NOT NULL DEFAULT '',
          system_prompt             TEXT NOT NULL DEFAULT '',
          post_history_instructions TEXT NOT NULL DEFAULT '',
          creator_notes             TEXT NOT NULL DEFAULT '',
          tags                      TEXT NOT NULL DEFAULT '[]',
          alternate_greetings       TEXT NOT NULL DEFAULT '[]',
          avatar_file               TEXT,
          spec_version              TEXT NOT NULL DEFAULT '2.0',
          source                    TEXT NOT NULL DEFAULT 'manual',
          created_at                TEXT NOT NULL,
          updated_at                TEXT NOT NULL
        )
      `);
      // 列表页按名称排序 + 搜索，走这个索引
      db.exec('CREATE INDEX idx_characters_name ON characters (name)');
      db.exec('CREATE INDEX idx_characters_updated ON characters (updated_at DESC)');
    },
  },
  {
    version: 2,
    name: 'worldbook',
    up: (db) => {
      db.exec(`
        CREATE TABLE worldbook_entries (
          id             TEXT PRIMARY KEY,
          character_id   TEXT REFERENCES characters (id) ON DELETE CASCADE,
          title          TEXT NOT NULL,
          keys           TEXT NOT NULL DEFAULT '[]',
          secondary_keys TEXT NOT NULL DEFAULT '[]',
          content        TEXT NOT NULL DEFAULT '',
          enabled        INTEGER NOT NULL DEFAULT 1,
          constant       INTEGER NOT NULL DEFAULT 0,
          case_sensitive INTEGER NOT NULL DEFAULT 0,
          priority       INTEGER NOT NULL DEFAULT 0,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        )
      `);
      // 按角色取条目是最常见的查询；character_id 为 NULL 表示全局设定
      db.exec('CREATE INDEX idx_worldbook_character ON worldbook_entries (character_id)');
      db.exec('CREATE INDEX idx_worldbook_priority ON worldbook_entries (priority DESC)');
    },
  },
  {
    version: 3,
    name: 'conversations',
    up: (db) => {
      db.exec(`
        CREATE TABLE conversations (
          id             TEXT PRIMARY KEY,
          character_id   TEXT NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
          title          TEXT NOT NULL DEFAULT '',
          active_leaf_id TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        )
      `);
      db.exec('CREATE INDEX idx_conversations_character ON conversations (character_id)');
      db.exec('CREATE INDEX idx_conversations_updated ON conversations (updated_at DESC)');

      db.exec(`
        CREATE TABLE messages (
          id               TEXT PRIMARY KEY,
          conversation_id  TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
          parent_id        TEXT REFERENCES messages (id) ON DELETE SET NULL,
          role             TEXT NOT NULL,
          content          TEXT NOT NULL DEFAULT '',
          swipes           TEXT NOT NULL DEFAULT '[]',
          swipe_index      INTEGER NOT NULL DEFAULT 0,
          model            TEXT,
          provider         TEXT,
          usage            TEXT,
          finish_reason    TEXT,
          duration_ms      INTEGER,
          first_token_ms   INTEGER,
          created_at       TEXT NOT NULL
        )
      `);
      db.exec('CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at)');
      db.exec('CREATE INDEX idx_messages_parent ON messages (parent_id)');
    },
  },
  {
    version: 4,
    name: 'backfill-thread',
    up: (db) => {
      /**
       * 回填 parent_id，把历史数据从「一堆散消息」补成一条链。
       *
       * 分支功能依赖 parent 链行得通：早期写入的用户消息没有 parent，
       * 解析线程时会断在中间。规则很朴素 —— 每条消息的父 = 同一会话里
       * 创建时间比它早、且最晚的那条（同毫秒用 rowid 兜底）。
       */
      db.exec(`
        UPDATE messages
        SET parent_id = (
          SELECT prev.id
          FROM messages AS prev
          WHERE prev.conversation_id = messages.conversation_id
            AND (prev.created_at < messages.created_at
                 OR (prev.created_at = messages.created_at AND prev.rowid < messages.rowid))
          ORDER BY prev.created_at DESC, prev.rowid DESC
          LIMIT 1
        )
        WHERE parent_id IS NULL
          AND EXISTS (
            SELECT 1 FROM messages AS prev
            WHERE prev.conversation_id = messages.conversation_id
              AND (prev.created_at < messages.created_at
                   OR (prev.created_at = messages.created_at AND prev.rowid < messages.rowid))
          )
      `);

      // active_leaf_id 也补齐：指向每个会话最后一条消息
      db.exec(`
        UPDATE conversations
        SET active_leaf_id = (
          SELECT id FROM messages
          WHERE messages.conversation_id = conversations.id
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        )
        WHERE active_leaf_id IS NULL
          AND EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id)
      `);
    },
  },
  {
    version: 5,
    name: 'character-secret-goal',
    up: (db) => {
      /**
       * 角色的「秘密」与「目的」。
       *
       * 这两个字段是让角色从「被动应答」变成「有戏」的关键：
       *   secret —— 它心里知道但绝不主动说的事，玩家要试探、套话才能挖出来
       *   goal   —— 它想从玩家这里得到什么，决定它会主动出招
       * 老数据留空即可，不影响既有行为。
       */
      db.exec("ALTER TABLE characters ADD COLUMN secret TEXT NOT NULL DEFAULT ''");
      db.exec("ALTER TABLE characters ADD COLUMN goal TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 6,
    name: 'conversation-player',
    up: (db) => {
      /**
       * 玩家身份：这一轮里「你是谁、你图什么」。
       *
       * 放在会话上而不是全局：同一个角色，你换一个身份就是另一场戏。
       * 没有它，角色只能对「旅人」说客套话；有了它，它的目的才会针对你出招。
       */
      db.exec("ALTER TABLE conversations ADD COLUMN player_name TEXT NOT NULL DEFAULT ''");
      db.exec("ALTER TABLE conversations ADD COLUMN player_role TEXT NOT NULL DEFAULT ''");
      db.exec("ALTER TABLE conversations ADD COLUMN player_goal TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 7,
    name: 'script-events',
    up: (db) => {
      /**
       * 剧本事件：到第几轮，发生什么事。
       *
       * 这是把「闲聊」变成「短剧」的关键 —— 剧情不再全靠玩家推，
       * 到点会有人推门进来、有人掏出通缉令。
       */
      db.exec(`
        CREATE TABLE script_events (
          id           TEXT PRIMARY KEY,
          character_id TEXT NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
          at_turn      INTEGER NOT NULL,
          title        TEXT NOT NULL,
          content      TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        )
      `);
      db.exec('CREATE INDEX idx_script_events_character ON script_events (character_id, at_turn)');

      // 每个会话各自记录哪些事件已经发生过（同一条支线不会重复触发）
      db.exec(`
        CREATE TABLE conversation_events (
          conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
          event_id        TEXT NOT NULL REFERENCES script_events (id) ON DELETE CASCADE,
          fired_at        TEXT NOT NULL,
          PRIMARY KEY (conversation_id, event_id)
        )
      `);
    },
  },
  {
    version: 8,
    name: 'script-conditions-and-facts',
    up: (db) => {
      /**
       * 剧本升级：条件触发、结局标记、状态写入。
       *
       *   condition —— 触发条件关键词（逗号分隔）。空 = 到轮次就触发；
       *                非空 = 还要玩家说过其中任意一个词（比如「那晚」「灯」）
       *   is_ending —— 这一幕是结局：触发后这一场戏就算演完
       *   sets      —— 触发后写入的「事实」，会一直注入后续对话。
       *                例如「老周已经承认那晚他睡着了」——
       *                没有它，下一轮角色又会装作没说过。
       */
      db.exec("ALTER TABLE script_events ADD COLUMN condition TEXT NOT NULL DEFAULT ''");
      db.exec('ALTER TABLE script_events ADD COLUMN is_ending INTEGER NOT NULL DEFAULT 0');
      db.exec("ALTER TABLE script_events ADD COLUMN sets TEXT NOT NULL DEFAULT ''");

      // 会话级的剧情事实：一次写入，之后每轮都注入
      db.exec(`
        CREATE TABLE conversation_facts (
          conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
          source_event_id TEXT NOT NULL,
          content         TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          PRIMARY KEY (conversation_id, source_event_id)
        )
      `);
    },
  },
  {
    version: 9,
    name: 'message-kind',
    up: (db) => {
      /**
       * 这条消息是「说的」还是「做的」还是「想的」。
       *
       * 同一句「推开门」，当成说话（他说"推开门"）和当行动（他推开门）交给模型，
       * 得到的是完全不同的两段文字。存下来才知道当时是怎么输入的。
       */
      db.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'speak'");
    },
  },
  {
    version: 10,
    name: 'hall-members',
    up: (db) => {
      /**
       * 酒馆大厅：一个会话里可以在场多个角色。
       *
       * hall_members 存 JSON 数组（角色 id），顺序就是默认接话顺序；
       * speaker_id 记在消息上，才知道这句是谁说的。
       */
      db.exec("ALTER TABLE conversations ADD COLUMN hall_members TEXT NOT NULL DEFAULT '[]'");
      db.exec('ALTER TABLE messages ADD COLUMN speaker_id TEXT');
    },
  },
  {
    version: 11,
    name: 'world-saves-scenes',
    up: (db) => {
      /**
       * 世界存档：存档 → 场景 → 在场者。
       *
       * 会话不再按角色分，而是按「地方」分；人在场景里进进出出，
       * 你只能在能联系上他的时候跟他说话。
       */
      db.exec(`
        CREATE TABLE saves (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          chapter    INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE scenes (
          id         TEXT PRIMARY KEY,
          save_id    TEXT NOT NULL REFERENCES saves (id) ON DELETE CASCADE,
          name       TEXT NOT NULL,
          kind       TEXT NOT NULL DEFAULT 'public',
          closeness  REAL NOT NULL DEFAULT 0.3,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      db.exec('CREATE INDEX idx_scenes_save ON scenes (save_id)');

      db.exec(`
        CREATE TABLE presence (
          scene_id     TEXT NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
          character_id TEXT NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
          entered_turn INTEGER NOT NULL,
          left_turn    INTEGER,
          busy_with    TEXT,
          PRIMARY KEY (scene_id, character_id)
        )
      `);
      db.exec('CREATE INDEX idx_presence_scene ON presence (scene_id)');

      db.exec('ALTER TABLE conversations ADD COLUMN scene_id TEXT');
      db.exec('ALTER TABLE messages ADD COLUMN whisper INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 12,
    name: 'whisper-eavesdrop-and-private-scenes',
    up: (db) => {
      /**
       * 低声、偷听与私密场景。
       *
       *   messages.whisper        —— 迁移 11 就加好了，这一版才真的用上：压低声音说的那几句
       *   messages.eavesdrop      —— 第三者听见私聊之后的反应。单独标出来的理由有二：
       *                              界面上要写「（他听见了）」，轮转时也不能算作「轮到他说话」
       *   presence.reason         —— 为什么走的。没有它，「他走了」分不清是他自己走的
       *                              还是被你带走的，世界就少了半句话
       *   scenes.source_scene_id  —— 私密场景是从哪个公开场景出去的：回来的时候得知道回哪
       */
      db.exec('ALTER TABLE messages ADD COLUMN eavesdrop INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE presence ADD COLUMN reason TEXT');
      db.exec('ALTER TABLE scenes ADD COLUMN source_scene_id TEXT');
    },
  },
  {
    version: 13,
    name: 'affinity',
    up: (db) => {
      /**
       * 好感度：他对你的态度。
       *
       * 按「存档 + 角色」存：同一个角色在另一个存档里是另一个人生，
       * 上一周目的交情不该顺着世界线带过来。
       *
       *   value       —— 0~100，初始 50（刚认识，不冷不热）
       *   last_reason —— 上一轮为什么变（一句人话，界面显示这个才有说服力）
       *   unlocked    —— 已经触发过的阈值点（JSON 数组），保证「松口」只发生一次
       */
      db.exec(`
        CREATE TABLE affinity (
          save_id      TEXT NOT NULL REFERENCES saves (id) ON DELETE CASCADE,
          character_id TEXT NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
          value        INTEGER NOT NULL DEFAULT 50,
          last_reason  TEXT NOT NULL DEFAULT '',
          unlocked     TEXT NOT NULL DEFAULT '[]',
          updated_at   TEXT NOT NULL,
          PRIMARY KEY (save_id, character_id)
        )
      `);
    },
  },
  {
    version: 14,
    name: 'quests-and-clues',
    up: (db) => {
      /**
       * 主线（quests）与情报本（clues）。
       *
       * 为什么不用 beats 那套通用条件：设计文档里已经定过 ——
       * 章节需求就是「几条情报 + 某人好感多少」，两个整数比一门小语言好校验、
       * 也好在侧栏上说清楚。真需要复杂条件时再加 beats 也不迟。
       *
       *   quests.required_clues     —— 关掉这一章要几条情报
       *   quests.required_affinity  —— 还要有人的好感达到多少（0 = 不看好感）
       *   clues.quote               —— 原话：情报本要能「展开看当时是怎么说的」
       */
      db.exec(`
        CREATE TABLE quests (
          id                TEXT PRIMARY KEY,
          save_id           TEXT NOT NULL REFERENCES saves (id) ON DELETE CASCADE,
          chapter           INTEGER NOT NULL,
          title             TEXT NOT NULL,
          goal              TEXT NOT NULL DEFAULT '',
          status            TEXT NOT NULL DEFAULT 'active',
          required_clues    INTEGER NOT NULL DEFAULT 1,
          required_affinity INTEGER NOT NULL DEFAULT 0,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        )
      `);
      db.exec('CREATE INDEX idx_quests_save ON quests (save_id, chapter)');

      db.exec(`
        CREATE TABLE clues (
          id         TEXT PRIMARY KEY,
          save_id    TEXT NOT NULL REFERENCES saves (id) ON DELETE CASCADE,
          content    TEXT NOT NULL,
          source     TEXT,
          source_turn INTEGER,
          quote      TEXT,
          known_at   TEXT NOT NULL
        )
      `);
      db.exec('CREATE INDEX idx_clues_save ON clues (save_id, known_at)');
    },
  },
  {
    version: 15,
    name: 'migrate-legacy-conversations-to-scenes',
    up: (db) => {
      /**
       * 把「按角色开的旧对话」搬进世界模式：每条旧会话变成一个场景。
       *
       * 消息一条都不动 —— 只把 conversations.scene_id 指向新场景，
       * 于是旧内容在场景页里原样读得出来（resolveThread 走的是同一条链）。
       *
       * 两个判断：
       *   1. 只有真·一对一的旧对话才做成 private（「私聊 · 只有你们」）；
       *      酒馆大厅那种多人在场的，做成 public —— 把三个人塞进「只有你们两个人」
       *      的场景里，界面上就是在说假话。
       *   2. 没有存档就先建一个：场景必须挂在存档下，不能凭空飘着。
       */
      const legacy = db
        .prepare(
          'SELECT id, character_id, title, hall_members FROM conversations WHERE scene_id IS NULL',
        )
        .all() as unknown as {
        id: string;
        character_id: string;
        title: string;
        hall_members: string | null;
      }[];
      if (legacy.length === 0) return;

      const at = new Date().toISOString();
      let saveRow = db.prepare('SELECT id FROM saves ORDER BY created_at ASC LIMIT 1').get() as
        { id: string } | undefined;
      if (!saveRow) {
        const saveId = randomUUID();
        db.prepare(
          'INSERT INTO saves (id, name, chapter, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
        ).run(saveId, '月灯镇', at, at);
        saveRow = { id: saveId };
      }
      const saveId = saveRow.id;

      const parseMembers = (raw: string | null): string[] => {
        try {
          const parsed: unknown = JSON.parse(raw ?? '[]');
          if (!Array.isArray(parsed)) return [];
          return parsed
            .map((item) =>
              typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined,
            )
            .filter((id): id is string => typeof id === 'string');
        } catch {
          return [];
        }
      };

      const characterName = (id: string): string => {
        const row = db.prepare('SELECT name FROM characters WHERE id = ?').get(id) as
          { name?: string } | undefined;
        return row?.name ?? '某人';
      };

      for (const conversation of legacy) {
        const hallMembers = parseMembers(conversation.hall_members).filter(
          (id) => id !== conversation.character_id,
        );
        const memberIds = [conversation.character_id, ...hallMembers].filter(
          (id, index, list) => list.indexOf(id) === index,
        );
        const isHall = memberIds.length > 1;
        const sceneId = randomUUID();
        const name =
          conversation.title.trim() ||
          `${characterName(conversation.character_id)}${isHall ? '的场景' : '的私聊'}`;

        db.prepare(
          `INSERT INTO scenes (id, save_id, name, kind, closeness, source_scene_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        ).run(sceneId, saveId, name, isHall ? 'public' : 'private', isHall ? 0.35 : 0.7, at, at);

        for (const characterId of memberIds) {
          db.prepare(
            `INSERT OR IGNORE INTO presence
               (scene_id, character_id, entered_turn, left_turn, busy_with, reason)
             VALUES (?, ?, 1, NULL, NULL, NULL)`,
          ).run(sceneId, characterId);
        }

        db.prepare('UPDATE conversations SET scene_id = ? WHERE id = ?').run(
          sceneId,
          conversation.id,
        );
      }
    },
  },
  {
    version: 16,
    name: 'repair-broken-message-chains',
    up: (db) => {
      /**
       * 把「断掉的链」接上。
       *
       * 早期的场景对话接口没给每条用户消息挂 parent_id，于是每轮各自成一条根链 ——
       * 从当前叶子回溯只看得到最后一轮，前面说过的话等于没了（第 2 步修的是不再产生
       * 新断链，已有数据得在这里补）。
       *
       * 规则：只有会话里的第一条消息可以没有父，其余没有父的都是漏挂，
       * 补成「同一会话里时间上紧挨着的前一条」。
       */
      db.exec(`
        UPDATE messages
        SET parent_id = (
          SELECT prev.id
          FROM messages AS prev
          WHERE prev.conversation_id = messages.conversation_id
            AND (prev.created_at < messages.created_at
                 OR (prev.created_at = messages.created_at AND prev.rowid < messages.rowid))
          ORDER BY prev.created_at DESC, prev.rowid DESC
          LIMIT 1
        )
        WHERE parent_id IS NULL
          AND conversation_id IN (SELECT id FROM conversations WHERE scene_id IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM messages AS prev
            WHERE prev.conversation_id = messages.conversation_id
              AND (prev.created_at < messages.created_at
                   OR (prev.created_at = messages.created_at AND prev.rowid < messages.rowid))
          )
      `);
    },
  },
  {
    version: 17,
    name: 'quest-focus-character',
    up: (db) => {
      /**
       * 每一章指名一个人。
       *
       * 之前的主线是「让在场有人愿意说点什么」这种抽象目标，进度又取全存档最高好感 ——
       * 于是「好感 61/60」显示达标了却没过章，玩家看不出差在哪。绑定焦点角色之后，
       * 进度、下一步、情报来源都落在同一个名字上。
       *
       * 已有章节的补法：按在场顺序挑「还没给过你情报」的人 ——
       * 已经松过口的人再当焦点没用（一个角色只会松口一次），
       * 拿情报本的来源名当「已经给过」的信号。
       */
      db.exec('ALTER TABLE quests ADD COLUMN focus_character_id TEXT');

      const cluesBySave = new Map<string, Set<string>>();
      for (const row of db.prepare('SELECT save_id, source FROM clues').all() as unknown as {
        save_id: string;
        source: string | null;
      }[]) {
        const used = cluesBySave.get(row.save_id) ?? new Set<string>();
        if (row.source) used.add(row.source);
        cluesBySave.set(row.save_id, used);
      }

      // SQLite 的 LIMIT/OFFSET 不能引用外层列（相关子查询在这里行不通），
      // 所以一行行补；按 rowid 排才是真正的进场顺序（entered_turn 常常都等于 1）。
      const presentOf = db.prepare(
        `SELECT p.character_id, c.name
         FROM presence AS p
         JOIN scenes AS s ON s.id = p.scene_id
         LEFT JOIN characters AS c ON c.id = p.character_id
         WHERE s.save_id = ? AND p.left_turn IS NULL
         ORDER BY p.entered_turn ASC, p.rowid ASC`,
      );
      const setFocus = db.prepare('UPDATE quests SET focus_character_id = ? WHERE id = ?');

      const quests = db
        .prepare('SELECT id, save_id FROM quests ORDER BY save_id ASC, chapter ASC')
        .all() as unknown as { id: string; save_id: string }[];

      for (const quest of quests) {
        const used = cluesBySave.get(quest.save_id) ?? new Set<string>();
        const candidates = presentOf.all(quest.save_id) as unknown as {
          character_id: string;
          name: string | null;
        }[];
        const pick = candidates.find((item) => !item.name || !used.has(item.name));
        if (!pick) continue;
        setFocus.run(pick.character_id, quest.id);
        if (pick.name) used.add(pick.name);
        cluesBySave.set(quest.save_id, used);
      }
    },
  },
];

/** 当前代码期望的数据库版本。 */
export const LATEST_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

/**
 * 执行未应用的迁移。
 *
 * 每个迁移单独包一个事务：中途失败不会留下「表建了一半」的数据库。
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const from = Number(row?.user_version ?? 0);

  const pending = [...migrations]
    .filter((migration) => migration.version > from)
    .sort((left, right) => left.version - right.version);

  const applied: string[] = [];
  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      migration.up(db);
      // PRAGMA 不支持参数绑定，版本号来自代码常量而不是外部输入，拼接是安全的
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      applied.push(`${migration.version}:${migration.name}`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return { from, to: LATEST_VERSION, applied };
}
