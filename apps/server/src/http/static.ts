import fs from 'node:fs';
import path from 'node:path';

/**
 * 前端静态产物（Vite build 的 dist）托管。
 *
 * 目的：`pnpm build && pnpm start` 之后，直接打开 http://127.0.0.1:8787
 * 就能看到完整页面 —— 一个端口跑整站，省掉再起一个 Nginx 的麻烦。
 * 开发阶段仍然用 5173（有 HMR），这里只是「生产形态」。
 */

/** 向上查找仓库根的最大层数。 */
const MAX_LOOKUP_DEPTH = 6;

/** 前端产物内必须存在的入口文件。 */
const INDEX_FILE = 'index.html';

export interface StaticHosting {
  /** dist 目录绝对路径 */
  root: string;
  /** 入口文件名 */
  indexFile: string;
}

function hasIndex(root: string): boolean {
  return fs.existsSync(path.join(root, INDEX_FILE));
}

/**
 * 解析前端产物目录。
 *
 * 有显式配置就用配置；否则从 cwd 向上找 apps/web/dist。
 * 找不到就返回 null，表示「不开启静态托管」——这不是错误，
 * 开发期本来就没有 dist。
 */
export function resolveStaticRoot(
  explicit: string | null | undefined,
  searchFrom: string = process.cwd(),
): StaticHosting | null {
  if (explicit) {
    const root = path.resolve(explicit);
    return hasIndex(root) ? { root, indexFile: INDEX_FILE } : null;
  }

  let current = path.resolve(searchFrom);
  for (let depth = 0; depth < MAX_LOOKUP_DEPTH; depth += 1) {
    const candidate = path.join(current, 'apps', 'web', 'dist');
    if (hasIndex(candidate)) return { root: candidate, indexFile: INDEX_FILE };

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Vite 产物带内容哈希：`index-BZnKrUZ6.js`、`HomeView-B0SEH_xI.css`。
 * 哈希与扩展名之间用 - 或 . 分隔，长度固定 8 位以上，据此判定可以长缓存。
 */
const HASHED_ASSET = /[-.][A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|svg|webp|ico)$/;

/**
 * 能设响应头的对象。
 *
 * @fastify/static 的 setHeaders 回调传的是 FastifyReply（用 .header()），
 * 而单元测试里造的是裸 ServerResponse（用 .setHeader()），两种都接。
 */
export interface HeaderSink {
  header?(name: string, value: string): unknown;
  setHeader?(name: string, value: string): unknown;
}

function applyHeader(sink: HeaderSink, name: string, value: string): void {
  if (typeof sink.header === 'function') sink.header(name, value);
  else sink.setHeader?.(name, value);
}

/**
 * 缓存策略：
 *   index.html 每次都要回源（否则发版后用户看到的还是旧入口）
 *   带哈希的静态资源一年不动
 */
export function setStaticHeaders(res: HeaderSink, filePath: string): void {
  const base = path.basename(filePath);
  if (base === INDEX_FILE) {
    applyHeader(res, 'cache-control', 'no-cache');
    return;
  }
  if (HASHED_ASSET.test(base)) {
    applyHeader(res, 'cache-control', 'public, max-age=31536000, immutable');
    return;
  }
  applyHeader(res, 'cache-control', 'public, max-age=3600');
}

/** 该请求是否应该回落到前端路由（SPA history 模式）。 */
export function isFrontendNavigation(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  // /api 归后端，未命中就该是 JSON 404，不能回落成 index.html
  if (url.startsWith('/api')) return false;
  return true;
}
