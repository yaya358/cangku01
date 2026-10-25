import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { APP_VERSION } from '@tavern/shared';
import Fastify, { LogController } from 'fastify';
import type { FastifyError } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from './config/schema.js';
import {
  createAvatarStore,
  resolveAvatarsDir,
  AVATAR_MAX_BYTES,
} from './core/character/avatars.js';
import { createCharacterRepository } from './core/character/repository.js';
import type { CharacterRepository } from './core/character/repository.js';
import { createConversationRepository } from './core/chat/conversation-repository.js';
import type { ConversationRepository } from './core/chat/conversation-repository.js';
import { createMessageRepository } from './core/chat/message-repository.js';
import type { MessageRepository } from './core/chat/message-repository.js';
import { ExtensionRegistry } from './core/extension/index.js';
import type { Extension } from './core/extension/index.js';
import { createProvidersFromConfig } from './core/provider/index.js';
import { seedSampleCharacters } from './core/samples/index.js';
import { createScriptEventRepository } from './core/script/repository.js';
import { createWorldRepository } from './core/world/repository.js';
import type { WorldRepository } from './core/world/repository.js';
import type { ScriptEventRepository } from './core/script/repository.js';
import { createSqliteStorage, resolveStoragePath } from './core/storage/index.js';
import { createWorldbookRepository } from './core/worldbook/repository.js';
import type { WorldbookRepository } from './core/worldbook/repository.js';
import { AppError, toAppError } from './http/errors.js';
import { failure } from './http/envelope.js';
import { registerRoutes } from './http/routes/index.js';
import { isFrontendNavigation, resolveStaticRoot, setStaticHeaders } from './http/static.js';
import { createLogger, loggerConfigFromApp } from './lib/logger.js';
import type { AppInstance } from './types/fastify.js';

/** 构建 Fastify 实例的入参。 */
export interface BuildAppOptions {
  /**
   * 已校验的配置。故意必填：配置决定端口、CORS、日志级别，
   * 给它一个「隐藏默认值」只会让测试和线上行为不一致。
   */
  config: AppConfig;
  /** 外部传入的日志器；不传则按配置新建 */
  logger?: Logger;
  /** 实际读到的配置文件路径，仅用于展示与健康检查 */
  configSources?: readonly string[];
  /** 实际生效的环境变量名，仅用于展示与健康检查 */
  configOverrides?: readonly string[];
  /** 启动前预置的扩展；后续各业务模块通过它挂进核心 */
  extensions?: readonly Extension[];
}

/**
 * 组装应用。
 *
 * 这个函数只负责「把零件接起来」，不负责 listen —— 因为测试里需要
 * 用 app.inject() 打请求，一旦它自己开始监听就没法测了。
 */
