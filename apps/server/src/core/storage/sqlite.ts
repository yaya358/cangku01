import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppLogger } from '../../lib/logger.js';
import type { Extension, ExtensionMeta } from '../extension/index.js';
import { runMigrations } from './migrations.js';

/**
 * SQLite 存储扩展。
 *
 * 用 Node 24 内置的 `node:sqlite`，不引第三方驱动：
 *   - 不需要 node-gyp / 预编译二进制，Windows 上装依赖不会翻车
 *   - 同步 API 在单进程本地应用里反而更简单（没有连接池、没有异步竞争）
 *
 * 作为扩展点（kind: 'storage'）接入注册表，好处是打开/关闭跟着应用生命周期走：
 * setup 里建连接与迁移，dispose 里关闭，中途崩溃不会留下半开状态。
 */

export interface SqliteStorageOptions {
  /** 文件路径；`':memory:'` 表示内存库（测试用） */
  path: string;
  logger?: AppLogger;
  /** 是否启用 WAL：内存库不支持，会自动跳过 */
  wal?: boolean;
}

export interface SqliteStorage extends Extension {
  readonly meta: ExtensionMeta & { kind: 'storage' };
  readonly path: string;
  /** 已打开的连接；未初始化时抛错而不是返回 undefined，避免空指针满天飞 */
  readonly db: DatabaseSync;
  readonly isOpen: boolean;
}

/** 内存库标识，写在配置里也能用。 */
export const MEMORY_PATH = ':memory:';

/**
 * 把配置里的相对路径解析成绝对路径。
 *
 * 基准是「仓库根目录」而不是进程 cwd：从 apps/server 启动和从仓库根启动
 * 必须落到同一个 data/ 目录，否则会出现「换了个终端数据库就空了」的怪事。
 * 仓库根从配置文件位置反推（config/default.yaml 的上一级）。
 */
export function resolveStoragePath(
  configuredPath: string,
  configSources: readonly string[] = [],
): string {
  if (configuredPath === MEMORY_PATH) return MEMORY_PATH;
  if (path.isAbsolute(configuredPath)) return configuredPath;

  const firstSource = configSources[0];
  const baseDir = firstSource ? path.resolve(path.dirname(firstSource), '..') : process.cwd();
  return path.resolve(baseDir, configuredPath);
}

export function createSqliteStorage(options: SqliteStorageOptions): SqliteStorage {
  const isMemory = options.path === MEMORY_PATH;
  const absolutePath = isMemory ? MEMORY_PATH : path.resolve(options.path);
  let connection: DatabaseSync | null = null;

  function requireDb(): DatabaseSync {
    if (!connection) {
      throw new Error('SQLite 尚未初始化：storage 扩展的 setup 还没执行');
    }
    return connection;
  }

  const storage: SqliteStorage = {
    meta: {
      kind: 'storage',
      name: 'storage.sqlite',
      version: '1.0.0',
      description: absolutePath,
      // 优先级最高：任何需要读库的扩展都必须在数据库打开之后才初始化
      priority: 100,
    },
    path: absolutePath,

    get db(): DatabaseSync {
      return requireDb();
    },

    get isOpen(): boolean {
      return connection !== null;
    },

    setup(context) {
      const logger = options.logger ?? context.logger;

      if (!isMemory) {
        // 目录不存在时 sqlite 不会自己创建，先补上
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      }

      const db = new DatabaseSync(absolutePath);

      // 外键约束默认是关的，本地应用里一定要打开，否则「删角色留下孤儿数据」
      db.exec('PRAGMA foreign_keys = ON');

      if (!isMemory && options.wal !== false) {
        // WAL 让读写不互相阻塞；同时设置 busy_timeout，避免并发写立刻报 SQLITE_BUSY
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec('PRAGMA busy_timeout = 5000');
      }

      const result = runMigrations(db);
      connection = db;

      logger.info(
        {
          database: absolutePath,
          fromVersion: result.from,
          toVersion: result.to,
          applied: result.applied,
        },
        result.applied.length > 0
          ? `数据库已迁移（${result.applied.join(', ')}）`
          : '数据库已就绪（无需迁移）',
      );
    },

    dispose() {
      if (!connection) return;
      connection.close();
      connection = null;
    },
  };

  return storage;
}
