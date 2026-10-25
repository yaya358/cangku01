/**
 * @tavern/shared —— 前后端共享的唯一事实源。
 *
 * 这里的每个契约都会被后端（Fastify）与前端（Vue3）同时 import，
 * 因此「改一处、两端同时报红」，不需要靠文档对齐字段名。
 */
export * from './constants.js';
export * from './contracts/envelope.js';
export * from './contracts/health.js';
export * from './contracts/chat.js';
export * from './contracts/character.js';
export * from './contracts/context.js';
export * from './contracts/conversation.js';
export * from './contracts/worldbook.js';
export * from './contracts/script.js';
export * from './contracts/world.js';
export * from './contracts/affinity.js';

// 内置示例角色（前后端共用：后端首次启动自动播种，前端用来展示说明）
export * from './samples/cards.js';
export * from './samples/avatars.js';
