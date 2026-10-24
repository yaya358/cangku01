/**
 * 聊天域出口：会话与消息。
 *
 * 消息是树（parent_id）+ 候选（swipes），会话只是「这个角色的一段对话」的容器。
 * 上下文引擎按线性视图取最近 N 条喂给模型，树结构留给分支功能用。
 */
export * from './conversation-repository.js';
export * from './message-repository.js';
