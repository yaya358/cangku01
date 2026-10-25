<template>
  <section class="scene">
    <header class="scene__head">
      <!-- 私聊场景：回去要把人一起带回去，所以不是普通链接而是动作。
           迁移过来的旧私聊没有来源场景，回不去，就退回普通入口。 -->
      <button
        v-if="isPrivate && scene?.sourceSceneId"
        class="scene__back scene__back--action"
        type="button"
        :disabled="leaving"
        @click="goBack"
      >
        ← 回到{{ sourceSceneName || '刚才的地方' }}
      </button>
      <RouterLink v-else class="scene__back" to="/conversations">← 对话</RouterLink>

      <div v-if="scene" class="scene__who">
        <h1 class="scene__name">{{ scene.name }}</h1>
        <p class="scene__sub">
          <span class="scene__place">{{ placeText }}</span>
          · 第 {{ turn }} 轮 · {{ messages.length }} 条消息
        </p>
      </div>

      <div class="scene__actions">
        <button class="tool" type="button" :disabled="loading || streaming" @click="reload">
          刷新现场
        </button>
      </div>
    </header>

    <div v-if="loading && !scene" class="scene__loading">
      <n-spin size="small" />
      <span>正在进入场景…</span>
    </div>

    <!-- 进不去（场景被删、后端没起）：说清为什么，并给一条回去的路 -->
    <n-alert
      v-else-if="error && !scene"
      type="error"
      :title="error"
      closable
      @close="store.clearError()"
    >
      <p class="scene__fail">
        这个场景可能已经不在了。回<RouterLink to="/conversations">对话列表</RouterLink>重新进酒馆。
      </p>
    </n-alert>

    <template v-else-if="scene">
      <div class="scene__body">
        <!-- 左：主线。你此刻要弄明白什么、该去找谁 -->
        <aside class="side side--left">
          <p class="side__head">主线</p>
          <template v-if="journal?.quest">
            <p class="quest__chapter">第 {{ journal.chapter }} 章</p>
            <p class="quest__title">{{ journal.quest.title }}</p>
            <p v-if="focusName" class="quest__focus">找：{{ focusName }}</p>
            <p class="quest__progress">
              情报 {{ journal.progress?.clues ?? 0 }}/{{ journal.progress?.needed ?? 0 }}
              <span v-if="(journal.progress?.requiredAffinity ?? 0) > 0">
                · 好感 {{ journal.progress?.affinity ?? 0 }}/{{
                  journal.progress?.requiredAffinity
                }}
              </span>
            </p>

            <!-- 下一步：说清差什么、找谁 —— 打开就知道该干嘛 -->
            <p v-if="journal.progress?.nextStep" class="quest__next">
              {{ journal.progress.nextStep }}
            </p>

            <!-- 不知道说什么时，至少先把「对谁说」摆好 -->
            <div v-if="focusName" class="quest__actions">
              <button
                class="tool"
                type="button"
                :disabled="streaming"
                title="在输入框里填上 @他，剩下的你想说什么就说什么"
                @click="addressFocus(false)"
              >
                @{{ focusName }}
              </button>
              <button
                class="tool"
                type="button"
                :disabled="streaming"
                title="切到低声，同样把 @他 填好"
                @click="addressFocus(true)"
              >
                低声问
              </button>
            </div>
          </template>
          <p v-else class="side__empty">这一条主线演完了 —— 世界还在，人可以继续聊。</p>

          <details v-if="pastQuests.length > 0" class="quest__history">
            <summary>之前的章节（{{ pastQuests.length }}）</summary>
            <p v-for="item in pastQuests" :key="item.id">{{ item.title }}</p>
          </details>
        </aside>

        <!-- 中：现场 -->
        <div class="scene__main">
          <!-- 在场者：点一下看这个人现在能不能搭上话 -->
          <div class="presence">
            <span class="presence__label">在场</span>
            <button
              v-for="person in present"
              :key="person.id"
              class="person"
              type="button"
              :class="{ 'person--busy': person.reachability === 'busy' }"
              :title="person.hint"
              @click="toggleHint(person.id)"
            >
              <span class="person__avatar">
                <img
                  v-if="!brokenAvatars[person.id]"
                  :src="avatarOf(person.id)"
                  :alt="person.name"
                  @error="markAvatarBroken(person.id)"
                />
                <span v-else class="person__initial">{{ person.name.slice(0, 1) }}</span>
              </span>
              <span class="person__text">
                <span class="person__name">{{ person.name }}</span>
                <span v-if="person.busyWith" class="person__busy">{{ person.busyWith }}</span>
              </span>
            </button>
            <span v-if="present.length === 0" class="presence__empty">
              这里现在没人 —— 换个地方，或者等有人进来
            </span>
          </div>

          <p v-if="hintText" class="presence__hint">
            <span>{{ hintText }}</span>
            <button
              v-if="canPullAway"
              class="tool"
              type="button"
              :disabled="pulling"
              @click="pullAway"
            >
              到没人的地方说话
            </button>
            <!-- 换地方不是免费的：说清代价，比事后解释好 -->
            <span v-if="canPullAway" class="presence__note">他会跟你走 —— 留下的人会看见</span>
          </p>

          <!-- 上一轮为什么加分/减分：没有这一行，好感就只是个会动的数字 -->
          <p v-if="affinityNote" class="relation__note">
            {{ affinityNote.name }}
            <template v-if="affinityNote.failed">{{ affinityNote.reason }}</template>
            <template v-else>
              好感 {{ affinityNote.delta >= 0 ? '+' : '' }}{{ affinityNote.delta }}
              <span class="relation__why">· {{ affinityNote.reason }}</span>
            </template>
          </p>

          <n-alert v-if="error" type="error" :title="error" closable @close="store.clearError()" />

          <div ref="logRef" class="scene__log">
            <p v-if="isEmpty" class="scene__empty">
              这一场还没人开口。说一句，在场的人会接 —— 用 @名字 可以指定谁先说。
            </p>

            <article
              v-for="bubble in messages"
              :key="bubble.id"
              class="bubble"
              :class="[
                `bubble--${bubble.role}`,
                bubble.kind ? `bubble--${bubble.kind}` : '',
                {
                  'bubble--optimistic': bubble.optimistic,
                  'bubble--notice': bubble.notice,
                  'bubble--whisper': bubble.whisper,
                  'bubble--eavesdrop': bubble.eavesdrop,
                },
              ]"
            >
              <!-- 场景日志：谁看见了你们离开、低声说话有没有被听见（不是谁说的话） -->
              <p v-if="bubble.role === 'system' && !bubble.notice" class="bubble__log">
                {{ bubble.content }}
              </p>

              <!-- 剧情事件：不是谁说的话，而是「这一轮发生了什么」 -->
              <p v-else-if="bubble.notice" class="notice">
                <span class="notice__head"
                  >第 {{ bubble.notice.turn }} 轮 · {{ bubble.notice.title }}</span
                >
                <span class="notice__body">{{ bubble.content }}</span>
              </p>

              <template v-else>
                <p v-if="bubble.role === 'assistant' && bubble.speakerId" class="bubble__speaker">
                  {{ store.speakerName(bubble.speakerId) }}
                  <span v-if="bubble.eavesdrop" class="bubble__tag">他听见了</span>
                </p>

                <p v-if="bubble.whisper" class="bubble__tag bubble__tag--whisper">低声</p>

                <p class="bubble__body">
                  {{ bubble.content
                  }}<span v-if="bubble.pending" class="bubble__caret" aria-hidden="true" />
                </p>

                <p v-if="bubble.meta && bubble.meta.totalTokens" class="bubble__meta">
                  {{ bubble.meta.totalTokens }} tokens
                  <template v-if="bubble.meta.durationMs"
                    >· {{ bubble.meta.durationMs }}ms</template
                  >
                </p>
              </template>
            </article>
          </div>

          <div class="scene__input">
            <!-- 输入方式：决定这句是说的、做的还是想的（prompt 与气泡样式都不同） -->
            <div class="modes">
              <button
                v-for="item in INPUT_MODES"
                :key="item.value"
                class="mode"
                type="button"
                :class="{ 'mode--on': mode === item.value }"
                :disabled="streaming"
                @click="mode = item.value"
              >
                {{ item.label }}
              </button>
              <span class="modes__hint">{{ currentMode.hint }}</span>
            </div>

            <n-input
              ref="draftRef"
              v-model:value="draft"
              type="textarea"
              :placeholder="currentMode.placeholder"
              :autosize="{ minRows: 2, maxRows: 4 }"
              :disabled="streaming || loading"
              @keydown="onKeydown"
            />

            <div class="scene__row">
              <n-button v-if="!streaming" type="primary" :disabled="!canSend" @click="submit">
                说
              </n-button>
              <n-button v-else type="error" ghost @click="store.stop()">停</n-button>
              <span class="scene__hint">
                @名字 指定谁先说；不指定的话在场的人轮流接。每轮都会落库。
              </span>
            </div>
          </div>
        </div>

        <!-- 右：情报本 + 好感 -->
        <aside class="side side--right">
          <p class="side__head">
            情报本 <span class="side__count">{{ clues.length }}</span>
          </p>

          <p v-if="clues.length === 0" class="side__empty">
            还没有情报。有人愿意跟你说真话时，这里会多一条。
            <template v-if="focusName">这一章要的是{{ focusName }}的那一句。</template>
          </p>

          <ul v-else class="clues">
            <li v-for="(clue, index) in clues" :key="clue.id" class="clue">
              <button
                class="clue__head"
                type="button"
                :title="clue.quote ? '点开看当时的原话' : '没有记下原话'"
                @click="toggleClue(clue.id)"
              >
                <span class="clue__index">{{ index + 1 }}</span>
                <span class="clue__text">{{ clue.content }}</span>
                <!-- 这一章要的那条标出来：情报本不是流水账 -->
                <span v-if="focusName && clue.source === focusName" class="clue__badge">
                  主线
                </span>
              </button>
              <p class="clue__meta">
                {{ clue.source || '你自己' }}
                <template v-if="clue.sourceTurn">· 第 {{ clue.sourceTurn }} 轮</template>
              </p>
              <p v-if="expandedClue === clue.id && clue.quote" class="clue__quote">
                「{{ clue.quote }}」
              </p>
            </li>
          </ul>

          <p class="side__head side__head--gap">好感</p>
          <p v-if="relations.length === 0" class="side__empty">还没打过交道。</p>
          <div
            v-for="item in relations"
            :key="item.id"
            class="relation relation--row"
            :title="`${item.reason || '还没打过交道'}（${affinityMarks.cold} 以下冷处理，${affinityMarks.open} 以上松口）`"
          >
            <span class="relation__name">{{ item.name }}</span>
            <span class="relation__bar">
              <span
                class="relation__fill"
                :class="`relation__fill--${item.mood}`"
                :style="{ width: `${item.value}%` }"
              />
            </span>
            <span class="relation__value">{{ item.value }}</span>
            <span v-if="item.moodText" class="relation__mood">{{ item.moodText }}</span>
          </div>
        </aside>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import type { MessageKind, ScenePresent } from '@tavern/shared';
