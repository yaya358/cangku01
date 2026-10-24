import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import { APP_VERSION } from '@tavern/shared';
import Fastify, { LogController } from 'fastify';
import type { FastifyError } from 'fastify';
import type { Logger } from 'pino';
import { ExtensionRegistry } from './core/extension/index.js';
import type { Extension } from './core/extension/index.js';
import { toAppError } from './http/errors.js';
import { failure } from './http/envelope.js';
import { registerRoutes } from './http/routes/index.js';
import { createLogger } from './lib/logger.js';
import { resolveRuntime } from './lib/runtime.js';
import type { ServerRuntime } from './lib/runtime.js';
import type { AppInstance } from './types/fastify.js';

/** 构建 Fastify 实例的可选覆盖项，测试会用它替代端口/日志。 */
export interface BuildAppOptions {
  runtime?: ServerRuntime;
  logger?: Logger;
  /** true = 反射请求 Origin；数组 = 白名单 */
  corsOrigin?: boolean | string[];
  /** 请求体上限，默认 2MB（角色卡 PNG 走 multipart，不占这个额度） */
  bodyLimit?: number;
  /** 启动前预置的扩展；后续各业务模块通过它挂进核心 */
  extensions?: readonly Extension[];
  /** 功能开关快照，透传给扩展上下文 */
  features?: Record<string, boolean>;
  /** true = 任何一个扩展初始化失败就中断启动 */
  strictExtensions?: boolean;
}

/**
 * 组装应用。
 *
 * 这个函数只负责「把零件接起来」，不负责 listen —— 因为测试里需要
 * 用 app.inject() 打请求，一旦它自己开始监听就没法测了。
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<AppInstance> {
  const runtime = options.runtime ?? resolveRuntime();
  const logger =
    options.logger ??
    createLogger({
      level: process.env.TAVERN_LOG_LEVEL ?? (runtime.env === 'production' ? 'info' : 'debug'),
      pretty: runtime.env !== 'production',
    });

  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    bodyLimit: options.bodyLimit ?? 2 * 1024 * 1024,
    // 关掉 Fastify 默认的「收到/完成」两条日志，改用下面 onResponse 里带耗时的单条。
    // 注意：顶层的 disableRequestLogging 在 fastify@6 会被移除，这里用新的 logController。
    logController: new LogController({ disableRequestLogging: true }),
  });

  await app.register(cors, {
    origin: options.corsOrigin ?? true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
  });

  // 一条请求一条日志：状态码 + 耗时 + traceId，排查慢接口直接看 durationMs
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'http',
    );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const appError = toAppError(error);
    if (appError.statusCode >= 500) {
      // 只有这里能看到真实堆栈，响应体里永远不带
      request.log.error({ err: error, code: appError.code }, '请求处理失败');
    } else {
      request.log.warn({ code: appError.code, status: appError.statusCode }, '请求被拒绝');
    }
    void reply.status(appError.statusCode).send(failure(request.id, appError.toBody()));
  });

  app.setNotFoundHandler((request, reply) => {
    request.log.warn({ method: request.method, url: request.url }, '接口不存在');
    void reply.status(404).send(
      failure(request.id, {
        code: 'NOT_FOUND',
        message: `接口不存在: ${request.method} ${request.url}`,
      }),
    );
  });

  /**
   * 扩展点注册表。
   *
   * 必须在挂路由之前 decorate：路由注册阶段就可能需要读注册表
   * （例如「按 provider 数量动态生成选项接口」）。
   * 真正的初始化放到 onReady —— 那时 Fastify 已就绪、配置已解析完，
   * 又早于 listen 开始接流量。
   */
  const extensions = new ExtensionRegistry({
    logger,
    env: runtime.env,
    appVersion: APP_VERSION,
    features: options.features,
    strict: options.strictExtensions,
  });
  if (options.extensions?.length) {
    extensions.register(...options.extensions);
  }
  app.decorate('extensions', extensions);

  await registerRoutes(app, runtime);

  app.addHook('onReady', async () => {
    await extensions.setupAll();
  });

  app.addHook('onClose', async () => {
    await extensions.disposeAll();
  });

  app.log.debug({ host: runtime.host, port: runtime.port }, 'Fastify 实例构建完成');
  return app;
}
