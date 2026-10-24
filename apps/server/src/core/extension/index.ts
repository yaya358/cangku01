/**
 * 扩展点体系对外出口。
 *
 * 上层（app.ts、各业务模块）只从这里 import，不直接摸内部文件，
 * 以后要重构目录结构时改动面被限制在这一个 barrel 里。
 */
export * from './types.js';
export * from './errors.js';
export * from './registry.js';
