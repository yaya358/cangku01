/** 展示层的小工具：只做格式化，不碰业务状态。 */

/** 秒 → 「2 天 03:04:05」这种可读时长。 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  const clock = [hours, minutes, rest].map((unit) => String(unit).padStart(2, '0')).join(':');
  return days > 0 ? `${days} 天 ${clock}` : clock;
}

/** 时间点 → 本地时间字符串（带毫秒会太吵，这里到秒）。 */
export function formatClock(value: Date | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}

/** ISO 字符串 → 本地日期时间，用于「启动于」。 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** 微信式相对时间：今天显示时刻，昨天显示「昨天」，更早显示日期。 */
export function relativeTime(iso: string): string {
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

  return `${time.getMonth() + 1} 月 ${time.getDate()} 日`;
}
