<template>
  <section class="conv">
    <header class="conv__head">
      <div>
        <h1 class="conv__title">对话</h1>
        <p class="conv__sub">
          挑一个人接着说，或者开一段新的。每段对话的记录都在库里，关掉页面也不会丢。
        </p>
        <p class="conv__sub conv__sub--dim">
          「进入酒馆」走世界模式：说话的地方是一个场景，能接话的是此刻在场的人 ——
          人来人往，不在场的人不会突然回你。下面这些是按角色开的旧对话，仍然能接着聊。
        </p>
      </div>
      <div class="conv__actions">
        <n-button size="small" :loading="entering" @click="enterTavern">进入酒馆</n-button>
        <n-button size="small" @click="savesOpen = true">存档</n-button>
        <n-button type="primary" size="small" @click="pickerOpen = true">新对话</n-button>
      </div>
    </header>

    <n-alert v-if="enterError" type="error" :title="enterError" closable @close="enterError = null">
      <p class="conv__hint">进不去不影响旧对话 —— 你可以先用下面的列表接着聊。</p>
    </n-alert>

    <n-input
      v-model:value="keyword"
      size="small"
      placeholder="搜角色名或消息内容…"
      clearable
      class="conv__search"
    />

    <p class="conv__legacy">
      老入口还在：
      <button class="conv__legacy-btn" type="button" @click="hallOpen = true">旧版酒馆大厅</button>
      —— 挑几个人同场轮流接话，等价于「进一个场景」，保留是为了兼容旧记录。
    </p>

    <!-- 场景：世界模式的入口。按世界分组 —— 四个题材的场景混在一张表里太乱 -->
    <section v-if="sceneGroups.length > 0" class="scenes">
      <div class="scenes__head">
        <h2 class="scenes__title">场景</h2>
        <span class="scenes__hint">按世界分开；点进去就是那个地方 —— 在场的人才会接你的话</span>
      </div>

      <div v-for="group in sceneGroups" :key="group.saveId" class="scene-group">
        <div class="scene-group__head">
          <span class="scene-group__name">{{ group.saveName }}</span>
          <span class="scene-group__theme">{{ group.themeName }}</span>
          <span class="scene-group__meta">
            第 {{ group.chapter }} 章 · {{ group.scenes.length }} 个场景
          </span>
        </div>

        <ul class="scene-list">
          <li v-for="item in group.scenes" :key="item.id">
            <RouterLink class="scene-item" :to="`/scenes/${item.id}`">
              <span class="scene-item__badge" :class="`scene-item__badge--${item.kind}`">
                {{ item.kind === 'private' ? '私聊' : '公开' }}
              </span>

              <span class="scene-item__main">
                <span class="scene-item__row">
                  <span class="scene-item__name">{{ item.name }}</span>
                  <span class="scene-item__time">{{ relativeTime(item.updatedAt) }}</span>
                </span>
                <span class="scene-item__row">
                  <span class="scene-item__preview">{{ item.preview || '（还没有人开口）' }}</span>
                  <span v-if="item.messageCount > 0" class="chat-item__badge">
                    {{ item.messageCount }}
                  </span>
                </span>
                <span class="scene-item__people">
                  {{ item.presentCount }} 人在场
                  <template v-if="item.presentNames.length > 0">
                    （{{ item.presentNames.join('、') }}）
                  </template>
                </span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </div>
    </section>

    <div v-if="loading" class="conv__loading">
      <n-spin size="small" />
      <span>正在读取对话…</span>
    </div>

    <p v-else-if="filtered.length === 0 && keyword.trim().length > 0" class="conv__empty">
      没有匹配的对话。
    </p>

    <div v-else-if="list.length === 0" class="conv__empty">
      <p>还没有按角色的旧对话。</p>
      <p class="conv__empty-hint">
        点右上「进入酒馆」去场景里说话；或者用「新对话」挑一个角色单独聊。
      </p>
    </div>

    <ul v-else class="chat-list">
      <li v-for="item in filtered" :key="item.id">
        <RouterLink class="chat-item" :to="`/conversations/${item.id}`">
          <span class="chat-item__avatar">
            <img :src="avatarOf(item.characterId)" :alt="item.characterName" />
          </span>

          <span class="chat-item__main">
            <span class="chat-item__row">
              <span class="chat-item__name">{{ item.characterName }}</span>
              <span class="chat-item__time">{{ relativeTime(item.updatedAt) }}</span>
            </span>
            <span class="chat-item__row">
              <span class="chat-item__preview">{{ item.preview || '（还没有消息）' }}</span>
              <span v-if="item.messageCount > 1" class="chat-item__badge">
                {{ item.messageCount }}
              </span>
            </span>
            <span v-if="hasPlayer(item)" class="chat-item__role">
              你是 {{ item.player.name || '无名' }}
              <template v-if="item.player.role">· {{ item.player.role }}</template>
            </span>
          </span>

          <button
            class="chat-item__delete"
            type="button"
            title="删除这段对话"
            @click.prevent.stop="remove(item.id)"
          >
            ✕
          </button>
        </RouterLink>
      </li>
    </ul>

    <!-- 新对话：先选角色，再选身份 -->
    <n-modal
      v-model:show="pickerOpen"
      preset="card"
      title="和谁聊"
      :style="{ width: '560px', maxWidth: '92vw' }"
      :bordered="false"
    >
      <div v-if="characters.length === 0" class="conv__empty">
        还没有角色，先去<RouterLink to="/characters">角色页</RouterLink>建一个。
      </div>

      <ul v-else class="picker">
        <li v-for="character in characters" :key="character.id">
          <button class="picker__item" type="button" @click="startWith(character)">
            <span class="chat-item__avatar">
              <img :src="avatarOf(character.id)" :alt="character.name" />
            </span>
            <span class="picker__main">
              <span class="picker__name">{{ character.name }}</span>
              <span class="picker__excerpt">{{ character.excerpt }}</span>
            </span>
          </button>
        </li>
      </ul>
    </n-modal>

    <!-- 酒馆大厅：挑几个角色同时在场（旧入口，世界模式请用「进入酒馆」） -->
    <n-modal
      v-model:show="hallOpen"
      preset="card"
      title="旧版酒馆大厅"
      :style="{ width: '560px', maxWidth: '92vw' }"
      :bordered="false"
    >
      <p class="conv__hint">
        选几个角色一起在场。他们按轮次轮流接话，你还可以用 @名字 指定谁先说。
        这条老入口没有「在场/离开」，新剧情请用「进入酒馆」。
      </p>

      <ul class="picker">
        <li v-for="character in characters" :key="character.id">
          <label class="picker__item picker__item--check">
            <input v-model="hallMembers" type="checkbox" :value="character.id" />
            <span class="chat-item__avatar">
              <img :src="avatarOf(character.id)" :alt="character.name" />
            </span>
            <span class="picker__main">
              <span class="picker__name">{{ character.name }}</span>
              <span class="picker__excerpt">{{ character.excerpt }}</span>
            </span>
          </label>
        </li>
      </ul>

      <template #footer>
        <div class="conv__actions conv__actions--end">
          <n-button size="small" @click="hallOpen = false">取消</n-button>
          <n-button
            size="small"
            type="primary"
            :disabled="hallMembers.length < 2"
            @click="openHall"
          >
            带 {{ hallMembers.length }} 个人进大厅
          </n-button>
        </div>
      </template>
    </n-modal>

    <!-- 选完角色再定身份：这一场你是谁 -->
    <PlayerIdentityModal
      v-model:show="identityOpen"
      :saving="starting"
      confirm-text="开始这一场"
      @submit="onIdentitySubmit"
    />

    <!-- 存档：载入 / 重新开始 / 删除 / 新建 -->
    <SavePanel v-model:show="savesOpen" @changed="loadAll" />
  </section>
