import { ApiError } from '@/api/client';

/**
 * 把各种失败折叠成一句玩家能看懂的话。
 *
 * 集中在一处的原因：网络断了、后端没起、生成被中止，这三种在界面上
 * 都表现为「没反应」，但给玩家的说法完全不同。
 */
export function describeError(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.isNetworkError ? '连不上后端，请确认服务已启动' : cause.message;
  }
  if (cause instanceof DOMException && cause.name === 'AbortError') return '已停止生成';
  return cause instanceof Error ? cause.message : String(cause);
}
