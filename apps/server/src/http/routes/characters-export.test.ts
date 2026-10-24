import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { AppInstance } from '../../types/fastify.js';
import { makeCardPng, sampleCardV2 } from '../../testing/png-fixture.js';
import { createTestConfig } from '../../testing/test-config.js';
import { contentDisposition, safeFileName } from '../../core/character/export.js';
import { extractCardFromPng, isPng, readTextChunks } from '../../core/character/png.js';

const silentLogger = pino({ level: 'silent' });

async function withApp<T>(run: (app: AppInstance, dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-export-'));
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

describe('文件名与 Content-Disposition', () => {
  it('去掉 Windows 非法字符并保留中文', () => {
    expect(safeFileName('月灯/老板:测试?', '.png')).toBe('月灯老板测试.png');
    expect(safeFileName('   ', '.json')).toBe('character.json');
    expect(safeFileName('a'.repeat(90), '.png').length).toBeLessThanOrEqual(64);
  });

  it('中文文件名走 RFC 5987，同时留 ASCII 兜底', () => {
    const header = contentDisposition('月灯老板.png');
    expect(header).toContain('attachment;');
    expect(header).toContain("filename*=UTF-8''");
    // 百分号编码后不该残留原始中文
    expect(header).not.toContain('月灯');
  });
});

describe('导出为 JSON', () => {
  it('返回 V2 结构与建议文件名', async () => {
    await withApp(async (app) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/characters',
        payload: { name: '月灯老板', description: '守夜的人', firstMes: '哟' },
      });
      const id = created.json().data.id;

      const response = await app.inject({
        method: 'GET',
        url: `/api/characters/${id}/export/json`,
      });
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.data.filename).toBe('月灯老板.json');
      expect(body.data.card.spec).toBe('chara_card_v2');
      expect(body.data.card.data.first_mes).toBe('哟');
      expect(body.data.card.data.description).toBe('守夜的人');
    });
  });

  it('角色不存在时 404', async () => {
    await withApp(async (app) => {
      const response = await app.inject({ method: 'GET', url: '/api/characters/nope/export/json' });
      expect(response.statusCode).toBe(404);
    });
  });
});

describe('导出为 PNG', () => {
  it('产出合法 PNG，且内嵌卡片能被自己解析回来', async () => {
    await withApp(async (app) => {
      const imported = await app.inject({
        method: 'POST',
        url: '/api/characters/import',
        headers: { 'content-type': 'image/png' },
        payload: makeCardPng(sampleCardV2('导出测试')),
      });
      const character = imported.json().data;

      const response = await app.inject({
        method: 'GET',
        url: `/api/characters/${character.id}/export/png`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('image/png');
      expect(String(response.headers['content-disposition'])).toContain('attachment');

      const png = response.rawPayload;
      expect(isPng(png)).toBe(true);

      const extracted = extractCardFromPng(png);
      const data = (extracted?.json as { data: Record<string, unknown> }).data;
      expect(data.name).toBe('导出测试');
      expect(data.first_mes).toBe('（擦着杯子）哟，这个点还来？');
    });
  });

  it('导出后再导入，字段完全一致（往返闭环）', async () => {
    await withApp(async (app) => {
      const original = await app.inject({
        method: 'POST',
        url: '/api/characters',
        payload: {
          name: '往返角色',
          description: '描述文本',
          firstMes: '开场白',
          tags: ['测试'],
          alternateGreetings: ['备选一'],
        },
      });
      const id = original.json().data.id;

      const exported = await app.inject({ method: 'GET', url: `/api/characters/${id}/export/png` });

      const reimported = await app.inject({
        method: 'POST',
        url: '/api/characters/import',
        headers: { 'content-type': 'image/png' },
        payload: exported.rawPayload,
      });

      expect(reimported.statusCode).toBe(200);
      const copy = reimported.json().data;
      expect(copy.name).toBe('往返角色');
      expect(copy.description).toBe('描述文本');
      expect(copy.firstMes).toBe('开场白');
      expect(copy.tags).toEqual(['测试']);
      expect(copy.alternateGreetings).toEqual(['备选一']);
      // 新角色是新记录，不该顶掉原角色
      expect(copy.id).not.toBe(id);
    });
  });

  it('没有头像（手动创建）时用占位图，仍然可导出可再导入', async () => {
    await withApp(async (app) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/characters',
        payload: { name: '无图角色', firstMes: 'hi' },
      });
      const id = created.json().data.id;
      expect(created.json().data.avatarUrl).toBeNull();

      const exported = await app.inject({ method: 'GET', url: `/api/characters/${id}/export/png` });
      const png = exported.rawPayload;

      expect(isPng(png)).toBe(true);
      // 占位图必须有真实图像数据，否则浏览器会裂图
      const chunkTypes = readTextChunks(png).map((chunk) => chunk.type);
      expect(chunkTypes).not.toContain('IDAT'); // 文本块里不该出现 IDAT
      expect(png.includes(Buffer.from('IDAT', 'latin1'))).toBe(true);

      const extracted = extractCardFromPng(png);
      expect((extracted?.json as { data: { name: string } }).data.name).toBe('无图角色');
    });
  });

  it('重复导出不会叠加 chara 块（否则下次导入会命中旧卡）', async () => {
    await withApp(async (app) => {
      const imported = await app.inject({
        method: 'POST',
        url: '/api/characters/import',
        headers: { 'content-type': 'image/png' },
        payload: makeCardPng(sampleCardV2('多次导出')),
      });
      const character = imported.json().data;

      // 改名后导出第一次
      await app.inject({
        method: 'PATCH',
        url: `/api/characters/${character.id}`,
        payload: { name: '改名之后' },
      });
      const first = await app.inject({
        method: 'GET',
        url: `/api/characters/${character.id}/export/png`,
      });

      const cardChunks = readTextChunks(first.rawPayload).filter(
        (chunk) => chunk.keyword === 'chara',
      );
      expect(cardChunks).toHaveLength(1);

      const extracted = extractCardFromPng(first.rawPayload);
      expect((extracted?.json as { data: { name: string } }).data.name).toBe('改名之后');
    });
  });
});
