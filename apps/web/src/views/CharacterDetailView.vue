<template>
  <section class="detail">
    <div class="detail__bar">
      <RouterLink class="detail__back" to="/characters">← 返回角色列表</RouterLink>

      <div v-if="character" class="detail__bar-actions">
        <n-button v-if="!editing" size="small" type="primary" ghost @click="startEdit"
          >编辑</n-button
        >
        <template v-else>
          <n-button size="small" @click="cancelEdit">取消</n-button>
          <n-button size="small" type="primary" :loading="saving" @click="save">保存</n-button>
        </template>

        <n-button size="small" type="primary" :loading="startingChat" @click="startChat">
          开始对话
        </n-button>
        <n-button size="small" @click="previewOpen = true">预览上下文</n-button>
        <n-button size="small" :loading="exporting" @click="downloadPng">导出 PNG</n-button>
        <n-button size="small" :loading="exporting" @click="downloadJson">导出 JSON</n-button>

        <n-popconfirm @positive-click="removeCharacter">
          <template #trigger>
            <n-button size="small" type="error" ghost>删除</n-button>
          </template>
          删除后无法恢复（连同头像文件一起删除），确定吗？
        </n-popconfirm>
      </div>
    </div>

    <n-alert
      v-if="error"
      type="error"
      :title="error"
      closable
      class="detail__alert"
      @close="clearError"
    />

    <div v-if="loading" class="detail__loading">
      <n-spin size="small" />
      <span>正在读取角色…</span>
    </div>

    <div v-else-if="!character" class="detail__missing">
      <p class="detail__missing-title">找不到这个角色</p>
      <p class="detail__missing-desc">它可能已经被删除了，或者链接里的 id 不对。</p>
      <RouterLink class="detail__missing-link" to="/characters">回到角色列表</RouterLink>
    </div>

    <template v-else>
      <aside class="sheet">
        <div class="sheet__avatar">
          <img v-if="character.avatarUrl" :src="character.avatarUrl" :alt="character.name" />
          <span v-else class="sheet__initial">{{ character.name.slice(0, 1) }}</span>
        </div>

        <button
          class="sheet__avatar-upload"
          type="button"
          :disabled="uploadingAvatar"
          @click="pickAvatar"
        >
          {{ uploadingAvatar ? '上传中…' : '上传头像' }}
        </button>
        <input
          ref="avatarInputRef"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          @change="onAvatarPicked"
        />

        <h1 class="sheet__name">{{ character.name }}</h1>

        <div class="sheet__meta">
          <div class="sheet__meta-row">
            <span>来源</span>
            <n-tag size="tiny" :bordered="false">{{ SOURCE_LABEL[character.source] }}</n-tag>
          </div>
          <div class="sheet__meta-row">
            <span>卡片规范</span>
            <code>v{{ character.specVersion }}</code>
          </div>
          <div class="sheet__meta-row">
            <span>创建</span>
            <span class="sheet__meta-value">{{ formatDateTime(character.createdAt) }}</span>
          </div>
          <div class="sheet__meta-row">
            <span>更新</span>
            <span class="sheet__meta-value">{{ formatDateTime(character.updatedAt) }}</span>
          </div>
        </div>

        <div v-if="character.tags.length > 0" class="sheet__tags">
          <n-tag v-for="tag in character.tags" :key="tag" size="small" :bordered="false" round>
            {{ tag }}
          </n-tag>
        </div>

        <p class="sheet__hint">
          对话时会用到：人设（description / personality）、场景、开场白、示例对话。 system prompt 与
          post-history instructions 会在上下文引擎里生效。
        </p>
      </aside>

      <div class="content">
        <article class="block">
          <h2 class="block__title">开场白</h2>
          <n-input
            v-if="editing"
            v-model:value="form.firstMes"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 10 }"
          />
          <p v-else class="block__text">{{ character.firstMes || '（还没有开场白）' }}</p>

          <div v-if="character.alternateGreetings.length > 0 || editing" class="block__sub">
            <h3 class="block__subtitle">备选开场白（每行一条）</h3>
            <n-input
              v-if="editing"
              v-model:value="form.alternateGreetings"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 8 }"
            />
            <ul v-else class="greetings">
              <li v-for="(greeting, index) in character.alternateGreetings" :key="index">
                {{ greeting }}
              </li>
            </ul>
          </div>
        </article>

        <article class="block">
          <h2 class="block__title">人设</h2>
          <n-input
            v-if="editing"
            v-model:value="form.description"
            type="textarea"
            :autosize="{ minRows: 4, maxRows: 16 }"
          />
          <p v-else class="block__text">{{ character.description || '（还没有写人设）' }}</p>

          <div class="block__sub">
            <h3 class="block__subtitle">性格</h3>
            <n-input
              v-if="editing"
              v-model:value="form.personality"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 10 }"
            />
            <p v-else class="block__text">{{ character.personality || '（未填写）' }}</p>
          </div>

          <div class="block__sub">
            <h3 class="block__subtitle">场景</h3>
            <n-input
              v-if="editing"
              v-model:value="form.scenario"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 10 }"
            />
            <p v-else class="block__text">{{ character.scenario || '（未填写）' }}</p>
          </div>
        </article>

        <article class="block">
          <h2 class="block__title">示例对话</h2>
          <n-input
            v-if="editing"
            v-model:value="form.mesExample"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 14 }"
          />
          <pre v-else class="block__code">{{ character.mesExample || '（未填写）' }}</pre>
        </article>

        <article class="block">
          <h2 class="block__title">提示词覆盖</h2>
          <div class="block__sub">
            <h3 class="block__subtitle">系统提示（system prompt）</h3>
            <n-input
              v-if="editing"
              v-model:value="form.systemPrompt"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 8 }"
            />
            <p v-else class="block__text">{{ character.systemPrompt || '（使用全局默认）' }}</p>
          </div>

          <div class="block__sub">
            <h3 class="block__subtitle">历史后指令（post-history instructions）</h3>
            <n-input
              v-if="editing"
              v-model:value="form.postHistoryInstructions"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 8 }"
            />
            <p v-else class="block__text">
              {{ character.postHistoryInstructions || '（未填写）' }}
            </p>
          </div>

          <div class="block__sub">
            <h3 class="block__subtitle">作者备注（不参与对话）</h3>
            <n-input
              v-if="editing"
              v-model:value="form.creatorNotes"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 6 }"
            />
            <p v-else class="block__text">{{ character.creatorNotes || '（未填写）' }}</p>
          </div>
        </article>

        <article v-if="editing" class="block">
          <h2 class="block__title">名字与标签</h2>
          <div class="block__sub">
            <h3 class="block__subtitle">名字</h3>
            <n-input v-model:value="form.name" />
          </div>
          <div class="block__sub">
            <h3 class="block__subtitle">标签（用逗号或空格分隔）</h3>
            <n-input v-model:value="form.tags" placeholder="酒馆, 日常" />
          </div>
        </article>

        <!-- 世界书：按关键词注入的设定，聊到这里才生效 -->
        <WorldbookPanel v-if="character" :character-id="character.id" />
      </div>
    </template>

    <!-- 上下文预览：不调模型，只看「这一轮会发给模型什么」 -->
    <ContextPreviewDrawer
      v-if="character"
      v-model:show="previewOpen"
      :character-id="character.id"
      :character-name="character.name"
    />
  </section>
