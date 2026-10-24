<template>
  <section class="pg">
    <header class="pg__head">
      <div class="pg__intro">
        <h1 class="pg__title">试话</h1>
        <p class="pg__desc">
          直接跟模型服务对话，验证流式链路。这里的「老板」只是临时人设，
          等角色卡做完，人设会从角色卡里来。
        </p>
      </div>

      <div class="pg__controls">
        <n-select
          v-model:value="selected"
          :options="providerOptions"
          size="small"
          class="pg__select"
          placeholder="选择模型服务"
          :disabled="streaming"
        />
        <n-button size="small" :disabled="messages.length === 0" @click="store.clear()">
          清空
        </n-button>
      </div>
    </header>

    <n-alert
      v-if="!hasUsableProvider && providers.length > 0"
      type="warning"
      title="模型服务还没配密钥"
      class="pg__alert"
    >
      打开 <code>config/user.yaml</code>，把 providers 里的 apiKey 填上，然后重启后端。
    </n-alert>

    <n-alert
      v-else-if="providers.length === 0"
      type="warning"
      title="还没有配置模型服务"
      class="pg__alert"
    >
      在 <code>config/user.yaml</code> 的 <code>providers</code> 段里加一个（参考
      <code>config/default.yaml</code> 里的注释示例），然后重启后端。
    </n-alert>

    <div ref="logRef" class="pg__log">
      <div v-if="messages.length === 0" class="pg__empty">
        <p class="pg__empty-title">还没开始。试一句：</p>
        <div class="pg__presets">
          <button
            v-for="preset in PRESETS"
            :key="preset"
            type="button"
            class="pg__preset"
            :disabled="!canSend"
            @click="send(preset)"
          >
            {{ preset }}
          </button>
        </div>
      </div>

      <article
        v-for="message in messages"
        :key="message.id"
        class="msg"
        :class="`msg--${message.role}`"
      >
        <span class="msg__role">{{ message.role === 'user' ? '你' : '老板' }}</span>
        <p class="msg__body">
          {{ message.content }}<span v-if="message.pending" class="msg__caret" aria-hidden="true" />
        </p>
      </article>
    </div>

    <n-alert
      v-if="error"
      type="error"
      :title="error"
      class="pg__alert"
      closable
      @close="clearError()"
    />

    <div class="pg__input">
      <n-input
        v-model:value="draft"
        type="textarea"
        placeholder="说点什么…（Ctrl + Enter 发送）"
        :autosize="{ minRows: 2, maxRows: 6 }"
        :disabled="!canSend"
        @keydown="onKeydown"
      />

      <div class="pg__actions">
        <n-button
          v-if="!streaming"
          type="primary"
          :disabled="!canSend || draft.trim().length === 0"
          @click="submit"
        >
          发送
        </n-button>
        <n-button v-else type="error" ghost @click="store.stop()">停止</n-button>

        <span v-if="stats" class="pg__stats">
          首字 {{ stats.firstTokenMs ?? '—' }}ms · 总 {{ stats.durationMs }}ms ·
          {{ stats.usage?.totalTokens ?? '—' }} tokens
          <span v-if="stats.model" class="pg__stats-model">· {{ stats.model }}</span>
        </span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { NAlert, NButton, NInput, NSelect } from 'naive-ui';
import { storeToRefs } from 'pinia';
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { usePlaygroundStore } from '@/stores/playground';

const PRESETS = ['你们家最烈的酒是什么？', '给我讲个酒馆里发生的故事', '今晚有乐队吗？'];

const route = useRoute();
const store = usePlaygroundStore();
const {
  providers,
  selectedProvider,
  messages,
  streaming,
  stats,
  error,
  canSend,
  hasUsableProvider,
} = storeToRefs(store);

const draft = ref('');
const logRef = ref<HTMLElement | null>(null);

const selected = computed({
  get: () => selectedProvider.value,
  set: (value: string | null) => {
    selectedProvider.value = value;
  },
});

const providerOptions = computed(() =>
  providers.value.map((provider) => ({
    label: `${provider.name} · ${provider.model}`,
    value: provider.name,
    disabled: !provider.hasCredentials,
  })),
);

function send(text: string): void {
  draft.value = '';
  void store.send(text);
}

function submit(): void {
  if (!canSend.value || draft.value.trim().length === 0) return;
  send(draft.value);
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    submit();
  }
}

function clearError(): void {
  error.value = null;
}

/** 内容变化时把日志滚到底部，跟手。 */
watch(
  () => messages.value.map((message) => message.content.length).join(','),
  async () => {
    await nextTick();
    const element = logRef.value;
    if (element) element.scrollTop = element.scrollHeight;
  },
);

onMounted(async () => {
  await store.loadProviders();

  // 支持深链接：/playground?q=你好 会自动发出去并开始流式回答，
  // 方便把它当「一键试话」的入口分享给别人。
  const initial = route.query.q;
  const text = typeof initial === 'string' ? initial.trim() : '';
  if (text.length > 0 && canSend.value) {
    send(text);
  }
});

onBeforeUnmount(() => {
  store.stop();
});
</script>

<style scoped>
.pg {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: calc(100vh - 190px);
  min-height: 460px;
}

.pg__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.pg__title {
  margin-bottom: 4px;
  font-size: 22px;
}

.pg__desc {
  max-width: 560px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.7;
}

.pg__controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pg__select {
  width: 220px;
}

.pg__alert code {
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.25);
  font-size: 12px;
}

.pg__log {
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

.pg__empty {
  margin: auto;
  text-align: center;
}

.pg__empty-title {
  margin-bottom: 10px;
  color: var(--text-faint);
  font-size: 12.5px;
}

.pg__presets {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.pg__preset {
  padding: 7px 13px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition:
    color 0.18s ease,
    border-color 0.18s ease,
    background 0.18s ease;
}

.pg__preset:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.pg__preset:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.msg {
  display: flex;
  max-width: 88%;
  flex-direction: column;
  gap: 4px;
}

.msg--user {
  margin-left: auto;
  align-items: flex-end;
}

.msg__role {
  padding: 0 4px;
  color: var(--text-faint);
  font-size: 11px;
  letter-spacing: 0.06em;
}

.msg__body {
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-elevated);
  font-size: 13.5px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg--user .msg__body {
  border-color: rgba(224, 167, 94, 0.35);
  background: var(--accent-soft);
}

/* 打字光标：只有正在接收的那条会闪 */
.msg__caret {
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

.pg__input {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pg__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pg__stats {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.pg__stats-model {
  color: var(--text-faint);
  opacity: 0.7;
}

@media (max-width: 640px) {
  .pg {
    height: auto;
  }

  .pg__log {
    min-height: 300px;
  }

  .pg__select {
    width: 150px;
  }
}
</style>
