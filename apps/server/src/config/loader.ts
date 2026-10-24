import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema } from './schema.js';
import type { AppConfig } from './schema.js';

/** 仓库里约定的配置目录名与文件名。 */
export const CONFIG_DIR_NAME = 'config';
export const DEFAULT_CONFIG_FILE = 'default.yaml';
export const USER_CONFIG_FILE = 'user.yaml';
/** 允许用环境变量指定配置目录（部署时常见）。 */
export const CONFIG_DIR_ENV = 'TAVERN_CONFIG_DIR';

/** 向上查找配置目录的最大层数，防止在奇怪的工作目录下一直爬到根。 */
const MAX_LOOKUP_DEPTH = 6;

type PlainObject = Record<string, unknown>;

/** 加载结果：既有解析后的配置，也保留「这些值从哪来」的痕迹。 */
export interface LoadedConfig {
  config: AppConfig;
  /** 配置目录的绝对路径 */
  configDir: string;
  /** 实际读到的配置文件（绝对路径，按合并顺序） */
  sources: string[];
}

/** 配置加载/校验失败。issues 里每一条都能直接展示给用户。 */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = [], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function isConfigError(value: unknown): value is ConfigError {
  return value instanceof ConfigError;
}

export interface LoadConfigOptions {
  /** 显式指定配置目录；不传则用 TAVERN_CONFIG_DIR 或自动向上查找 */
  configDir?: string;
  /** 环境变量来源，默认 process.env；测试传 {} 可隔离宿主环境 */
  env?: Record<string, string | undefined>;
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 递归合并配置。
 *
 * 语义：对象逐层合并，数组与标量直接覆盖（用户填的 [a,b] 不应该和默认值拼起来）。
 * undefined 视为「没填」，不覆盖已有值——这样 yaml 里留空的键不会把默认值清掉。
 */
export function deepMerge<TValue>(base: TValue, override: unknown): TValue {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as TValue)) as TValue;
  }

  const result: PlainObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = result[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result as TValue;
}

/** 从起始目录向上找 config/default.yaml，找到就返回该 config 目录。 */
export function findConfigDir(startDir: string = process.cwd()): string | undefined {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < MAX_LOOKUP_DEPTH; depth += 1) {
    const candidate = path.join(current, CONFIG_DIR_NAME);
    if (fs.existsSync(path.join(candidate, DEFAULT_CONFIG_FILE))) return candidate;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** 解析配置目录：显式参数 > 环境变量 > 自动查找。 */
export function resolveConfigDir(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicit) return path.resolve(explicit);

  const fromEnv = env[CONFIG_DIR_ENV];
  if (fromEnv) return path.resolve(fromEnv);

  const found = findConfigDir();
  if (found) return found;

  throw new ConfigError('找不到配置目录：请确认仓库根目录下存在 config/default.yaml', [
    `已从 ${process.cwd()} 向上查找 ${MAX_LOOKUP_DEPTH} 层`,
    `也可以通过环境变量 ${CONFIG_DIR_ENV} 指定配置目录`,
  ]);
}

/** 读一个 yaml 文件并保证顶层是对象；解析错误带上行列号。 */
function readYamlObject(filePath: string): PlainObject {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`读取配置文件失败: ${filePath}`, [String(error)], error);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const linePos = (error as { linePos?: Array<{ line: number; col: number }> }).linePos?.[0];
    const reason = error instanceof Error ? error.message : String(error);
    // yaml 的报错自带行列，这里再补上文件名，用户才能直接跳过去改
    const location = linePos ? `${filePath}:${linePos.line}:${linePos.col}` : filePath;
    throw new ConfigError(
      `配置文件 YAML 语法错误: ${filePath}`,
      [`${location} → ${reason}`],
      error,
    );
  }

  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`配置文件顶层必须是一个对象: ${filePath}`);
  }
  return parsed;
}

/**
 * 加载配置。
 *
 * 合并顺序（后者覆盖前者）：
 *   内置默认值 → config/default.yaml → config/user.yaml → 环境变量（见后续阶段）
 *
 * default.yaml 缺失时不会失败：直接退回内置默认值，让「刚 clone 下来」也能跑。
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const configDir = resolveConfigDir(options.configDir, env);

  const sources: string[] = [];
  let merged: PlainObject = {};

  const defaultFile = path.join(configDir, DEFAULT_CONFIG_FILE);
  if (fs.existsSync(defaultFile)) {
    merged = deepMerge(merged, readYamlObject(defaultFile));
    sources.push(defaultFile);
  }

  const userFile = path.join(configDir, USER_CONFIG_FILE);
  if (fs.existsSync(userFile)) {
    merged = deepMerge(merged, readYamlObject(userFile));
    sources.push(userFile);
  }

  // 即使一个文件都没读到，schema 里的默认值也能把 merged 补成完整配置
  const parsed = AppConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(根节点)';
      return `${where}: ${issue.message}`;
    });
    throw new ConfigError('配置校验失败', issues);
  }

  return { config: parsed.data, configDir, sources };
}
