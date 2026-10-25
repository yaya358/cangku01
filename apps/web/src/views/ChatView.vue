<template>
  <section class="chat">
    <header class="chat__head">
      <RouterLink class="chat__back" to="/characters">← 角色</RouterLink>

      <div v-if="character" class="chat__who">
        <span class="chat__avatar">
          <img v-if="character.avatarUrl" :src="character.avatarUrl" :alt="character.name" />
          <span v-else>{{ character.name.slice(0, 1) }}</span>
        </span>
        <div>
          <h1 class="chat__name">{{ character.name }}</h1>
          <p class="chat__sub">{{ store.title }} · {{ messages.length }} 条消息</p>
        </div>
      </div>

      <div class="chat__actions">
        <RouterLink v-if="character" class="chat__link" :to="`/characters/${character.id}`">
          角色设定
        </RouterLink>
      </div>
    </header>

    <n-alert v-if="error" type="error" :title="error" closable @close="store.clearError()" />

    <div ref="logRef" class="chat__log">
      <div v-if="loading" class="chat__loading">
        <n-spin size="small" />
        <span>正在读取会话…</span>
      </div>

      <p v-else-if="isEmpty" class="chat__empty">这段对话还没有内容。打个招呼吧。</p>

      <article
        v-for="bubble in messages"
        :key="bubble.id"
        class="bubble"
        :class="[`bubble--${bubble.role}`, { 'bubble--optimistic': bubble.optimistic }]"
      >
        <p class="bubble__body">
          {{ bubble.content
          }}<span v-if="bubble.pending" class="bubble__caret" aria-hidden="true" />
        </p>

        <div v-if="bubble.role === 'assistant'" class="bubble__tools">
          <template v-if="bubble.swipes.length > 1">
            <button
              class="tool"
              type="button"
              :disabled="bubble.swipeIndex === 0 || streaming"
              title="上一版"
              @click="store.switchSwipe(bubble.id, bubble.swipeIndex - 1)"
            >
              ‹
            </button>
            <span class="tool__page">{{ bubble.swipeIndex + 1 }}/{{ bubble.swipes.length }}</span>
            <button
              class="tool"
              type="button"
              :disabled="bubble.swipeIndex >= bubble.swipes.length - 1 || streaming"
              title="下一版"
              @click="store.switchSwipe(bubble.id, bubble.swipeIndex + 1)"
            >
              ›
            </button>
          </template>
          <button
            class="tool tool--regen"
            type="button"
            :disabled="streaming || bubble.optimistic"
            title="让模型换个说法重新生成"
            @click="store.regenerate(bubble.id)"
          >
            重说
          </button>
        </div>

        <p v-if="bubble.meta && bubble.role === 'assistant'" class="bubble__meta">
          <span v-if="bubble.meta.firstTokenMs">首字 {{ bubble.meta.firstTokenMs }}ms</span>
          <span v-if="bubble.meta.durationMs">· 总 {{ bubble.meta.durationMs }}ms</span>
          <span v-if="bubble.meta.totalTokens">· {{ bubble.meta.totalTokens }} tokens</span>
        </p>
      </article>
    </div>

    <div class="chat__input">
      <n-input
        v-model:value="draft"
        type="textarea"
        placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
        :autosize="{ minRows: 2, maxRows: 6 }"
        :disabled="streaming || loading || !conversation"
        @keydown="onKeydown"
      />
      <div class="chat__actions-row">
        <n-button v-if="!streaming" type="primary" :disabled="!canSend" @click="submit">
          发送
        </n-button>
        <n-button v-else type="error" ghost @click="store.stop()">停止</n-button>
        <span class="chat__hint">每轮都会落库，刷新页面记录还在</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { Character } from '@tavern/shared';
import { NAlert, NButton, NInput, NSpin } from 'naive-ui';
import { storeToRefs } from 'pinia';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { fetchCharacter } from '@/api/characters';
import { useChatStore } from '@/stores/chat';

const route = useRoute();
const store = useChatStore();
const { messages, loading, streaming, error, conversation, isEmpty } = storeToRefs(store);

