import type { Character, CharacterInput, CharacterList, CharacterSummary } from '@tavern/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError } from '@/api/client';
import {
  createCharacter,
  deleteCharacter,
  fetchCharacter,
  fetchCharacters,
  importCharacterCard,
  importCharacterFile,
  uploadAvatar,
} from '@/api/characters';
import { SAMPLE_AVATARS } from '@/samples/avatars';
import { SAMPLE_CARDS } from '@/samples/cards';

/** 搜索输入到请求之间的防抖时间。 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 角色列表状态仓库。
 *
 * 列表与详情分开管理：列表只需要摘要，详情按 id 现取，
 * 避免把十几个角色的长文本（人设、示例对话）一次性读进内存。
 */
/**
 * 把内联的 base64 头像还原成 Blob。
 *
 * 走 base64 而不是静态资源 URL，是为了让「导入示例」在开发与生产环境下
 * 行为完全一致（不需要额外的资源路径解析）。
 */
function sampleAvatarBlob(key: string): Blob | null {
  const base64 = SAMPLE_AVATARS[key];
  if (!base64) return null;
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: 'image/png' });
  } catch {
    return null;
  }
}

export const useCharacterStore = defineStore('characters', () => {
  const items = ref<CharacterSummary[]>([]);
  const total = ref(0);
  const search = ref('');
  const loading = ref(false);
  const importing = ref(false);
  const error = ref<string | null>(null);
  /** 正在导入的文件名，用于显示进度文案 */
  const importingName = ref<string | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const isEmpty = computed(() => !loading.value && items.value.length === 0);
  const hasSearch = computed(() => search.value.trim().length > 0);

  function describeError(cause: unknown): string {
    if (cause instanceof ApiError) {
      if (cause.isNetworkError) return '连不上后端，请确认服务已启动';
      return cause.message;
    }
    return cause instanceof Error ? cause.message : String(cause);
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      const page: CharacterList = await fetchCharacters({
        search: search.value.trim() || undefined,
        limit: 60,
      });
      items.value = page.items;
      total.value = page.total;
      error.value = null;
    } catch (cause) {
      error.value = describeError(cause);
      items.value = [];
      total.value = 0;
    } finally {
      loading.value = false;
    }
  }

  /** 搜索防抖：每敲一个字就发一次请求太浪费。 */
  function scheduleRefresh(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refresh();
    }, SEARCH_DEBOUNCE_MS);
  }

  function setSearch(value: string): void {
    search.value = value;
    scheduleRefresh();
  }

  async function importFile(file: File): Promise<Character | null> {
    importing.value = true;
    importingName.value = file.name;
    error.value = null;
    try {
      const created = await importCharacterFile(file);
      await refresh();
      return created;
    } catch (cause) {
      error.value = describeError(cause);
      return null;
    } finally {
      importing.value = false;
      importingName.value = null;
    }
  }

  /**
   * 一键导入内置示例角色。
   *
   * 两件事：先建角色（同名跳过），再补头像。
   * 头像单独走上传接口是因为「导入 JSON 卡」本身不带图，
   * 而示例的头像内联在 samples/avatars.ts 里。
   */
  async function importSamples(): Promise<number> {
    importing.value = true;
    importingName.value = '示例角色';
    error.value = null;
    let created = 0;

    try {
      const byName = new Map(items.value.map((item) => [item.name, item]));
      const needAvatar: Array<{ id: string; key: string }> = [];

      for (const sample of SAMPLE_CARDS) {
        const existing = byName.get(sample.name);
        if (existing) {
          // 已经存在：只要没有头像就补一张，不重复建角色
          if (!existing.avatarUrl) needAvatar.push({ id: existing.id, key: sample.avatarKey });
          continue;
        }

        const character = await importCharacterCard(sample.card);
        created += 1;
        needAvatar.push({ id: character.id, key: sample.avatarKey });
      }

      for (const item of needAvatar) {
        const blob = sampleAvatarBlob(item.key);
        if (blob) await uploadAvatar(item.id, blob).catch(() => undefined);
      }

      await refresh();
      return created;
    } catch (cause) {
      error.value = describeError(cause);
      return created;
    } finally {
      importing.value = false;
      importingName.value = null;
    }
  }

  /** 手动新建（表单提交）。成功返回 null，失败返回错误文案。 */
  async function createManual(input: CharacterInput): Promise<string | null> {
    try {
      await createCharacter(input);
      await refresh();
      return null;
    } catch (cause) {
      return describeError(cause);
    }
  }

  async function loadOne(id: string): Promise<Character | null> {
    try {
      return await fetchCharacter(id);
    } catch (cause) {
      error.value = describeError(cause);
      return null;
    }
  }

  async function remove(id: string): Promise<boolean> {
    try {
      await deleteCharacter(id);
      await refresh();
      return true;
    } catch (cause) {
      error.value = describeError(cause);
      return false;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    items,
    total,
    search,
    loading,
    importing,
    importingName,
    error,
    isEmpty,
    hasSearch,
    refresh,
    setSearch,
    importFile,
    importSamples,
    createManual,
    loadOne,
    remove,
    clearError,
  };
});
