import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEMORY_PATH } from '../storage/sqlite.js';

/**
 * 头像文件存储。
 *
 * 为什么头像不进数据库：图片是二进制大对象，塞进 SQLite 会让备份、
 * 迁移、VACUUM 都变慢；而文件系统天然适合，数据库只存文件名。
 * 代价是要自己处理「删角色时删文件」，所以这里把读写删收在一个小接口里。
 */

/** 单张头像上限；角色卡原图通常几百 KB，8MB 足够且能挡住误传的大文件。 */
export const AVATAR_MAX_BYTES = 8 * 1024 * 1024;

/** 只允许「uuid.png」这种名字，杜绝 ../ 之类的路径穿越。 */
const SAFE_FILENAME = /^[0-9a-f-]{36}\.png$/i;

export interface AvatarStore {
  readonly dir: string;
  /** 写入并返回文件名（固定为 <id>.png） */
  save: (id: string, buffer: Buffer) => string;
  /** 读取；文件不存在返回 undefined */
  read: (fileName: string) => Buffer | undefined;
  /** 删除；不存在或名字不合法时静默忽略（清理逻辑不该抛错） */
  remove: (fileName: string | null) => void;
}

export function createAvatarStore(dir: string): AvatarStore {
  return {
    dir,

    save(id: string, buffer: Buffer): string {
      fs.mkdirSync(dir, { recursive: true });
      const fileName = `${id}.png`;
      fs.writeFileSync(path.join(dir, fileName), buffer);
      return fileName;
    },

    read(fileName: string): Buffer | undefined {
      if (!SAFE_FILENAME.test(fileName)) return undefined;
      try {
        return fs.readFileSync(path.join(dir, fileName));
      } catch {
        return undefined;
      }
    },

    remove(fileName: string | null): void {
      if (!fileName || !SAFE_FILENAME.test(fileName)) return;
      try {
        fs.unlinkSync(path.join(dir, fileName));
      } catch {
        // 文件本来就不在，忽略即可
      }
    },
  };
}

/**
 * 头像目录与数据库同放一处（data/avatars）。
 *
 * 基准用数据库文件所在目录，这样「换机器只搬 data/ 目录」就能整体迁移；
 * 内存库（测试）没有目录，落到系统临时目录。
 */
export function resolveAvatarsDir(storagePath: string): string {
  if (storagePath === MEMORY_PATH) {
    return path.join(os.tmpdir(), 'tavern-avatars');
  }
  return path.join(path.dirname(storagePath), 'avatars');
}
