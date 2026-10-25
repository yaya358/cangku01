<!--
  一个世界的三个动作：存档 / 读档 / 重开。

  之前「存档」只等于「存一本故事」，想要回到十分钟前只能整本重开；
  这里补上时间维度的：存一张快照、读回去、或者从头再来。

  为什么做成组件：世界页每张卡要一套，对话页每个世界的标题栏也要一套，
  逻辑（含读档列表、确认框）只该写一遍。
-->
<template>
  <span class="world-actions">
    <n-button size="tiny" :loading="saving" @click="takeSnapshot">存档</n-button>

    <n-button size="tiny" :disabled="!save" @click="openLoad">读档</n-button>

    <n-popconfirm positive-text="重新开始" negative-text="算了" @positive-click="restart">
      <template #trigger>
        <n-button size="tiny" quaternary type="warning" :disabled="!save || restarting">
          重开
        </n-button>
      </template>
      整本从头再演一遍？场景、对话、情报、好感都会清空，名字和在场的人留着。不能撤销。
    </n-popconfirm>

    <!-- 读档：列出这个世界的快照 -->
    <n-modal
      v-model:show="loadOpen"
      preset="card"
      class="load-modal"
      :title="`读档 · ${save?.name ?? ''}`"
      :style="{ width: 'min(560px, 92vw)' }"
    >
      <n-spin :show="loadingSnapshots">
        <ul v-if="snapshots.length > 0" class="load-list">
          <li v-for="item in snapshots" :key="item.id" class="load-item">
            <div class="load-item__main">
              <span class="load-item__label">{{ item.label }}</span>
              <span class="load-item__meta">
                第 {{ item.chapter }} 章 · {{ item.messageCount }} 条对话 ·
                {{ relativeTime(item.createdAt) }}
              </span>
            </div>
            <div class="load-item__actions">
              <n-popconfirm
                positive-text="读回去"
                negative-text="取消"
                @positive-click="restore(item)"
              >
                <template #trigger>
                  <n-button size="tiny" type="primary" :disabled="busyId === item.id">
                    读档
                  </n-button>
                </template>
                回到「{{ item.label }}」那一刻？现在的进度会被覆盖。
              </n-popconfirm>
              <n-button size="tiny" quaternary type="error" @click="drop(item)">删除</n-button>
            </div>
          </li>
        </ul>

        <n-empty
          v-if="!loadingSnapshots && snapshots.length === 0"
          description="还没有存过档 —— 点上面的「存档」存一张"
        />
      </n-spin>

      <n-alert
        v-if="error"
        type="error"
        :title="error"
        closable
        class="load-modal__error"
        @close="error = null"
      />
    </n-modal>
  </span>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage, NAlert, NButton, NEmpty, NModal, NPopconfirm, NSpin } from 'naive-ui';
import type { Save, Snapshot } from '@tavern/shared';
import {
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  restartSave,
} from '@/api/world';
import { describeError } from '@/utils/errors';
import { relativeTime } from '@/utils/format';

const props = defineProps<{ save: Save | null }>();
const emit = defineEmits<{ changed: [] }>();

const router = useRouter();
const message = useMessage();

const saving = ref(false);
const restarting = ref(false);
const loadOpen = ref(false);
const loadingSnapshots = ref(false);
const snapshots = ref<Snapshot[]>([]);
const busyId = ref<string | null>(null);
const error = ref<string | null>(null);

/** 存档：拍一张快照，名字默认带上章号和时刻（服务端补） */
async function takeSnapshot(): Promise<void> {
  if (!props.save) return;
  saving.value = true;
  error.value = null;
  try {
    const created = await createSnapshot(props.save.id);
    message.success(`已存档：${created.label}`);
    emit('changed');
  } catch (cause) {
    error.value = describeError(cause);
    message.error(error.value);
  } finally {
    saving.value = false;
  }
}

async function openLoad(): Promise<void> {
  if (!props.save) return;
  loadOpen.value = true;
  loadingSnapshots.value = true;
  error.value = null;
  try {
    snapshots.value = await listSnapshots(props.save.id);
  } catch (cause) {
    error.value = describeError(cause);
    snapshots.value = [];
  } finally {
    loadingSnapshots.value = false;
  }
}

/**
 * 读档。
 *
 * 读完之后要刷新：当前场景的 id 不变（快照里存的就是它），但消息、情报、
 * 好感都换了一批 —— 所以让调用方（世界页 / 对话页）重新拉一遍。
 */
async function restore(item: Snapshot): Promise<void> {
  busyId.value = item.id;
  error.value = null;
  try {
    const result = await restoreSnapshot(item.id);
    message.success(`已读档到「${item.label}」（第 ${result.chapter} 章）`);
    loadOpen.value = false;
    emit('changed');
  } catch (cause) {
    error.value = describeError(cause);
    message.error(error.value);
  } finally {
    busyId.value = null;
  }
}

async function drop(item: Snapshot): Promise<void> {
  busyId.value = item.id;
  try {
    await deleteSnapshot(item.id);
    snapshots.value = snapshots.value.filter((snapshot) => snapshot.id !== item.id);
    message.success('快照已删除');
  } catch (cause) {
    error.value = describeError(cause);
    message.error(error.value);
  } finally {
    busyId.value = null;
  }
}

/** 重开：换了一个新存档 id，得跳到新场景去 */
async function restart(): Promise<void> {
  if (!props.save) return;
  restarting.value = true;
  error.value = null;
  try {
    const started = await restartSave(props.save.id);
    message.success('这本故事从头开始了');
    emit('changed');
    await router.push(`/scenes/${started.scene.id}`);
  } catch (cause) {
    error.value = describeError(cause);
    message.error(error.value);
  } finally {
    restarting.value = false;
  }
}
</script>

<style scoped>
.world-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.load-list {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 8px;
  list-style: none;
}

.load-item {
  display: flex;
  padding: 9px 11px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-soft);
}

.load-item__main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.load-item__label {
  font-size: 12.5px;
  font-weight: 600;
}

.load-item__meta {
  color: var(--text-dim);
  font-size: 11px;
}

.load-item__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
}

.load-modal__error {
  margin-top: 12px;
}
</style>
