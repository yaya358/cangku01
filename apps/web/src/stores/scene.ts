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
import {
  createPrivateScene,
  fetchScene,
  listScenes,
  returnToSourceScene,
  sendSceneTurn,
} from '@/api/world';
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
  /** 压低声音说的 */
  whisper?: boolean;
  /** 第三者听见私聊之后的反应 */
  eavesdrop?: boolean;
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
    whisper: message.whisper,
    eavesdrop: message.eavesdrop,
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
  /** 私密场景：原来那个公开场景叫什么（回头的路要有名字才好走） */
  const sourceSceneName = ref<string | null>(null);
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

  /** 私密场景开回来之后，把来源场景的名字也取到手（只为了文案）。 */
  async function loadSourceName(): Promise<void> {
    const current = scene.value;
    sourceSceneName.value = null;
    if (!current || current.kind !== 'private' || !current.sourceSceneId) return;
    try {
      const scenes = await listScenes(current.saveId);
      sourceSceneName.value =
        scenes.find((item) => item.id === current.sourceSceneId)?.name ?? null;
    } catch {
      // 名字取不到不影响说话，退化成「回到原处」
    }
  }

  async function open(id: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const detail = await fetchScene(id);
      applyMeta(detail);
      messages.value = detail.messages.map(toBubble);
      await loadSourceName();
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
   * 一轮结束后在场者可能已经变了，所以每轮都要复核；
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

  /** 偷听事件：听见了就把反应插进对话流，没听见也要给一句确定的反馈。 */
  function applyEavesdrop(event: Extract<ChatStreamPayload, { type: 'eavesdrop' }>): void {
    if (event.heard && event.listener) {
      const listener = event.listener;
      if (!cast.value.some((member) => member.id === listener.id)) {
        cast.value = [...cast.value, listener];
      }
      messages.value.push({
        id: event.messageId ?? `tmp-e-${++seq}`,
        role: 'assistant',
        content: event.text,
        createdAt: new Date().toISOString(),
        speakerId: listener.id,
        eavesdrop: true,
      });
      return;
    }

    messages.value.push({
      id: event.messageId ?? `tmp-miss-${++seq}`,
      role: 'system',
      content: event.text,
      createdAt: new Date().toISOString(),
    });
  }

  async function send(
    content: string,
    kind: MessageKind = 'speak',
    whisper = false,
  ): Promise<void> {
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
      whisper,
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
        whisper,
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
            case 'eavesdrop':
              applyEavesdrop(event);
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

  /**
   * 把在场的人带到私密场景。
   *
   * 返回新场景 id 交给页面跳转 —— 换地方是页面级的事，不该由 store 改路由。
   */
  async function pullAway(characterId: string): Promise<string | null> {
    const current = scene.value;
    if (!current || streaming.value) return null;
    error.value = null;
    try {
      const result = await createPrivateScene(current.id, characterId);
      return result.scene.id;
    } catch (cause) {
      error.value = describeError(cause);
      return null;
    }
  }

  /** 从私密场景回到原来的地方（把人带回去）。 */
  async function goBack(): Promise<string | null> {
    const current = scene.value;
    if (!current || current.kind !== 'private') return null;
    error.value = null;
    try {
      const result = await returnToSourceScene(current.id);
      return result.scene.id;
    } catch (cause) {
      error.value = describeError(cause);
      return null;
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
    sourceSceneName,
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
    pullAway,
    goBack,
    stop,
    clearError,
  };
});
