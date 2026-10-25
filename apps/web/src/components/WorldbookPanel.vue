<template>
  <article class="wb">
    <header class="wb__head">
      <div>
        <h2 class="wb__title">
          世界书
          <span class="wb__count">{{ entries.length }}</span>
        </h2>
        <p class="wb__hint">
          只有提到关键词时才注入对应设定 —— 既省 token，也避免无关设定把对话带跑偏。
          常驻条目每轮都会带上，适合放世界总纲。
        </p>
      </div>
      <n-button size="small" type="primary" @click="openCreate">新增条目</n-button>
    </header>

    <div v-if="loading" class="wb__loading">
      <n-spin size="small" />
      <span>正在读取条目…</span>
    </div>

    <p v-else-if="entries.length === 0" class="wb__empty">
      还没有条目。试试加一条：标题「月光麦酒」，关键词「招牌酒、月光麦酒」， 内容写这酒的味道和后果
      —— 之后只要对话里提到关键词，它就会自动生效。
    </p>

    <ul v-else class="wb__list">
      <li
        v-for="entry in entries"
        :key="entry.id"
        class="entry"
        :class="{ 'entry--off': !entry.enabled }"
      >
        <div class="entry__head">
          <span class="entry__title">{{ entry.title }}</span>

          <n-tag v-if="entry.constant" size="tiny" :bordered="false" type="warning">常驻</n-tag>
          <n-tag v-if="!entry.characterId" size="tiny" :bordered="false">全局</n-tag>
          <n-tag v-if="!entry.enabled" size="tiny" :bordered="false" type="error">已停用</n-tag>
          <n-tag v-if="entry.priority !== 0" size="tiny" :bordered="false">
            优先级 {{ entry.priority }}
          </n-tag>

          <span class="entry__actions">
            <button class="tool" type="button" @click="openEdit(entry)">编辑</button>
            <button class="tool" type="button" @click="toggleEnabled(entry)">
              {{ entry.enabled ? '停用' : '启用' }}
            </button>
            <button class="tool tool--danger" type="button" @click="remove(entry)">删除</button>
          </span>
        </div>

        <p class="entry__keys">
          <template v-if="entry.constant">不看关键词，每轮注入</template>
          <template v-else-if="entry.keys.length === 0">（没有关键词，这条永远不会触发）</template>
          <template v-else>关键词：{{ entry.keys.join('、') }}</template>
          <template v-if="entry.secondaryKeys.length > 0">
            ＋ 需同时出现：{{ entry.secondaryKeys.join('、') }}
          </template>
        </p>

        <p class="entry__content">{{ entry.content || '（内容为空）' }}</p>
      </li>
    </ul>

    <n-modal
      v-model:show="editorOpen"
      preset="card"
      :title="editingId ? '编辑条目' : '新增条目'"
      :style="{ width: '620px', maxWidth: '92vw' }"
      :bordered="false"
    >
      <div class="form">
        <label class="field">
          <span class="field__label">标题 <em>*</em></span>
          <n-input v-model:value="form.title" placeholder="例如：月光麦酒" maxlength="120" />
        </label>

        <label class="field">
          <span class="field__label">关键词（逗号或空格分隔，命中任意一个即触发）</span>
          <n-input
            v-model:value="form.keys"
            placeholder="月光麦酒, 招牌酒, 最烈的酒"
            :disabled="form.constant"
          />
        </label>

        <label class="field">
          <span class="field__label">次要关键词（可选，填了要求与关键词同时出现）</span>
          <n-input v-model:value="form.secondaryKeys" placeholder="酒" :disabled="form.constant" />
        </label>

        <label class="field">
          <span class="field__label">内容（注入到上下文里的正文）</span>
          <n-input
            v-model:value="form.content"
            type="textarea"
            :autosize="{ minRows: 4, maxRows: 10 }"
            placeholder="用月光草酿成，入口是晒暖的麦芽香，三杯之后灯就灭了。"
          />
        </label>

        <div class="form__row">
          <label class="field">
            <span class="field__label">优先级（越大越先保留）</span>
            <n-input-number v-model:value="form.priority" :min="-1000" :max="1000" />
          </label>
          <label class="field">
            <span class="field__label">归属</span>
            <n-select v-model:value="form.scope" :options="SCOPE_OPTIONS" />
          </label>
        </div>

        <div class="form__switches">
          <label class="switch">
            <n-switch v-model:value="form.constant" size="small" />
            <span>常驻（不看关键词，每轮都注入）</span>
          </label>
          <label class="switch">
            <n-switch v-model:value="form.caseSensitive" size="small" />
            <span>区分大小写</span>
          </label>
          <label class="switch">
            <n-switch v-model:value="form.enabled" size="small" />
            <span>启用</span>
          </label>
        </div>

        <n-alert v-if="error" type="error" :title="error" closable @close="error = null" />
      </div>

      <template #footer>
        <div class="form__footer">
          <span class="form__tip">只填标题也能保存，之后再补关键词。</span>
          <div class="form__actions">
            <n-button size="small" :disabled="saving" @click="editorOpen = false">取消</n-button>
            <n-button size="small" type="primary" :loading="saving" @click="save">保存</n-button>
          </div>
        </div>
      </template>
    </n-modal>
  </article>
