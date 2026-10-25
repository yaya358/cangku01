import type { ChatStreamPayload, Conversation, Message } from '@tavern/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError } from '@/api/client';
import {
  createConversation,
  deleteConversation,
  fetchConversation,
  listConversations,
  sendTurn,
} from '@/api/conversations';

/** 渲染用的消息：库里来的 + 正在流式生成的那条。 */
export interface ChatBubble {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  /** 正在接收流（显示光标） */
  pending?: boolean;
  /** 乐观插入、还没被服务端确认 */
  optimistic?: boolean;
  /** 生成元信息，只在助手消息下方显示 */
  meta?: {
    model?: string | null;
    firstTokenMs?: number | null;
    durationMs?: number | null;
    totalTokens?: number | null;
  };
}

export const useChatStore = defineStore('chat', () => {
  const conversation = ref<Conversation | null>(null);
  const messages = ref<ChatBubble[]>([]);
  const list = ref<Conversation[]>([]);
  const loading = ref(false);
  const streaming = ref(false);
  const error = ref<string | null>(null);

  let controller: AbortController | null = null;
  let seq = 0;

  const title = computed(() => conversation.value?.title ?? '对话');
  const characterId = computed(() => conversation.value?.characterId ?? null);
  const isEmpty = computed(() => messages.value.length === 0);

  function describeError(cause: unknown): string {
    if (cause instanceof ApiError) {
      return cause.isNetworkError ? '连不上后端，请确认服务已启动' : cause.message;
    }
    if (cause instanceof DOMException && cause.name === 'AbortError') return '已停止生成';
    return cause instanceof Error ? cause.message : String(cause);
  }

  function toBubble(message: Message): ChatBubble {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      meta: {
        model: message.model,
        firstTokenMs: message.firstTokenMs,
        durationMs: message.durationMs,
        totalTokens: message.usage?.totalTokens ?? null,
      },
    };
  }

  async function loadList(character?: string): Promise<void> {
    try {
      list.value = await listConversations(character);
    } catch (cause) {
      error.value = describeError(cause);
    }
  }

  async function open(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const detail = await fetchConversation(id);
      conversation.value = detail.conversation;
      messages.value = detail.messages.map(toBubble);
    } catch (cause) {
      error.value = describeError(cause);
      conversation.value = null;
      messages.value = [];
    } finally {
      loading.value = false;
    }
  }

  /** 为角色开一个新会话（已有则直接用最近一个）。 */
  async function startWith(characterId: string, reuseLatest = true): Promise<string | null> {
    error.value = null;
    try {
      if (reuseLatest) {
        const existing = await listConversations(characterId);
        const recent = existing[0];
        if (recent) return recent.id;
      }
      const created = await createConversation(characterId);
      return created.id;
    } catch (cause) {
      error.value = describeError(cause);
      return null;
    }
  }

  async function send(content: string): Promise<void> {
    const text = content.trim();
    const current = conversation.value;
    if (!current || text.length === 0 || streaming.value) return;

    error.value = null;

    // 乐观插入用户消息：等 saved 事件回来再换成真实 id
    const tempUserId = `tmp-u-${++seq}`;
    messages.value.push({
      id: tempUserId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      optimistic: true,
    });

    const tempAssistantId = `tmp-a-${++seq}`;
    messages.value.push({
      id: tempAssistantId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      pending: true,
      optimistic: true,
    });

    streaming.value = true;
    controller = new AbortController();

    const patch = (id: string, changes: Partial<ChatBubble>): void => {
      const target = messages.value.find((bubble) => bubble.id === id);
      if (target) Object.assign(target, changes);
    };

    try {
      await sendTurn(current.id, text, {
        signal: controller.signal,
        onEvent: (event: ChatStreamPayload) => {
          switch (event.type) {
            case 'delta': {
              const target = messages.value.find((bubble) => bubble.id === tempAssistantId);
              if (target) target.content += event.text;
              break;
            }
            case 'done':
              patch(tempAssistantId, {
                pending: false,
                meta: {
                  firstTokenMs: event.firstTokenMs,
                  durationMs: event.durationMs,
                  totalTokens: event.usage?.totalTokens ?? null,
                },
              });
              break;
            case 'saved':
              // 用真实 id 替换临时 id，后续操作（重说/编辑）才有对象可用
              patch(tempUserId, { id: event.userMessageId, optimistic: false });
              patch(tempAssistantId, { id: event.assistantMessageId, optimistic: false });
              break;
            case 'error':
              error.value = `${event.message}${event.retryable ? '（可重试）' : ''}`;
              patch(tempAssistantId, { pending: false });
              break;
            default:
              break;
          }
        },
      });
    } catch (cause) {
      error.value = describeError(cause);
    } finally {
      streaming.value = false;
      controller = null;
      const last = messages.value.find((bubble) => bubble.id === tempAssistantId);
      if (last) {
        last.pending = false;
        // 一个字都没生成就失败：把空气泡删掉，别留个空白块
        if (last.content.trim().length === 0) {
          messages.value = messages.value.filter((bubble) => bubble.id !== tempAssistantId);
        }
      }
      // 会话的 updatedAt/preview 变了，顺手刷新一下元信息
      void refreshMeta();
    }
  }

  /** 只刷新会话元信息（标题、预览），不动消息列表。 */
  async function refreshMeta(): Promise<void> {
    const current = conversation.value;
    if (!current) return;
    try {
      const detail = await fetchConversation(current.id);
      conversation.value = detail.conversation;
    } catch {
      // 元信息刷新失败不影响对话
    }
  }

  function stop(): void {
    controller?.abort();
  }

  async function removeConversation(id: string): Promise<boolean> {
    try {
      await deleteConversation(id);
      list.value = list.value.filter((item) => item.id !== id);
      return true;
    } catch (cause) {
      error.value = describeError(cause);
      return false;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    conversation,
    messages,
    list,
    loading,
    streaming,
    error,
    title,
    characterId,
    isEmpty,
    loadList,
    open,
    startWith,
    send,
    stop,
    removeConversation,
    clearError,
  };
});
