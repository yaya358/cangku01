import type {
  Affinity,
  Snapshot,
  ChatStreamPayload,
  CreateSaveInput,
  Journal,
  MessageKind,
  PrivateSceneResult,
  Save,
  SaveStarted,
  SnapshotRestoreResult,
  Scene,
  SceneDetail,
  SceneOpening,
} from '@tavern/shared';
import {
  WORLD_SAVES_ENDPOINT,
  WORLD_SCENES_ENDPOINT,
  worldSaveAffinityEndpoint,
  worldSaveEndpoint,
  worldSaveJournalEndpoint,
  worldSaveRestartEndpoint,
  worldSaveScenesEndpoint,
  worldSaveSnapshotsEndpoint,
  worldSnapshotEndpoint,
  worldSnapshotRestoreEndpoint,
  worldSceneEndpoint,
  worldSceneOpeningEndpoint,
  worldScenePrivateEndpoint,
  worldSceneReturnEndpoint,
  worldSceneStreamEndpoint,
} from '@tavern/shared';
import { fetchCharacters } from './characters';
import { apiDelete, apiGet, apiPost } from './client';
import { readSseStream, throwIfNotOk } from './sse';

/**
 * 世界模式接口封装。
 *
 * 与 /conversations 的区别：这里是「去哪说话」，不是「跟谁说话」。
 * 能接话的人由场景的在场者决定，前端不自己挑人 —— 挑也没用，服务端不认。
 */

/** 场景列表项：带上在场者名字，列表里不用再查一次。 */
export interface SceneSummary extends Scene {
  present: { id: string; name: string; busyWith: string | null }[];
}

/** 全世界的场景（"对话"页的入口）：带上存档名、在场者、消息数与最后一句。 */
export interface SceneListItem extends Scene {
  saveName: string;
  presentCount: number;
  presentNames: string[];
  messageCount: number;
  preview: string;
}

export function listSaves(): Promise<Save[]> {
  return apiGet<Save[]>(WORLD_SAVES_ENDPOINT, { timeoutMs: 10_000 });
}

/** 所有场景（不分存档），按最近有动静排。 */
export function listAllScenes(): Promise<SceneListItem[]> {
  return apiGet<SceneListItem[]>(WORLD_SCENES_ENDPOINT, { timeoutMs: 15_000 });
}

export function listScenes(saveId: string): Promise<SceneSummary[]> {
  return apiGet<SceneSummary[]>(worldSaveScenesEndpoint(saveId), { timeoutMs: 10_000 });
}

export function createSave(input: CreateSaveInput): Promise<SaveStarted> {
  return apiPost<SaveStarted>(WORLD_SAVES_ENDPOINT, input);
}

/**
 * 重新开始：同一本故事、同样的名字和在场的人，进度清零。
 *
 * 返回新的 save 与第一个场景 —— 存档 id 会变，调用方要跳到新场景去。
 */
export function restartSave(saveId: string): Promise<SaveStarted> {
  return apiPost<SaveStarted>(worldSaveRestartEndpoint(saveId), {});
}

/** 手动存档：给这本故事拍一张快照 */
export function createSnapshot(saveId: string, label?: string): Promise<Snapshot> {
  return apiPost<Snapshot>(worldSaveSnapshotsEndpoint(saveId), label ? { label } : {});
}

/** 这个存档存过哪些快照（新的在前） */
export function listSnapshots(saveId: string): Promise<Snapshot[]> {
  return apiGet<Snapshot[]>(worldSaveSnapshotsEndpoint(saveId));
}

/** 读档：回到快照那一刻 */
export function restoreSnapshot(snapshotId: string): Promise<SnapshotRestoreResult> {
  return apiPost<SnapshotRestoreResult>(worldSnapshotRestoreEndpoint(snapshotId), {});
}

/** 删掉一张快照 */
export function deleteSnapshot(snapshotId: string): Promise<{ deleted: boolean }> {
  return apiDelete<{ deleted: boolean }>(worldSnapshotEndpoint(snapshotId));
}
/** 删除一个存档（连同它的场景、对话、主线一起）。 */
export function removeSave(saveId: string): Promise<{ deleted: boolean }> {
  return apiDelete<{ deleted: boolean }>(worldSaveEndpoint(saveId));
}