const draft = ref('');
const character = ref<Character | null>(null);
const logRef = ref<HTMLElement | null>(null);

const canSend = computed(
  () => !streaming.value && !!conversation.value && draft.value.trim().length > 0,
);

function submit(): void {
  if (!canSend.value) return;
  const text = draft.value;
  draft.value = '';
  void store.send(text);
}

function onKeydown(event: KeyboardEvent): void {
  // Enter 发送、Shift+Enter 换行；输入法组合中不拦截
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}

async function loadAll(): Promise<void> {
  const id = String(route.params.id ?? '');
  await store.open(id);

  const characterId = store.characterId;
  if (characterId) {
    try {
      character.value = await fetchCharacter(characterId);
    } catch {
      character.value = null;
    }
  }
}

/** 新内容进来自动滚到底部（跟手，但用户向上翻时不打断）。 */
watch(
  () => messages.value.map((bubble) => bubble.content.length).join(','),
  async () => {
    const element = logRef.value;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
    if (!nearBottom && streaming.value) return;
    await nextTick();
    element.scrollTop = element.scrollHeight;
  },
);

watch(
  () => route.params.id,
  () => {
    void loadAll();
  },
);

onMounted(() => {
  void loadAll();
});

onBeforeUnmount(() => {
  store.stop();
});
</script>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(100vh - 200px);
  min-height: 480px;
}

.chat__head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.chat__back {
  color: var(--text-dim);
  font-size: 12.5px;
}

.chat__back:hover {
  color: var(--accent);
  text-decoration: none;
}

.chat__who {
  display: flex;
  align-items: center;
  gap: 10px;
}

.chat__avatar {
  display: grid;
  overflow: hidden;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: linear-gradient(150deg, #2a2118, #16120f);
  font-family: var(--font-mono);
  color: var(--border-strong);
}

.chat__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.chat__name {
  font-size: 15px;
  line-height: 1.3;
}

.chat__sub {
  color: var(--text-faint);
  font-size: 11.5px;
}

.chat__actions {
  margin-left: auto;
}

.chat__link {
  color: var(--text-dim);
  font-size: 12px;
}

.chat__link:hover {
  color: var(--accent);
  text-decoration: none;
}

.chat__log {
  display: flex;
  overflow-y: auto;
  padding: 16px;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: linear-gradient(180deg, var(--bg-soft), var(--bg));
}

.chat__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: auto;
  color: var(--text-dim);
  font-size: 12.5px;
}

.chat__empty {
  margin: auto;
  color: var(--text-faint);
  font-size: 12.5px;
}

.bubble {
  display: flex;
  max-width: 86%;
  flex-direction: column;
  gap: 4px;
}

.bubble--user {
  margin-left: auto;
  align-items: flex-end;
}

.bubble--system {
  max-width: 100%;
  align-items: center;
}

.bubble__body {
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-elevated);
  font-size: 13.5px;
  line-height: 1.85;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble--user .bubble__body {
  border-color: rgba(224, 167, 94, 0.34);
  background: var(--accent-soft);
}

.bubble--system .bubble__body {
  border-style: dashed;
  color: var(--text-faint);
  font-size: 12px;
}

.bubble--optimistic .bubble__body {
  opacity: 0.86;
}

.bubble__caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  background: var(--accent);
  vertical-align: text-bottom;
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
  to {
    visibility: hidden;
  }
}

.bubble__meta {
  padding: 0 6px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

/* 重说 / 候选翻页 */
.bubble__tools {
  display: flex;
  padding: 0 2px;
  align-items: center;
  gap: 6px;
  opacity: 0.55;
  transition: opacity 0.15s ease;
}

.bubble:hover .bubble__tools {
  opacity: 1;
}

.tool {
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
}

.tool:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--accent);
}

.tool:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.tool--regen {
  margin-left: 4px;
}

.tool__page {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.chat__input {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chat__actions-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.chat__hint {
  color: var(--text-faint);
  font-size: 11px;
}

@media (max-width: 640px) {
  .chat {
    height: auto;
  }

  .chat__log {
    min-height: 320px;
  }
}
</style>
