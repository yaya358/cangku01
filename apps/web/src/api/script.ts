import type { ScriptEvent, ScriptEventInput, ScriptEventPatch } from '@tavern/shared';
import { SCRIPT_EVENT_ENDPOINT, scriptEventEndpoint } from '@tavern/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from './client';

/**
 * 剧本事件接口。
 *
 * 挂在角色下：事件天然属于某个角色的小剧本。
 */
function byCharacter(characterId: string): string {
  return `${SCRIPT_EVENT_ENDPOINT}/by-character/${encodeURIComponent(characterId)}`;
}

export function listScriptEvents(characterId: string): Promise<ScriptEvent[]> {
  return apiGet<ScriptEvent[]>(byCharacter(characterId), { timeoutMs: 10_000 });
}

export function createScriptEvent(
  characterId: string,
  input: ScriptEventInput,
): Promise<ScriptEvent> {
  return apiPost<ScriptEvent>(byCharacter(characterId), input);
}

export function updateScriptEvent(id: string, patch: ScriptEventPatch): Promise<ScriptEvent> {
  return apiPatch<ScriptEvent>(scriptEventEndpoint(id), patch);
}

export function deleteScriptEvent(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiDelete<{ id: string; deleted: boolean }>(scriptEventEndpoint(id));
}
