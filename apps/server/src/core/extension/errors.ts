import { EXTENSION_KINDS } from './types.js';
import type { ExtensionKind } from './types.js';

/** 扩展点相关错误码。 */
export type ExtensionErrorCode =
  'INVALID_NAME' | 'INVALID_KIND' | 'DUPLICATE_NAME' | 'SETUP_FAILED' | 'NOT_REGISTERED';

/**
 * 扩展点异常。
 *
 * 与 AppError 分开：这是启动期/装配期的编程错误，不是用户请求导致的，
 * 不应该被 HTTP 错误处理器包装成 400/500 返回给前端。
 */
export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;
  readonly extensionName?: string;

  constructor(code: ExtensionErrorCode, message: string, extensionName?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExtensionError';
    this.code = code;
    this.extensionName = extensionName;
  }

  static invalidName(name: string): ExtensionError {
    return new ExtensionError(
      'INVALID_NAME',
      `扩展名不合法: "${name}"，只允许小写字母/数字/点/下划线/短横线，且首尾为字母或数字`,
      name,
    );
  }

  static invalidKind(name: string, kind: unknown): ExtensionError {
    return new ExtensionError(
      'INVALID_KIND',
      `扩展 "${name}" 的 kind 不合法: ${String(kind)}，可选值: ${EXTENSION_KINDS.join(', ')}`,
      name,
    );
  }

  static duplicateName(name: string): ExtensionError {
    return new ExtensionError(
      'DUPLICATE_NAME',
      `扩展名重复: "${name}"，每个扩展必须有唯一 id`,
      name,
    );
  }

  static notRegistered(name: string): ExtensionError {
    return new ExtensionError('NOT_REGISTERED', `扩展未注册: "${name}"`, name);
  }

  static setupFailed(name: string, cause: unknown): ExtensionError {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new ExtensionError('SETUP_FAILED', `扩展 "${name}" 初始化失败: ${reason}`, name, cause);
  }
}

/** 供外部做类型判断。 */
export function isExtensionError(value: unknown): value is ExtensionError {
  return value instanceof ExtensionError;
}

/** 判断扩展名是否合法（供注册表与测试共用）。 */
export function isValidExtensionName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(name);
}

/** 判断 kind 是否合法，并顺带把类型收窄。 */
export function isValidExtensionKind(kind: unknown): kind is ExtensionKind {
  return typeof kind === 'string' && (EXTENSION_KINDS as readonly string[]).includes(kind);
}
