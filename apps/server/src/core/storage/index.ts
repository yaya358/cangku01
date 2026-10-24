/**
 * 存储层出口。
 *
 * 目前只有 SQLite 一种实现（用 Node 内置 node:sqlite）。
 * 配置里 storage.driver 还留了 json 选项，将来接文件存储时在这里加一个工厂即可。
 */
export * from './migrations.js';
export * from './sqlite.js';
