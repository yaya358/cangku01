<template>
  <n-modal
    :show="show"
    preset="card"
    title="新建角色"
    class="create-modal"
    :bordered="false"
    :style="{ width: '620px', maxWidth: '92vw' }"
    @update:show="onUpdateShow"
  >
    <div class="form">
      <label class="field">
        <span class="field__label">名字 <em>*</em></span>
        <n-input v-model:value="form.name" placeholder="例如：月灯老板" maxlength="80" />
      </label>

      <label class="field">
        <span class="field__label">人设描述</span>
        <n-input
          v-model:value="form.description"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          placeholder="外貌、身份、经历……模型会把它当成角色的自我认知"
        />
      </label>

      <div class="form__row">
        <label class="field">
          <span class="field__label">性格</span>
          <n-input v-model:value="form.personality" placeholder="话痨、心软、嘴毒" />
        </label>
        <label class="field">
          <span class="field__label">场景</span>
          <n-input v-model:value="form.scenario" placeholder="深夜的酒馆，炉火正旺" />
        </label>
      </div>

      <label class="field">
        <span class="field__label">开场白</span>
        <n-input
          v-model:value="form.firstMes"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          placeholder="角色说的第一句话，可以用括号写动作"
        />
      </label>

      <label class="field">
        <span class="field__label">示例对话</span>
        <n-input
          v-model:value="form.mesExample"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          placeholder="<START>&#10;{{user}}: 有酒吗？&#10;{{char}}: 有，也有故事。"
        />
      </label>

      <label class="field">
        <span class="field__label">标签（逗号或空格分隔）</span>
        <n-input v-model:value="form.tags" placeholder="酒馆, 日常" />
      </label>

      <n-alert v-if="error" type="error" :title="error" closable @close="error = null" />
    </div>

    <template #footer>
      <div class="footer">
        <span class="footer__hint">只填名字也能创建，之后随时可以补全</span>
        <div class="footer__actions">
          <n-button size="small" :disabled="saving" @click="onUpdateShow(false)">取消</n-button>
          <n-button size="small" type="primary" :loading="saving" @click="submit">创建</n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { NAlert, NButton, NInput, NModal } from 'naive-ui';
import { reactive, ref, watch } from 'vue';
import { useCharacterStore } from '@/stores/characters';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; created: [] }>();

const store = useCharacterStore();
const saving = ref(false);
const error = ref<string | null>(null);

const form = reactive({
  name: '',
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
  mesExample: '',
  tags: '',
});

/** 标签输入容忍中英文逗号、空格、分号。 */
function parseTags(input: string): string[] {
  return input
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 20);
}

async function submit(): Promise<void> {
  const name = form.name.trim();
  if (name.length === 0) {
    error.value = '名字不能为空';
    return;
  }

  saving.value = true;
  error.value = null;
  try {
    const failure = await store.createManual({
      name,
      description: form.description,
      personality: form.personality,
      scenario: form.scenario,
      firstMes: form.firstMes,
      mesExample: form.mesExample,
      systemPrompt: '',
      postHistoryInstructions: '',
      creatorNotes: '',
      tags: parseTags(form.tags),
      alternateGreetings: [],
    });

    if (failure) {
      error.value = failure;
      return;
    }

    emit('created');
    onUpdateShow(false);
  } finally {
    saving.value = false;
  }
}

function onUpdateShow(value: boolean): void {
  emit('update:show', value);
}

/** 每次打开清空，避免上次的残留内容让用户以为已经填好了。 */
watch(
  () => props.show,
  (visible) => {
    if (!visible) return;
    error.value = null;
    form.name = '';
    form.description = '';
    form.personality = '';
    form.scenario = '';
    form.firstMes = '';
    form.mesExample = '';
    form.tags = '';
  },
);
</script>

<style scoped>
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

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.footer__hint {
  color: var(--text-faint);
  font-size: 11px;
}

.footer__actions {
  display: flex;
  gap: 8px;
}

@media (max-width: 640px) {
  .form__row {
    grid-template-columns: 1fr;
  }

  .footer__hint {
    display: none;
  }
}
</style>
