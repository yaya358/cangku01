import type {
  ChatStreamPayload,
  CreateSaveInput,
  MessageKind,
  PrivateSceneResult,
  Save,
  Scene,
  SceneDetail,
} from '@tavern/shared';
import {
  WORLD_SAVES_ENDPOINT,
  worldSaveScenesEndpoint,
  worldSceneEndpoint,
  worldScenePrivateEndpoint,
  worldSceneReturnEndpoint,
  worldSceneStreamEndpoint,
} from '@tavern/shared';
import { fetchCharacters } from './characters';
import { apiGet, apiPost } from './client';
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

export function listSaves(): Promise<Save[]> {
  return apiGet<Save[]>(WORLD_SAVES_ENDPOINT, { timeoutMs: 10_000 });
}

export function listScenes(saveId: string): Promise<SceneSummary[]> {
  return apiGet<SceneSummary[]>(worldSaveScenesEndpoint(saveId), { timeoutMs: 10_000 });
}

export function createSave(input: CreateSaveInput): Promise<{ save: Save; scene: Scene }> {
  return apiPost<{ save: Save; scene: Scene }>(WORLD_SAVES_ENDPOINT, input);
}

/** 场景详情：场景 + 在场者 + 名字对照表 + 当前分支的消息。 */
export function fetchScene(id: string): Promise<SceneDetail> {
  return apiGet<SceneDetail>(worldSceneEndpoint(id), { timeoutMs: 15_000 });
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
