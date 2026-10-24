import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { AppInstance } from '../../types/fastify.js';
import {
  makeCardPng,
  makeCompressedCardPng,
  makePlainPng,
  sampleCardV2,
} from '../../testing/png-fixture.js';
import { createTestConfig } from '../../testing/test-config.js';

const silentLogger = pino({ level: 'silent' });

/**
 * 每个用例一套独立的临时目录（数据库 + 头像目录都在里面），
 * 用完删干净，既不污染仓库也不互相干扰。
 */
async function withApp<T>(run: (app: AppInstance, dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-char-'));
  const config = createTestConfig();
  config.storage.path = path.join(dir, 'test.db');

  const app = await buildApp({ config, logger: silentLogger });
  await app.ready();

  try {
    return await run(app, dir);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const NEW_CHARACTER = {
  name: '夜巡人',
  description: '夜里巡街的人',
  firstMes: '这么晚还在外面？',
  tags: ['悬疑'],
};

describe('角色 CRUD', () => {
  it('新建后能读到，列表里出现摘要', async () => {
    await withApp(async (app) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/characters',
        payload: NEW_CHARACTER,
      });

      expect(created.statusCode).toBe(200);
      const body = created.json();
      expect(body.data.name).toBe('夜巡人');
      expect(body.data.source).toBe('manual');
      expect(body.data.avatarUrl).toBeNull();

      const list = await app.inject({ method: 'GET', url: '/api/characters' });
      const page = list.json().data;
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        name: '夜巡人',
        excerpt: '夜里巡街的人',
        hasGreeting: true,
      });
    });
  });

  it('缺 name 返回 422 并指出字段', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/characters',
        payload: { description: '没有名字' },
      });

      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(body.error.details)).toContain('name');
    });
  });

  it('列表支持搜索与分页', async () => {
    await withApp(async (app) => {
      for (const name of ['月灯老板', '夜巡人', '五十度灰']) {
        await app.inject({ method: 'POST', url: '/api/characters', payload: { name } });
      }

      const searched = await app.inject({ method: 'GET', url: '/api/characters?search=巡' });
      expect(searched.json().data.total).toBe(1);
      expect(searched.json().data.items[0].name).toBe('夜巡人');

      const paged = await app.inject({ method: 'GET', url: '/api/characters?limit=2&offset=2' });
      expect(paged.json().data.items).toHaveLength(1);
      expect(paged.json().data.limit).toBe(2);
      expect(paged.json().data.total).toBe(3);

      // 非法分页参数当没传
      const dirty = await app.inject({ method: 'GET', url: '/api/characters?limit=abc' });
      expect(dirty.json().data.limit).toBe(50);
    });
  });

  it('详情页对不存在的 id 返回 404', async () => {
    await withApp(async (app) => {
      const response = await app.inject({ method: 'GET', url: '/api/characters/nope' });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    });
  });

  it('PATCH 只改传入字段', async () => {
    await withApp(async (app) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/characters',
        payload: NEW_CHARACTER,
      });
      const id = created.json().data.id;

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/characters/${id}`,
        payload: { name: '夜巡人（改）', tags: ['悬疑', '都市'] },
      });

      expect(patched.statusCode).toBe(200);
      expect(patched.json().data.name).toBe('夜巡人（改）');
      expect(patched.json().data.tags).toEqual(['悬疑', '都市']);
      expect(patched.json().data.description).toBe('夜里巡街的人');

      const missing = await app.inject({
        method: 'PATCH',
        url: '/api/characters/nope',
        payload: { name: 'x' },
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  it('DELETE 后读不到，列表清空', async () => {
    await withApp(async (app) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/characters',
        payload: NEW_CHARACTER,
      });
      const id = created.json().data.id;

      const deleted = await app.inject({ method: 'DELETE', url: `/api/characters/${id}` });
      expect(deleted.json().data.deleted).toBe(true);

      expect((await app.inject({ method: 'GET', url: `/api/characters/${id}` })).statusCode).toBe(
        404,
      );
      expect((await app.inject({ method: 'GET', url: '/api/characters' })).json().data.total).toBe(
        0,
      );
      // 重复删除返回 404
      expect(
        (await app.inject({ method: 'DELETE', url: `/api/characters/${id}` })).statusCode,
      ).toBe(404);
    });
  });
});

describe('角色卡导入', () => {
  it('导入 JSON 卡片（V2）', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/characters/import',
        headers: { 'content-type': 'application/json' },
        payload: sampleCardV2(),
      });

      expect(response.statusCode).toBe(200);
      const character = response.json().data;
      expect(character.name).toBe('月灯老板');
      expect(character.source).toBe('json');
      expect(character.firstMes).toContain('擦着杯子');
      expect(character.alternateGreetings).toEqual(['（打了个哈欠）来啦？']);
    });
  });

  it('导入 PNG 卡片：存下头像并能取回原始字节', async () => {
    await withApp(async (app, dir) => {
      const png = makeCardPng(sampleCardV2('PNG 老板'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/characters/import',
        headers: { 'content-type': 'image/png' },
        payload: png,
      });

      expect(response.statusCode).toBe(200);
      const character = response.json().data;
      expect(character.name).toBe('PNG 老板');
      expect(character.source).toBe('png');
      expect(character.avatarUrl).toBe(`/api/characters/${character.id}/avatar`);

      // 头像文件确实落在 data 目录旁
      expect(fs.existsSync(path.join(dir, 'avatars', `${character.id}.png`))).toBe(true);

      const avatar = await app.inject({
        method: 'GET',
        url: `/api/characters/${character.id}/avatar`,
      });
      expect(avatar.statusCode).toBe(200);
      expect(avatar.headers['content-type']).toContain('image/png');
      expect(Buffer.compare(avatar.rawPayload, png)).toBe(0);
    });
  });

  it('zTXt 压缩块的卡片也能导入', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/characters/import',
        headers: { 'content-type': 'image/png' },
        payload: makeCompressedCardPng(sampleCardV2('压缩老板')),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.name).toBe('压缩老板');
    });
  });

  it('普通头像图返回 422 并解释原因', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/characters/import',
        headers: { 'content-type': 'image/png' },
        payload: makePlainPng(),
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.message).toContain('没有角色卡数据');
    });
  });

  it('不支持的 content-type 返回 400', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/characters/import',
        headers: { 'content-type': 'text/plain' },
        payload: '随便什么',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  it('删角色时头像文件一起清理', async () => {
    await withApp(async (app, dir) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/characters/import',
        headers: { 'content-type': 'image/png' },
        payload: makeCardPng(sampleCardV2('待删角色')),
      });
      const id = created.json().data.id;
      const avatarPath = path.join(dir, 'avatars', `${id}.png`);
      expect(fs.existsSync(avatarPath)).toBe(true);

      await app.inject({ method: 'DELETE', url: `/api/characters/${id}` });
      expect(fs.existsSync(avatarPath)).toBe(false);
    });
  });
});

describe('健康检查与角色数量', () => {
  it('导入后 storage 检查项里的角色数会变', async () => {
    await withApp(async (app) => {
      await app.inject({ method: 'POST', url: '/api/characters', payload: NEW_CHARACTER });

      const health = await app.inject({ method: 'GET', url: '/api/health' });
      const storageCheck = health
        .json()
        .data.checks.find((item: { name: string }) => item.name === 'storage');

      expect(storageCheck.status).toBe('ok');
      expect(storageCheck.message).toContain('1 个角色');
    });
  });
});
