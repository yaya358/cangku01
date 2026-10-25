<!--
  存档面板：一个存档 = 一本故事。

  为什么要它：之前存档是「隐式」的 —— 库里就一个世界，玩家既不能挑、也不能重来，
  玩一半想换条路只能去改数据库。这里把三件事摆出来：
  · 载入：回到某本故事最近待的地方
  · 重新开始：同一本故事、同样的名字和在场的人，进度清零
  · 删除：整本丢掉（场景、对话、主线、好感一起走）
-->
<template>
  <n-modal
    :show="show"
    preset="card"
    class="save-panel"
    title="存档"
    :style="{ width: 'min(680px, 92vw)' }"
    @update:show="emit('update:show', $event)"
  >
    <p class="save-panel__hint">每本书自己走自己的主线。关掉页面不会丢 —— 下次点「载入」接着演。</p>

    <!-- 换题材：一套题材 = 一个场景 + 一队人 + 三章谜题，都是现成的 -->
    <section class="themes">
      <p class="themes__head">换个世界</p>
      <div class="themes__grid">
        <button
          v-for="theme in themes"
          :key="theme.id"
          class="theme-card"
          type="button"
          :disabled="creating"
          @click="createTheme(theme)"
        >
          <span class="theme-card__name">{{ theme.name }}</span>
          <span class="theme-card__tag">{{ theme.tagline }}</span>
          <span class="theme-card__go">开局 →</span>
        </button>
      </div>
    </section>

    <n-spin :show="loading">
      <ul v-if="slots.length > 0" class="save-list">
        <li
          v-for="slot in slots"
          :key="slot.save.id"
          class="save-item"
          :class="{ 'save-item--current': slot.save.id === currentSaveId }"
        >
          <div class="save-item__main">
            <div class="save-item__row">
              <span class="save-item__name">{{ slot.save.name }}</span>
              <span class="save-item__theme">{{ themeNameOf(slot.save.theme) }}</span>
              <span class="save-item__chapter">第 {{ slot.save.chapter }} 章</span>
              <span v-if="slot.save.id === currentSaveId" class="save-item__badge">正在玩</span>
            </div>
            <p class="save-item__meta">
              {{ slot.sceneCount }} 个场景 · {{ slot.messageCount }} 句对话 · 最近
              {{ relativeTime(slot.updatedAt) }}
              <template v-if="slot.lastScene">在「{{ slot.lastScene.name }}」</template>
            </p>
          </div>

          <div class="save-item__actions">
            <n-button size="tiny" type="primary" :disabled="!slot.entrySceneId" @click="load(slot)">
              载入
            </n-button>

            <n-popconfirm
              positive-text="重新开始"
              negative-text="算了"
              @positive-click="restart(slot)"
            >
              <template #trigger>
                <n-button size="tiny" :disabled="restarting === slot.save.id">重新开始</n-button>
              </template>
              「{{ slot.save.name }}」会从头演：场景、对话、情报、好感全部清空，
              名字和原来在场的人留着。这一步不能撤销。
            </n-popconfirm>

            <n-popconfirm positive-text="删除" negative-text="取消" @positive-click="remove(slot)">
              <template #trigger>
                <n-button size="tiny" quaternary type="error" :disabled="removing === slot.save.id">
                  删除
                </n-button>
              </template>
              删掉「{{ slot.save.name }}」这本书？场景、对话、情报都会没，不能撤销。
            </n-popconfirm>
          </div>
        </li>
      </ul>

      <n-empty v-if="!loading && slots.length === 0" description="还没有存档，下面建一个" />
    </n-spin>

    <div class="save-panel__new">
      <n-input
        v-model:value="newName"
        size="small"
        placeholder="新存档叫什么？（比如「第二遍」「另一条路」）"
        :maxlength="40"
        @keydown.enter="create"
      />
      <n-button size="small" type="primary" :loading="creating" @click="create">新建存档</n-button>
    </div>

    <n-alert
      v-if="error"
      type="error"
      :title="error"
      closable
      class="save-panel__error"
      @close="error = null"
    />
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NAlert, NButton, NEmpty, NInput, NModal, NPopconfirm, NSpin } from 'naive-ui';
import type { Save, WorldTheme } from '@tavern/shared';
import { WORLD_THEMES, themeById } from '@tavern/shared';
import { fetchCharacters } from '@/api/characters';
import type { SceneListItem } from '@/api/world';
import { createSave, listAllScenes, listSaves, removeSave, restartSave } from '@/api/world';
import { describeError } from '@/utils/errors';
import { relativeTime } from '@/utils/format';

const props = defineProps<{ show: boolean; currentSaveId?: string | null }>();
const emit = defineEmits<{ 'update:show': [boolean]; changed: [] }>();

const router = useRouter();

interface SaveSlot {
  save: Save;
  sceneCount: number;
  messageCount: number;
  updatedAt: string;
  lastScene: SceneListItem | null;
  /** 载入时进哪个场景：优先公开场景，其次最近有动静的 */
  entrySceneId: string | null;
}

const loading = ref(false);
const creating = ref(false);
const restarting = ref<string | null>(null);
const removing = ref<string | null>(null);
const error = ref<string | null>(null);
const newName = ref('');
const saves = ref<Save[]>([]);
const scenes = ref<SceneListItem[]>([]);

