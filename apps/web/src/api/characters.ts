import {
  CHARACTERS_ENDPOINT,
  CHARACTER_IMPORT_ENDPOINT,
  characterAvatarEndpoint,
  characterEndpoint,
  characterExportJsonEndpoint,
  characterExportPngEndpoint,
} from '@tavern/shared';
import type { Character, CharacterInput, CharacterList, CharacterPatch } from '@tavern/shared';
import { apiDelete, apiGet, apiPatch, apiPost, postBinary } from './client';

/**
 * 角色卡接口封装。
 *
 * 页面只跟这一层打交道，路径与参数拼装都在这里，
 * 以后接口路径调整不会波及视图。
 */

export interface CharacterQuery {
  search?: string;
  limit?: number;
  offset?: number;
}

export function fetchCharacters(query: CharacterQuery = {}): Promise<CharacterList> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));

  const suffix = params.toString();
  return apiGet<CharacterList>(`${CHARACTERS_ENDPOINT}${suffix ? `?${suffix}` : ''}`, {
    timeoutMs: 10_000,
  });
}

export function fetchCharacter(id: string): Promise<Character> {
  return apiGet<Character>(characterEndpoint(id), { timeoutMs: 10_000 });
}

export function createCharacter(input: CharacterInput): Promise<Character> {
  return apiPost<Character>(CHARACTERS_ENDPOINT, input);
}

export function updateCharacter(id: string, patch: CharacterPatch): Promise<Character> {
  return apiPatch<Character>(characterEndpoint(id), patch);
}

export function deleteCharacter(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiDelete<{ id: string; deleted: boolean }>(characterEndpoint(id));
}

/**
 * 上传/替换头像。
 *
 * 导入 PNG 角色卡时头像随卡片一起进来；手动创建的角色用这个补上。
 * 后端原字节落盘，不重新编码。
 */
export function uploadAvatar(id: string, png: Blob): Promise<Character> {
  return postBinary<Character>(characterAvatarEndpoint(id), png, 'image/png', {
    timeoutMs: 30_000,
  });
}

/** 导入角色卡 PNG（图片本身就是一张卡，后端会把图存成头像）。 */
export function importCharacterPng(file: File): Promise<Character> {
  return postBinary<Character>(CHARACTER_IMPORT_ENDPOINT, file, 'image/png', {
    timeoutMs: 30_000,
  });
}

/** 导入角色卡 JSON（V1/V2/V3 都行，后端负责归一化）。 */
export async function importCharacterJson(file: File): Promise<Character> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('这个文件不是合法 JSON');
  }

  // 用原始 fetch 而不是 apiPost：要把「卡片的 JSON 原文」原样递过去，
  // 而不是再包一层 { card: ... }。
  return apiPost<Character>(CHARACTER_IMPORT_ENDPOINT, parsed, { timeoutMs: 30_000 });
}

/** 根据文件类型选择导入方式。 */
export function importCharacterFile(file: File): Promise<Character> {
  if (file.type === 'image/png' || file.name.toLowerCase().endsWith('.png')) {
    return importCharacterPng(file);
  }
  return importCharacterJson(file);
}

/** 导出为角色卡 PNG 的地址（浏览器直接下载，不必先请求再转 blob）。 */
export function exportCardPngUrl(id: string): string {
  return characterExportPngEndpoint(id);
}

/** 直接导入一个已解析好的卡片对象（内置示例角色走这条）。 */
export function importCharacterCard(card: unknown): Promise<Character> {
  return apiPost<Character>(CHARACTER_IMPORT_ENDPOINT, card, { timeoutMs: 15_000 });
}

export interface ExportedCard {
  filename: string;
  card: unknown;
}

/** 导出为 V2 卡片 JSON。 */
export function exportCardJson(id: string): Promise<ExportedCard> {
  return apiGet<ExportedCard>(characterExportJsonEndpoint(id), { timeoutMs: 15_000 });
}
