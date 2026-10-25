import type { Character, CharacterInput, CharacterList, CharacterSummary } from '@tavern/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError } from '@/api/client';
import {
  createCharacter,
  deleteCharacter,
  fetchCharacter,
  fetchCharacters,
  importCharacterFile,
  seedSampleCharacters,
} from '@/api/characters';

/** 搜索输入到请求之间的防抖时间。 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 角色列表状态仓库。
 *
 * 列表与详情分开管理：列表只需要摘要，详情按 id 现取，
 * 避免把十几个角色的长文本（人设、示例对话）一次性读进内存。
 */
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
   * 补回内置示例角色（走服务端播种接口）。
   *
   * 播种逻辑在服务端：空库首次启动会自动写一次，这里是手动重放入口，
   * 用来「我把示例删了，想再要回来」。接口幂等：同名只补头像，不覆盖用户改动。
   */
  async function seedSamples(): Promise<number> {
    importing.value = true;
    importingName.value = '示例角色';
    error.value = null;

    try {
      const result = await seedSampleCharacters();
      await refresh();
      return result.created.length;
    } catch (cause) {
      error.value = describeError(cause);
      return 0;
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
    seedSamples,
    createManual,
    loadOne,
    remove,
    clearError,
  };
});