</template>

<script setup lang="ts">
import type { Character, CharacterSource } from '@tavern/shared';
import { NAlert, NButton, NInput, NPopconfirm, NSpin, NTag } from 'naive-ui';
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { updateCharacter, exportCardJson, exportCardPngUrl, uploadAvatar } from '@/api/characters';
import { toAvatarPng } from '@/api/avatar';
import ContextPreviewDrawer from '@/components/ContextPreviewDrawer.vue';
import WorldbookPanel from '@/components/WorldbookPanel.vue';
import { useChatStore } from '@/stores/chat';
import { useCharacterStore } from '@/stores/characters';
import { formatDateTime } from '@/utils/format';

const SOURCE_LABEL: Record<CharacterSource, string> = {
  png: 'PNG 角色卡',
  json: 'JSON 角色卡',
  manual: '手动创建',
};

const route = useRoute();
const router = useRouter();
const store = useCharacterStore();

const character = ref<Character | null>(null);
const loading = ref(false);
const saving = ref(false);
const exporting = ref(false);
/** 上下文预览抽屉 */
const previewOpen = ref(false);
/** 正在创建/打开会话 */
const startingChat = ref(false);
/** 头像上传 */
const avatarInputRef = ref<HTMLInputElement | null>(null);
const uploadingAvatar = ref(false);

