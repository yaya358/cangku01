import type { WorldbookEntryDto, WorldbookInput, WorldbookPatch } from '@tavern/shared';
import { WORLDBOOK_ENDPOINT, worldbookEntryEndpoint } from '@tavern/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from './client';

/**
 * 世界书接口封装。
 *
 * 列表按角色取时会包含全局条目 —— 与对话里实际生效的范围一致。
 */

export function listWorldbook(characterId?: string): Promise<WorldbookEntryDto[]> {
  const suffix = characterId ? `?characterId=${encodeURIComponent(characterId)}` : '';
  return apiGet<WorldbookEntryDto[]>(`${WORLDBOOK_ENDPOINT}${suffix}`, { timeoutMs: 10_000 });
}

export function createWorldbookEntry(input: WorldbookInput): Promise<WorldbookEntryDto> {
  return apiPost<WorldbookEntryDto>(WORLDBOOK_ENDPOINT, input);
}

export function updateWorldbookEntry(
  id: string,
  patch: WorldbookPatch,
): Promise<WorldbookEntryDto> {
  return apiPatch<WorldbookEntryDto>(worldbookEntryEndpoint(id), patch);
}

export function deleteWorldbookEntry(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiDelete<{ id: string; deleted: boolean }>(worldbookEntryEndpoint(id));
}
