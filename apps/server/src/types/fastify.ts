import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyTypeProviderDefault, RawServerDefault } from 'fastify';
import type { AppLogger } from '../lib/logger.js';

/**
 * 全项目统一的 Fastify 实例类型。
 *
 * 因为用 loggerInstance 传入 pino 实例，Fastify 的第四个泛型参数会被推断成
 * Logger 而不是默认的 FastifyBaseLogger。把这份「具体化」的类型收在一处，
 * 路由、入口、测试都引用它，就不必在每个签名里重复写五个泛型参数。
 *
 * 后续 app.decorate() 增加的成员（extensions / config）在下面的
 * module augmentation 里声明，这样 `app.extensions` 处处有类型。
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  AppLogger,
  FastifyTypeProviderDefault
>;
