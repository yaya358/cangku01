import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 测试里把 @tavern/shared 指向源码而不是 dist。
 *
 * 这样 `pnpm test` 不需要先 build 一次 shared，改契约后测试立刻反映最新代码，
 * 也不会出现「dist 没重建导致测试通过但线上炸」这种鬼问题。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@tavern/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
  },
});
