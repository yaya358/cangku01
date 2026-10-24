import type { AppLogger } from '../../lib/logger.js';
import { ExtensionError, isValidExtensionKind, isValidExtensionName } from './errors.js';
import type {
  Extension,
  ExtensionContext,
  ExtensionEntry,
  ExtensionKind,
  ExtensionSummary,
} from './types.js';

/** 注册表构造参数。 */
export interface ExtensionRegistryOptions {
  logger: AppLogger;
  /** development | production | test，透传给扩展上下文 */
  env: string;
  appVersion: string;
  /** 功能开关快照 */
  features?: Record<string, boolean>;
  /**
   * strict = true 时任何一个扩展初始化失败都终止启动；
   * 默认 false，失败即隔离，剩余功能照常可用（酒馆场景更实用：
   * 某个 provider 的 Key 填错不应该导致整个应用打不开）。
   */
  strict?: boolean;
  /** setupAll 的最大轮次，防止扩展在 setup 里无限注册新扩展拖爆启动 */
  maxSetupPasses?: number;
}

const DEFAULT_MAX_SETUP_PASSES = 5;

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 扩展点注册表。
 *
 * 职责边界：
 *   - 只管「注册 → 初始化 → 就绪 → 释放」的生命周期，不关心扩展具体做什么；
 *   - 单个扩展失败不会引发雪崩（除 strict 模式）；
 *   - 执行顺序由 priority 决定，相同则按注册顺序，保证可复现。
 */
export class ExtensionRegistry {
  #entries = new Map<string, ExtensionEntry>();
  #registrationOrder: string[] = [];
  #logger: AppLogger;
  #env: string;
  #appVersion: string;
  #features: Readonly<Record<string, boolean>>;
  #strict: boolean;
  #maxSetupPasses: number;
  #disposing = false;

  constructor(options: ExtensionRegistryOptions) {
    this.#logger = options.logger;
    this.#env = options.env;
    this.#appVersion = options.appVersion;
    this.#features = Object.freeze({ ...(options.features ?? {}) });
    this.#strict = options.strict ?? false;
    this.#maxSetupPasses = options.maxSetupPasses ?? DEFAULT_MAX_SETUP_PASSES;
  }

  /** 已注册数量（含失败的，不含已释放的）。 */
  get size(): number {
    return this.#entries.size;
  }

  /** 是否处于关闭流程中。 */
  get isDisposing(): boolean {
    return this.#disposing;
  }

