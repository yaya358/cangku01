import { SAMPLE_AVATARS, SAMPLE_CARDS } from '@tavern/shared';
import { parseCardJson } from '../character/card.js';
import type { AppInstance } from '../../types/fastify.js';

/**
 * 内置示例角色播种。
 *
 * 解决一个很实际的问题：**别人拿到仓库、起服务、打开页面，应该直接有东西可玩**，
 * 而不是面对一个空白的角色墙。所以示例角色由服务端负责播种（不是前端点按钮才导），
 * 头像也一起写入 data/avatars —— 换句话说，第一眼看到的就是带图的样子。
 *
 * 三条约束：
 *   1. 幂等：按名字去重，重复调用不会刷出副本
 *   2. 只补不删：已存在的角色不会被覆盖（用户改过的设定优先）
 *   3. 头像缺失就补：老库里的同名角色如果没图，也会被补上
 */

export interface SeedResult {
  /** 新建的角色名 */
  created: string[];
  /** 已存在、这次补了头像的角色名 */
  adopted: string[];
  /** 已存在且无需改动的角色名 */
  skipped: string[];
}

/** 把内置示例写进数据库；返回做了哪些事。 */
export function seedSampleCharacters(app: AppInstance): SeedResult {
  const characters = app.characters();
  const result: SeedResult = { created: [], adopted: [], skipped: [] };

  // 一次性取现有角色，避免每条示例都查一次
  const existing = new Map(
    characters
      .list({ limit: 500 })
      .items.map((item) => [item.name, { id: item.id, avatarUrl: item.avatarUrl }]),
  );

  for (const sample of SAMPLE_CARDS) {
    let parsed;
    try {
      parsed = parseCardJson(sample.card);
    } catch {
      // 内置卡片解析失败属于代码缺陷，跳过但不影响启动
      continue;
    }

    /**
     * 去重键用卡片里的真名，而不是文件里的展示名。
     * 两者可能不同（例如样本名「铁匠学徒·炭」，卡里的 name 是「炭」），
     * 用错会导致每次播种都多建一份。
     */
    const name = parsed.input.name;

    const found = existing.get(name);
    if (found) {
      if (found.avatarUrl) {
        result.skipped.push(name);
        continue;
      }
      attachAvatar(app, found.id, name, sample.avatarKey);
      result.adopted.push(name);
      existing.set(name, { id: found.id, avatarUrl: '/avatar' });
      continue;
    }

    const created = characters.create(parsed.input, {
      source: 'json',
      specVersion: parsed.specVersion,
    });
    attachAvatar(app, created.id, name, sample.avatarKey);
    result.created.push(name);
    // 同一批里不重复建（理论上不会，但守住这点更安全）
    existing.set(name, { id: created.id, avatarUrl: '/avatar' });
  }

  return result;
}

/** 写入头像文件并更新角色记录；失败不影响角色本身。 */
function attachAvatar(
  app: AppInstance,
  characterId: string,
  name: string,
  avatarKey: string,
): void {
  const base64 = SAMPLE_AVATARS[avatarKey];
  if (!base64) return;

  try {
    const buffer = Buffer.from(base64, 'base64');
    const fileName = app.avatars.save(characterId, buffer);
    app.characters().setAvatar(characterId, fileName);
  } catch (error) {
    app.log.warn({ err: error, name }, '示例角色头像写入失败，角色本身已创建');
  }
}
