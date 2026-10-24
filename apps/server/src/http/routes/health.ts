import { APP_NAME, APP_VERSION, HEALTH_ENDPOINT, summarizeHealth } from '@tavern/shared';
import type { HealthCheck, HealthExtensions, HealthPayload } from '@tavern/shared';
import { success } from '../envelope.js';
import { currentMemoryMb, processStartedAt, roundSeconds } from '../../lib/runtime.js';
import type { AppConfig } from '../../config/schema.js';
import type { AppInstance } from '../../types/fastify.js';

/** 超过这个常驻内存就报 degraded，用来及早发现泄漏而不是等 OOM。 */
const MEMORY_WARN_MB = 1024;

/** 自检时能拿到的所有依赖，新增检查项往这里加字段即可。 */
export interface HealthDeps {
  config: AppConfig;
  extensions: HealthExtensions;
  /** 实际读到的配置文件路径，用来显示「配置从哪来」 */
  configSources: readonly string[];
}

/** 一项自检的定义。返回值允许是 Promise，方便后续接存储探活。 */
interface CheckDefinition {
  name: string;
  run: (deps: HealthDeps) => HealthCheck | Promise<HealthCheck>;
}

/** 自检清单。接数据库时再加 storage（带一次真实 ping）。 */
const DEFINITIONS: readonly CheckDefinition[] = [
  {
    name: 'config',
    run: ({ configSources, config }) => ({
      name: 'config',
      status: 'ok',
      message:
        configSources.length === 0
          ? `内置默认值 · ${config.app.env}`
          : `${configSources.length} 个配置文件 · ${config.app.env}`,
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
async function runCheck(definition: CheckDefinition, deps: HealthDeps): Promise<HealthCheck> {
  const startedAt = performance.now();
  try {
    const result = await definition.run(deps);
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
export async function buildHealthPayload(deps: HealthDeps): Promise<HealthPayload> {
  const checks = await Promise.all(DEFINITIONS.map((item) => runCheck(item, deps)));

  return {
    status: summarizeHealth(checks),
    app: {
      name: APP_NAME,
      version: APP_VERSION,
      env: deps.config.app.env,
      startedAt: processStartedAt.toISOString(),
      uptimeSeconds: roundSeconds(process.uptime()),
      nodeVersion: process.version,
    },
    server: {
      host: deps.config.server.host,
      port: deps.config.server.port,
      pid: process.pid,
      memoryMb: currentMemoryMb(),
    },
    extensions: deps.extensions,
    checks,
  };
}

/**
 * 注册健康检查路由。
 *
 * 前端首页会轮询它：拿到 ok 就点亮「后端已连接」，
 * 拿到 degraded 就把具体是哪一项不健康显示出来。
 */
export function registerHealthRoutes(app: AppInstance): void {
  app.get(HEALTH_ENDPOINT, async (request) =>
    success(
      request.id,
      await buildHealthPayload({
        config: app.config,
        configSources: app.configSources,
        extensions: app.extensions.summary(),
      }),
    ),
  );
}
