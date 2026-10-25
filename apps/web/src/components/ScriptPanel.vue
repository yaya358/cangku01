<template>
  <article class="script">
    <header class="script__head">
      <div>
        <h2 class="script__title">
          剧本
          <span class="script__count">{{ events.length }} 幕</span>
        </h2>
        <p class="script__hint">
          按轮次推进的小剧本：第 3 轮有人推门进来，第 6 轮掏出一张通缉令。 最后一幕就是本章结局 ——
          演完这一场就结束了。
        </p>
      </div>
    </header>

    <div v-if="loading" class="script__loading">
      <n-spin size="small" />
      <span>正在读取剧本…</span>
    </div>

    <ul v-else-if="events.length > 0" class="acts">
      <li
        v-for="(event, index) in events"
        :key="event.id"
        class="act"
        :class="{ 'act--ending': index === events.length - 1 }"
      >
        <span class="act__turn">第 {{ event.atTurn }} 轮</span>
        <span class="act__title">{{ event.title }}</span>
        <span v-if="index === events.length - 1" class="act__ending">结局</span>
        <span class="act__actions">
          <button class="tool" type="button" @click="edit(event)">改</button>
          <button class="tool tool--danger" type="button" @click="remove(event)">删除</button>
        </span>
        <p class="act__content">{{ event.content }}</p>
      </li>
    </ul>

    <p v-else class="script__empty">
      还没有剧本。加第一幕试试：第 3 轮，「有人推门进来」—— 门被推开，进来的人看见你就愣住了。
    </p>

    <!-- 新增/编辑都用这一行：字段少，不值得再弹一个窗 -->
    <div class="editor">
      <div class="editor__row">
        <n-input-number
          v-model:value="draftTurn"
          :min="1"
          :max="500"
          size="small"
          class="editor__turn"
        />
        <n-input
          v-model:value="draftTitle"
          size="small"
          placeholder="这一幕叫什么（例如：有人推门进来）"
        />
      </div>
      <n-input
        v-model:value="draftContent"
        type="textarea"
        size="small"
        :autosize="{ minRows: 2, maxRows: 5 }"
        placeholder="发生了什么（会被注入上下文，让角色对它做出反应）"
      />
      <div class="editor__foot">
        <span class="editor__tip">
          {{ editingId ? '正在改这一幕' : '轮次 = 玩家第几次发言' }}
        </span>
        <div class="editor__actions">
          <n-button v-if="editingId" size="tiny" @click="resetDraft">取消修改</n-button>
          <n-button size="tiny" type="primary" :loading="saving" @click="save">
            {{ editingId ? '保存' : '加这一幕' }}
          </n-button>
        </div>
      </div>
      <n-alert v-if="error" type="error" :title="error" closable @close="error = null" />
    </div>
  </article>
</template>

<script setup lang="ts">
import type { ScriptEvent } from '@tavern/shared';
import { NAlert, NButton, NInput, NInputNumber, NSpin } from 'naive-ui';
import { onMounted, ref, watch } from 'vue';
import {
  createScriptEvent,
  deleteScriptEvent,
  listScriptEvents,
  updateScriptEvent,
} from '@/api/script';

const props = defineProps<{ characterId: string }>();

const events = ref<ScriptEvent[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

const editingId = ref<string | null>(null);
const draftTurn = ref(3);
const draftTitle = ref('');
const draftContent = ref('');

/** 下一幕默认排在本轮之后，少改一次数字。 */
function nextTurn(): number {
  const last = events.value.at(-1);
  return last ? last.atTurn + 3 : 3;
}

function resetDraft(): void {
  editingId.value = null;
  draftTurn.value = nextTurn();
  draftTitle.value = '';
  draftContent.value = '';
  error.value = null;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    events.value = await listScriptEvents(props.characterId);
    if (editingId.value === null) draftTurn.value = nextTurn();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function edit(event: ScriptEvent): void {
  editingId.value = event.id;
  draftTurn.value = event.atTurn;
  draftTitle.value = event.title;
  draftContent.value = event.content;
}

async function save(): Promise<void> {
  const title = draftTitle.value.trim();
  const content = draftContent.value.trim();
  if (title.length === 0 || content.length === 0) {
    error.value = '标题和内容都要填';
    return;
  }

  saving.value = true;
  error.value = null;
  try {
    const payload = { atTurn: draftTurn.value, title, content };
    if (editingId.value) await updateScriptEvent(editingId.value, payload);
    else await createScriptEvent(props.characterId, payload);

    resetDraft();
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

async function remove(event: ScriptEvent): Promise<void> {
  try {
    await deleteScriptEvent(event.id);
    if (editingId.value === event.id) resetDraft();
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

watch(
  () => props.characterId,
  () => {
    resetDraft();
    void load();
  },
);

onMounted(() => {
  resetDraft();
  void load();
});
</script>

<style scoped>
.script {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}

.script__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.script__count {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
}

.script__hint {
  max-width: 620px;
  margin-top: 6px;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.7;
}

.script__loading,
.script__empty {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.8;
}

.acts {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 8px;
  list-style: none;
}

.act {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 9px;
  background: var(--bg-elevated);
}

.act--ending {
  border-left-color: var(--err);
}

.act__turn {
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11px;
}

.act__title {
  font-size: 12.5px;
  font-weight: 600;
}

.act__ending {
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(217, 118, 95, 0.16);
  color: var(--err);
  font-size: 10.5px;
}

.act__actions {
  display: flex;
  margin-left: auto;
  gap: 6px;
}

.act__content {
  flex-basis: 100%;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.75;
  white-space: pre-wrap;
}

.tool {
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
}

.tool:hover {
  border-color: var(--border-strong);
  color: var(--accent);
}

.tool--danger:hover {
  border-color: rgba(217, 118, 95, 0.6);
  color: var(--err);
}

.editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}

.editor__row {
  display: flex;
  gap: 8px;
}

.editor__turn {
  width: 110px;
  flex-shrink: 0;
}

.editor__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.editor__tip {
  color: var(--text-faint);
  font-size: 11px;
}

.editor__actions {
  display: flex;
  gap: 8px;
}
</style>
