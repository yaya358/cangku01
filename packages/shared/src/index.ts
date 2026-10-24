/**
 * @tavern/shared —— 前后端共享的唯一事实源。
 *
 * 这里的每个契约都会被后端（Fastify）与前端（Vue3）同时 import，
 * 因此「改一处、两端同时报红」，不需要靠文档对齐字段名。
 */
export * from './constants.js';
export * from './contracts/envelope.js';
export * from './contracts/health.js';
