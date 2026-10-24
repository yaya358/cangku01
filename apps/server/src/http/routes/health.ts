import { APP_NAME, APP_VERSION, HEALTH_ENDPOINT, summarizeHealth } from '@tavern/shared';
import type { HealthCheck, HealthExtensions, HealthPayload } from '@tavern/shared';
import { success } from '../envelope.js';
import { currentMemoryMb, processStartedAt } from '../../lib/runtime.js';
import type { ServerRuntime } from '../../lib/runtime.js';
import type { AppInstance } from '../../types/fastify.js';

/** 超过这个常驻内存就报 degraded，用来及早发现泄漏而不是等 OOM。 */
const MEMORY_WARN_MB = 1024;

/** 自检时能拿到的所有依赖，新增检查项往这里加字段即可。 */
interface HealthContext {
  runtime: ServerRuntime;
  extensions: HealthExtensions;
}

/** 一项自检的定义。返回值允许是 Promise，方便后续接存储探活。 */
interface CheckDefinition {
  name: string;
  run: (context: HealthContext) => HealthCheck | Promise<HealthCheck>;
}

/**
 * 自检清单。
 *
 * 阶段 0-F 会在这里追加 config 一项；接数据库时再加 storage（带一次真实 ping）。
 */
const DEFINITIONS: readonly CheckDefinition[] = [
  {
    name: 'runtime',
    run: ({ runtime }) => ({
      name: 'runtime',
      status: runtime.port > 0 ? 'ok' : 'failed',
      message: `${runtime.env} · ${runtime.host}:${runtime.port}`,
    }),
  },
  {
    name: 'memory',
    run: () => {
      const memoryMb = currentMemoryMb();
      return {
        name: 'memory',
        status: memoryMb < MEMORY_WARN_MB ? 'ok' : 'degraded',
        message: `${memoryMb} MB`,
      };
    },
  },
  {
    name: 'extensions',
    run: ({ extensions }) => ({
      name: 'extensions',
      // 有扩展失败 → 服务仍可用但降级，前端会把这个数字直接显示出来
      status: extensions.failed > 0 ? 'degraded' : 'ok',
      message:
        extensions.total === 0
          ? '尚未注册扩展'
          : `${extensions.ready}/${extensions.total} 就绪${extensions.failed > 0 ? `，${extensions.failed} 个失败` : ''}`,
    }),
  },
];

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 跑一项检查：单项失败不允许拖垮整个健康检查。 */
async function runCheck(definition: CheckDefinition, context: HealthContext): Promise<HealthCheck> {
  const startedAt = performance.now();
  try {
    const result = await definition.run(context);
    return { ...result, latencyMs: roundMs(performance.now() - startedAt) };
  } catch (error) {
    return {
      name: definition.name,
      status: 'failed',
      message: error instanceof Error ? error.message : '检查执行失败',
      latencyMs: roundMs(performance.now() - startedAt),
    };
  }
}

/** 组装健康载荷。抽出来是为了让测试可以直接断言，不必起 HTTP。 */
export async function buildHealthPayload(
  runtime: ServerRuntime,
  extensions: HealthExtensions,
): Promise<HealthPayload> {
  const checks = await Promise.all(
    DEFINITIONS.map((item) => runCheck(item, { runtime, extensions })),
  );

  return {
    status: summarizeHealth(checks),
    app: {
      name: APP_NAME,
      version: APP_VERSION,
      env: runtime.env,
      startedAt: processStartedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime() * 100) / 100,
      nodeVersion: process.version,
    },
    server: {
      host: runtime.host,
      port: runtime.port,
      pid: process.pid,
      memoryMb: currentMemoryMb(),
    },
    extensions,
    checks,
  };
}

/**
 * 注册健康检查路由。
 *
 * 前端首页会轮询它：拿到 ok 就点亮「后端已连接」，
 * 拿到 degraded 就把具体是哪一项不健康显示出来。
 */
export function registerHealthRoutes(app: AppInstance, runtime: ServerRuntime): void {
  app.get(HEALTH_ENDPOINT, async (request) =>
    success(request.id, await buildHealthPayload(runtime, app.extensions.summary())),
  );
}