</template>

<script setup lang="ts">
import type { WorldbookEntryDto } from '@tavern/shared';
import { NAlert, NButton, NInput, NInputNumber, NModal, NSelect, NSpin, NTag } from 'naive-ui';
import { onMounted, reactive, ref, watch } from 'vue';
import {
  createWorldbookEntry,
  deleteWorldbookEntry,
  listWorldbook,
  updateWorldbookEntry,
} from '@/api/worldbook';

const props = defineProps<{ characterId: string }>();

const SCOPE_OPTIONS = [
  { label: '仅本角色', value: 'character' },
  { label: '全局（所有角色共享）', value: 'global' },
];

const entries = ref<WorldbookEntryDto[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

const editorOpen = ref(false);
const editingId = ref<string | null>(null);

const form = reactive({
  title: '',
  keys: '',
  secondaryKeys: '',
  content: '',
  priority: 0,
  scope: 'character' as 'character' | 'global',
  constant: false,
  caseSensitive: false,
  enabled: true,
});

/** 关键词输入容忍中英文逗号、顿号、空格、分号。 */
function parseKeywords(input: string): string[] {
  const unique = new Set(
    input
      .split(/[,，、;；\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
  return [...unique].slice(0, 32);
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    entries.value = await listWorldbook(props.characterId);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    loading.value = false;
  }
}

function resetForm(): void {
  form.title = '';
  form.keys = '';
  form.secondaryKeys = '';
  form.content = '';
  form.priority = 0;
  form.scope = 'character';
  form.constant = false;
  form.caseSensitive = false;
  form.enabled = true;
  error.value = null;
}

function openCreate(): void {
  editingId.value = null;
  resetForm();
  editorOpen.value = true;
}

function openEdit(entry: WorldbookEntryDto): void {
  editingId.value = entry.id;
  form.title = entry.title;
  form.keys = entry.keys.join('、');
  form.secondaryKeys = entry.secondaryKeys.join('、');
  form.content = entry.content;
  form.priority = entry.priority;
  form.scope = entry.characterId ? 'character' : 'global';
  form.constant = entry.constant;
  form.caseSensitive = entry.caseSensitive;
  form.enabled = entry.enabled;
  error.value = null;
  editorOpen.value = true;
}

async function save(): Promise<void> {
  if (form.title.trim().length === 0) {
    error.value = '标题不能为空';
    return;
  }

  saving.value = true;
  error.value = null;

  const payload = {
    title: form.title.trim(),
    keys: form.constant ? [] : parseKeywords(form.keys),
    secondaryKeys: form.constant ? [] : parseKeywords(form.secondaryKeys),
    content: form.content,
    characterId: form.scope === 'character' ? props.characterId : null,
    constant: form.constant,
    caseSensitive: form.caseSensitive,
    priority: form.priority,
    enabled: form.enabled,
  };

  try {
    if (editingId.value) await updateWorldbookEntry(editingId.value, payload);
    else await createWorldbookEntry(payload);

    editorOpen.value = false;
    await load();
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(entry: WorldbookEntryDto): Promise<void> {
  try {
    await updateWorldbookEntry(entry.id, { enabled: !entry.enabled });
    await load();
  } catch (cause) {
    error.value = describeError(cause);
  }
}

async function remove(entry: WorldbookEntryDto): Promise<void> {
  try {
    await deleteWorldbookEntry(entry.id);
    await load();
  } catch (cause) {
    error.value = describeError(cause);
  }
}

watch(
  () => props.characterId,
  () => {
    void load();
  },
);

onMounted(() => {
  void load();
});
</script>

<style scoped>
.wb {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}

.wb__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.wb__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.wb__count {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
}

.wb__hint {
  max-width: 620px;
  margin-top: 6px;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.7;
}

.wb__loading,
.wb__empty {
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.8;
}

.wb__loading {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wb__list {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 10px;
  list-style: none;
}

.entry {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 9px;
  background: var(--bg-elevated);
}

.entry--off {
  border-left-color: var(--border-strong);
  opacity: 0.6;
}

.entry__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.entry__title {
  margin-right: 4px;
  font-size: 13px;
  font-weight: 600;
}

.entry__actions {
  display: flex;
  margin-left: auto;
  gap: 6px;
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

.entry__keys {
  margin-top: 4px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
}

.entry__content {
  margin-top: 6px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-wrap;
}

/* 编辑器 */
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field__label {
  color: var(--text-faint);
  font-size: 11.5px;
}

.field__label em {
  color: var(--err);
  font-style: normal;
}

.form__switches {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.switch {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
  font-size: 12px;
}

.form__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.form__tip {
  color: var(--text-faint);
  font-size: 11px;
}

.form__actions {
  display: flex;
  gap: 8px;
}
</style>
