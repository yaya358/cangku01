/**
 * 世界书（World Info / Lorebook）的触发引擎。
 *
 * 这是"酒馆味"的来源：角色卡只写了人设，但世界的设定（王都、魔法体系、
 * 某个 NPC 的旧事）不可能全塞进 prompt —— 那样既贵又跑题。
 *
 * 做法：平时不注入，等对话里出现「关键词」才把对应条目插进去，
 * 而且允许条目之间互相触发（A 提到 B 就再扫一遍），但要防住死循环。
 */

export interface WorldbookEntry {
  id: string;
  title: string;
  /** 主关键词：命中任意一个即触发 */
  keys: readonly string[];
  /** 次要关键词：非空时要求主次同时命中（减少误触发） */
  secondaryKeys?: readonly string[];
  content: string;
  /** 常驻条目：不看关键词，永远注入 */
  constant?: boolean;
  /** 是否区分大小写 */
  caseSensitive?: boolean;
  /** 排序权重，越大越靠前（同时受条数与 token 预算约束） */
  priority?: number;
  enabled?: boolean;
}

export interface WorldbookHit {
  entry: WorldbookEntry;
  /** 命中的那个关键词，便于前端展示「因为提到了 X 才触发」 */
  keyword: string;
  /** 第几轮扫描发现的（0 = 用户输入直接命中） */
  pass: number;
}

export interface ScanOptions {
  /** 最多扫几轮（条目内容里再触发新条目），默认 3 */
  maxPasses?: number;
  /** 最多触发多少条，默认 8；防止一篇文章把上下文吃光 */
  maxEntries?: number;
  /** 已经触发过的条目 id，避免同一轮重复注入 */
  alreadyTriggered?: Iterable<string>;
}

export interface ScanResult {
  /** 按 priority 降序、pass 升序排好 */
  hits: WorldbookHit[];
  /** 实际扫了几轮 */
  passes: number;
  /** 达到上限被截断的条目数 */
  skipped: number;
}

const DEFAULT_MAX_PASSES = 3;
const DEFAULT_MAX_ENTRIES = 8;

/** 关键词是否命中文本。空关键词视为不命中（否则会全量触发）。 */
function matches(text: string, keyword: string, caseSensitive: boolean): boolean {
  const needle = keyword.trim();
  if (needle.length === 0) return false;

  if (caseSensitive) return text.includes(needle);
  return text.toLowerCase().includes(needle.toLowerCase());
}

/** 找出该条目命中的关键词；没命中返回 null。 */
function findHit(text: string, entry: WorldbookEntry): { keyword: string } | null {
  const caseSensitive = entry.caseSensitive ?? false;

  const primary = entry.keys.find((keyword) => matches(text, keyword, caseSensitive));
  if (!primary) return null;

  const secondaryKeys = entry.secondaryKeys ?? [];
  if (secondaryKeys.length > 0) {
    const secondary = secondaryKeys.some((keyword) => matches(text, keyword, caseSensitive));
    if (!secondary) return null;
  }

  return { keyword: primary };
}

/**
 * 扫描世界书。
 *
 * 递归规则：第 0 轮只扫「用户输入 + 最近对话」，之后每一轮把上一轮命中条目的
 * 内容当作待扫文本 —— 于是「提到王都 → 注入王都设定 → 设定里提到黑市 →
 * 再注入黑市」这种链式触发能自然发生。
 *
 * 三轮上限 + 条数上限 + 已触发集合，三个闸门一起防死循环。
 */
export function scanWorldbook(
  entries: readonly WorldbookEntry[],
  seedText: string,
  options: ScanOptions = {},
): ScanResult {
  const maxPasses = options.maxPasses ?? DEFAULT_MAX_PASSES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const triggered = new Set<string>(options.alreadyTriggered ?? []);

  // 先按优先级排一遍：条数上限吃满时，留下的应该是高优先级条目，
  // 而不是「数组里恰好排在前面的那几个」。
  const available = entries
    .filter((entry) => entry.enabled !== false)
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        (right.entry.priority ?? 0) - (left.entry.priority ?? 0) || left.index - right.index,
    )
    .map((item) => item.entry);
  const hits: WorldbookHit[] = [];
  let skipped = 0;

  // 常驻条目不需要关键词，直接进（但仍占条数配额）
  for (const entry of available) {
    if (!entry.constant) continue;
    if (triggered.has(entry.id)) continue;
    if (hits.length >= maxEntries) {
      skipped += 1;
      continue;
    }
    triggered.add(entry.id);
    hits.push({ entry, keyword: '(常驻)', pass: 0 });
  }

  let pass = 0;
  let scanText = seedText;

  while (pass < maxPasses && scanText.trim().length > 0) {
    const discovered: WorldbookHit[] = [];

    for (const entry of available) {
      if (entry.constant) continue;
      if (triggered.has(entry.id)) continue;

      const hit = findHit(scanText, entry);
      if (!hit) continue;

      if (hits.length + discovered.length >= maxEntries) {
        skipped += 1;
        continue;
      }

      triggered.add(entry.id);
      discovered.push({ entry, keyword: hit.keyword, pass });
    }

    if (discovered.length === 0) break;

    hits.push(...discovered);
    // 下一轮的待扫文本 = 本轮新增条目的内容（它们可能提到别的条目）
    scanText = discovered.map((hit) => hit.entry.content).join('\n');
    pass += 1;
  }

  hits.sort(
    (left, right) =>
      (right.entry.priority ?? 0) - (left.entry.priority ?? 0) || left.pass - right.pass,
  );

  return { hits, passes: pass, skipped };
}

/** 把命中结果转换成上下文管线要的层输入。 */
export function toWorldbookLayers(
  hits: readonly WorldbookHit[],
): { id: string; title: string; content: string; keywords: string[] }[] {
  return hits.map((hit) => ({
    id: hit.entry.id,
    title: hit.entry.title,
    content: hit.entry.content,
    keywords: [hit.keyword],
  }));
}
