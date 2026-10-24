<template>
  <section class="home">
    <header class="hero">
      <div class="hero__main">
        <h1 class="hero__title">基建就绪</h1>
        <p class="hero__desc">
          本页所有数据都来自后端 <code>/api/health</code>：Vite 代理 → Fastify 路由 → 扩展点注册表 →
          Pinia store → 页面渲染。链路通了，后面的角色卡、上下文引擎、流式对话才有地基。
        </p>
      </div>

      <div class="hero__actions">
        <n-tag :type="statusTagType" round size="large" :bordered="false">
          <span class="dot" :class="`dot--${statusTone}`" aria-hidden="true"></span>
          {{ store.statusText }}
        </n-tag>
        <n-button type="primary" :loading="loading" @click="store.refresh()">刷新</n-button>
      </div>
    </header>

    <n-alert v-if="error" type="error" :title="`后端未连通（${error.code}）`" class="alert">
      <p class="alert__line">{{ error.message }}</p>
      <p class="alert__hint">{{ error.hint }}</p>
    </n-alert>

    <div v-else-if="!payload" class="placeholder">
      <n-spin size="medium" />
      <span>正在连接后端…</span>
    </div>

    <template v-else>
      <div class="stats">
        <article v-for="item in stats" :key="item.label" class="stat">
          <p class="stat__label">{{ item.label }}</p>
          <p class="stat__value">{{ item.value }}</p>
          <p class="stat__hint">{{ item.hint }}</p>
        </article>
      </div>

      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">自检清单</h2>
          <span class="panel__hint">{{ passedCount }}/{{ payload.checks.length }} 通过</span>
        </div>

        <ul class="checks">
          <li v-for="check in payload.checks" :key="check.name" class="check">
            <n-tag :type="tagTypeOf(check.status)" size="small" :bordered="false">
              {{ CHECK_LABELS[check.status] }}
            </n-tag>
            <code class="check__name">{{ check.name }}</code>
            <span class="check__message">{{ check.message ?? '' }}</span>
            <span class="check__latency">{{ check.latencyMs?.toFixed(2) ?? '—' }} ms</span>
          </li>
        </ul>
      </section>

      <div class="grid">
        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">服务信息</h2>
          </div>
          <dl class="facts">
            <div class="fact">
              <dt>监听地址</dt>
              <dd>
                <code>http://{{ payload.server.host }}:{{ payload.server.port }}</code>
              </dd>
            </div>
            <div class="fact">
              <dt>运行环境</dt>
              <dd>{{ payload.app.env }}</dd>
            </div>
            <div class="fact">
              <dt>版本</dt>
              <dd>
                v{{ payload.app.version }}
                <span class="fact__dim">· Node {{ payload.app.nodeVersion }}</span>
              </dd>
            </div>
            <div class="fact">
              <dt>进程</dt>
              <dd>
                PID {{ payload.server.pid }}
                <span class="fact__dim">· {{ payload.server.memoryMb.toFixed(1) }} MB</span>
              </dd>
            </div>
          </dl>
        </section>

        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">扩展点</h2>
            <span class="panel__hint">provider / context / storage</span>
          </div>

          <ul class="extensions">
            <li class="extension">
              <span class="extension__label">总数</span>
              <strong>{{ payload.extensions.total }}</strong>
            </li>
            <li class="extension">
              <span class="extension__label">已就绪</span>
              <strong class="extension__value--ok">{{ payload.extensions.ready }}</strong>
            </li>
            <li class="extension">
              <span class="extension__label">失败</span>
              <strong :class="{ 'extension__value--err': payload.extensions.failed > 0 }">
                {{ payload.extensions.failed }}
              </strong>
            </li>
            <li class="extension">
              <span class="extension__label">待初始化</span>
              <strong>{{ payload.extensions.pending }}</strong>
            </li>
          </ul>

          <p class="panel__note">
            注册表支持 priority
            排序、失败隔离与逆序释放；后续的模型接入层、上下文引擎都会以扩展形式挂进来。
          </p>
        </section>
      </div>
    </template>

    <div class="meta">
      <span>最近检查：{{ formatClock(lastCheckedAt) }}</span>
      <span class="meta__sep">·</span>
      <span>往返 {{ latencyMs ?? '—' }} ms</span>
      <span class="meta__sep">·</span>
      <label class="meta__toggle">
        <span>自动刷新（10s）</span>
        <n-switch size="small" :value="autoRefresh" @update:value="toggleAutoRefresh" />
      </label>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { CheckStatus } from '@tavern/shared';
import { NAlert, NButton, NSpin, NSwitch, NTag } from 'naive-ui';
import { storeToRefs } from 'pinia';
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useHealthStore } from '@/stores/health';
import { formatClock, formatDateTime, formatDuration } from '@/utils/format';

const store = useHealthStore();
const { payload, error, loading, latencyMs, lastCheckedAt, autoRefresh } = storeToRefs(store);

const CHECK_LABELS: Record<CheckStatus, string> = {
  ok: '正常',
  degraded: '降级',
  failed: '失败',
};

const statusTone = computed(() => {
  if (!payload.value) return 'off';
  return payload.value.status === 'ok' ? 'ok' : 'warn';
});

