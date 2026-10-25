<template>
  <section
    class="chars"
    :class="{ 'chars--dragging': dragging }"
    @dragover.prevent="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <header class="chars__head">
      <div>
        <h1 class="chars__title">角色</h1>
        <p class="chars__desc">
          把角色卡 PNG（或 JSON）拖进来就能导入。角色卡里存着人设、开场白和示例对话，
          后面的对话会按这些设定来扮演。
        </p>
      </div>

      <div class="chars__actions">
        <n-input
          :value="search"
          placeholder="搜索名字或设定…"
          clearable
          size="small"
          class="chars__search"
          @update:value="onSearch"
        />
        <n-button size="small" @click="createOpen = true">新建</n-button>
        <n-button type="primary" size="small" :loading="importing" @click="pickFile">
          {{ importing ? '导入中…' : '导入角色卡' }}
        </n-button>
        <input
          ref="fileInputRef"
          type="file"
          accept=".png,.json,image/png,application/json"
          hidden
          @change="onFilePicked"
        />
      </div>
    </header>

    <n-alert
      v-if="error"
      type="error"
      :title="error"
      closable
      class="chars__alert"
      @close="store.clearError()"
    />

    <div v-if="dragging" class="chars__drop">
      <span class="chars__drop-mark" aria-hidden="true">🍺</span>
      <p>松手即可导入这张角色卡</p>
    </div>

    <div v-if="loading && items.length === 0" class="chars__loading">
      <n-spin size="small" />
      <span>正在读取角色…</span>
    </div>

    <div v-else-if="isEmpty && !hasSearch" class="chars__empty">
      <p class="chars__empty-title">还没有角色</p>
      <p class="chars__empty-desc">
        可以拖一张角色卡 PNG 进来、点「导入角色卡」，或者自己填一份设定。
      </p>

      <div class="chars__empty-actions">
        <n-button type="primary" size="small" :loading="importing" @click="seedSamples">
          补回 8 个内置示例角色
        </n-button>
        <n-button size="small" @click="createOpen = true">自己新建一个</n-button>
      </div>

      <p class="chars__empty-hint">
        示例角色（含头像）会在首次启动时自动写入；这里是把它们重新补回来的入口。
        每个示例都演示一种写法：话痨老板、寡言巡夜人、只说「喵」的猫……
        导入后点「开始对话」就能聊，也可以照着它们的写法自己造一张。
      </p>
    </div>

    <div v-else-if="isEmpty && hasSearch" class="chars__empty">
      <p class="chars__empty-title">没有匹配的角色</p>
      <p class="chars__empty-desc">换个关键词试试，或清空搜索框。</p>
    </div>

    <div v-else class="chars__grid">
      <RouterLink
        v-for="character in items"
        :key="character.id"
        class="card"
        :to="`/characters/${character.id}`"
      >
        <div class="card__avatar">
          <img
            v-if="character.avatarUrl"
            :src="character.avatarUrl"
            :alt="character.name"
            loading="lazy"
          />
          <span v-else class="card__initial">{{ character.name.slice(0, 1) }}</span>
        </div>

        <div class="card__body">
          <div class="card__title-row">
            <h2 class="card__name">{{ character.name }}</h2>
            <n-tag
              size="tiny"
              :bordered="false"
              :type="character.hasGreeting ? 'success' : 'default'"
            >
              {{ character.hasGreeting ? '有开场白' : '无开场白' }}
            </n-tag>
          </div>

          <p class="card__excerpt">{{ character.excerpt || '（还没有写设定）' }}</p>

          <div class="card__foot">
            <span class="card__tags">
              <span v-for="tag in character.tags.slice(0, 3)" :key="tag" class="card__tag">{{
                tag
              }}</span>
            </span>
            <span class="card__source">{{ SOURCE_LABEL[character.source] }}</span>
          </div>
        </div>
      </RouterLink>
    </div>

    <footer class="chars__foot">
      <span>共 {{ total }} 个角色</span>
      <span class="chars__foot-sep">·</span>
      <span>支持 V1 / V2 / V3 卡片，也支持带压缩文本块（zTXt）的图</span>
    </footer>

    <CharacterCreateModal v-model:show="createOpen" @created="onCreate" />
  </section>
</template>

<script setup lang="ts">
import type { CharacterSource } from '@tavern/shared';
import { NAlert, NButton, NInput, NSpin, NTag } from 'naive-ui';
import { storeToRefs } from 'pinia';
import { onMounted, ref } from 'vue';
import CharacterCreateModal from '@/components/CharacterCreateModal.vue';
import { useCharacterStore } from '@/stores/characters';