</template>

<script setup lang="ts">
import type { CharacterSummary, Conversation, Player, Save } from '@tavern/shared';
import { characterAvatarEndpoint, themeById } from '@tavern/shared';
import { NAlert, NButton, NInput, NModal, NSpin } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { fetchCharacters } from '@/api/characters';
import { ensureDefaultScene, listAllScenes, listSaves } from '@/api/world';
import type { SceneListItem } from '@/api/world';
import { useChatStore } from '@/stores/chat';
import { describeError } from '@/utils/errors';
import PlayerIdentityModal from '@/components/PlayerIdentityModal.vue';
import SavePanel from '@/components/SavePanel.vue';

const router = useRouter();
const store = useChatStore();

const list = ref<Conversation[]>([]);
/** 场景列表：世界模式的入口，也是迁移过来的旧对话的去处 */
const scenes = ref<SceneListItem[]>([]);
/** 存档（= 一个世界）：用来给场景分组，并显示各自的题材 */
const saves = ref<Save[]>([]);
const characters = ref<CharacterSummary[]>([]);
const loading = ref(false);
const keyword = ref('');

const pickerOpen = ref(false);
/** 存档面板：载入 / 重开 / 删除 / 新建 */
const savesOpen = ref(false);
/** 大厅：勾选在场角色 */
const hallOpen = ref(false);
const hallMembers = ref<string[]>([]);
/** 大厅待定的身份提交 */
const pendingHall = ref(false);
const identityOpen = ref(false);
const starting = ref(false);
/** 选中但要等身份确认的角色 */
const pending = ref<CharacterSummary | null>(null);
/** 进入酒馆：正在找/建场景 */
const entering = ref(false);
const enterError = ref<string | null>(null);

