import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HealthPayloadSchema } from '@tavern/shared';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createDefaultConfig } from '../config/index.js';
import { isFrontendNavigation, resolveStaticRoot, setStaticHeaders } from './static.js';
import type { HeaderSink } from './static.js';

const silentLogger = pino({ level: 'silent' });
const tempDirs: string[] = [];

/** 造一个假的 dist：入口 + 一个带哈希的资源。 */
function makeFakeDist(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-dist-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>酒馆 AI</title>', 'utf8');
  fs.writeFileSync(path.join(root, 'assets', 'index-BZnKrUZ6.js'), 'console.info(1)', 'utf8');
  return root;
}

function makeEmptyDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-empty-'));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveStaticRoot', () => {
  it('显式目录且含 index.html 时启用', () => {
    const root = makeFakeDist();
    expect(resolveStaticRoot(root)).toEqual({ root: path.resolve(root), indexFile: 'index.html' });
  });

  it('显式目录但没有 index.html 时不启用', () => {
    expect(resolveStaticRoot(makeEmptyDir())).toBeNull();
  });

  it('未配置时从 cwd 向上自动发现 apps/web/dist', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-repo-'));
    tempDirs.push(repo);
    const dist = path.join(repo, 'apps', 'web', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>', 'utf8');

    // 从两层深的位置（模拟 pnpm 在 apps/server 下启动）也要能找到
    const nested = path.join(repo, 'apps', 'server');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveStaticRoot(null, nested)?.root).toBe(dist);
  });
});

describe('SPA 回落与缓存策略', () => {
  it('只有非 /api 的 GET/HEAD 才回落', () => {
    expect(isFrontendNavigation('GET', '/chat/123')).toBe(true);
    expect(isFrontendNavigation('HEAD', '/')).toBe(true);
    expect(isFrontendNavigation('GET', '/api/health')).toBe(false);
    expect(isFrontendNavigation('GET', '/api')).toBe(false);
    expect(isFrontendNavigation('POST', '/chat')).toBe(false);
  });

  it('index.html 不缓存、带哈希资源长缓存', () => {
    const headers = new Map<string, string>();
    const res = {
      setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    } as unknown as HeaderSink;

    setStaticHeaders(res, '/srv/dist/index.html');
    expect(headers.get('cache-control')).toBe('no-cache');

    headers.clear();
    setStaticHeaders(res, '/srv/dist/assets/index-BZnKrUZ6.js');
    expect(headers.get('cache-control')).toContain('immutable');

    headers.clear();
    setStaticHeaders(res, '/srv/dist/assets/logo.svg');
    expect(headers.get('cache-control')).toContain('max-age=3600');
  });
});

describe('静态托管（集成）', () => {
  it('GET / 返回 index.html，前端路由回落到同一入口', async () => {
    const root = makeFakeDist();
    const config = createDefaultConfig();
    config.server.staticDir = root;
    const app = await buildApp({ config, logger: silentLogger });

    try {
      expect(app.webDist).toBe(path.resolve(root));

      const home = await app.inject({ method: 'GET', url: '/' });
      expect(home.statusCode).toBe(200);
      expect(home.headers['content-type']).toContain('text/html');
      expect(home.body).toContain('酒馆 AI');

      const spaRoute = await app.inject({ method: 'GET', url: '/chat/abc' });
      expect(spaRoute.statusCode).toBe(200);
      expect(spaRoute.body).toContain('<title>酒馆 AI</title>');

      const asset = await app.inject({ method: 'GET', url: '/assets/index-BZnKrUZ6.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
    } finally {
      await app.close();
    }
  });

  it('/api 下未命中仍然是 JSON 404，不会回落到 index.html', async () => {
    const config = createDefaultConfig();
    config.server.staticDir = makeFakeDist();
    const app = await buildApp({ config, logger: silentLogger });

    try {
      const response = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');

      const body = response.json() as { ok: boolean; error?: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe('NOT_FOUND');
    } finally {
      await app.close();
    }
  });

  it('没有 dist 时 / 返回 JSON 404（纯 API 模式）', async () => {
    const config = createDefaultConfig();
    config.server.staticDir = makeEmptyDir();
    const app = await buildApp({ config, logger: silentLogger });

    try {
      expect(app.webDist).toBeNull();
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(404);

      // 健康检查不受影响
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      HealthPayloadSchema.parse(health.json().data);
    } finally {
      await app.close();
    }
  });
});
