import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_CONFIG_FILE,
  USER_CONFIG_FILE,
  deepMerge,
  findConfigDir,
  loadConfig,
} from './loader.js';
import { createDefaultConfig } from './schema.js';

/** 每个用例独立临时目录，互不干扰，也不会读到仓库里的 user.yaml。 */
const tempDirs: string[] = [];

function makeTempConfigDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-config-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

/** 仓库里真实的 config 目录（从 apps/server 向上找到仓库根）。 */
const repoConfigDir = path.resolve(process.cwd(), '../../config');

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadConfig 合并顺序', () => {
  it('仓库里的 default.yaml 与代码内置默认值完全一致（防漂移）', () => {
    // 跳过 user.yaml：开发者本机的个人配置（可能含密钥）不该影响这条断言
    const loaded = loadConfig({ configDir: repoConfigDir, env: {}, skipUserConfig: true });

    expect(loaded.sources).toContain(path.join(repoConfigDir, DEFAULT_CONFIG_FILE));
    // 注释掉的字段（如 logging.pretty）两边都应是 undefined，所以可以直接深比较
    expect(loaded.config).toEqual(createDefaultConfig());
  });

  it('空段落（整段被注释掉）不会把默认值覆盖成 null', () => {
    const dir = makeTempConfigDir({
      [DEFAULT_CONFIG_FILE]: 'server:\n  port: 8787\n',
      // YAML 会把只有注释的段落解析成 null
      [USER_CONFIG_FILE]: 'server:\n  # port: 9000\nlogging:\n  # level: debug\n',
    });

    const loaded = loadConfig({ configDir: dir, env: {} });
    expect(loaded.config.server.port).toBe(8787);
    expect(loaded.config.logging.level).toBe('info');
  });

  it('user.yaml 深合并：只改 port，其余继承 default', () => {
    const dir = makeTempConfigDir({
      [DEFAULT_CONFIG_FILE]: 'server:\n  port: 8787\n  bodyLimitMb: 2\nlogging:\n  level: info\n',
      [USER_CONFIG_FILE]: 'server:\n  port: 9000\n',
    });

    const loaded = loadConfig({ configDir: dir, env: {} });

    expect(loaded.sources).toHaveLength(2);
    expect(loaded.config.server.port).toBe(9000);
    // 没在 user.yaml 里出现的兄弟字段必须保留
    expect(loaded.config.server.bodyLimitMb).toBe(2);
    expect(loaded.config.logging.level).toBe('info');
    // 两个文件都没写的段由 schema 默认值补齐
    expect(loaded.config.storage.driver).toBe('sqlite');
  });

  it('数组是整体替换而不是拼接', () => {
    const dir = makeTempConfigDir({
      [DEFAULT_CONFIG_FILE]: 'server:\n  corsOrigins:\n    - http://a.test\n',
      [USER_CONFIG_FILE]: 'server:\n  corsOrigins:\n    - http://b.test\n',
    });

    const loaded = loadConfig({ configDir: dir, env: {} });
    expect(loaded.config.server.corsOrigins).toEqual(['http://b.test']);
  });

  it('没有 default.yaml 时退回内置默认值，不报错', () => {
    const dir = makeTempConfigDir();
    const loaded = loadConfig({ configDir: dir, env: {} });

    expect(loaded.sources).toHaveLength(0);
    expect(loaded.config).toEqual(createDefaultConfig());
  });
});

