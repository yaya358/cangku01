<template>
  <n-drawer :show="show" :width="640" placement="right" @update:show="onUpdateShow">
    <n-drawer-content :title="`上下文预览 · ${characterName}`" closable>
      <div class="preview">
        <section class="block">
          <div class="block__row">
            <n-input
              v-model:value="draft"
              placeholder="试一句用户输入，看会触发什么"
              :disabled="loading"
              @keydown.enter="refresh"
            />
            <n-button type="primary" :loading="loading" @click="refresh">生成预览</n-button>
          </div>

          <label class="toggle">
            <n-switch v-model:value="tight" size="small" :disabled="loading" />
            <span>压测模式（把上下文窗口压到 600 token，观察裁剪行为）</span>
          </label>
        </section>

        <n-alert v-if="error" type="error" :title="error" closable @close="error = null" />

        <div v-if="loading" class="loading">
          <n-spin size="small" />
          <span>正在组装…</span>
        </div>

        <template v-else-if="preview">
          <!-- 预算 -->
          <section class="block">
            <h3 class="block__title">预算</h3>
            <div class="budget">
              <div class="budget__bar">
                <div
                  class="budget__used"
                  :class="{ 'budget__used--warn': preview.budget.truncated }"
                  :style="{ width: `${usedPercent}%` }"
                ></div>
              </div>
              <div class="budget__meta">
                <span>已用 {{ preview.budget.used }} tokens</span>
                <span>可用 {{ preview.budget.available }}</span>
                <span
                  >窗口 {{ preview.budget.contextWindow }} － 输出预留
                  {{ preview.budget.reservedForOutput }} － 余量
                  {{ preview.budget.safetyMargin }}</span
                >
              </div>
            </div>

            <ul v-if="preview.notes.length > 0" class="notes">
              <li v-for="note in preview.notes" :key="note">{{ note }}</li>
            </ul>
          </section>

          <!-- 组成 -->
          <section class="block">
            <h3 class="block__title">组成占比</h3>
            <ul class="breakdown">
              <li v-for="item in preview.breakdown" :key="item.kind" class="breakdown__item">
                <span class="breakdown__label">{{ KIND_LABEL[item.kind] ?? item.kind }}</span>
                <span class="breakdown__track">
                  <span
                    class="breakdown__fill"
                    :class="`breakdown__fill--${item.kind}`"
                    :style="{ width: `${Math.max(2, item.ratio * 100)}%` }"
                  ></span>
                </span>
                <span class="breakdown__value">{{ item.tokens }}</span>
                <span class="breakdown__ratio">{{ Math.round(item.ratio * 100) }}%</span>
              </li>
            </ul>
          </section>

          <!-- 世界书命中 -->
          <section class="block">
            <h3 class="block__title">世界书命中</h3>
            <p v-if="preview.worldbook.length === 0" class="muted">
              这一轮没有条目被触发（换个说法，或加一条常驻条目试试）
            </p>
            <div v-else class="hits">
              <n-tag
                v-for="hit in preview.worldbook"
                :key="hit.id"
                size="small"
                round
                :bordered="false"
              >
                {{ hit.title }} ← {{ hit.keyword }}
              </n-tag>
            </div>
          </section>

          <!-- 层 -->
          <section class="block">
            <h3 class="block__title">分层明细（{{ preview.layers.length }} 层）</h3>
            <details v-for="layer in preview.layers" :key="layer.id" class="layer">
              <summary class="layer__head">
                <span class="layer__kind" :class="`layer__kind--${layer.kind}`">
                  {{ KIND_LABEL[layer.kind] ?? layer.kind }}
                </span>
                <span class="layer__title">{{ layer.title }}</span>
                <span class="layer__tokens">{{ layer.tokens }} t</span>
              </summary>
              <pre class="layer__content">{{ layer.content }}</pre>
            </details>

            <details v-if="preview.dropped.length > 0" class="layer layer--dropped">
              <summary class="layer__head">
                <span class="layer__kind layer__kind--dropped">被裁掉</span>
                <span class="layer__title">{{ preview.dropped.length }} 层因预算不足被丢弃</span>
              </summary>
              <pre
                v-for="layer in preview.dropped"
                :key="layer.id"
                class="layer__content layer__content--dropped"
                >{{ layer.title }}（{{ layer.tokens }} t）\n{{ layer.content }}</pre>
            </details>
          </section>

          <!-- 最终消息 -->
          <section class="block">
            <h3 class="block__title">最终发给模型的消息（{{ preview.messages.length }} 条）</h3>
            <article
              v-for="(message, index) in preview.messages"
              :key="index"
              class="message"
              :class="`message--${message.role}`"
            >
              <span class="message__role">{{ ROLE_LABEL[message.role] ?? message.role }}</span>
              <p class="message__body">{{ message.content }}</p>
            </article>
          </section>
        </template>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import type { ContextPreviewPayload } from '@tavern/shared';
