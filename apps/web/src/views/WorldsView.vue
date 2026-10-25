<!--
  世界（题材）页：四个世界包各自一张卡，选一个进去或者开一本新的。

  为什么要单独一页：题材以前塞在「存档」面板里，和存档条目混在一起；
  四个世界的场景又全挤在对话页的同一张场景表里 —— 玩家的原话是「看着多乱」。
  现在题材是导航上的独立入口，对话页的场景也按世界分组。
-->
<template>
  <section class="worlds">
    <header class="worlds__head">
      <div>
        <h1 class="worlds__title">世界</h1>
        <p class="worlds__sub">
          一套题材 = 一个场景 + 一队人 + 三章谜题。挑一个进去；已有的书会标出进度。
        </p>
      </div>
      <n-button size="small" :loading="loading" @click="load">刷新</n-button>
    </header>

    <n-alert v-if="error" type="error" :title="error" closable @close="error = null" />

    <div class="worlds__grid">
      <article v-for="card in cards" :key="card.theme.id" class="world-card">
        <header class="world-card__head">
          <h2 class="world-card__name">{{ card.theme.name }}</h2>
          <span v-if="card.save" class="world-card__chapter">第 {{ card.save.chapter }} 章</span>
          <span v-else class="world-card__fresh">还没开局</span>
        </header>

        <p class="world-card__tag">{{ card.theme.tagline }}</p>

        <ul class="world-card__cast">
          <li v-for="person in card.cast" :key="person.name" class="cast-chip">
            <img
              v-if="person.avatarUrl"
              class="cast-chip__avatar"
              :src="person.avatarUrl"
              :alt="person.name"
              loading="lazy"
            />
            <span v-else class="cast-chip__initial">{{ person.name.slice(0, 1) }}</span>
            <span class="cast-chip__name">{{ person.name }}</span>
          </li>
        </ul>

        <ol class="world-card__mysteries">
          <li v-for="mystery in card.theme.mysteries" :key="mystery.title">
            <span class="world-card__mystery-title">{{ mystery.title }}</span>
            <span class="world-card__mystery-q">{{ mystery.question }}</span>
          </li>
        </ol>

        <div class="world-card__actions">
          <n-button
            v-if="card.save"
            type="primary"
            size="small"
            :disabled="!card.entrySceneId"
            @click="enter(card)"
          >
            继续
          </n-button>
          <n-button size="small" :loading="starting === card.theme.id" @click="start(card)">
            {{ card.save ? '再开一本' : '开局' }}
          </n-button>
          <!-- 每个世界自己的存档 / 读档 / 重开 -->
          <WorldActions v-if="card.save" :save="card.save" @changed="load" />
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NAlert, NButton } from 'naive-ui';
import type { Save, WorldTheme } from '@tavern/shared';
import { WORLD_THEMES, characterAvatarEndpoint } from '@tavern/shared';
import { fetchCharacters } from '@/api/characters';
import { createSave, listAllScenes, listSaves } from '@/api/world';
import type { SceneListItem } from '@/api/world';
import WorldActions from '@/components/WorldActions.vue';
import { describeError } from '@/utils/errors';

const router = useRouter();

const loading = ref(false);
const error = ref<string | null>(null);
const starting = ref<string | null>(null);
const saves = ref<Save[]>([]);
const scenes = ref<SceneListItem[]>([]);
const avatarByName = ref<Map<string, string>>(new Map());

interface WorldCard {
  theme: WorldTheme;
  save: Save | null;
  entrySceneId: string | null;
  cast: { name: string; avatarUrl: string | null }[];
}

/**
 * 每个题材一张卡：找到同题材的存档就标进度，并给出「继续」要进的场景。
 *
 * 一个题材可能被开过好几本，这里取最近更新的那本 —— 卡片只有一行进度，
 * 其它几本仍然可以在「存档」面板里找到。
 */
const cards = computed<WorldCard[]>(() =>
  WORLD_THEMES.map((theme) => {
    const candidates = saves.value
      .filter((save) => save.theme === theme.id)
      .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
    const save = candidates[0] ?? null;

    const ownScenes = save
      ? scenes.value
          .filter((scene) => scene.saveId === save.id)
          .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))
      : [];
    const entry = ownScenes.find((scene) => scene.kind === 'public') ?? ownScenes[0] ?? null;

    return {
      theme,
      save,
      entrySceneId: entry?.id ?? null,
      cast: theme.cast.map((person) => ({
        name: person.name,
        avatarUrl: avatarByName.value.get(person.name) ?? null,
      })),
    };
  }),
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [saveList, sceneList, characters] = await Promise.all([
      listSaves(),
      listAllScenes(),
      fetchCharacters({ limit: 200 }),
    ]);
    saves.value = saveList;
    scenes.value = sceneList;
    avatarByName.value = new Map(
      characters.items.map((item) => [
        item.name,
        item.avatarUrl ? characterAvatarEndpoint(item.id) : '',
      ]),
    );
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    loading.value = false;
  }
}

function enter(card: WorldCard): void {
  if (!card.entrySceneId) return;
  void router.push(`/scenes/${card.entrySceneId}`);
}

/** 开局：按题材建一本新书（同名就加序号，免得两本「雾岭村」分不清） */
async function start(card: WorldCard): Promise<void> {
  starting.value = card.theme.id;
  error.value = null;
  try {
    const sameName = saves.value.filter((save) => save.name === card.theme.name).length;
    const name = sameName === 0 ? card.theme.name : `${card.theme.name} ${sameName + 1}`;
    const started = await createSave({ name, theme: card.theme.id });
    await router.push(`/scenes/${started.scene.id}`);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    starting.value = null;
  }
}

onMounted(() => {
  void load();
});
</script>

<style scoped>
.worlds {
  display: flex;
  padding: 28px 32px 40px;
  flex-direction: column;
  gap: 16px;
}

.worlds__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.worlds__title {
  margin: 0 0 4px;
  font-size: 22px;
}

.worlds__sub {
  margin: 0;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.7;
}

.worlds__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}

.world-card {
  display: flex;
  padding: 16px;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background:
    radial-gradient(120% 90% at 0% 0%, rgba(224, 167, 94, 0.08), transparent 60%),
    linear-gradient(170deg, var(--bg-elevated), var(--bg-soft));
}

.world-card__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.world-card__name {
  margin: 0;
  font-size: 16px;
}

.world-card__chapter {
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(224, 167, 94, 0.14);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.world-card__fresh {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.world-card__tag {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.75;
}

.world-card__cast {
  display: flex;
  margin: 0;
  padding: 0;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
}

.cast-chip {
  display: flex;
  padding: 2px 8px 2px 2px;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.03);
}

.cast-chip__avatar,
.cast-chip__initial {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.cast-chip__initial {
  display: grid;
  place-items: center;
  background: var(--bg-soft);
  color: var(--text-dim);
  font-size: 10px;
}

.cast-chip__name {
  font-size: 11px;
}

.world-card__mysteries {
  display: flex;
  margin: 0;
  padding-left: 16px;
  flex-direction: column;
  gap: 4px;
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.6;
}

.world-card__mystery-title {
  color: var(--text);
}

.world-card__mystery-q {
  margin-left: 6px;
}

.world-card__actions {
  display: flex;
  margin-top: auto;
  padding-top: 4px;
  gap: 8px;
}
</style>