describe('loadConfig 校验', () => {
  it('类型错误时报出具体字段', () => {
    const dir = makeTempConfigDir({
      [DEFAULT_CONFIG_FILE]: 'server:\n  port: "不是数字"\n',
    });

    let error: unknown;
    try {
      loadConfig({ configDir: dir, env: {} });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const issues = (error as ConfigError).issues;
    expect(issues.some((issue) => issue.startsWith('server.port'))).toBe(true);
  });

  it('未知字段被拒绝（防手滑拼错）', () => {
    const dir = makeTempConfigDir({
      [DEFAULT_CONFIG_FILE]: 'server:\n  prot: 8787\n',
    });

    expect(() => loadConfig({ configDir: dir, env: {} })).toThrow(ConfigError);
  });

  it('YAML 语法错误带出出错位置', () => {
    const dir = makeTempConfigDir({
      [DEFAULT_CONFIG_FILE]: 'server:\n  port: [unclosed\n',
    });

    try {
      loadConfig({ configDir: dir, env: {} });
      expect.unreachable('应当抛出 ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('YAML 语法错误');
      expect((error as ConfigError).issues.join()).toContain(DEFAULT_CONFIG_FILE);
    }
  });
});

describe('环境变量覆盖', () => {
  it('TAVERN_ 前缀 + 双下划线可以覆盖任意深度的字段，且类型被还原', () => {
    const dir = makeTempConfigDir({
      [DEFAULT_CONFIG_FILE]: 'server:\n  port: 8787\nlogging:\n  level: info\n',
    });

    const loaded = loadConfig({
      configDir: dir,
      env: { TAVERN_SERVER__PORT: '9999', TAVERN_LOGGING__LEVEL: 'debug' },
    });

    expect(loaded.config.server.port).toBe(9999); // 数字，不是字符串
    expect(loaded.config.logging.level).toBe('debug');
    expect(loaded.overrides).toEqual(['TAVERN_LOGGING__LEVEL', 'TAVERN_SERVER__PORT']);
  });

  it('环境变量优先级高于 user.yaml', () => {
    const dir = makeTempConfigDir({
      [DEFAULT_CONFIG_FILE]: 'server:\n  port: 8787\n',
      [USER_CONFIG_FILE]: 'server:\n  port: 9000\n',
    });

    const loaded = loadConfig({ configDir: dir, env: { TAVERN_SERVER__PORT: '9100' } });
    expect(loaded.config.server.port).toBe(9100);
  });

  it('通用别名 PORT / NODE_ENV 也生效', () => {
    const dir = makeTempConfigDir({ [DEFAULT_CONFIG_FILE]: 'app:\n  env: development\n' });

    const loaded = loadConfig({ configDir: dir, env: { PORT: '9200', NODE_ENV: 'production' } });
    expect(loaded.config.server.port).toBe(9200);
    expect(loaded.config.app.env).toBe('production');
  });

  it('布尔与字符串数组也能通过环境变量给', () => {
    const dir = makeTempConfigDir({ [DEFAULT_CONFIG_FILE]: 'server:\n  port: 8787\n' });

    const loaded = loadConfig({
      configDir: dir,
      env: {
        TAVERN_FEATURES__PLUGINS: 'true',
        TAVERN_SERVER__CORS_ORIGINS: '["http://a.test","http://b.test"]',
      },
    });

    expect(loaded.config.features).toEqual({ plugins: true });
    expect(loaded.config.server.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('环境变量给了非法值时同样被 schema 拦下', () => {
    const dir = makeTempConfigDir({ [DEFAULT_CONFIG_FILE]: 'server:\n  port: 8787\n' });

    try {
      loadConfig({ configDir: dir, env: { TAVERN_SERVER__PORT: 'not-a-number' } });
      expect.unreachable('应当抛出 ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.some((issue) => issue.startsWith('server.port'))).toBe(
        true,
      );
    }
  });

  it('TAVERN_CONFIG_DIR 只用于定位目录，不算作配置覆盖', () => {
    const dir = makeTempConfigDir({ [DEFAULT_CONFIG_FILE]: 'server:\n  port: 8787\n' });

    const loaded = loadConfig({ env: { TAVERN_CONFIG_DIR: dir } });
    expect(loaded.configDir).toBe(path.resolve(dir));
    expect(loaded.overrides).toEqual([]);
  });
});

describe('deepMerge', () => {
  it('undefined 不覆盖已有值', () => {
    const merged = deepMerge({ a: 1, b: { c: 2 } }, { a: undefined, b: { c: 3 } });
    expect(merged).toEqual({ a: 1, b: { c: 3 } });
  });

  it('数组整体替换', () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it('不修改入参', () => {
    const base = { nested: { value: 1 } };
    deepMerge(base, { nested: { value: 2 } });
    expect(base.nested.value).toBe(1);
  });
});

describe('findConfigDir', () => {
  it('在临时目录里找不到配置目录', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-nocfg-'));
    tempDirs.push(dir);
    expect(findConfigDir(dir)).toBeUndefined();
  });

  it('从子目录能向上找到仓库的 config', () => {
    expect(findConfigDir(path.join(repoConfigDir, '..', 'apps', 'server'))).toBe(
      path.resolve(repoConfigDir),
    );
  });
});