const SOURCE_LABEL: Record<CharacterSource, string> = {
  png: '来自 PNG',
  json: '来自 JSON',
  manual: '手动创建',
};

const store = useCharacterStore();
const { items, total, search, loading, importing, error, isEmpty, hasSearch } = storeToRefs(store);

const fileInputRef = ref<HTMLInputElement | null>(null);
const createOpen = ref(false);
const dragging = ref(false);
/** dragleave 在子元素间移动时会连发，用计数避免闪烁 */
let dragDepth = 0;

function pickFile(): void {
  fileInputRef.value?.click();
}

async function onFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = ''; // 允许重复选同一个文件
  await importFiles(files);
}

async function importFiles(files: File[]): Promise<void> {
  for (const file of files) {
    await store.importFile(file);
  }
}

function onDragOver(): void {
  dragDepth += 1;
  dragging.value = true;
}

function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}

async function onDrop(event: DragEvent): Promise<void> {
  dragDepth = 0;
  dragging.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length > 0) await importFiles(files);
}

function onSearch(value: string): void {
  store.setSearch(value);
}

/** 补回内置示例角色（服务端播种，幂等）。 */
async function seedSamples(): Promise<void> {
  await store.seedSamples();
}

/** 新建成功后关掉弹窗并刷新列表（store 里已经刷过了）。 */
function onCreate(): void {
  createOpen.value = false;
}

onMounted(() => {
  void store.refresh();
});
</script>

<style scoped>
.chars {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 60vh;
}

.chars--dragging {
  outline: 2px dashed var(--accent);
  outline-offset: 12px;
  border-radius: var(--radius);
}

.chars__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}

.chars__title {
  margin-bottom: 6px;
  font-size: 24px;
}

.chars__desc {
  max-width: 520px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.7;
}

.chars__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chars__search {
  width: 200px;
}

.chars__alert {
  margin-bottom: 2px;
}

.chars__drop {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: grid;
  place-content: center;
  gap: 8px;
  border-radius: var(--radius);
  background: rgba(18, 16, 14, 0.86);
  color: var(--accent);
  text-align: center;
  font-size: 14px;
  backdrop-filter: blur(2px);
}

.chars__drop-mark {
  font-size: 34px;
}

.chars__loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 32px;
  color: var(--text-dim);
  font-size: 13px;
}

.chars__empty {
  display: flex;
  padding: 56px 24px;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  text-align: center;
}

.chars__empty-title {
  font-size: 15px;
  font-weight: 600;
}

.chars__empty-desc {
  color: var(--text-dim);
  font-size: 13px;
}

.chars__empty-hint {
  max-width: 460px;
  margin-top: 6px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.7;
}

.chars__empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
}

.chars__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 12px;
}

.card {
  display: flex;
  overflow: hidden;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: linear-gradient(170deg, var(--bg-elevated), var(--bg-soft));
  color: inherit;
  text-decoration: none;
  transition:
    border-color 0.18s ease,
    transform 0.18s ease;
}

.card:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
  text-decoration: none;
}

/* 头像是方形胸像：给一块方形的舞台，别用横幅裁掉半张脸 */
.card__avatar {
  display: grid;
  height: 152px;
  place-items: center;
  border-bottom: 1px solid var(--border);
  background:
    radial-gradient(120% 90% at 50% 0%, rgba(224, 167, 94, 0.1), transparent 70%),
    linear-gradient(150deg, #2a2118, #16120f);
}

.card__avatar img {
  width: 120px;
  height: 120px;
  border: 1px solid var(--border-strong);
  border-radius: 22px;
  object-fit: cover;
}

.card__initial {
  font-family: var(--font-mono);
  font-size: 40px;
  color: var(--border-strong);
}

.card__body {
  display: flex;
  padding: 12px 14px 14px;
  flex: 1;
  flex-direction: column;
  gap: 8px;
}

.card__title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card__name {
  overflow: hidden;
  font-size: 14.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__excerpt {
  display: -webkit-box;
  overflow: hidden;
  flex: 1;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.6;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card__tags {
  display: flex;
  overflow: hidden;
  gap: 4px;
}

.card__tag {
  padding: 1px 7px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  color: var(--text-dim);
  font-size: 10.5px;
  white-space: nowrap;
}

.card__source {
  color: var(--text-faint);
  font-size: 10.5px;
  white-space: nowrap;
}

.chars__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  padding-top: 8px;
  color: var(--text-faint);
  font-size: 11.5px;
}

.chars__foot-sep {
  color: var(--border-strong);
}

@media (max-width: 640px) {
  .chars__actions {
    width: 100%;
  }

  .chars__search {
    flex: 1;
    width: auto;
  }
}
</style>