import {
  AFFINITY_COLD,
  AFFINITY_OPEN,
  affinityMood,
  characterAvatarEndpoint,
} from '@tavern/shared';
import { NAlert, NButton, NInput, NSpin } from 'naive-ui';
import { storeToRefs } from 'pinia';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSceneStore } from '@/stores/scene';

/** 低声不是第六种「说什么」，而是「怎么说」：它按说话处理，只是加了压低声音。 */
type InputMode = MessageKind | 'whisper';

const route = useRoute();
const router = useRouter();
const store = useSceneStore();
const { scene, present, messages, loading, streaming, error, turn, isEmpty, isPrivate } =
  storeToRefs(store);
const { sourceSceneName, affinityNote, journal } = storeToRefs(store);

/** 关系条：只显示此刻在场的人，数值来自 store 里的好感表。 */
const relations = computed(() =>
  present.value
    .map((person) => {
      const entry = store.affinityOf(person.id);
      if (!entry) return null;
      const mood = affinityMood(entry.value);
      return {
        id: person.id,
        name: person.name,
        value: entry.value,
        reason: entry.lastReason,
        mood,
        moodText: mood === 'open' ? '松了口' : mood === 'cold' ? '冷处理' : '',
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null),
);

/** 刻度提示：60 以上松口、20 以下冷处理，界面上要有迹可循。 */
const affinityMarks = { open: AFFINITY_OPEN, cold: AFFINITY_COLD };

/** 输入方式：说话最常用，放第一个；低声排第二（世界模式里它最常用） */
const INPUT_MODES: { value: InputMode; label: string; placeholder: string; hint: string }[] = [
  {
    value: 'speak',
    label: '说话',
    placeholder: '说点什么…（Enter 发送，Shift+Enter 换行）',
    hint: '会包成「你说：…」，在场的人都当作听到',
  },
  {
    value: 'whisper',
    label: '低声',
    placeholder: '压低声音说…（同场的人有机会听不到）',
    hint: '压低声音说 —— 在场的人有概率听见，也可能没有',
  },
  {
    value: 'act',
    label: '行动',
    placeholder: '你要做什么…（例如：把杯子推到他面前）',
    hint: '包成「你（行动）：…」，做不做得到由世界说了算',
  },
  {
    value: 'think',
    label: '心里想',
    placeholder: '想什么…（说出口的和想的不一样时很好用）',
    hint: '没人能听到你在想什么',
  },
  {
    value: 'narrate',
    label: '旁白',
    placeholder: '叙述一段环境或时间跳跃…',
    hint: '当成场景叙述，不当作你说的话',
  },
  {
    value: 'ooc',
    label: '场外',
    placeholder: '对扮演本身的说明（例如：这段写得再简短些）',
    hint: '是你在跟"导演"说话，不是角色的台词',
  },
];

const mode = ref<InputMode>('speak');
const currentMode = computed(
  () => INPUT_MODES.find((item) => item.value === mode.value) ?? INPUT_MODES[0]!,
);

const draft = ref('');
const draftRef = ref<{ focus: () => void } | null>(null);
const logRef = ref<HTMLElement | null>(null);
/** 点开的那个人的提示（null = 收起） */
const hintFor = ref<string | null>(null);
/** 头像 404 的角色：退回首字，避免一片破图 */
const brokenAvatars = ref<Record<string, boolean>>({});
/** 正在带人换地方 / 正在回去 */
const pulling = ref(false);
const leaving = ref(false);
/** 情报本里展开的那一条 */
const expandedClue = ref<string | null>(null);

/** 情报本：从新到旧还是从旧到新？按拿到的时间正序，读起来像一条线索链 */
const clues = computed(() => store.journal?.clues ?? []);
/** 已完成的章节（左下角折叠着看） */
const pastQuests = computed(
  () => store.journal?.quests.filter((quest) => quest.status === 'done') ?? [],
);
/** 这一章指着谁：进度、下一步、情报来源都以他为准 */
const focusName = computed(() => store.journal?.quest?.focusCharacterName ?? null);

function toggleClue(clueId: string): void {
  expandedClue.value = expandedClue.value === clueId ? null : clueId;
}

/**
 * 「不知道说什么」时最省事的一步：先把 @他 填进输入框。
 *
 * 不替玩家写台词 —— 那会让这一场变成念稿；只解决「对谁说」和「用什么音量说」。
 */
async function addressFocus(whisper: boolean): Promise<void> {
  const name = focusName.value;
  if (!name) return;
  draft.value = `@${name} `;
  mode.value = whisper ? 'whisper' : 'speak';
  await nextTick();
  draftRef.value?.focus();
}

function avatarOf(characterId: string): string {
  return characterAvatarEndpoint(characterId);
}

function markAvatarBroken(characterId: string): void {
  brokenAvatars.value[characterId] = true;
}

function toggleHint(characterId: string): void {
  hintFor.value = hintFor.value === characterId ? null : characterId;
}

/** 点开的这个人 */
const selected = computed(
  () => present.value.find((person: ScenePresent) => person.id === hintFor.value) ?? null,
);

const hintText = computed(() => selected.value?.hint ?? '');

/** 能不能把他带走：只有公开场所里、现在有空的人才带得走。 */
const canPullAway = computed(
  () => scene.value?.kind === 'public' && selected.value?.reachability === 'available',
);

const placeText = computed(() => {
  if (!scene.value) return '';
  return scene.value.kind === 'private' ? '私聊 · 只有你们' : '公开场所 · 谁都可能进来';
});

const canSend = computed(() => !streaming.value && draft.value.trim().length > 0);

function submit(): void {
  if (!canSend.value) return;
  const text = draft.value;
  const selected = mode.value;
  draft.value = '';
  // 低声就是「说话 + 压低声音」：不占一种新的输入方式，只是说话的另一种说法
  if (selected === 'whisper') {
    void store.send(text, 'speak', true);
    return;
  }
  void store.send(text, selected, false);
}

/** 把人带到后巷：成功就跳进新场景，失败留在原地并说明原因。 */
async function pullAway(): Promise<void> {
  const person = selected.value;
  if (!person || pulling.value) return;
  pulling.value = true;
  try {
    const sceneId = await store.pullAway(person.id);
    if (sceneId) {
      hintFor.value = null;
      await router.push(`/scenes/${sceneId}`);
    }
  } finally {
    pulling.value = false;
  }
}

/** 从私聊回到原来的地方（人一起回去）。 */
async function goBack(): Promise<void> {
  if (leaving.value) return;
  leaving.value = true;
  try {
    const sceneId = await store.goBack();
    if (sceneId) await router.push(`/scenes/${sceneId}`);
  } finally {
    leaving.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  // Enter 发送、Shift+Enter 换行；输入法组合中不拦截
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}

function reload(): void {
  void store.refresh({ messages: true });
}

// 新内容进来自动滚到底部（用户向上翻时不打断）
watch(
  () => messages.value.map((bubble) => bubble.content.length).join(','),
  async () => {
    const element = logRef.value;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
    if (!nearBottom && streaming.value) return;
    await nextTick();
    element.scrollTop = element.scrollHeight;
  },
);

watch(
  () => route.params.id,
  () => {
    hintFor.value = null;
    void store.open(String(route.params.id ?? ''));
  },
);

onMounted(() => {
  void store.open(String(route.params.id ?? ''));
});

onBeforeUnmount(() => {
  store.stop();
});
</script>

<style scoped>
.scene {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(100vh - 200px);
  min-height: 480px;
}

.scene__head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.scene__back {
  color: var(--text-dim);
  font-size: 12.5px;
}

.scene__back:hover {
  color: var(--accent);
  text-decoration: none;
}

.scene__name {
  font-size: 17px;
  line-height: 1.3;
}

.scene__sub {
  color: var(--text-faint);
  font-size: 11.5px;
}

.scene__place {
  color: var(--accent);
}

.scene__actions {
  margin-left: auto;
}

.scene__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: auto;
  color: var(--text-dim);
  font-size: 12.5px;
}

.scene__fail {
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.8;
}

/* 三栏：主线 | 现场 | 情报本 + 好感 */
.scene__body {
  display: grid;
  flex: 1;
  min-height: 0;
  grid-template-columns: 190px minmax(0, 1fr) 232px;
  gap: 12px;
}

.scene__main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.side {
  display: flex;
  overflow-y: auto;
  padding: 12px;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}

.side__head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
}

.side__head--gap {
  margin-top: 8px;
}

.side__count {
  color: var(--text-faint);
}

.side__empty {
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.75;
}

/* 主线那一栏 */
.quest__chapter {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.quest__title {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}

/* 「找：夜巡人」：主线里最该被一眼看到的是人名 */
.quest__focus {
  color: var(--accent);
  font-size: 11.5px;
}

.quest__progress {
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

/* 下一步：差什么、找谁，一句人话 */
.quest__next {
  padding: 6px 8px;
  border-left: 2px solid rgba(224, 167, 94, 0.45);
  border-radius: 0 6px 6px 0;
  background: rgba(224, 167, 94, 0.06);
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.7;
}

.quest__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.quest__history {
  margin-top: 4px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.8;
}

.quest__history summary {
  cursor: pointer;
}

/* 情报本 */
.clues {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 10px;
  list-style: none;
}

.clue {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.clue__head {
  display: flex;
  width: 100%;
  padding: 0;
  align-items: baseline;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.65;
  text-align: left;
  cursor: pointer;
}

.clue__head:hover {
  color: var(--accent);
}

.clue__index {
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 10px;
}

.clue__text {
  flex: 1;
}

/* 主线要的那条：别的可以先放着，这条不能丢 */
.clue__badge {
  flex-shrink: 0;
  padding: 0 5px;
  border: 1px solid rgba(224, 167, 94, 0.4);
  border-radius: 999px;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 15px;
}

.clue__meta {
  padding-left: 16px;
  color: var(--text-faint);
  font-size: 10.5px;
}

/* 原话：不确定真假的时候，玩家想看的其实是「他当时怎么说的」 */
.clue__quote {
  margin-top: 2px;
  padding: 6px 9px;
  border-left: 2px solid var(--border-strong);
  border-radius: 0 6px 6px 0;
  background: var(--bg-elevated);
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.75;
  white-space: pre-wrap;
}

.relation--row {
  padding: 2px 0;
  cursor: default;
}

/* 在场者头像条 */
.presence {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
}

.presence__label {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
}

.presence__empty {
  color: var(--text-faint);
  font-size: 12px;
}

.person {
  display: flex;
  padding: 3px 8px 3px 3px;
  align-items: center;
  gap: 7px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.person:hover {
  border-color: var(--border-strong);
  background: var(--bg-elevated);
}

.person__avatar {
  display: grid;
  overflow: hidden;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: linear-gradient(150deg, #2a2118, #16120f);
  color: var(--border-strong);
  font-family: var(--font-mono);
  font-size: 12px;
}

.person__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.person__text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.person__name {
  font-size: 12.5px;
}

/* 在忙的人：名字旁边挂个小标注，一眼看出他现在没空 */
.person__busy {
  color: var(--text-faint);
  font-size: 10px;
}

.person--busy .person__name {
  color: var(--text-dim);
}

.presence__hint {
  margin-top: -4px;
  padding: 0 4px;
  color: var(--text-dim);
  font-size: 11.5px;
}

.scene__log {
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

.scene__empty {
  margin: auto;
  color: var(--text-faint);
  font-size: 12.5px;
  text-align: center;
}

.bubble {
  display: flex;
  max-width: 86%;
  flex-direction: column;
  gap: 4px;
}

.bubble--user {
  margin-left: auto;
  align-items: flex-end;
}

.bubble--system {
  max-width: 100%;
  align-items: center;
}

.bubble--notice {
  max-width: 100%;
  align-items: stretch;
}

.notice {
  display: flex;
  padding: 9px 14px;
  flex-direction: column;
  gap: 3px;
  border: 1px dashed rgba(224, 167, 94, 0.4);
  border-radius: 10px;
  background: rgba(224, 167, 94, 0.07);
}

.notice__head {
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
}

.notice__body {
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.8;
  white-space: pre-wrap;
}

.bubble__body {
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-elevated);
  font-size: 13.5px;
  line-height: 1.85;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble--user .bubble__body {
  border-color: rgba(224, 167, 94, 0.34);
  background: var(--accent-soft);
}

.bubble--optimistic .bubble__body {
  opacity: 0.86;
}

.bubble__caret {
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

.bubble__meta {
  padding: 0 6px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

/* 场景里可能有好几个人在说：名字必须显示清楚 */
.bubble__speaker {
  padding: 0 6px;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.scene__input {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.scene__row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.scene__hint {
  color: var(--text-faint);
  font-size: 11px;
}

/* 输入方式切换 */
.modes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.mode {
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
  cursor: pointer;
}

.mode:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--accent);
}

.mode--on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.modes__hint {
  color: var(--text-faint);
  font-size: 11px;
}

.tool {
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
}

.tool:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--accent);
}

.tool:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

/* 行动用斜体、心里想用灰色、旁白/场外更淡 —— 一眼看出这是在做什么 */
.bubble--act .bubble__body {
  border-style: dashed;
  color: var(--text-dim);
  font-style: italic;
}

.bubble--think .bubble__body {
  border-color: var(--border);
  background: transparent;
  color: var(--text-faint);
  font-style: italic;
}

.bubble--narrate .bubble__body,
.bubble--ooc .bubble__body {
  border-style: dotted;
  background: transparent;
  color: var(--text-faint);
  font-size: 12px;
}

/* 私聊场景里「回去」是个动作（要把人一起带回原场景），做成按钮但看着像链接 */
.scene__back--action {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 12.5px;
  cursor: pointer;
}

.scene__back--action:hover:not(:disabled) {
  color: var(--accent);
}

.scene__back--action:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* 换地方的代价说明：比提示正文再淡一档，别喧宾夺主 */
.presence__note {
  color: var(--text-faint);
  font-size: 11px;
}

/* 关系条：一眼看出「他松了口」还是「他在冷处理」 */
.relation {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: default;
}

.relation__name {
  color: var(--text-dim);
  font-size: 11.5px;
}

.relation__bar {
  position: relative;
  display: inline-block;
  overflow: hidden;
  width: 72px;
  height: 5px;
  border-radius: 999px;
  background: var(--bg-elevated);
}

/* 刻度：20 与 60 各画一道细线 —— 阈值不该是隐藏规则，看得见才叫规则 */
.relation__bar::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to right,
    transparent 19%,
    rgba(236, 228, 216, 0.22) 20%,
    transparent 21%,
    transparent 59%,
    rgba(236, 228, 216, 0.22) 60%,
    transparent 61%
  );
  pointer-events: none;
}

.relation__fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--text-faint);
  transition: width 0.25s ease;
}

/* 松口：琥珀色；冷处理：冷灰；中间：低调的灰 —— 颜色本身就是提示 */
.relation__fill--open {
  background: var(--accent);
}

.relation__fill--cold {
  background: #5b6a7a;
}

.relation__value {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.relation__mood {
  color: var(--accent);
  font-size: 10.5px;
}

.relation__note {
  margin-top: -2px;
  padding: 0 4px;
  color: var(--text-dim);
  font-size: 11.5px;
}

.relation__why {
  color: var(--text-faint);
}

/* 低声说的话：加个标签，气泡换成虚线，和当众说话区分开 */
.bubble__tag {
  align-self: flex-start;
  padding: 0 6px;
  border: 1px solid rgba(224, 167, 94, 0.35);
  border-radius: 999px;
  background: rgba(224, 167, 94, 0.08);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
}

/* 自己说的话靠右，标签也跟着靠右 */
.bubble--user .bubble__tag {
  align-self: flex-end;
}

.bubble--whisper .bubble__body {
  border-style: dashed;
  font-size: 13px;
}

/* 偷听反应：不是回你的话，而是他听见之后的自动反应 */
.bubble--eavesdrop .bubble__body {
  border-color: rgba(224, 167, 94, 0.4);
  border-style: dashed;
  background: rgba(224, 167, 94, 0.05);
}

.bubble__log {
  width: 100%;
  padding: 2px 6px;
  color: var(--text-faint);
  font-size: 11.5px;
  text-align: center;
}

.bubble--system {
  width: 100%;
}

/* 窄屏：侧栏跑到上下，别把对话挤成一条缝 */
@media (max-width: 1000px) {
  .scene {
    height: auto;
  }

  .scene__body {
    grid-template-columns: minmax(0, 1fr);
  }

  .side {
    max-height: 220px;
  }

  .scene__log {
    min-height: 320px;
  }
}

@media (max-width: 640px) {
  .scene__log {
    min-height: 260px;
  }
}
</style>
