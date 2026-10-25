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
