import type { HealthPayload } from '@tavern/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError } from '@/api/client';
import { fetchHealth } from '@/api/health';

/** 自动刷新间隔：健康检查很轻，10 秒一次足够感知后端掉线。 */
const AUTO_REFRESH_INTERVAL_MS = 10_000;

export interface HealthError {
  code: string;
  message: string;
  /** 给用户看的排查建议，比单纯报错有用 */
  hint: string;
}

/**
 * 健康状态仓库。
 *
 * 用 setup 语法写 store：内部就是普通 ref/computed，
 * 相比 options 语法更好读，也方便把「自动刷新」这类副作用收在这里。
 */
export const useHealthStore = defineStore('health', () => {
  const payload = ref<HealthPayload | null>(null);
  const error = ref<HealthError | null>(null);
  const loading = ref(false);
  const latencyMs = ref<number | null>(null);
  const lastCheckedAt = ref<Date | null>(null);
  const autoRefresh = ref(true);

  let timer: ReturnType<typeof setInterval> | null = null;

  /** 有载荷且最近一次请求没出错，才算「在线」。 */
  const online = computed(() => payload.value !== null && error.value === null);
  const degraded = computed(() => payload.value?.status === 'degraded');
  const failedChecks = computed(
    () => payload.value?.checks.filter((check) => check.status !== 'ok') ?? [],
  );

  const statusText = computed(() => {
    if (loading.value && payload.value === null) return '连接中';
    if (!online.value) return '未连接';
    return degraded.value ? '降级运行' : '运行正常';
  });

  function describeError(cause: unknown): HealthError {
    if (cause instanceof ApiError) {
      if (cause.isNetworkError) {
        return {
          code: cause.code,
          message: cause.message,
          hint: '请确认后端已启动（pnpm dev:server），以及端口与 config/default.yaml 一致。',
        };
      }
      return {
        code: cause.code,
        message: cause.message,
        hint: cause.traceId ? `可在后端日志中搜索 traceId：${cause.traceId}` : '请查看后端日志。',
      };
    }
    return {
      code: 'UNKNOWN',
      message: cause instanceof Error ? cause.message : String(cause),
      hint: '请打开浏览器控制台查看详细错误。',
    };
  }

  async function refresh(): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    const startedAt = performance.now();

    try {
      payload.value = await fetchHealth();
      error.value = null;
    } catch (cause) {
      payload.value = null;
      error.value = describeError(cause);
    } finally {
      latencyMs.value = Math.round(performance.now() - startedAt);
      lastCheckedAt.value = new Date();
      loading.value = false;
    }
  }

  function startAutoRefresh(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      // 页面在后台时不必打扰后端
      if (document.visibilityState === 'visible') void refresh();
    }, AUTO_REFRESH_INTERVAL_MS);
  }

  function stopAutoRefresh(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    payload,
    error,
    loading,
    latencyMs,
    lastCheckedAt,
    autoRefresh,
    online,
    degraded,
    failedChecks,
    statusText,
    refresh,
    startAutoRefresh,
    stopAutoRefresh,
  };
});