export async function buildApp(options: BuildAppOptions): Promise<AppInstance> {
  const { config } = options;
  const logger = options.logger ?? createLogger(loggerConfigFromApp(config));

  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    bodyLimit: Math.round(config.server.bodyLimitMb * 1024 * 1024),
    // 关掉 Fastify 默认的「收到/完成」两条日志，改用下面 onResponse 里带耗时的单条。
    // 注意：顶层的 disableRequestLogging 在 fastify@6 会被移除，这里用新的 logController。
    logController: new LogController({ disableRequestLogging: true }),
  });

  /**
   * 静态托管：存在 apps/web/dist 就顺带把前端一起伺服。
   *
   * 开发期用 5173（有 HMR），这里服务的是「生产形态」——
   * pnpm build 之后单个 8787 端口就能打开完整页面。
   */
  const staticHosting = resolveStaticRoot(config.server.staticDir);
  if (staticHosting) {
    await app.register(fastifyStatic, {
      root: staticHosting.root,
      prefix: '/',
      index: [staticHosting.indexFile],
      setHeaders: (response, filePath) => setStaticHeaders(response, filePath),
    });
  }
  app.decorate('webDist', staticHosting?.root ?? null);

  /**
   * 角色卡导入要收原始 PNG 字节。
   *
   * 用自建的 content-type 解析器而不是 multipart：前端只要
   * `fetch(url, { body: file })` 就行，省一个依赖，也少一层 boundary 解析。
   */
  app.addContentTypeParser(
    'image/png',
    { parseAs: 'buffer', bodyLimit: AVATAR_MAX_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  // 依赖通过装饰器挂载，路由与钩子直接 app.config / app.extensions 取用
  app.decorate('config', config);
  app.decorate('configSources', options.configSources ?? []);
  app.decorate('configOverrides', options.configOverrides ?? []);

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
    env: config.app.env,
    appVersion: APP_VERSION,
    features: config.features,
    strict: config.extensions.strict,
    maxSetupPasses: config.extensions.maxSetupPasses,
  });

  /**
   * 数据库存储扩展。
   *
   * 只支持 sqlite：配置里留了 json 选项，但没实现就别假装能用，
   * 启动时直接报清楚，好过跑起来才发现数据写丢。
   */
  if (config.storage.driver !== 'sqlite') {
    throw AppError.notImplemented(
      `storage.driver 目前只实现了 sqlite，收到的是 "${config.storage.driver}"`,
    );
  }

  const storage = createSqliteStorage({
    path: resolveStoragePath(config.storage.path, options.configSources ?? []),
    logger,
  });
  app.decorate('storage', storage);
  app.decorate('avatars', createAvatarStore(resolveAvatarsDir(storage.path)));

  // 仓储层延迟创建：它依赖已打开的连接，而连接是在 onReady 阶段才建立的
  let characterRepo: CharacterRepository | null = null;
  app.decorate('characters', (): CharacterRepository => {
    if (!storage.isOpen) throw AppError.internal('数据库尚未就绪，请稍后重试');
    characterRepo ??= createCharacterRepository(storage.db);
    return characterRepo;
  });

  let worldbookRepo: WorldbookRepository | null = null;
  app.decorate('worldbook', (): WorldbookRepository => {
    if (!storage.isOpen) throw AppError.internal('数据库尚未就绪，请稍后重试');
    worldbookRepo ??= createWorldbookRepository(storage.db);
    return worldbookRepo;
  });

  let conversationRepo: ConversationRepository | null = null;
  app.decorate('conversations', (): ConversationRepository => {
    if (!storage.isOpen) throw AppError.internal('数据库尚未就绪，请稍后重试');
    conversationRepo ??= createConversationRepository(storage.db);
    return conversationRepo;
  });

  let messageRepo: MessageRepository | null = null;
  app.decorate('messages', (): MessageRepository => {
    if (!storage.isOpen) throw AppError.internal('数据库尚未就绪，请稍后重试');
    messageRepo ??= createMessageRepository(storage.db);
    return messageRepo;
  });

  let worldRepo: WorldRepository | null = null;
  app.decorate('world', (): WorldRepository => {
    if (!storage.isOpen) throw AppError.internal('数据库尚未就绪，请稍后重试');
    worldRepo ??= createWorldRepository(storage.db);
    return worldRepo;
  });

  let scriptRepo: ScriptEventRepository | null = null;
  app.decorate('scriptEvents', (): ScriptEventRepository => {
    if (!storage.isOpen) throw AppError.internal('数据库尚未就绪，请稍后重试');
    scriptRepo ??= createScriptEventRepository(storage.db);
    return scriptRepo;
  });

  // 配置里声明的模型服务按顺序注册成 provider 扩展；
  // 之后再注册调用方传进来的扩展（测试、上层模块）。
  const providers = createProvidersFromConfig(config.providers);
  const declaredExtensions: Extension[] = [storage, ...providers, ...(options.extensions ?? [])];
  extensions.register(...declaredExtensions);
  app.decorate('extensions', extensions);

  await app.register(cors, {
    origin: config.server.corsOrigins,
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
    // SPA 回落：/chat、/settings 这类前端路由交给 index.html，由 Vue Router 接手。
    // 注意 /api/* 不在此列，接口写错就该老老实实返回 JSON 404。
    if (staticHosting && isFrontendNavigation(request.method, request.url)) {
      return reply.code(200).sendFile(staticHosting.indexFile);
    }

    request.log.warn({ method: request.method, url: request.url }, '接口不存在');
    return reply.status(404).send(
      failure(request.id, {
        code: 'NOT_FOUND',
        message: `接口不存在: ${request.method} ${request.url}`,
      }),
    );
  });

  await registerRoutes(app);

  app.addHook('onReady', async () => {
    await extensions.setupAll();
    await seedSamplesIfEmpty(app);
  });

  app.addHook('onClose', async () => {
    await extensions.disposeAll();
  });

  app.log.debug(
    { host: config.server.host, port: config.server.port, env: config.app.env },
    'Fastify 实例构建完成',
  );
  return app;
}

/**
 * 空库时写入内置示例角色。
 *
 * 只在「角色表为空」时动手：这是给第一次跑起来的人准备的，
 * 老库不会被动，关掉开关（server.seedSamples: false）也不动手。
 */
async function seedSamplesIfEmpty(app: AppInstance): Promise<void> {
  if (!app.config.server.seedSamples) return;
  if (app.characters().count() > 0) return;

  try {
    const result = seedSampleCharacters(app);
    app.log.info(
      { created: result.created.length, adopted: result.adopted.length },
      '已写入内置示例角色',
    );
  } catch (error) {
    // 播种失败不该挡住启动：用户仍然可以自己导入角色
    app.log.warn({ err: error }, '内置示例角色写入失败');
  }
}