/** 场景详情：场景 + 在场者 + 名字对照表 + 当前分支的消息。 */
export function fetchScene(id: string): Promise<SceneDetail> {
  return apiGet<SceneDetail>(worldSceneEndpoint(id), { timeoutMs: 15_000 });
}

/**
 * 第一次走进场景时让世界先写一句（幂等）。
 *
 * 放成显式请求而不是塞进 GET 场景详情里：GET 不该产生副作用。
 */
export function ensureSceneOpening(id: string): Promise<SceneOpening> {
  return apiPost<SceneOpening>(worldSceneOpeningEndpoint(id), {}, { timeoutMs: 30_000 });
}

/** 这个存档里所有人对你的好感（界面上的好感条）。 */
export function fetchAffinity(saveId: string): Promise<Affinity[]> {
  return apiGet<Affinity[]>(worldSaveAffinityEndpoint(saveId), { timeoutMs: 10_000 });
}

/** 侧栏要用的一整份资料：主线进度 + 情报本 + 好感。 */
export function fetchJournal(saveId: string): Promise<Journal> {
  return apiGet<Journal>(worldSaveJournalEndpoint(saveId), { timeoutMs: 10_000 });
}

export interface SendSceneHandlers {
  signal?: AbortSignal;
  kind?: MessageKind;
  /** 低声说：同场的人有机会听不到（第 3 步起起作用） */
  whisper?: boolean;
  onEvent: (event: ChatStreamPayload) => void;
}

/**
 * 在场景里说一句并接收流式回复。
 *
 * 服务端同一轮内完成：写用户消息 → 挑接话的人 → 组装上下文 → 生成 → 写助手消息，
 * 最后回一帧 `saved` 告诉我们两条消息的真实 id。
 */
export async function sendSceneTurn(
  sceneId: string,
  content: string,
  handlers: SendSceneHandlers,
): Promise<void> {
  const response = await fetch(worldSceneStreamEndpoint(sceneId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      content,
      ...(handlers.kind ? { kind: handlers.kind } : {}),
      ...(handlers.whisper ? { whisper: true } : {}),
    }),
    signal: handlers.signal,
  });

  await throwIfNotOk(response);
  await readSseStream(response, handlers.onEvent);
}

/**
 * 把在场的人带到私密场景（后巷）。
 *
 * 服务端会顺手把「离开」这件事记进原场景的日志 —— 带人走不是免费的，
 * 留下的人看见了就是看见了。
 */
export function createPrivateScene(
  sceneId: string,
  characterId: string,
  name?: string,
): Promise<PrivateSceneResult> {
  return apiPost<PrivateSceneResult>(worldScenePrivateEndpoint(sceneId), {
    characterId,
    ...(name ? { name } : {}),
  });
}

/** 从私密场景回到原来那个公开场景（把人一起带回去）。 */
export function returnToSourceScene(sceneId: string): Promise<{ scene: Scene }> {
  return apiPost<{ scene: Scene }>(worldSceneReturnEndpoint(sceneId));
}

/**
 * 「进入酒馆」用：找到一个能直接进去的场景，没有就开一个。
 *
 * 空库时先建存档（把前几个人放进去），这样第一次点进来就有地方站着 ——
 * 否则新用户会看到一个「没有场景」的死胡同。
 */
export async function ensureDefaultScene(): Promise<string | null> {
  const saves = await listSaves();

  // 优先沿用已有存档里的公开场景；私聊场景不该被当成默认入口
  for (const save of saves) {
    const scenes = await listScenes(save.id);
    const target = scenes.find((scene) => scene.kind === 'public') ?? scenes[0];
    if (target) return target.id;
  }

  // 一个存档都没有：挑几个已有的角色当首批在场者
  const characters = await fetchCharacters({ limit: 12 });
  const picked = characters.items.slice(0, 3).map((item) => item.id);
  const created = await createSave({
    name: '月灯镇',
    sceneName: '月灯酒馆',
    ...(picked.length > 0 ? { characterIds: picked } : {}),
  });
  return created.scene.id;
}