import { NAlert, NButton, NDrawer, NDrawerContent, NInput, NSpin, NSwitch, NTag } from 'naive-ui';
import { computed, ref, watch } from 'vue';
import { previewContext } from '@/api/context';

const props = defineProps<{
  show: boolean;
  characterId: string;
  characterName: string;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const KIND_LABEL: Record<string, string> = {
  system: '系统',
  persona: '人设',
  scenario: '场景',
  motive: '秘密目的',
  worldbook: '世界书',
  summary: '摘要',
  history: '历史',
  post_history: '后置指令',
  user_input: '本轮输入',
};

const ROLE_LABEL: Record<string, string> = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
};

const draft = ref('你们家有什么招牌？');
const tight = ref(false);
const loading = ref(false);
const preview = ref<ContextPreviewPayload | null>(null);
const error = ref<string | null>(null);

const usedPercent = computed(() => {
  if (!preview.value) return 0;
  const { used, available } = preview.value.budget;
  return Math.min(100, Math.round((used / Math.max(1, available)) * 100));
});

async function refresh(): Promise<void> {
  const text = draft.value.trim();
  if (text.length === 0) return;

  loading.value = true;
  error.value = null;
  try {
    preview.value = await previewContext({
      characterId: props.characterId,
      messages: [{ role: 'user', content: text }],
      userName: '旅人',
      ...(tight.value
        ? { budget: { contextWindow: 600, reservedForOutput: 200, safetyMargin: 40 } }
        : {}),
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function onUpdateShow(value: boolean): void {
  emit('update:show', value);
}

// 抽屉打开时才请求，避免每次进详情页都白跑一次组装
watch(
  () => props.show,
  (visible) => {
    if (visible && preview.value === null) void refresh();
  },
);
</script>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.block__row {
  display: flex;
  gap: 8px;
}

.block__title {
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--accent);
}

.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-faint);
  font-size: 11.5px;
}

.toggle span {
  line-height: 1.5;
}

.loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px 0;
  color: var(--text-dim);
  font-size: 12.5px;
}

.muted {
  color: var(--text-faint);
  font-size: 12px;
}

/* 预算条 */
.budget {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.budget__bar {
  overflow: hidden;
  height: 8px;
  border-radius: 999px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
}

.budget__used {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s ease;
}

.budget__used--warn {
  background: var(--warn);
}

.budget__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
}

.notes {
  margin: 0;
  padding-left: 16px;
  color: var(--warn);
  font-size: 11.5px;
  line-height: 1.7;
}

/* 占比条 */
.breakdown {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 5px;
  list-style: none;
}

.breakdown__item {
  display: grid;
  grid-template-columns: 62px 1fr 42px 34px;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}

.breakdown__label {
  color: var(--text-dim);
}

.breakdown__track {
  overflow: hidden;
  height: 6px;
  border-radius: 999px;
  background: var(--bg-soft);
}

.breakdown__fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--border-strong);
}

.breakdown__fill--system {
  background: #7b8fa8;
}

.breakdown__fill--persona {
  background: #e0a75e;
}

.breakdown__fill--scenario {
  background: #b98c5a;
}

.breakdown__fill--motive {
  background: #c9603f;
}

.breakdown__fill--worldbook {
  background: #8ab48a;
}

.breakdown__fill--history {
  background: #7f7ba8;
}

.breakdown__fill--user_input {
  background: #d9765f;
}

.breakdown__value,
.breakdown__ratio {
  color: var(--text-faint);
  font-family: var(--font-mono);
  text-align: right;
}

.hits {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 层 */
.layer {
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-soft);
}

.layer--dropped {
  border-color: rgba(217, 118, 95, 0.4);
}

.layer__head {
  display: flex;
  padding: 8px 10px;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
  list-style: none;
}

.layer__head::-webkit-details-marker {
  display: none;
}

.layer__kind {
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-dim);
  font-size: 10.5px;
  white-space: nowrap;
}

.layer__kind--dropped {
  background: rgba(217, 118, 95, 0.16);
  color: var(--err);
}

.layer__title {
  flex: 1;
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layer__tokens {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.layer__content {
  max-height: 260px;
  margin: 0;
  overflow: auto;
  padding: 0 10px 10px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.layer__content--dropped {
  opacity: 0.65;
}

/* 最终消息 */
.message {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-elevated);
}

.message--system {
  border-left: 3px solid #7b8fa8;
}

.message--user {
  border-left: 3px solid var(--accent);
}

.message__role {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.message__body {
  margin-top: 4px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
