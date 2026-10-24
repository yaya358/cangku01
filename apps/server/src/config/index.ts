/**
 * 配置模块出口。
 *
 * 上层只从 'config/index.js' 引入，内部文件可以自由重构；
 * schema 的默认值与 yaml 的一致性由 loader.test.ts 守住。
 */
export * from './schema.js';
export * from './loader.js';