function pickAvatar(): void {
  avatarInputRef.value?.click();
}

async function onAvatarPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const current = character.value;
  if (!file || !current) return;

  uploadingAvatar.value = true;
  error.value = null;
  try {
    // 后端只收 PNG：浏览器端统一裁成正方形并转码，用户选 JPEG/照片也能用
    const png = await toAvatarPng(file);
    const updated = await uploadAvatar(current.id, png);
    character.value = updated;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    uploadingAvatar.value = false;
  }
}

/** 开始对话：有历史会话就进最近一个，没有就新建。 */
async function startChat(): Promise<void> {
  const current = character.value;
  if (!current || startingChat.value) return;

  startingChat.value = true;
  try {
    const conversationId = await useChatStore().startWith(current.id);
    if (conversationId) await router.push(`/conversations/${conversationId}`);
    else error.value = useChatStore().error;
  } finally {
    startingChat.value = false;
  }
}
const editing = ref(false);
const error = ref<string | null>(null);

/** 编辑态的表单副本，保存前不动原对象。 */
const form = ref({
  name: '',
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
  mesExample: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  creatorNotes: '',
  tags: '',
  alternateGreetings: '',
});

async function load(): Promise<void> {
  const id = String(route.params.id ?? '');
  loading.value = true;
  error.value = null;
  try {
    character.value = await store.loadOne(id);
  } finally {
    loading.value = false;
  }
}

function startEdit(): void {
  const current = character.value;
  if (!current) return;

  form.value = {
    name: current.name,
    description: current.description,
    personality: current.personality,
    scenario: current.scenario,
    firstMes: current.firstMes,
    mesExample: current.mesExample,
    systemPrompt: current.systemPrompt,
    postHistoryInstructions: current.postHistoryInstructions,
    creatorNotes: current.creatorNotes,
    tags: current.tags.join(', '),
    alternateGreetings: current.alternateGreetings.join('\n'),
  };
  editing.value = true;
}

function cancelEdit(): void {
  editing.value = false;
}

/** 标签输入容忍中英文逗号、空格、分号。 */
function parseTags(input: string): string[] {
  return input
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 20);
}

function parseLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 20);
}

