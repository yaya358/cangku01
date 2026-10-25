<template>
  <n-modal
    :show="show"
    preset="card"
    title="你是谁"
    :style="{ width: '560px', maxWidth: '92vw' }"
    :bordered="false"
    @update:show="onUpdateShow"
  >
    <div class="form">
      <p class="form__intro">
        这一场里你是什么人、图什么 —— 角色会按这个来对待你。 不填的话，它只能把你当陌生人客套。
      </p>

      <label class="field">
        <span class="field__label">称呼</span>
        <n-input v-model:value="name" placeholder="陈九" maxlength="40" />
      </label>

      <div class="field">
        <span class="field__label">身份（选一个，或自己写）</span>
        <div class="chips">
          <button
            v-for="preset in ROLE_PRESETS"
            :key="preset"
            class="chip"
            type="button"
            :class="{ 'chip--on': role === preset }"
            @click="role = preset"
          >
            {{ preset }}
          </button>
        </div>
        <n-input v-model:value="role" placeholder="来讨债的" maxlength="200" />
      </div>

      <label class="field">
        <span class="field__label">你图什么（这一场的目标）</span>
        <n-input
          v-model:value="goal"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 5 }"
          placeholder="让他承认十四年前那件事"
          maxlength="400"
        />
      </label>

      <div class="chips chips--goal">
        <button
          v-for="preset in GOAL_PRESETS"
          :key="preset"
          class="chip"
          type="button"
          @click="goal = preset"
        >
          {{ preset }}
        </button>
      </div>
    </div>

    <template #footer>
      <div class="footer">
        <n-button size="small" :disabled="saving" @click="onUpdateShow(false)">取消</n-button>
        <n-button size="small" type="primary" :loading="saving" @click="submit">
          {{ confirmText }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import type { Player } from '@tavern/shared';
import { NButton, NInput, NModal } from 'naive-ui';
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    show: boolean;
    initial?: Partial<Player>;
    confirmText?: string;
    saving?: boolean;
  }>(),
  { initial: () => ({}), confirmText: '开始', saving: false },
);

const emit = defineEmits<{ 'update:show': [value: boolean]; submit: [player: Player] }>();

/** 常见身份：覆盖「讨债 / 找人 / 装身份 / 路过」这几类动机。 */
const ROLE_PRESETS = [
  '来讨债的',
  '来找人的',
  '假冒的吟游诗人',
  '只是来避雨的',
  '新来的学徒',
  '官府的差役',
];

/** 目标写得越具体，角色越知道该防你什么。 */
const GOAL_PRESETS = ['让他承认十四年前那件事', '套出他不想让人知道的事', '只是想安静喝一杯'];

const name = ref('');
const role = ref('');
const goal = ref('');

function submit(): void {
  emit('submit', { name: name.value.trim(), role: role.value.trim(), goal: goal.value.trim() });
}

function onUpdateShow(value: boolean): void {
  emit('update:show', value);
}

/** 每次打开都按传进来的初值重置，避免上次内容残留。 */
watch(
  () => props.show,
  (visible) => {
    if (!visible) return;
    name.value = props.initial.name ?? '';
    role.value = props.initial.role ?? '';
    goal.value = props.initial.goal ?? '';
  },
);
</script>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form__intro {
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.75;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field__label {
  color: var(--text-faint);
  font-size: 11.5px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chips--goal {
  margin-top: -4px;
}

.chip {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
  cursor: pointer;
}

.chip:hover {
  border-color: var(--border-strong);
  color: var(--accent);
}

.chip--on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