const statusTagType = computed<'success' | 'warning' | 'error'>(() => {
  if (!payload.value) return 'error';
  return payload.value.status === 'ok' ? 'success' : 'warning';
});

const passedCount = computed(
  () => payload.value?.checks.filter((check) => check.status === 'ok').length ?? 0,
);

/** 顶部四个数字卡：把「服务是否健康」拆成四个能一眼判断的量。 */
const stats = computed(() => {
  const data = payload.value;
  if (!data) return [];

  return [
    {
      label: '运行时长',
      value: formatDuration(data.app.uptimeSeconds),
      hint: `启动于 ${formatDateTime(data.app.startedAt)}`,
    },
    {
      label: '进程内存',
      value: `${data.server.memoryMb.toFixed(1)} MB`,
      hint: `PID ${data.server.pid} · ${data.app.nodeVersion}`,
    },
    {
      label: '扩展点',
      value: `${data.extensions.ready}/${data.extensions.total}`,
      hint: data.extensions.failed > 0 ? `${data.extensions.failed} 个初始化失败` : '全部就绪',
    },
    {
      label: '往返耗时',
      value: `${latencyMs.value ?? 0} ms`,
      hint: `最近检查 ${formatClock(lastCheckedAt.value)}`,
    },
  ];
});

function tagTypeOf(status: CheckStatus): 'success' | 'warning' | 'error' {
  if (status === 'ok') return 'success';
  return status === 'degraded' ? 'warning' : 'error';
}

function toggleAutoRefresh(value: boolean): void {
  autoRefresh.value = value;
  if (value) store.startAutoRefresh();
  else store.stopAutoRefresh();
}

onMounted(() => {
  void store.refresh();
  if (autoRefresh.value) store.startAutoRefresh();
});

// 离开页面必须停掉定时器，否则切来切去会叠加多个 interval
onBeforeUnmount(() => {
  store.stopAutoRefresh();
});
</script>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.hero {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  padding: 4px 2px 2px;
}

.hero__main {
  max-width: 620px;
}

.hero__title {
  margin-bottom: 8px;
  font-size: 26px;
  letter-spacing: 0.02em;
}

.hero__desc {
  color: var(--text-dim);
  font-size: 13.5px;
  line-height: 1.75;
}

.hero__desc code {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-soft);
  color: var(--accent);
}

.hero__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 状态点：正常绿、降级黄、离线灰 */
.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}

.dot--ok {
  background: var(--ok);
  box-shadow: 0 0 0 3px rgba(108, 191, 139, 0.16);
}

.dot--warn {
  background: var(--warn);
  box-shadow: 0 0 0 3px rgba(224, 179, 94, 0.16);
}

.dot--off {
  background: var(--err);
  box-shadow: 0 0 0 3px rgba(217, 118, 95, 0.16);
}

.alert__line {
  font-weight: 500;
}

.alert__hint {
  margin-top: 6px;
  opacity: 0.78;
  font-size: 12.5px;
}

.placeholder {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 28px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-dim);
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
}

.stat {
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: linear-gradient(168deg, var(--bg-elevated), var(--bg-soft));
}

.stat__label {
  color: var(--text-faint);
  font-size: 11.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.stat__value {
  margin: 6px 0 4px;
  font-family: var(--font-mono);
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.stat__hint {
  color: var(--text-faint);
  font-size: 11.5px;
}

.panel {
  padding: 18px 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.panel__title {
  font-size: 14px;
  letter-spacing: 0.03em;
}

.panel__hint {
  color: var(--text-faint);
  font-size: 11.5px;
}

.panel__note {
  margin-top: 14px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.7;
}

.checks {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.check {
  display: grid;
  grid-template-columns: 62px minmax(88px, 120px) 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
}

.check:hover {
  border-color: var(--border);
}

.check__name {
  color: var(--accent);
}

.check__message {
  color: var(--text-dim);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check__latency {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
}

.facts {
  display: flex;
  margin: 0;
  flex-direction: column;
  gap: 10px;
}

.fact {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 9px;
  border-bottom: 1px dashed var(--border);
}

.fact:last-child {
  padding-bottom: 0;
  border-bottom: none;
}

.fact dt {
  color: var(--text-faint);
  font-size: 12px;
}

.fact dd {
  margin: 0;
  text-align: right;
  font-size: 12.5px;
}

.fact__dim {
  color: var(--text-faint);
}

.extensions {
  display: grid;
  margin: 0;
  padding: 0;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  list-style: none;
}

.extension {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
}

.extension__label {
  color: var(--text-faint);
  font-size: 11px;
}

.extension strong {
  font-family: var(--font-mono);
  font-size: 18px;
}

.extension__value--ok {
  color: var(--ok);
}

.extension__value--err {
  color: var(--err);
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
  color: var(--text-faint);
  font-size: 12px;
}

.meta__sep {
  color: var(--border-strong);
}

.meta__toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  cursor: pointer;
}

@media (max-width: 640px) {
  .check {
    grid-template-columns: 58px 1fr auto;
  }

  .check__message {
    grid-column: 2 / -1;
    white-space: normal;
  }

  .extensions {
    grid-template-columns: repeat(2, 1fr);
  }

  .meta__toggle {
    margin-left: 0;
  }
}
</style>
