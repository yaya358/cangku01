import type {
  ChatStreamPayload,
  Message,
  MessageKind,
  Scene,
  SceneCastMember,
  SceneDetail,
  ScenePresent,
} from '@tavern/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { fetchScene, sendSceneTurn } from '@/api/world';
import { describeError } from '@/utils/errors';

/**
 * 场景（世界模式）的会话状态。
 *
 * 与 chat store 的区别：这里没有「选角色」这件事 —— 谁接话由服务端按在场者决定，
 * 所以状态里最要紧的是「现在谁在场」，消息只是结果。
 */

/** 渲染用的消息：库里来的 + 正在流式生成的那条。 */
export interface SceneBubble {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  /** 这句是我说的、做的还是想的（决定气泡样式） */
  kind?: MessageKind;
  /** 这句是谁说的（场景里可能有好几个人） */
  speakerId?: string | null;
  /** 正在接收流（显示光标） */
  pending?: boolean;
  /** 乐观插入、还没被服务端确认 */
  optimistic?: boolean;
  /** 剧情事件提示（不是消息，只是这一轮发生了什么） */
  notice?: { title: string; turn: number };
  meta?: {
    durationMs?: number | null;
    totalTokens?: number | null;
  };
}

function toBubble(message: Message): SceneBubble {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    kind: message.kind,
    speakerId: message.speakerId,
    meta: {
      durationMs: message.durationMs,
      totalTokens: message.usage?.totalTokens ?? null,
    },
  };
}

export const useSceneStore = defineStore('scene', () => {
  const scene = ref<Scene | null>(null);
  const present = ref<ScenePresent[]>([]);
  const cast = ref<SceneCastMember[]>([]);
  const conversationId = ref<string | null>(null);
  const messages = ref<SceneBubble[]>([]);
  const loading = ref(false);
  const streaming = ref(false);
  const error = ref<string | null>(null);

  let controller: AbortController | null = null;
  let seq = 0;

  /** 第几轮 = 我已经发过几句（服务端也是这么数的）。 */
  const turn = computed(() => messages.value.filter((bubble) => bubble.role === 'user').length);
  const isEmpty = computed(() => messages.value.length === 0);
  const isPrivate = computed(() => scene.value?.kind === 'private');

  /** 气泡上显示的名字。名字对照表来自服务端，走了的人也在里面。 */
  function speakerName(speakerId: string | null | undefined): string {
    if (!speakerId) return '';
    return cast.value.find((member) => member.id === speakerId)?.name ?? '';
  }

  function applyMeta(detail: SceneDetail): void {
    scene.value = detail.scene;
    present.value = detail.present;
    cast.value = detail.cast;
    conversationId.value = detail.conversationId;
  }

  async function open(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const detail = await fetchScene(id);
      applyMeta(detail);
      messages.value = detail.messages.map(toBubble);
    } catch (cause) {
      error.value = describeError(cause);
      scene.value = null;
      present.value = [];
      cast.value = [];
      messages.value = [];
    } finally {
      loading.value = false;
    }
  }

  /**
   * 重新对一遍现场。
   *
   * 一轮结束后在场者可能已经变了（第 3 步起真的会变），所以每轮都要复核；
   * 生成被中止时消息仍在对岸写入，这时只同步在场者，别用半截消息覆盖界面。
   */
  async function refresh(options: { messages: boolean }): Promise<void> {
    const current = scene.value;
    if (!current) return;
    try {
      const detail = await fetchScene(current.id);
      applyMeta(detail);
      if (options.messages) messages.value = detail.messages.map(toBubble);
    } catch {
      // 复核失败不该盖掉刚拿到的那条回复
    }
  }

  async function send(content: string, kind: MessageKind = 'speak'): Promise<void> {
    const text = content.trim();
    const current = scene.value;
    if (!current || streaming.value || text.length === 0) return;

    error.value = null;

    const tempUserId = `tmp-u-${++seq}`;
    messages.value.push({
      id: tempUserId,
      role: 'user',
      content: text,
      kind,
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

    const patch = (id: string, changes: Partial<SceneBubble>): void => {
      const target = messages.value.find((bubble) => bubble.id === id);
      if (target) Object.assign(target, changes);
    };

    try {
      await sendSceneTurn(current.id, text, {
        signal: controller.signal,
        kind,
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
                  durationMs: event.durationMs,
                  totalTokens: event.usage?.totalTokens ?? null,
                },
              });
              break;
            case 'saved':
              patch(tempUserId, { id: event.userMessageId, optimistic: false });
              patch(tempAssistantId, {
                id: event.assistantMessageId,
                optimistic: false,
              });
              break;
            case 'notice':
              // 剧情事件：插在助手气泡之前，读起来就是「提示 → 有人应对」
              messages.value.splice(messages.value.length - 1, 0, {
                id: `notice-${event.eventId}`,
                role: 'system',
                content: event.content,
                createdAt: new Date().toISOString(),
                notice: { title: event.title, turn: event.atTurn },
              });
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
      const aborted = controller?.signal.aborted ?? false;
      streaming.value = false;
      controller = null;

      const last = messages.value.find((bubble) => bubble.id === tempAssistantId);
      if (last) {
        last.pending = false;
        // 一个字都没生成：把空气泡删掉，别留个空白块
        if (last.content.trim().length === 0) {
          messages.value = messages.value.filter((bubble) => bubble.id !== tempAssistantId);
        }
      }

      await refresh({ messages: !aborted });
    }
  }

  function stop(): void {
    controller?.abort();
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    scene,
    present,
    cast,
    conversationId,
    messages,
    loading,
    streaming,
    error,
    turn,
    isEmpty,
    isPrivate,
    speakerName,
    open,
    refresh,
    send,
    stop,
    clearError,
  };
});