async function save(): Promise<void> {
  const current = character.value;
  if (!current) return;

  saving.value = true;
  error.value = null;
  try {
    const updated = await updateCharacter(current.id, {
      name: form.value.name.trim() || current.name,
      description: form.value.description,
      personality: form.value.personality,
      scenario: form.value.scenario,
      firstMes: form.value.firstMes,
      mesExample: form.value.mesExample,
      systemPrompt: form.value.systemPrompt,
      postHistoryInstructions: form.value.postHistoryInstructions,
      creatorNotes: form.value.creatorNotes,
      tags: parseTags(form.value.tags),
      alternateGreetings: parseLines(form.value.alternateGreetings),
    });

    character.value = updated;
    editing.value = false;
    // 列表页的摘要（名字/标签）也跟着变，回去时不该是旧的
    void store.refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

async function removeCharacter(): Promise<void> {
  const current = character.value;
  if (!current) return;

  const ok = await store.remove(current.id);
  if (ok) await router.push('/characters');
  else error.value = store.error;
}

/** 触发浏览器下载：统一用临时 <a> 点击，避免 window.open 被拦截。 */
function triggerDownload(href: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function downloadPng(): void {
  const current = character.value;
  if (!current) return;
  // 后端已设 content-disposition，这里再指定一次让文件名在本地也可读
  triggerDownload(exportCardPngUrl(current.id), `${current.name}.png`);
}

async function downloadJson(): Promise<void> {
  const current = character.value;
  if (!current) return;

  exporting.value = true;
  error.value = null;
  try {
    const data = await exportCardJson(current.id);
    const blob = new Blob([JSON.stringify(data.card, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, data.filename);
    // 下载已开始，回收对象 URL，避免内存泄漏
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    exporting.value = false;
  }
}

function clearError(): void {
  error.value = null;
  store.clearError();
}

watch(
  () => route.params.id,
  () => {
    editing.value = false;
    void load();
  },
);

onMounted(() => {
  void load();
});
</script>

<style scoped>
.detail {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

.detail__bar {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.detail__back {
  color: var(--text-dim);
  font-size: 12.5px;
}

.detail__back:hover {
  color: var(--accent);
  text-decoration: none;
}

.detail__bar-actions {
  display: flex;
  gap: 8px;
}

.detail__alert {
  grid-column: 1 / -1;
}

.detail__loading {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  gap: 10px;
  padding: 40px;
  color: var(--text-dim);
  font-size: 13px;
}

.detail__missing {
  display: flex;
  grid-column: 1 / -1;
  padding: 60px 24px;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}

.detail__missing-title {
  font-size: 15px;
  font-weight: 600;
}

.detail__missing-desc {
  color: var(--text-dim);
  font-size: 13px;
}

.detail__missing-link {
  margin-top: 8px;
  color: var(--accent);
  font-size: 13px;
}

/* 左侧信息卡 */
.sheet {
  display: flex;
  padding: 16px;
  flex-direction: column;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.sheet__avatar {
  display: grid;
  overflow: hidden;
  height: 160px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: linear-gradient(150deg, #2a2118, #16120f);
}

.sheet__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sheet__initial {
  font-family: var(--font-mono);
  font-size: 52px;
  color: var(--border-strong);
}

.sheet__avatar-upload {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  cursor: pointer;
}

.sheet__avatar-upload:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--accent);
}

.sheet__avatar-upload:disabled {
  cursor: progress;
  opacity: 0.6;
}

.sheet__name {
  font-size: 17px;
  line-height: 1.4;
}

.sheet__meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sheet__meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-faint);
  font-size: 11.5px;
}

.sheet__meta-value {
  color: var(--text-dim);
}

.sheet__meta-row code {
  color: var(--accent);
}

.sheet__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.sheet__hint {
  padding-top: 10px;
  border-top: 1px dashed var(--border);
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.7;
}

/* 右侧内容 */
.content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.block {
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.block__title {
  margin-bottom: 10px;
  font-size: 13px;
  letter-spacing: 0.04em;
  color: var(--accent);
}

.block__sub {
  margin-top: 14px;
}

.block__subtitle {
  margin-bottom: 6px;
  color: var(--text-faint);
  font-size: 11.5px;
  font-weight: 500;
}

.block__text {
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.block__code {
  max-height: 260px;
  margin: 0;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-soft);
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.greetings {
  margin: 0;
  padding-left: 18px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.8;
}

@media (max-width: 860px) {
  .detail {
    grid-template-columns: 1fr;
  }

  .sheet__avatar {
    height: 200px;
  }
}
</style>