function avatarOf(characterId: string): string {
  return characterAvatarEndpoint(characterId);
}

function hasPlayer(item: Conversation): boolean {
  return Boolean(item.player.name || item.player.role || item.player.goal);
}

/** 微信式相对时间：今天显示时刻，昨天显示"昨天"，更早显示日期。 */
function relativeTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '';

  const now = new Date();
  const sameDay =
    time.getFullYear() === now.getFullYear() &&
    time.getMonth() === now.getMonth() &&
    time.getDate() === now.getDate();
  if (sameDay) {
    return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    time.getFullYear() === yesterday.getFullYear() &&
    time.getMonth() === yesterday.getMonth() &&
    time.getDate() === yesterday.getDate()
  ) {
    return '昨天';
  }

  return `${time.getMonth() + 1}/${time.getDate()}`;
}

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  if (text.length === 0) return list.value;
  return list.value.filter(
    (item) =>
      item.characterName.toLowerCase().includes(text) || item.preview.toLowerCase().includes(text),
  );
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    // 会话列表与角色列表一起拉：前者要显示预览，后者给「新对话」挑人
    const [conversations, characterList] = await Promise.all([
      store.loadListAll(),
      fetchCharacters({ limit: 50 }),
    ]);
    list.value = conversations;
    characters.value = characterList.items;
  } finally {
    loading.value = false;
  }
}

/** 场景列表读失败不该挡住页面：旧对话还能接着聊 */
async function loadScenes(): Promise<void> {
  try {
    const [sceneList, saveList] = await Promise.all([listAllScenes(), listSaves()]);
    scenes.value = sceneList;
    saves.value = saveList;
  } catch {
    scenes.value = [];
    saves.value = [];
  }
}

/**
 * 场景按世界分组。
 *
 * 四个题材的场景混在一张表里，看起来就是「喜堂」「货舱层」「旧图书室」「酒馆」
 * 乱七八糟排一排 —— 玩家分不清哪几个是自己的。分组之后一个世界一块。
 */