/** 可选题材：月灯镇 / 雾岭村 / 长夜号 / 灰塔学院 */
const themes = WORLD_THEMES;

function themeNameOf(themeId: string): string {
  return themeById(themeId).name;
}

const slots = computed<SaveSlot[]>(() =>
  saves.value.map((save) => {
    const own = scenes.value.filter((scene) => scene.saveId === save.id);
    const sorted = [...own].sort((left, right) =>
      left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0,
    );
    const entry = sorted.find((scene) => scene.kind === 'public') ?? sorted[0] ?? null;
    return {
      save,
      sceneCount: own.length,
      messageCount: own.reduce((total, scene) => total + scene.messageCount, 0),
      updatedAt: sorted[0]?.updatedAt ?? save.updatedAt,
      lastScene: sorted[0] ?? null,
      entrySceneId: entry?.id ?? null,
    };
  }),
);

async function loadSlots(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [saveList, sceneList] = await Promise.all([listSaves(), listAllScenes()]);
    saves.value = saveList;
    scenes.value = sceneList;
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.show,
  (open) => {
    if (open) void loadSlots();
  },
);

function load(slot: SaveSlot): void {
  if (!slot.entrySceneId) return;
  emit('update:show', false);
  void router.push(`/scenes/${slot.entrySceneId}`);
}

async function restart(slot: SaveSlot): Promise<void> {
  restarting.value = slot.save.id;
  error.value = null;
  try {
    const started = await restartSave(slot.save.id);
    await loadSlots();
    emit('changed');
    emit('update:show', false);
    await router.push(`/scenes/${started.scene.id}`);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    restarting.value = null;
  }
}

async function remove(slot: SaveSlot): Promise<void> {
  removing.value = slot.save.id;
  error.value = null;
  try {
    await removeSave(slot.save.id);
    await loadSlots();
    emit('changed');
    // 删掉的正是当前这本：留在原地会看到一堆 404，干脆回对话页
    if (slot.save.id === props.currentSaveId) await router.push('/conversations');
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    removing.value = null;
  }
}

/**
 * 开一个题材世界。
 *
 * 场景名、在场的人、三章谜题都由世界包决定 —— 前端只递一个 theme id，
 * 内容全在 shared 里，加题材不用改这里。
 */
async function createTheme(theme: WorldTheme): Promise<void> {
  creating.value = true;
  error.value = null;
  try {
    const started = await createSave({ name: theme.name, theme: theme.id });
    await loadSlots();
    emit('changed');
    emit('update:show', false);
    await router.push(`/scenes/${started.scene.id}`);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    creating.value = false;
  }
}

/**
 * 新建一本故事。
 *
 * 默认把前几个角色放进酒馆 —— 空场景里连开场旁白都生成不出来（没人在场），
 * 新存档一进去就该有人站着。
 */
async function create(): Promise<void> {
  const name = newName.value.trim() || '另一条路';
  creating.value = true;
  error.value = null;
  try {
    const characters = await fetchCharacters({ limit: 12 });
    const cast = characters.items.slice(0, 3).map((item) => item.id);
    const started = await createSave({
      name,
      sceneName: '月灯酒馆',
      ...(cast.length > 0 ? { characterIds: cast } : {}),
    });
    newName.value = '';
    await loadSlots();
    emit('changed');
    emit('update:show', false);
    await router.push(`/scenes/${started.scene.id}`);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    creating.value = false;
  }
}
</script>

<style scoped>
.save-panel__hint {
  margin-bottom: 12px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.7;
}

.save-list {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 8px;
  list-style: none;
}

/* 换个世界：四张题材卡 */
.themes {
  margin-bottom: 14px;
}

.themes__head {
  margin-bottom: 8px;
  color: var(--text-dim);
  font-size: 11.5px;
  letter-spacing: 0.04em;
}

.themes__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: 8px;
}

.theme-card {
  display: flex;
  padding: 10px 11px;
  align-items: flex-start;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: linear-gradient(160deg, var(--bg-soft), rgba(224, 167, 94, 0.04));
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition:
    border-color 0.16s ease,
    transform 0.16s ease;
}

.theme-card:hover:not(:disabled) {
  border-color: rgba(224, 167, 94, 0.5);
  transform: translateY(-1px);
}

.theme-card:disabled {
  cursor: progress;
  opacity: 0.6;
}

.theme-card__name {
  font-size: 13px;
  font-weight: 600;
}

.theme-card__tag {
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.55;
}

.theme-card__go {
  margin-top: 2px;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.save-item__theme {
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-dim);
  font-size: 10.5px;
}

.save-item {
  display: flex;
  padding: 10px 12px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-soft);
}

.save-item--current {
  border-color: rgba(224, 167, 94, 0.45);
  background: rgba(224, 167, 94, 0.06);
}

.save-item__main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.save-item__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.save-item__name {
  font-size: 13.5px;
  font-weight: 600;
}

.save-item__chapter {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11px;
}

.save-item__badge {
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(224, 167, 94, 0.16);
  color: var(--accent);
  font-size: 10.5px;
}

.save-item__meta {
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.6;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.save-item__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
}

.save-panel__new {
  display: flex;
  margin-top: 14px;
  gap: 8px;
}

.save-panel__error {
  margin-top: 12px;
}
</style>
