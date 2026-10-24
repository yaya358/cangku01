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
