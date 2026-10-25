<template>
  <article class="script">
    <header class="script__head">
      <div>
        <h2 class="script__title">
          剧本
          <span class="script__count">{{ events.length }} 幕</span>
        </h2>
        <p class="script__hint">
          按轮次推进的小剧本：第 3 轮有人推门进来，第 6 轮掏出一张通缉令。 标了「结局」的那一幕演完，
          这一场就结束。
        </p>
      </div>

      <div class="script__tools">
        <n-button size="tiny" :disabled="events.length === 0 || busy" @click="doExport">
          导出剧本
        </n-button>
        <n-button size="tiny" :loading="busy" @click="pickImport">导入剧本</n-button>
        <input
          ref="importInputRef"
          type="file"
          accept="application/json,.json"
          hidden
          @change="onImportPicked"
        />
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
        <span v-if="event.isEnding" class="act__ending">结局</span>
        <span v-if="event.condition" class="act__cond">需提到：{{ event.condition }}</span>
        <span class="act__actions">
          <button class="tool" type="button" @click="edit(event)">改</button>
          <button class="tool tool--danger" type="button" @click="remove(event)">删除</button>
        </span>
        <p class="act__content">{{ event.content }}</p>
        <p v-if="event.sets" class="act__sets">触发后记住：{{ event.sets }}</p>
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

      <!-- 条件与结局：条件让「说到才发生」，结局让这一场能收尾 -->
      <div class="editor__row">
        <n-input
          v-model:value="draftCondition"
          size="small"
          placeholder="触发条件（可选，逗号分隔；空=到轮次就发生）"
        />
        <label class="toggle">
          <n-switch v-model:value="draftEnding" size="small" />
          <span>这一幕是结局</span>
        </label>
      </div>

      <n-input
        v-model:value="draftSets"
        size="small"
        placeholder="触发后记住什么（可选，例如：他已经承认那晚他睡着了）"
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
  exportScript,
  importScript,
  listScriptEvents,
  updateScriptEvent,
} from '@/api/script';

const props = defineProps<{ characterId: string }>();

const events = ref<ScriptEvent[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
/** 导出/导入进行中 */
const busy = ref(false);
const importInputRef = ref<HTMLInputElement | null>(null);

const editingId = ref<string | null>(null);
const draftTurn = ref(3);
const draftTitle = ref('');
const draftContent = ref('');
/** 条件关键词（逗号分隔）；空 = 到轮次就触发 */
const draftCondition = ref('');
/** 这一幕是结局 */
const draftEnding = ref(false);
/** 触发后写入的剧情事实 */
const draftSets = ref('');

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
  draftCondition.value = '';
  draftEnding.value = false;
  draftSets.value = '';
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
  draftCondition.value = event.condition;
  draftEnding.value = event.isEnding;
  draftSets.value = event.sets;
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
    const payload = {
      atTurn: draftTurn.value,
      title,
      content,
      condition: draftCondition.value.trim(),
      isEnding: draftEnding.value,
      sets: draftSets.value.trim(),
    };
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

/** 导出成 JSON 文件（浏览器里自己下载，不经后端中转）。 */
async function doExport(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const { filename, bundle } = await exportScript(props.characterId);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

function pickImport(): void {
  importInputRef.value?.click();
}

/** 导入：接受 {events:[...]} 或直接的数组，宽松一点更好用。 */
async function onImportPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  busy.value = true;
  error.value = null;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { events?: unknown[] })?.events ?? null;
    if (!Array.isArray(list) || list.length === 0) {
      error.value = '这个文件里没有剧本（需要 events 数组）';
      return;
    }
    const result = await importScript(props.characterId, list as Record<string, unknown>[]);
    await load();
    error.value = null;
    alert(`已导入 ${result.imported} 幕`);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
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

.script__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.script__tools {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
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

.act__cond {
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(224, 167, 94, 0.14);
  color: var(--warn);
  font-size: 10.5px;
}

.act__sets {
  flex-basis: 100%;
  color: var(--warn);
  font-size: 11px;
  line-height: 1.7;
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

.toggle {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
  font-size: 11.5px;
  white-space: nowrap;
}
</style>