  /**
   * 批量注册。
   *
   * 先整体校验再落表：一批里只要有一个不合法，整批都不注册，
   * 避免出现「注了一半」的中间状态难以排查。
   */
  register(...extensions: readonly Extension[]): this {
    const existing = new Set(this.#entries.keys());
    const batch = new Set<string>();

    for (const extension of extensions) {
      const name = extension?.meta?.name;
      if (typeof name !== 'string' || !isValidExtensionName(name)) {
        throw ExtensionError.invalidName(typeof name === 'string' ? name : String(name));
      }
      if (!isValidExtensionKind(extension.meta.kind)) {
        throw ExtensionError.invalidKind(name, extension.meta.kind);
      }
      if (existing.has(name) || batch.has(name)) {
        throw ExtensionError.duplicateName(name);
      }
      batch.add(name);
    }

    for (const extension of extensions) {
      const name = extension.meta.name;
      this.#entries.set(name, {
        extension,
        state: 'registered',
        registeredAt: new Date(),
      });
      this.#registrationOrder.push(name);
      this.#logger.debug(
        { extension: name, kind: extension.meta.kind, version: extension.meta.version },
        '扩展已注册',
      );
    }

    return this;
  }

  /**
   * 注销一个尚未初始化的扩展。
   *
   * 已就绪的必须先 dispose 再注销，否则会漏掉清理逻辑（连接、定时器）。
   * 这里直接拒绝并返回 false，把选择权交回调用方。
   */
  unregister(name: string): boolean {
    const entry = this.#entries.get(name);
    if (!entry) return false;
    if (entry.state === 'setting-up' || entry.state === 'ready') {
      this.#logger.warn({ extension: name, state: entry.state }, '扩展已初始化，不能直接注销');
      return false;
    }
    this.#entries.delete(name);
    this.#registrationOrder = this.#registrationOrder.filter((item) => item !== name);
    return true;
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  getEntry(name: string): ExtensionEntry | undefined {
    return this.#entries.get(name);
  }

  /** 取扩展本体，泛型用于还原扩展自定义的字段（如 provider 的 chat 方法）。 */
  get<TExtension extends Extension = Extension>(name: string): TExtension | undefined {
    return this.#entries.get(name)?.extension as TExtension | undefined;
  }

  /** 取扩展本体，取不到直接抛错（用于「必需扩展」场景）。 */
  require<TExtension extends Extension = Extension>(name: string): TExtension {
    const extension = this.get<TExtension>(name);
    if (!extension) throw ExtensionError.notRegistered(name);
    return extension;
  }

  /** 按 kind 过滤，结果已按执行顺序排好。 */
  list(kind?: ExtensionKind): ExtensionEntry[] {
    return this.#sortedEntries().filter((entry) => !kind || entry.extension.meta.kind === kind);
  }

  /** 聚合摘要，给健康检查用。 */
  summary(): ExtensionSummary {
    let ready = 0;
    let failed = 0;
    let pending = 0;
    for (const entry of this.#entries.values()) {
      if (entry.state === 'ready') ready += 1;
      else if (entry.state === 'failed') failed += 1;
      else if (entry.state === 'registered' || entry.state === 'setting-up') pending += 1;
    }
    return { total: this.#entries.size, ready, failed, pending };
  }

  /** 明细快照，给调试接口 / 日志用。 */
  describe(): Array<{
    name: string;
    kind: ExtensionKind;
    version: string;
    state: ExtensionEntry['state'];
    setupDurationMs?: number;
  }> {
    return this.#sortedEntries().map((entry) => ({
      name: entry.extension.meta.name,
      kind: entry.extension.meta.kind,
      version: entry.extension.meta.version,
      state: entry.state,
      setupDurationMs: entry.setupDurationMs,
    }));
  }

  /**
   * 初始化所有已注册扩展。
   *
   * 用「多轮」而不是「一次遍历」：扩展在 setup 期间可能注册子扩展
   * （例如 provider 扩展为每个模型注册一个实现），这些新条目也要被初始化。
   * 轮次上限防止恶意/写错的扩展无限注册。
   */
  async setupAll(): Promise<void> {
    for (let pass = 1; pass <= this.#maxSetupPasses; pass += 1) {
      const pending = this.#sortedEntries().filter((entry) => entry.state === 'registered');
      if (pending.length === 0) return;

      for (const entry of pending) {
        await this.#setupEntry(entry);
      }
    }

    const stillPending = this.#sortedEntries().filter((entry) => entry.state === 'registered');
    if (stillPending.length > 0) {
      this.#logger.warn(
        { extensions: stillPending.map((entry) => entry.extension.meta.name) },
        `扩展初始化轮次超过上限 ${this.#maxSetupPasses}，剩余扩展未初始化`,
      );
    }
  }

  /**
   * 逆序释放所有已初始化的扩展。
   *
   * 逆序是硬要求：后启动的扩展可能依赖先启动的，先释放者会让依赖方拿到失效资源。
   * dispose 失败只记录不抛出——关闭流程必须走完。
   */
  async disposeAll(): Promise<void> {
    if (this.#disposing) return;
    this.#disposing = true;

    const entries = this.#sortedEntries().reverse();
    for (const entry of entries) {
      if (entry.state !== 'ready' && entry.state !== 'failed') continue;
      await this.#disposeEntry(entry);
    }
  }

  /** 执行顺序：priority 降序，相同则按注册顺序。 */
  #sortedEntries(): ExtensionEntry[] {
    return [...this.#registrationOrder]
      .map((name) => this.#entries.get(name))
      .filter((entry): entry is ExtensionEntry => entry !== undefined)
      .sort((left, right) => {
        const delta = (right.extension.meta.priority ?? 0) - (left.extension.meta.priority ?? 0);
        if (delta !== 0) return delta;
        return (
          this.#registrationOrder.indexOf(left.extension.meta.name) -
          this.#registrationOrder.indexOf(right.extension.meta.name)
        );
      });
  }

  #buildContext(): ExtensionContext {
    return {
      logger: this.#logger,
      env: this.#env,
      appVersion: this.#appVersion,
      features: this.#features,
      registry: this,
    };
  }

  async #setupEntry(entry: ExtensionEntry): Promise<void> {
    const { meta, setup } = entry.extension;
    entry.state = 'setting-up';
    const startedAt = performance.now();
    this.#logger.debug({ extension: meta.name, kind: meta.kind }, '扩展初始化开始');

    try {
      await setup?.(this.#buildContext());
      entry.state = 'ready';
      entry.readyAt = new Date();
      entry.setupDurationMs = roundMs(performance.now() - startedAt);
      this.#logger.info({ extension: meta.name, durationMs: entry.setupDurationMs }, '扩展已就绪');
    } catch (error) {
      entry.state = 'failed';
      entry.error = error;
      entry.setupDurationMs = roundMs(performance.now() - startedAt);

      if (this.#strict) {
        throw ExtensionError.setupFailed(meta.name, error);
      }
      this.#logger.error(
        { err: error, extension: meta.name },
        '扩展初始化失败，已隔离该扩展并继续启动',
      );
    }
  }

  async #disposeEntry(entry: ExtensionEntry): Promise<void> {
    const { meta, dispose } = entry.extension;
    const startedAt = performance.now();
    try {
      await dispose?.(this.#buildContext());
      this.#logger.debug(
        { extension: meta.name, durationMs: roundMs(performance.now() - startedAt) },
        '扩展已释放',
      );
    } catch (error) {
      this.#logger.error({ err: error, extension: meta.name }, '扩展释放失败，继续关闭流程');
    } finally {
      entry.state = 'disposed';
    }
  }
}
