import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { AppInstance } from '../../types/fastify.js';
import { defineProvider } from '../../testing/provider-fixture.js';
import { createTestConfig } from '../../testing/test-config.js';

const silentLogger = pino({ level: 'silent' });

async function withApp<T>(run: (app: AppInstance) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-wb-'));
  const config = createTestConfig();
  config.storage.path = path.join(dir, 'test.db');

  const provider = defineProvider({
    meta: { name: 'fake', version: '1.0.0' },
    capabilities: { streaming: false },
    defaultModel: 'fake-model',
    hasCredentials: true,
    async chat() {
      return {
        text: 'ok',
        finishReason: 'stop',
        model: 'fake-model',
        durationMs: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async *stream() {
      yield { type: 'done' as const, finishReason: 'stop', durationMs: 1, firstTokenMs: 1 };
    },
  });

  const app = await buildApp({ config, logger: silentLogger, extensions: [provider] });
  await app.ready();
  try {
    return await run(app);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 建一个角色，返回 id。 */
async function seedCharacter(app: AppInstance, name = '月灯老板'): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: { name, description: '守着一间只在夜里开门的小酒馆。' },
  });
  return created.json().data.id as string;
}

describe('世界书接口 · 增删改查', () => {
  it('新建后能读回，字段完整', async () => {
    await withApp(async (app) => {
      const characterId = await seedCharacter(app);

      const created = await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: {
          characterId,
          title: '月光麦酒',
          keys: ['月光麦酒', '招牌酒'],
          secondaryKeys: ['酒'],
          content: '用月光草酿成，三杯之后灯就灭了。',
          priority: 10,
        },
      });

      expect(created.statusCode).toBe(200);
      const entry = created.json().data;
      expect(entry.title).toBe('月光麦酒');
      expect(entry.keys).toEqual(['月光麦酒', '招牌酒']);
      expect(entry.secondaryKeys).toEqual(['酒']);
      expect(entry.enabled).toBe(true);
      expect(entry.constant).toBe(false);
      expect(entry.priority).toBe(10);
      expect(entry.characterId).toBe(characterId);

      const list = await app.inject({
        method: 'GET',
        url: `/api/worldbook?characterId=${characterId}`,
      });
      expect(list.json().data).toHaveLength(1);
    });
  });

  it('列表包含全局条目', async () => {
    await withApp(async (app) => {
      const first = await seedCharacter(app, '角色一');
      const second = await seedCharacter(app, '角色二');

      await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: { title: '世界设定', keys: ['魔法'], content: '这是个魔法世界。' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: { characterId: first, title: '专属一', keys: ['秘密'], content: 'x' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: { characterId: second, title: '专属二', keys: ['别的'], content: 'y' },
      });

      const forFirst = await app.inject({
        method: 'GET',
        url: `/api/worldbook?characterId=${first}`,
      });
      expect(
        forFirst
          .json()
          .data.map((entry: { title: string }) => entry.title)
          .sort(),
      ).toEqual(['世界设定', '专属一'].sort());

      // 不带 characterId 时看全部（管理视角）
      const all = await app.inject({ method: 'GET', url: '/api/worldbook' });
      expect(all.json().data).toHaveLength(3);
    });
  });

  it('局部更新只改传入字段', async () => {
    await withApp(async (app) => {
      const characterId = await seedCharacter(app);
      const created = await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: { characterId, title: '旧标题', keys: ['a'], content: '旧内容' },
      });
      const id = created.json().data.id;

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/worldbook/${id}`,
        payload: { title: '新标题', enabled: false },
      });

      const entry = updated.json().data;
      expect(entry.title).toBe('新标题');
      expect(entry.enabled).toBe(false);
      expect(entry.content).toBe('旧内容');
      expect(entry.keys).toEqual(['a']);
    });
  });

  it('常驻开关与优先级可以改', async () => {
    await withApp(async (app) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: { title: '酒馆规矩', keys: [], content: '不问客人的过去。' },
      });
      const id = created.json().data.id;

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/worldbook/${id}`,
        payload: { constant: true, priority: 100 },
      });
      expect(updated.json().data.constant).toBe(true);
      expect(updated.json().data.priority).toBe(100);
    });
  });

  it('删除后读不到，重复删除 404', async () => {
    await withApp(async (app) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: { title: 't', keys: ['k'], content: 'c' },
      });
      const id = created.json().data.id;

      const deleted = await app.inject({ method: 'DELETE', url: `/api/worldbook/${id}` });
      expect(deleted.json().data.deleted).toBe(true);

      const again = await app.inject({ method: 'DELETE', url: `/api/worldbook/${id}` });
      expect(again.statusCode).toBe(404);
    });
  });

  it('删除角色时它的条目级联删除，全局条目保留', async () => {
    await withApp(async (app) => {
      const characterId = await seedCharacter(app);
      await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: { characterId, title: '专属', keys: ['x'], content: 'y' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: { title: '全局', keys: ['z'], content: 'w' },
      });

      await app.inject({ method: 'DELETE', url: `/api/characters/${characterId}` });

      const remaining = await app.inject({ method: 'GET', url: '/api/worldbook' });
      expect(remaining.json().data.map((entry: { title: string }) => entry.title)).toEqual([
        '全局',
      ]);
    });
  });
});

describe('世界书接口 · 校验与错误', () => {
  it('标题为空返回 422', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: { title: '', keys: ['a'], content: 'c' },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    });
  });

  it('给不存在的角色挂条目返回 404', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: { characterId: 'nope', title: 't', keys: ['k'], content: 'c' },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it('更新不存在的条目返回 404', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/worldbook/nope',
        payload: { title: 'x' },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it('新建的条目真的能触发（与上下文预览联动）', async () => {
    await withApp(async (app) => {
      const characterId = await seedCharacter(app);

      await app.inject({
        method: 'POST',
        url: '/api/worldbook',
        payload: {
          characterId,
          title: '月光麦酒',
          keys: ['招牌酒'],
          content: '用月光草酿成，三杯之后灯就灭了。',
        },
      });

      const preview = await app.inject({
        method: 'POST',
        url: '/api/context/preview',
        payload: { characterId, messages: [{ role: 'user', content: '招牌酒是什么？' }] },
      });

      const titles = preview.json().data.worldbook.map((hit: { title: string }) => hit.title);
      expect(titles).toContain('月光麦酒');
    });
  });
});
