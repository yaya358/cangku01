import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, LATEST_VERSION } from '../storage/migrations.js';
import { createCharacterRepository } from '../character/repository.js';
import { createWorldRepository, describeReachability } from './repository.js';
import type { WorldRepository } from './repository.js';

let db: DatabaseSync;
let world: WorldRepository;
let characterId: string;
let sceneId: string;

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

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);

  world = createWorldRepository(db);
  characterId = createCharacterRepository(db).create({ ...BLANK, name: '月灯老板' }).id;

  const save = world.createSave('月灯镇');
  sceneId = world.createScene(save.id, { name: '月灯酒馆', closeness: 0.3 }).id;
});

afterEach(() => {
  db.close();
});

describe('迁移', () => {
  it('版本到 11 且幂等', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(11);
    expect(runMigrations(db).applied).toEqual([]);
  });
});

describe('世界存档 · 存档与场景', () => {
  it('新建存档带章节号，能读回', () => {
    const save = world.createSave('第二周目');
    expect(save.name).toBe('第二周目');
    expect(save.chapter).toBe(1);
    expect(world.getSave(save.id)).toEqual(save);
    expect(world.listSaves().map((item) => item.name)).toContain('第二周目');
  });

  it('场景有默认知名度（偷听概率）与私密类型', () => {
    const alley = world.createScene(world.listSaves()[0]!.id, { name: '后巷', closeness: 0.7 });
    expect(alley.closeness).toBe(0.7);
    expect(alley.kind).toBe('public');

    const privateScene = world.createScene(world.listSaves()[0]!.id, {
      name: '账房',
      kind: 'private',
    });
    expect(privateScene.kind).toBe('private');
    // 不传就是默认 0.3（嘈杂场所更安全）
    expect(privateScene.closeness).toBe(0.3);
  });

  it('删除存档会连带删掉场景', () => {
    const save = world.createSave('临时');
    world.createScene(save.id, { name: '临时的屋子' });
    db.prepare('DELETE FROM saves WHERE id = ?').run(save.id);
    const left = db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE save_id = ?').get(save.id) as {
      n?: number;
    };
    expect(Number(left.n)).toBe(0);
  });
});

describe('世界存档 · 在场与可达性', () => {
  it('进场后是 available，离开后是 left', () => {
    world.enter(sceneId, characterId, 1);
    expect(world.reachability(sceneId, characterId)).toBe('available');

    world.leave(sceneId, characterId, 5);
    expect(world.reachability(sceneId, characterId)).toBe('left');
  });

  it('从没出现过的人是 absent', () => {
    expect(world.reachability(sceneId, characterId)).toBe('absent');
  });

  it('在忙的人未必有空理你', () => {
    world.enter(sceneId, characterId, 1, '擦杯子');
    expect(world.reachability(sceneId, characterId)).toBe('busy');
    expect(describeReachability('busy', '月灯老板')).toContain('忙着');
  });

  it('离开后再进场：重新在场，不丢历史', () => {
    world.enter(sceneId, characterId, 1);
    world.leave(sceneId, characterId, 4);
    world.enter(sceneId, characterId, 9);

    expect(world.reachability(sceneId, characterId)).toBe('available');
    expect(world.present(sceneId)).toHaveLength(1);
    expect(world.history(sceneId)).toHaveLength(1);
  });

  it('同一个人重复 enter 不会出现两条在场记录', () => {
    world.enter(sceneId, characterId, 1);
    world.enter(sceneId, characterId, 2, '添柴');
    expect(world.present(sceneId)).toHaveLength(1);
    expect(world.reachability(sceneId, characterId)).toBe('busy');
  });

  it('在场列表按进场顺序排（说话顺序稳定）', () => {
    const second = createCharacterRepository(db).create({ ...BLANK, name: '夜巡人' }).id;
    world.enter(sceneId, characterId, 1);
    world.enter(sceneId, second, 3);

    expect(world.present(sceneId).map((item) => item.characterId)).toEqual([characterId, second]);
  });

  it('提示文案覆盖四种状态', () => {
    expect(describeReachability('available', '他')).toContain('可以过去说话');
    expect(describeReachability('left', '他')).toContain('已经走了');
    expect(describeReachability('absent', '他')).toContain('没有');
  });

  it('离开要记原因，回来时清掉', () => {
    world.enter(sceneId, characterId, 1);
    world.leave(sceneId, characterId, 3, '跟你去了后巷');
    expect(world.history(sceneId)[0]?.reason).toBe('跟你去了后巷');

    // 回来之后「为什么走」就不该再挂着
    world.enter(sceneId, characterId, 4);
    expect(world.history(sceneId)[0]?.reason).toBeNull();
    expect(world.reachability(sceneId, characterId)).toBe('available');
  });
});

describe('世界存档 · 私密场景', () => {
  it('私密场景记得自己是从哪出去的', () => {
    const source = world.listSaves()[0]!;
    const privateScene = world.createScene(source.id, {
      name: '后巷',
      kind: 'private',
      closeness: 0.75,
      sourceSceneId: sceneId,
    });

    expect(privateScene.sourceSceneId).toBe(sceneId);
    expect(world.getScene(sceneId)?.sourceSceneId).toBeNull();

    // 人同时只该在一个地方：进了后巷，酒馆这边就要标记离开
    world.enter(privateScene.id, characterId, 2);
    world.leave(sceneId, characterId, 2, '跟你去了后巷');
    expect(world.present(sceneId)).toHaveLength(0);
    expect(world.reachability(privateScene.id, characterId)).toBe('available');
  });
});