const sceneGroups = computed(() => {
  const groups = new Map<
    string,
    {
      saveId: string;
      saveName: string;
      themeName: string;
      chapter: number;
      scenes: SceneListItem[];
    }
  >();

  for (const save of saves.value) {
    groups.set(save.id, {
      saveId: save.id,
      saveName: save.name,
      themeName: themeById(save.theme).name,
      chapter: save.chapter,
      scenes: [],
    });
  }

  for (const scene of scenes.value) {
    const group = groups.get(scene.saveId);
    if (group) {
      group.scenes.push(scene);
      continue;
    }
    // 没在存档列表里的场景（理论上不会有）也给它一个自己的组，别丢
    groups.set(scene.saveId, {
      saveId: scene.saveId,
      saveName: scene.saveName,
      themeName: '未知世界',
      chapter: 0,
      scenes: [scene],
    });
  }

  return [...groups.values()]
    .filter((group) => group.scenes.length > 0)
    .sort((left, right) => {
      const newest = (items: SceneListItem[]): string =>
        items.reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), '');
      return newest(right.scenes) > newest(left.scenes) ? 1 : -1;
    });
});

function startWith(character: CharacterSummary): void {
  pending.value = character;
  pickerOpen.value = false;
  identityOpen.value = true;
}

/**
 * 进入酒馆：世界模式的入口。
 *
 * 第一次点进来可能什么都还没有 —— 那就当场建一个存档（顺手把几个角色放进去），
 * 而不是把人推到一个「没有场景」的死胡同里。
 */
async function enterTavern(): Promise<void> {
  if (entering.value) return;
  entering.value = true;
  enterError.value = null;
  try {
    const sceneId = await ensureDefaultScene();
    if (!sceneId) {
      enterError.value = '还没有可以进的场景：先去角色页放几个人进来，再点一次。';
      return;
    }
    await router.push(`/scenes/${sceneId}`);
  } catch (cause) {
    enterError.value = describeError(cause);
  } finally {
    entering.value = false;
  }
}

/** 打开大厅：先勾人，再定身份 */
function openHall(): void {
  if (hallMembers.value.length < 2) return;
  pendingHall.value = true;
  hallOpen.value = false;
  identityOpen.value = true;
}

async function onIdentitySubmit(player: Player): Promise<void> {
  const character = pending.value;
  if (starting.value) return;

  // 大厅模式：成员已经在勾选时定了
  if (pendingHall.value) {
    starting.value = true;
    try {
      const hallId = await store.startHall(hallMembers.value, player);
      if (hallId) {
        identityOpen.value = false;
        pendingHall.value = false;
        await router.push(`/conversations/${hallId}`);
      }
    } finally {
      starting.value = false;
    }
    return;
  }

  if (!character) return;

  starting.value = true;
  try {
    const conversationId = await store.startWithPlayer(character.id, player);
    if (conversationId) {
      identityOpen.value = false;
      await router.push(`/conversations/${conversationId}`);
    }
  } finally {
    starting.value = false;
  }
}

async function remove(id: string): Promise<void> {
  if (!confirm('删除这段对话？角色与世界书不受影响。')) return;
  const ok = await store.removeConversation(id);
  if (ok) list.value = list.value.filter((item) => item.id !== id);
}

/** 存档里改过东西（重开/删除/新建）之后，两边的列表都得重新拉一遍 */
function loadAll(): void {
  void load();
  void loadScenes();
}

onMounted(() => {
  void load();
  void loadScenes();
});
</script>

<style scoped>
.conv {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.conv__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.conv__title {
  font-size: 20px;
}

.conv__sub {
  max-width: 560px;
  margin-top: 6px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.7;
}

.conv__search {
  max-width: 320px;
}

.conv__loading,
.conv__empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text-faint);
  font-size: 12.5px;
  line-height: 1.8;
}

