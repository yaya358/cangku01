import type {
  ChatStreamPayload,
  Conversation,
  ConversationDetail,
  Message,
  Player,
} from '@tavern/shared';
import {
  CONVERSATIONS_ENDPOINT,
  conversationEndpoint,
  conversationMessagesEndpoint,
  conversationStreamEndpoint,
  messageEndpoint,
  messageRegenerateEndpoint,
  messageSwipeSelectEndpoint,
} from '@tavern/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from './client';
import { readSseStream, throwIfNotOk } from './sse';

/**
 * 会话接口封装。
 *
 * 与试话页不同：这里每轮生成都由服务端落库，前端只负责渲染流。
 */

export function listConversations(characterId?: string): Promise<Conversation[]> {
  const suffix = characterId ? `?characterId=${encodeURIComponent(characterId)}` : '';
  return apiGet<Conversation[]>(`${CONVERSATIONS_ENDPOINT}${suffix}`, { timeoutMs: 10_000 });
}

export function createConversation(
  characterId: string,
  title?: string,
  player?: Partial<Player>,
): Promise<Conversation> {
  return apiPost<Conversation>(CONVERSATIONS_ENDPOINT, {
    characterId,
    ...(title ? { title } : {}),
    ...(player ? { player } : {}),
  });
}

/** 改动玩家身份（之后每一轮都按新身份组装上下文）。 */
export function updatePlayer(id: string, player: Partial<Player>): Promise<Conversation> {
  return apiPatch<Conversation>(conversationEndpoint(id), { player });
}

/** 读取会话。传 leafId 可以临时看某一支（不改会话状态）。 */
export function fetchConversation(id: string, leafId?: string): Promise<ConversationDetail> {
  const suffix = leafId ? `?leafId=${encodeURIComponent(leafId)}` : '';
  return apiGet<ConversationDetail>(`${conversationEndpoint(id)}${suffix}`, { timeoutMs: 15_000 });
}

/** 切换当前分支（改 activeLeafId）。 */
export function switchBranch(id: string, leafId: string): Promise<Conversation> {
  return apiPatch<Conversation>(conversationEndpoint(id), { activeLeafId: leafId });
}

export function renameConversation(id: string, title: string): Promise<Conversation> {
  return apiPatch<Conversation>(conversationEndpoint(id), { title });
}

export function deleteConversation(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiDelete<{ id: string; deleted: boolean }>(conversationEndpoint(id));
}

export function appendMessage(
  conversationId: string,
  input: { role: string; content: string },
): Promise<Message> {
  return apiPost<Message>(conversationMessagesEndpoint(conversationId), input);
}

export function editMessage(id: string, content: string): Promise<Message> {
  return apiPatch<Message>(messageEndpoint(id), { content });
}

export function deleteMessage(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiDelete<{ id: string; deleted: boolean }>(messageEndpoint(id));
}

export interface SendTurnHandlers {
  signal?: AbortSignal;
  onEvent: (event: ChatStreamPayload) => void;
}

/**
 * 发一句话并接收流式回复。
 *
 * 服务端会在同一轮里完成：写用户消息 → 组装上下文 → 生成 → 写助手消息，
 * 最后回一帧 `saved` 事件告诉我们两条消息的真实 id。
 */
export async function sendTurn(
  conversationId: string,
  content: string,
  handlers: SendTurnHandlers & { parentId?: string; kind?: string },
): Promise<void> {
  const response = await fetch(conversationStreamEndpoint(conversationId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      content,
      ...(handlers.kind ? { kind: handlers.kind } : {}),
      ...(handlers.parentId ? { parentId: handlers.parentId } : {}),
    }),
    signal: handlers.signal,
  });

  await throwIfNotOk(response);
  await readSseStream(response, handlers.onEvent);
}

/**
 * 重说：让模型重新生成这条回复。
 *
 * 生成完服务端会追加一个候选并切过去，回一帧 `swiped` 事件。
 */
export async function regenerateMessage(
  messageId: string,
  handlers: SendTurnHandlers,
): Promise<void> {
  const response = await fetch(messageRegenerateEndpoint(messageId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: '{}',
    signal: handlers.signal,
  });

  await throwIfNotOk(response);
  await readSseStream(response, handlers.onEvent);
}

/** 切换候选回复，返回切换后的消息。 */
export function selectSwipe(messageId: string, index: number): Promise<Message> {
  return apiPost<Message>(messageSwipeSelectEndpoint(messageId), { index });
}
