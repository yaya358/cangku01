import type { AppLogger } from '../../lib/logger.js';
import type { ExtensionRegistry } from './registry.js';

/**
 * 扩展点体系。
 *
 * 设计目标：后续的「模型接入层」「上下文引擎」「存储驱动」都不用改核心代码，
 * 而是各写一个扩展注册进来。三类角色：
 *
 *   provider   —— 上游模型服务（OpenAI、Claude、本地 llama.cpp…）
 *   context    —— 上下文组装策略（分层拼装、世界书注入、摘要压缩）
 *   storage    —— 持久化驱动（SQLite、JSON 文件、内存）
 *   route      —— 一组 HTTP 路由（把某块功能整体挂进来）
 *   integration —— 外围能力（TTS、图片生成、WebDAV 备份…）
 */
export const EXTENSION_KINDS = ['provider', 'context', 'storage', 'route', 'integration'] as const;

export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

/** 扩展的静态描述。name 是全局唯一 id，会写进日志与健康检查。 */
export interface ExtensionMeta {
  /** 全局唯一，小写字母/数字/点/下划线/短横线，例如 'openai'、'ctx.worldbook' */
  readonly name: string;
  readonly kind: ExtensionKind;
  /** 语义化版本，便于排查「哪个扩展把服务搞挂了」 */
  readonly version: string;
  readonly description?: string;
  /** 同类内的执行顺序，数值越大越先；默认 0，相同则按注册顺序 */
  readonly priority?: number;
}

/** 生命周期状态机：registered → setting-up → ready | failed → disposed */
export type ExtensionState = 'registered' | 'setting-up' | 'ready' | 'failed' | 'disposed';

/**
 * setup / dispose 拿到的运行时上下文。
 *
 * 故意做得很窄：扩展只能看到日志、配置快照和注册表，
 * 不能直接摸 Fastify 实例或数据库连接，避免扩展之间隐式耦合。
 */
export interface ExtensionContext {
  readonly logger: AppLogger;
  readonly env: string;
  readonly appVersion: string;
  /** 功能开关快照，例如 { plugins: true } */
  readonly features: Readonly<Record<string, boolean>>;
  /** 注册表本身，允许扩展在 setup 期间再注册子扩展 */
  readonly registry: ExtensionRegistry;
}

/**
 * 一个扩展。
 *
 * setup 做初始化（建连接、预热缓存），dispose 必须能安全地收拾自己，
 * 即使 setup 只完成了一半。
 */
export interface Extension {
  readonly meta: ExtensionMeta;
  setup?(context: ExtensionContext): void | Promise<void>;
  dispose?(context: ExtensionContext): void | Promise<void>;
}

/** 注册表内部保存的一条记录。 */
export interface ExtensionEntry {
  readonly extension: Extension;
  state: ExtensionState;
  /** setup 抛出的原始异常，只用于日志与健康检查展示 */
  error?: unknown;
  readonly registeredAt: Date;
  readyAt?: Date;
  setupDurationMs?: number;
}

/** 健康检查用的聚合摘要。 */
export interface ExtensionSummary {
  total: number;
  ready: number;
  failed: number;
  /** 尚未执行 setup 的数量（包括已 dispose 的） */
  pending: number;
}

/**
 * 声明扩展时套一层，作用是把字面量类型原样保留下来。
 *
 * 如果直接写 `const ext: Extension = {...}`，扩展上额外的自定义字段
 * （比如 provider 的 `chat()` 方法）会被擦掉；用这个函数可以保留完整类型，
 * 同时又校验 meta/setup 的形状。
 */
export function defineExtension<TExtension extends Extension>(extension: TExtension): TExtension {
  return extension;
}
