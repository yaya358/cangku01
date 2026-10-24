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
