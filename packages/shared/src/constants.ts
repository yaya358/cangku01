/** 应用显示名，出现在 title、健康检查与日志中。 */
export const APP_NAME = '酒馆 AI';

/** 语义化版本号，与 package.json 保持同步。 */
export const APP_VERSION = '0.1.0';

/** 所有 HTTP 接口统一挂在 /api 前缀下，方便前端走 Vite 代理。 */
export const API_PREFIX = '/api';

/** 后端默认端口；可在 config/*.yaml 或环境变量中覆盖。 */
export const DEFAULT_SERVER_PORT = 8787;

/** 前端开发服务器默认端口。 */
export const DEFAULT_WEB_PORT = 5173;

/** 健康检查接口路径。 */
export const HEALTH_ENDPOINT = `${API_PREFIX}/health`;

/** provider 列表接口路径。 */
export const PROVIDERS_ENDPOINT = `${API_PREFIX}/providers`;

/** 管理接口前缀（本机/可信内网使用，无鉴权）。 */
export const ADMIN_PREFIX = `${API_PREFIX}/admin`;

/** 重新播种内置示例角色（幂等）。 */
export const ADMIN_SEED_ENDPOINT = `${ADMIN_PREFIX}/seed`;

/** 非流式对话接口路径。 */
export const CHAT_ENDPOINT = `${API_PREFIX}/chat`;

/** 流式对话接口路径（SSE）。 */
export const CHAT_STREAM_ENDPOINT = `${API_PREFIX}/chat/stream`;

/** 角色卡集合路径。 */
export const CHARACTERS_ENDPOINT = `${API_PREFIX}/characters`;

/** 角色卡导入路径（按 content-type 区分 PNG / JSON）。 */
export const CHARACTER_IMPORT_ENDPOINT = `${CHARACTERS_ENDPOINT}/import`;

/** 单个角色路径。 */
export function characterEndpoint(id: string): string {
  return `${CHARACTERS_ENDPOINT}/${encodeURIComponent(id)}`;
}

/** 角色头像路径。 */
export function characterAvatarEndpoint(id: string): string {
  return `${characterEndpoint(id)}/avatar`;
}

/** 导出为角色卡 PNG。 */
export function characterExportPngEndpoint(id: string): string {
  return `${characterEndpoint(id)}/export/png`;
}

/** 导出为角色卡 JSON（V2 结构）。 */
export function characterExportJsonEndpoint(id: string): string {
  return `${characterEndpoint(id)}/export/json`;
}

/** 上下文预览（不调模型，只返回组装结果）。 */
export const CONTEXT_PREVIEW_ENDPOINT = `${API_PREFIX}/context/preview`;

/** 会话集合。 */
export const CONVERSATIONS_ENDPOINT = `${API_PREFIX}/conversations`;

/** 单个会话。 */
export function conversationEndpoint(id: string): string {
  return `${CONVERSATIONS_ENDPOINT}/${encodeURIComponent(id)}`;
}

/** 会话里的消息集合（追加一条）。 */
export function conversationMessagesEndpoint(id: string): string {
  return `${conversationEndpoint(id)}/messages`;
}

/** 会话里发一句话并流式生成（SSE）。 */
export function conversationStreamEndpoint(id: string): string {
  return `${conversationEndpoint(id)}/stream`;
}

/** 消息集合（用于编辑 / 删除单条）。 */
export const MESSAGES_ENDPOINT = `${API_PREFIX}/messages`;

/** 单条消息。 */
export function messageEndpoint(id: string): string {
  return `${MESSAGES_ENDPOINT}/${encodeURIComponent(id)}`;
}

/** 追加一个候选回复（重说）。 */
export function messageSwipeEndpoint(id: string): string {
  return `${messageEndpoint(id)}/swipe`;
}

/** 切换候选回复。 */
export function messageSwipeSelectEndpoint(id: string): string {
  return `${messageEndpoint(id)}/swipe/select`;
}

/** 重说：让模型重新生成这条回复（SSE）。 */
export function messageRegenerateEndpoint(id: string): string {
  return `${messageEndpoint(id)}/regenerate`;
}

/** 世界书条目集合。 */
export const WORLDBOOK_ENDPOINT = `${API_PREFIX}/worldbook`;

/** 单个世界书条目。 */
export function worldbookEntryEndpoint(id: string): string {
  return `${WORLDBOOK_ENDPOINT}/${encodeURIComponent(id)}`;
}
