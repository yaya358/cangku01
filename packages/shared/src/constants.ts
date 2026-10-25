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

/**
 * 世界模式：存档 → 场景 → 在场者。
 *
 * 场景是新的「说话的地方」，所以流式接口挂在场景下，而不是挂到某个角色上。
 */
export const WORLD_SAVES_ENDPOINT = `${API_PREFIX}/world/saves`;

/** 某存档下的场景集合。 */
export function worldSaveScenesEndpoint(saveId: string): string {
  return `${WORLD_SAVES_ENDPOINT}/${encodeURIComponent(saveId)}/scenes`;
}

/** 某存档里所有人对你的好感（界面上的好感条）。 */
export function worldSaveAffinityEndpoint(saveId: string): string {
  return `${WORLD_SAVES_ENDPOINT}/${encodeURIComponent(saveId)}/affinity`;
}

/** 某存档的侧栏资料：主线章节 + 情报本 + 好感。 */
export function worldSaveJournalEndpoint(saveId: string): string {
  return `${WORLD_SAVES_ENDPOINT}/${encodeURIComponent(saveId)}/journal`;
}

/** 场景集合（详情、进场都要用）。 */
export const WORLD_SCENES_ENDPOINT = `${API_PREFIX}/world/scenes`;

/** 单个场景（详情：在场者 + 消息）。 */
export function worldSceneEndpoint(id: string): string {
  return `${WORLD_SCENES_ENDPOINT}/${encodeURIComponent(id)}`;
}

/** 场景内说一句并流式生成（SSE）。 */
export function worldSceneStreamEndpoint(id: string): string {
  return `${worldSceneEndpoint(id)}/stream`;
}

/** 第一次走进场景时，让世界先写一句开场（幂等）。 */
export function worldSceneOpeningEndpoint(id: string): string {
  return `${worldSceneEndpoint(id)}/opening`;
}

/** 场景的在场者集合（进场）。 */
export function worldScenePresenceEndpoint(id: string): string {
  return `${worldSceneEndpoint(id)}/presence`;
}

/** 某个人的在场记录（离场）。 */
export function worldScenePresenceMemberEndpoint(id: string, characterId: string): string {
  return `${worldScenePresenceEndpoint(id)}/${encodeURIComponent(characterId)}`;
}

/** 把在场的人带到私密场景（后巷 / 账房）。 */
export function worldScenePrivateEndpoint(id: string): string {
  return `${worldSceneEndpoint(id)}/private`;
}

/** 从私密场景回到原来那个公开场景（把人一起带回来）。 */
export function worldSceneReturnEndpoint(id: string): string {
  return `${worldSceneEndpoint(id)}/return`;
}

/** 世界书条目集合。 */
export const WORLDBOOK_ENDPOINT = `${API_PREFIX}/worldbook`;

/** 单个世界书条目。 */
export function worldbookEntryEndpoint(id: string): string {
  return `${WORLDBOOK_ENDPOINT}/${encodeURIComponent(id)}`;
}

/** 某角色的小剧本事件集合。 */
export function scriptEventsEndpoint(characterId: string): string {
  return `${characterEndpoint(characterId)}/events`;
}

/** 单条剧本事件。 */
export const SCRIPT_EVENT_ENDPOINT = `${API_PREFIX}/script-events`;

export function scriptEventEndpoint(id: string): string {
  return `${SCRIPT_EVENT_ENDPOINT}/${encodeURIComponent(id)}`;
}

/** 导出某角色的整份剧本（JSON）。 */
export function scriptExportEndpoint(characterId: string): string {
  return `${SCRIPT_EVENT_ENDPOINT}/by-character/${encodeURIComponent(characterId)}/export`;
}

/** 导入一份剧本到某角色。 */
export function scriptImportEndpoint(characterId: string): string {
  return `${SCRIPT_EVENT_ENDPOINT}/by-character/${encodeURIComponent(characterId)}/import`;
}
