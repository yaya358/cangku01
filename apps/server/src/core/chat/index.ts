/**
 * 聊天域出口：会话、消息与对话树。
 *
 * 消息是树（parent_id）+ 候选（swipes），会话只是「这个角色的一段对话」的容器。
 * 上下文只取「根 → 当前叶子」这一条路径，所以分支之间互不污染。
 */
export * from './conversation-repository.js';
export * from './message-repository.js';
export * from './thread.js';
