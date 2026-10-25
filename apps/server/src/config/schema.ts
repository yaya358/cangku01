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
  /**
   * 首次启动时自动写入内置示例角色（带头像）。
   *
   * 只在角色表为空时生效 —— 目的是「clone 下来起服务就有东西可玩」，
   * 而不是每次都往库里塞。老库不会被动。
   */
  seedSamples: z.boolean().default(true),
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

/** 目前只实现了 OpenAI 兼容协议；新增厂商时在这里加枚举值即可 */
export const PROVIDER_TYPES = ['openai-compatible'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/**
 * 一个模型服务。
 *
 * 密钥两种给法：
 *   apiKeyEnv: DEEPSEEK_API_KEY   ← 推荐，密钥留在环境里，配置文件可以入版本库
 *   apiKey: sk-xxx                ← 直接写，必须放在 config/user.yaml（已 gitignore）
 * 两者都给时环境变量优先，避免本地残留的旧 Key 覆盖部署环境。
 */
export const ProviderConfigSchema = z.strictObject({
  /** 全局唯一 id，日志与接口里引用它，例如 'deepseek' */
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, '只允许小写字母/数字/点/下划线/短横线'),
  type: z.enum(PROVIDER_TYPES).default('openai-compatible'),
  baseUrl: z.string().url('必须是完整 URL，例如 https://api.deepseek.com/v1'),
  /** 默认模型名，请求未指定 model 时用它 */
  model: z.string().min(1),
  apiKey: z.string().min(1).optional(),
  /** 从这个环境变量读密钥 */
  apiKeyEnv: z.string().min(1).optional(),
  /** 额外请求头（例如某些中转站要求的 HTTP-Referer） */
  headers: z.record(z.string(), z.string()).optional(),
  /** 部分兼容实现不认 stream_options，可以关掉 */
  requestStreamUsage: z.boolean().default(true),
  /** 同类内初始化顺序，数值越大越靠前 */
  priority: z.number().int().default(0),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** 根配置。 */
export const AppConfigSchema = z.strictObject({
  app: AppMetaConfigSchema.default(sectionDefaults(AppMetaConfigSchema)),
  server: ServerConfigSchema.default(sectionDefaults(ServerConfigSchema)),
  logging: LoggingConfigSchema.default(sectionDefaults(LoggingConfigSchema)),
  storage: StorageConfigSchema.default(sectionDefaults(StorageConfigSchema)),
  extensions: ExtensionsConfigSchema.default(sectionDefaults(ExtensionsConfigSchema)),
  /** 功能开关，扩展会拿到这份快照，例如 { plugins: true } */
  features: z.record(z.string(), z.boolean()).default({}),
  /** 模型服务列表，按顺序注册成 provider 扩展 */
  providers: z.array(ProviderConfigSchema).default([]),
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
