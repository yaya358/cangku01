import { z } from 'zod';

/**
 * 应用配置的 schema。
 *
 * 这里是「配置的唯一权威定义」——yaml 写错类型、环境变量拼错名字、
 * 新增字段忘了写默认值，都会在启动的第一秒以可读的报错停下，
 * 而不是等到某个请求打到一半才崩。
 */

/** 运行环境。production 会关掉彩色日志、隐藏错误细节。 */
export const APP_ENVS = ['development', 'production', 'test'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** 与 pino 的 level 保持一致，避免出现「配置写 warn 但日志库不认识」。 */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 持久化驱动。sqlite 是默认；json 用于极简部署或测试。 */
export const STORAGE_DRIVERS = ['sqlite', 'json'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

/**
 * 段默认值工厂。
 *
 * zod 4 的 .default() 要求传入「输出类型」的完整值，手写一遍等于把默认值
 * 抄两遍。这里直接让 schema 自己解析空对象得到默认段，永远不会写歪。
 */
function sectionDefaults<TSchema extends z.ZodType>(schema: TSchema): () => z.output<TSchema> {
  return () => schema.parse({});
}

/** app 段：显示名与运行环境。 */
export const AppMetaConfigSchema = z.strictObject({
  name: z.string().min(1).default('酒馆 AI'),
  env: z.enum(APP_ENVS).default('development'),
});
export type AppMetaConfig = z.infer<typeof AppMetaConfigSchema>;

/** server 段：监听地址、端口、CORS、请求体上限。 */
export const ServerConfigSchema = z.strictObject({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8787),
  /** 普通 JSON 请求体上限（MB）。角色卡 PNG 走 multipart，不吃这个额度。 */
  bodyLimitMb: z.number().positive().max(64).default(2),
  /** true = 反射任意 Origin（开发方便）；数组 = 明确白名单（生产必须用这个） */
  corsOrigins: z.union([z.literal(true), z.array(z.string().min(1))]).default(true),
  /**
   * 前端构建产物目录（Vite 的 dist）。
   * 留 null 表示自动从仓库根找 apps/web/dist；找不到就不托管静态资源。
   */
  staticDir: z.string().min(1).nullable().default(null),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** logging 段：pretty 留空时按 env 推导。 */
export const LoggingConfigSchema = z.strictObject({
  level: z.enum(LOG_LEVELS).default('info'),
  pretty: z.boolean().optional(),
  /** 预留：写文件日志的路径，null 表示只输出到 stdout */
  file: z.string().min(1).nullable().default(null),
});
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

/** storage 段：持久化驱动与数据文件位置。 */
export const StorageConfigSchema = z.strictObject({
  driver: z.enum(STORAGE_DRIVERS).default('sqlite'),
  /** 相对路径以仓库根目录为基准 */
  path: z.string().min(1).default('./data/tavern.db'),
});
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

/** extensions 段：扩展点生命周期策略。 */
export const ExtensionsConfigSchema = z.strictObject({
  /** true = 扩展初始化失败即中断启动 */
  strict: z.boolean().default(false),
  /** 扩展在 setup 期间注册子扩展时的最大轮次 */
  maxSetupPasses: z.number().int().min(1).max(20).default(5),
});
export type ExtensionsConfig = z.infer<typeof ExtensionsConfigSchema>;

/** 根配置。 */
export const AppConfigSchema = z.strictObject({
  app: AppMetaConfigSchema.default(sectionDefaults(AppMetaConfigSchema)),
  server: ServerConfigSchema.default(sectionDefaults(ServerConfigSchema)),
  logging: LoggingConfigSchema.default(sectionDefaults(LoggingConfigSchema)),
  storage: StorageConfigSchema.default(sectionDefaults(StorageConfigSchema)),
  extensions: ExtensionsConfigSchema.default(sectionDefaults(ExtensionsConfigSchema)),
  /** 功能开关，扩展会拿到这份快照，例如 { plugins: true } */
  features: z.record(z.string(), z.boolean()).default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * 内置默认配置。
 *
 * 当 config/default.yaml 缺失时作为兜底，也是测试用的基线。
 * config/default.yaml 的内容必须与它一致，由 loader.test.ts 里的
 * 「默认文件与代码默认值等价」用例守住。
 */
export function createDefaultConfig(): AppConfig {
  return AppConfigSchema.parse({});
}

/** 配置中某一段的类型，供上层只取需要的部分。 */
export type AppConfigSection<TKey extends keyof AppConfig> = AppConfig[TKey];
