import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyTypeProviderDefault, RawServerDefault } from 'fastify';
import type { AppConfig } from '../config/schema.js';
import type { AvatarStore } from '../core/character/avatars.js';
import type { CharacterRepository } from '../core/character/repository.js';
import type { ConversationRepository } from '../core/chat/conversation-repository.js';
import type { MessageRepository } from '../core/chat/message-repository.js';
import type { ExtensionRegistry } from '../core/extension/index.js';
import type { ScriptEventRepository } from '../core/script/repository.js';
import type { SqliteStorage } from '../core/storage/index.js';
import type { WorldbookRepository } from '../core/worldbook/repository.js';
import type { AppLogger } from '../lib/logger.js';

/**
 * 全项目统一的 Fastify 实例类型。
 *
 * 因为用 loggerInstance 传入 pino 实例，Fastify 的第四个泛型参数会被推断成
 * Logger 而不是默认的 FastifyBaseLogger。把这份「具体化」的类型收在一处，
 * 路由、入口、测试都引用它，就不必在每个签名里重复写五个泛型参数。
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  AppLogger,
  FastifyTypeProviderDefault
>;

/**
 * 通过 app.decorate() 挂到实例上的成员在这里统一声明。
 *
 * 声明之后 `app.extensions` 在路由、钩子、测试里都有类型，
 * 不需要 `as` 断言，也不会出现「属性名拼错、运行时才炸」。
 */
declare module 'fastify' {
  interface FastifyInstance {
    /** 扩展点注册表，见 core/extension */
    extensions: ExtensionRegistry;
    /** 已校验的只读配置，路由里直接 app.config.server.port 这样用 */
    config: AppConfig;
    /** 实际读到的配置文件绝对路径，按合并顺序排列 */
    configSources: readonly string[];
    /** 实际生效的环境变量名（覆盖了 yaml 的那些） */
    configOverrides: readonly string[];
    /** 前端静态产物目录；null 表示没开启静态托管 */
    webDist: string | null;
    /** 数据库存储扩展（打开 / 关闭跟随应用生命周期） */
    storage: SqliteStorage;
    /** 角色仓储；内部按需创建，数据库没就绪时调用会抛错 */
    characters: () => CharacterRepository;
    /** 头像文件存储（data/avatars） */
    avatars: AvatarStore;
    /** 世界书仓储；同样按需创建 */
    worldbook: () => WorldbookRepository;
    /** 会话仓储 */
    conversations: () => ConversationRepository;
    /** 消息仓储 */
    messages: () => MessageRepository;
    /** 剧本事件仓储（含会话触发记录） */
    scriptEvents: () => ScriptEventRepository;
  }
}
