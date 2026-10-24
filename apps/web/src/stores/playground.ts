import type { ChatMessage, ChatUsage, ProviderInfo } from '@tavern/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError } from '@/api/client';
import { fetchProviders, streamChat } from '@/api/chat';

/** 试话面板里的一条消息。 */
export interface PlaygroundMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 正在流式接收，用来渲染光标 */
  pending?: boolean;
}

export interface PlaygroundStats {
  firstTokenMs: number | null;
  durationMs: number;
  usage?: ChatUsage;
  model: string;
}

/** 默认人设：让「试话」不只是一次裸调用，能看出角色扮演的雏形。 */
const SYSTEM_PROMPT =
  '你是「月灯酒馆」的老板，说话简短、有画面感，喜欢用酒和灯做比喻。回答控制在三句话以内。';

let messageSeq = 0;

function nextId(prefix: string): string {
  messageSeq += 1;
  return `${prefix}-${messageSeq}`;
}

export const usePlaygroundStore = defineStore('playground', () => {
  const providers = ref<ProviderInfo[]>([]);
  const selectedProvider = ref<string | null>(null);
  const messages = ref<PlaygroundMessage[]>([]);
  const streaming = ref(false);
  const stats = ref<PlaygroundStats | null>(null);
  const error = ref<string | null>(null);

  let controller: AbortController | null = null;

  const currentProvider = computed(
    () => providers.value.find((item) => item.name === selectedProvider.value) ?? null,
  );
  const canSend = computed(() => !streaming.value && providers.value.length > 0);
  const hasUsableProvider = computed(() => providers.value.some((item) => item.hasCredentials));

  async function loadProviders(): Promise<void> {
    try {
      providers.value = await fetchProviders();
      if (!selectedProvider.value && providers.value.length > 0) {
        selectedProvider.value = providers.value[0]?.name ?? null;
      }
      error.value = null;
    } catch (cause) {
      error.value = cause instanceof ApiError ? cause.message : String(cause);
    }
  }

  /** 组装请求消息：系统人设 + 历史对话。 */
  function buildMessages(): ChatMessage[] {
    const history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
    for (const message of messages.value) {
      // 正在生成中的那条不参与下一次请求
      if (message.pending) continue;
      if (message.content.trim().length === 0) continue;
      history.push({ role: message.role, content: message.content });
    }
    return history;
  }

  async function send(text: string): Promise<void> {
    const content = text.trim();
    if (content.length === 0 || streaming.value) return;

    error.value = null;
    stats.value = null;

    messages.value.push({ id: nextId('u'), role: 'user', content });
    const assistantIndex =
      messages.value.push({
        id: nextId('a'),
        role: 'assistant',
        content: '',
        pending: true,
      }) - 1;

    streaming.value = true;
    controller = new AbortController();

    try {
      await streamChat(
        {
          provider: selectedProvider.value ?? undefined,
          messages: buildMessages(),
          params: { maxTokens: 800, temperature: 1.1 },
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            const current = messages.value[assistantIndex];
            if (!current) return;

            switch (event.type) {
              case 'delta':
                current.content += event.text;
                break;
              case 'usage':
                stats.value = {
                  firstTokenMs: stats.value?.firstTokenMs ?? null,
                  durationMs: stats.value?.durationMs ?? 0,
                  usage: event.usage,
                  model: stats.value?.model ?? currentProvider.value?.model ?? '',
                };
                break;
              case 'done':
                stats.value = {
                  firstTokenMs: event.firstTokenMs,
                  durationMs: event.durationMs,
                  usage: event.usage ?? stats.value?.usage,
                  model: currentProvider.value?.model ?? '',
                };
                break;
              case 'error':
                if (event.code === 'ABORTED') {
                  current.content += current.content.length > 0 ? '' : '（已取消）';
                } else {
                  error.value = `${event.message}${event.retryable ? '（可重试）' : ''}`;
                  if (current.content.length === 0) current.content = '（生成失败）';
                }
                break;
              default:
                break;
            }
          },
        },
      );
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        // 用户主动停止，不算错误
      } else if (cause instanceof ApiError) {
        error.value = cause.message;
      } else {
        error.value = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      streaming.value = false;
      controller = null;
      const current = messages.value[assistantIndex];
      if (current) current.pending = false;
    }
  }

  function stop(): void {
    controller?.abort();
  }

  function clear(): void {
    messages.value = [];
    stats.value = null;
    error.value = null;
  }

  return {
    providers,
    selectedProvider,
    messages,
    streaming,
    stats,
    error,
    currentProvider,
    canSend,
    hasUsableProvider,
    loadProviders,
    send,
    stop,
    clear,
  };
});