.conv__loading {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.conv__empty-hint {
  font-size: 11.5px;
}

.chat-list {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 2px;
  list-style: none;
}

.chat-item {
  display: flex;
  padding: 10px 12px;
  align-items: center;
  gap: 12px;
  border-radius: 10px;
  color: inherit;
  text-decoration: none;
}

.chat-item:hover {
  background: var(--bg-soft);
  text-decoration: none;
}

.chat-item__avatar {
  display: grid;
  overflow: hidden;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-elevated);
}

.chat-item__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.chat-item__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.chat-item__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chat-item__name {
  color: var(--text);
  font-size: 13.5px;
  font-weight: 600;
}

.chat-item__time {
  margin-left: auto;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.chat-item__preview {
  overflow: hidden;
  flex: 1;
  color: var(--text-faint);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-item__badge {
  padding: 0 7px;
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 16px;
}

.chat-item__role {
  color: var(--accent);
  font-size: 11px;
}

.chat-item__delete {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
}

.chat-item:hover .chat-item__delete {
  opacity: 1;
}

.chat-item__delete:hover {
  background: rgba(217, 118, 95, 0.16);
  color: var(--err);
}

.picker {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 4px;
  list-style: none;
}

.picker__item {
  display: flex;
  width: 100%;
  padding: 8px;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.picker__item:hover {
  background: var(--bg-soft);
}

.picker__main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.picker__name {
  color: var(--text);
  font-size: 13px;
}

.picker__excerpt {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv__actions {
  display: flex;
  gap: 8px;
}

.conv__actions--end {
  justify-content: flex-end;
}

.conv__hint {
  margin-bottom: 10px;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.7;
}

/* 世界模式入口的说明：比正文弱一档，别抢标题 */
.conv__sub--dim {
  color: var(--text-faint);
  opacity: 0.85;
}

.conv__legacy {
  color: var(--text-faint);
  font-size: 11.5px;
}

.conv__legacy-btn {
  padding: 1px 6px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
  cursor: pointer;
}

.conv__legacy-btn:hover {
  border-color: var(--border-strong);
  color: var(--accent);
}

/* 场景列表：世界模式的入口。比旧对话列表更显眼 —— 它才是现在的主线 */
.scenes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: linear-gradient(180deg, var(--bg-soft), var(--bg));
}

.scenes__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.scenes__title {
  font-size: 14px;
}

.scenes__hint {
  color: var(--text-faint);
  font-size: 11px;
}

/* 一个世界一块：标题行把它和别的题材隔开，免得四本书的场景连成一片 */
.scene-group + .scene-group {
  margin-top: 14px;
}

.scene-group__head {
  display: flex;
  margin-bottom: 4px;
  padding-bottom: 5px;
  align-items: baseline;
  gap: 8px;
  border-bottom: 1px dashed var(--border);
}

.scene-group__name {
  font-size: 13px;
  font-weight: 600;
}

.scene-group__theme {
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(224, 167, 94, 0.12);
  color: var(--accent);
  font-size: 10.5px;
}

.scene-group__meta {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.scene-list {
  display: grid;
  margin: 0;
  padding: 0;
  gap: 2px;
  list-style: none;
}

.scene-item {
  display: flex;
  padding: 8px 10px;
  align-items: flex-start;
  gap: 10px;
  border-radius: 10px;
  color: inherit;
  text-decoration: none;
}

.scene-item:hover {
  background: var(--bg-elevated);
  text-decoration: none;
}

.scene-item__badge {
  flex-shrink: 0;
  padding: 0 7px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 9.5px;
  line-height: 18px;
}

/* 私聊用琥珀色：一眼分得清「当众」和「只有你们」 */
.scene-item__badge--private {
  border-color: rgba(224, 167, 94, 0.45);
  color: var(--accent);
}

.scene-item__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.scene-item__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.scene-item__name {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.scene-item__time {
  margin-left: auto;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.scene-item__preview {
  overflow: hidden;
  flex: 1;
  color: var(--text-faint);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scene-item__people {
  color: var(--accent);
  font-size: 11px;
  opacity: 0.85;
}

.picker__item--check {
  gap: 10px;
}
</style>
