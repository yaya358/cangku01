import type { ChatMessage } from '@tavern/shared';
import { estimateTokens } from './tokens.js';
import { DEFAULT_BUDGET, DEFAULT_SYSTEM_PROMPT } from './types.js';
import type { AssembledContext, AssembleInput, ContextBudget, ContextLayer } from './types.js';

/**
 * 上下文组装管线。
 *
 * 顺序即「模型看到的顺序」：
 *   系统提示 → 角色人设 → 场景 → 世界书 → 前情摘要 → 历史对话 → 历史后指令 → 本轮输入
 *
 * 裁剪只看 priority，不看顺序：同一个数组既决定拼装顺序又决定裁剪优先级，
 * 用两个字段分开表达，避免「为了裁剪方便而打乱语义顺序」。
 */

/** 保留优先级（越大越不容易被裁）。 */
const PRIORITY = {
  userInput: 1000,
  system: 950,
  postHistory: 800,
  persona: 700,
  // 秘密与目的比场景重要：丢了它角色就退回「问一句答一句」
  motive: 680,
  // 玩家身份：决定角色对谁说话，丢了就变成对陌生人客套
  userPersona: 730,
  // 剧本事件：这一轮刚发生的事，比场景和世界书都更该被看到
  event: 690,
  // 剧情事实：已经算数的事，丢了角色就会「翻脸不认」
  fact: 685,
  scenario: 650,
  // 此刻在哪个场景、谁在场：比世界书要紧（说错人比少一段设定更伤）
  scene: 660,
  worldbook: 600,
  summary: 500,
  historyBase: 300,
} as const;

/** 低于这个优先级的层不尝试截断，直接丢弃（截半句历史没有意义）。 */
const TRUNCATE_FLOOR = 600;

/** 截断后至少要保留的 token 数，太小等于没保留。 */
const MIN_TRUNCATED_TOKENS = 48;

/** 把 {{char}} / {{user}} 替换成实际名字。写死在角色卡里的文本靠它生效。 */
function substitute(text: string, charName: string, userName: string): string {
  return text
    .replaceAll('{{char}}', charName)
    .replaceAll('{{user}}', userName)
    .replaceAll('{{char_name}}', charName)
    .replaceAll('{{user_name}}', userName);
}

/** 生成一层，同时算好 token。空内容返回 null，避免往 prompt 里塞空行。 */
function makeLayer(layer: Omit<ContextLayer, 'tokens'>): ContextLayer | null {
  const content = layer.content.trim();
  if (content.length === 0) return null;
  return { ...layer, content, tokens: estimateTokens(content) };
}

let historySeq = 0;

/** 按 token 上限截断文本，尽量在句子边界断开。 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens < MIN_TRUNCATED_TOKENS) return '';

  // 先按比例估一个字符数，再逐步收敛（估算函数不是线性的，留一步校正）
  const totalTokens = estimateTokens(text);
  if (totalTokens <= maxTokens) return text;

  let limitChars = Math.floor((text.length * maxTokens) / totalTokens);
  let candidate = text.slice(0, limitChars);

  for (let attempt = 0; attempt < 8 && estimateTokens(candidate) > maxTokens; attempt += 1) {
    limitChars = Math.floor(limitChars * 0.85);
    candidate = text.slice(0, limitChars);
  }

  // 优先在句末/换行处断开，读起来不突兀
  const boundary = Math.max(
    candidate.lastIndexOf('。'),
    candidate.lastIndexOf('！'),
    candidate.lastIndexOf('？'),
    candidate.lastIndexOf('\n'),
    candidate.lastIndexOf('.'),
  );
  if (boundary > candidate.length * 0.6) candidate = candidate.slice(0, boundary + 1);

  return `${candidate.trimEnd()}…`;
}

/**
 * 按输入方式给玩家这句话套壳。
 *
 * 为什么要区分：同一句「推开门」，
 *   当成说话（他说"推开门"）和当行动（他推开门）交给模型是两回事。
 * 套上壳模型就不用猜，也不会把行动当成一句话复述回来。
 */
function wrapUserInput(input: AssembleInput, userName: string): string {
  const text = input.userInput.trim();
  /**
   * 低声只是「怎么说」，不改变「说什么」：所以先按输入方式套壳，
   * 再在说话这一档上换成压低声音的说法。行动/旁白低声没有意义，原样处理。
   */
  if (input.whisper && (input.userInputKind === undefined || input.userInputKind === 'speak')) {
    return `${userName}压低声音说：「${text}」`;
  }
  switch (input.userInputKind) {
    case 'act':
      return `${userName}（行动）：${text}`;
    case 'think':
      return `${userName}（心里想，没有说出口）：${text}`;
    case 'narrate':
      return `【旁白】${text}`;
    case 'ooc':
      return `【场外（不是角色的发言，是玩家在跟你说话）】${text}`;
    case 'speak':
    default:
      return `${userName}说：「${text}」`;
  }
}

/** 收集所有层（未裁剪），顺序即拼装顺序。 */
function collectLayers(input: AssembleInput, charName: string, userName: string): ContextLayer[] {
  const layers: (ContextLayer | null)[] = [];
  const character = input.character;

  // 1. 系统提示：角色自己写了就用角色的，否则用全局默认
  const systemText = character.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  layers.push(
    makeLayer({
      id: 'system',
      kind: 'system',
      title: '系统提示',
      content: substitute(systemText, charName, userName),
      priority: PRIORITY.system,
      splittable: false,
    }),
  );

  /**
   * 2. 玩家身份。
   *
   * 没有这一层时，角色只能对「一个陌生人」说话，于是全是客套。
   * 有了身份与目的，它才知道该戒备、该讨好还是该试探。
   */
  const playerRole = input.player?.role?.trim() ?? '';
  const playerGoal = input.player?.goal?.trim() ?? '';
  if (playerRole.length > 0 || playerGoal.length > 0) {
    const parts = [`【坐在你对面的人】${userName}`];
    if (playerRole.length > 0) parts.push(`身份：${substitute(playerRole, charName, userName)}`);
    if (playerGoal.length > 0) {
      parts.push(`此人想要：${substitute(playerGoal, charName, userName)}`);
    }
    parts.push(
      '把对方当成这个身份来对待 —— 该戒备就戒备，该试探就试探，' +
        '不要把他当成第一次见面的陌生人寒暄。',
    );

    layers.push(
      makeLayer({
        id: 'user_persona',
        kind: 'user_persona',
        title: '玩家身份',
        content: parts.join('\n'),
        priority: PRIORITY.userPersona,
        splittable: false,
      }),
    );
  }

  // 3. 角色人设：名字 + 描述 + 性格
  const personaParts: string[] = [`【角色】${charName}`];
  if (character.description.trim().length > 0) personaParts.push(character.description.trim());
  if (character.personality.trim().length > 0) {
    personaParts.push(`【性格】${character.personality.trim()}`);
  }
  layers.push(
    makeLayer({
      id: 'persona',
      kind: 'persona',
      title: '角色人设',
      content: substitute(personaParts.join('\n'), charName, userName),
      priority: PRIORITY.persona,
      splittable: true,
    }),
  );

  // 3. 场景
  if (character.scenario.trim().length > 0) {
    layers.push(
      makeLayer({
        id: 'scenario',
        kind: 'scenario',
        title: '场景',
        content: `【场景】${substitute(character.scenario.trim(), charName, userName)}`,
        priority: PRIORITY.scenario,
        splittable: true,
      }),
    );
  }

  /**
   * 3.5 此刻的地方与在场的人（世界模式）。
   *
   * 这段的价值不在氛围，而在约束：模型很容易把「不在场的人」也拉进来说话，
   * 或者把压低声音说的话当众说出来。把「谁在」「听不听得见」写进 prompt，
   * 它才知道该对谁说、该不该避人。
   */
  if (input.scene) {
    const scene = input.scene;
    const privateScene = scene.kind === 'private';
    const parts: string[] = [
      `【此刻的地方】${scene.name} · ${privateScene ? '只有你们两个人' : '公开场所，人来人往'}`,
    ];
    if (privateScene) {
      parts.push('周围没有别人 —— 说出口的话不会传出去。');
    } else if (scene.others && scene.others.length > 0) {
      const others = scene.others
        .map((other) => (other.busyWith ? `${other.name}（${other.busyWith}）` : other.name))
        .join('、');
      parts.push(`在场的还有：${others}。`);
      parts.push('你只对在场的人说话，不要凭空叫出不在场的人。');
      if (input.whisper) {
        parts.push(`他这句话是压低声音说的 —— 旁边的${others}未必听得见。`);
      }
    }

    layers.push(
      makeLayer({
        id: 'scene',
        kind: 'scene',
        title: '此刻的地方',
        content: substitute(parts.join('\n'), charName, userName),
        priority: PRIORITY.scene,
        splittable: false,
      }),
    );
  }

  /**
   * 4. 秘密与目的。
   *
   * 没有这两项时，角色只会「问一句答一句」；有了它们才有戏：
   *   - 目的是它的动机，会让它主动试探、讨好、设套
   *   - 秘密是它的软肋，玩家得追问、给好处、抓住矛盾才能挖出来
   * 提示词必须写清「绝不主动交代」，否则模型会一开口就把底牌全抖了。
   */
  const secret = character.secret?.trim() ?? '';
  const goal = character.goal?.trim() ?? '';
  if (secret.length > 0 || goal.length > 0) {
    const motiveParts: string[] = ['【你心里的事】'];
    if (goal.length > 0) {
      motiveParts.push(
        `你想要：${substitute(goal, charName, userName)}`,
        '这会驱动你的行为 —— 可以主动试探、示好、转移话题、提条件，不必等对方先开口。',
      );
    }
    if (secret.length > 0) {
      motiveParts.push(
        `你隐藏的事：${substitute(secret, charName, userName)}`,
        '这件事绝不主动说出。只有被直接问到、被证据逼住，或你足够信任对方时，才可以松口；' +
          '即便如此，也先用回避、反问或半真半假的话挡一挡。',
      );
    }

    layers.push(
      makeLayer({
        id: 'motive',
        kind: 'motive',
        title: '秘密与目的',
        content: motiveParts.join('\n'),
        priority: PRIORITY.motive,
        splittable: false,
      }),
    );
  }

  /**
   * 5. 剧情事实（已经成立的事）。
   *
   * 这段必须写成「不可推翻」：模型很容易在下一轮把刚才发生的事当成没发生，
   * 于是玩家说「你刚才承认了」，它又装回去。
   */
  if (input.facts && input.facts.length > 0) {
    layers.push(
      makeLayer({
        id: 'facts',
        kind: 'fact',
        title: '已经发生的事',
        content: [
          '【已经发生的事】',
          ...input.facts.map((fact) => `- ${substitute(fact, charName, userName)}`),
          '这些事已经发生、无法否认，你的言行必须与之一致，不要装作没发生过。',
        ].join('\n'),
        priority: PRIORITY.fact,
        splittable: false,
      }),
    );
  }

  /**
   * 6. 剧本事件（这一轮到点了，发生了什么）。
   *
   * 关键在最后那句指令：只描述「有人推门进来」还不够，
   * 模型可能当旁白念一遍就继续闲聊 —— 必须明确要求它对这件事做出反应。
   */
  for (const event of input.events ?? []) {
    layers.push(
      makeLayer({
        id: `event:${event.id}`,
        kind: 'event',
        title: `剧情 · ${event.title}`,
        content: [
          `【刚刚发生】${substitute(event.content, charName, userName)}`,
          '这是此刻正在发生的事。你的回复必须让人看出你在应对它' +
            '（动作、神态或一句话），不要只回答对方的问题，也不要把它当背景介绍略过。',
        ].join('\n'),
        priority: PRIORITY.event,
        splittable: false,
        meta: { turn: event.turn ?? 0 },
      }),
    );
  }

  // 6. 世界书（提到才注入的设定）
  for (const entry of input.worldbook ?? []) {
    layers.push(
      makeLayer({
        id: `worldbook:${entry.id}`,
        kind: 'worldbook',
        title: `世界书 · ${entry.title}`,
        content: substitute(entry.content, charName, userName),
        priority: PRIORITY.worldbook,
        splittable: true,
        meta: { keywords: entry.keywords ?? [] },
      }),
    );
  }

  // 5. 前情摘要（长对话的压缩结果）
  if (input.summary && input.summary.trim().length > 0) {
    layers.push(
      makeLayer({
        id: 'summary',
        kind: 'summary',
        title: '前情提要',
        content: `【前情提要】\n${substitute(input.summary.trim(), charName, userName)}`,
        priority: PRIORITY.summary,
        splittable: true,
      }),
    );
  }

  // 6. 历史对话：一条一层，越新优先级越高（裁剪时先丢最早的）
  const history = input.history.filter((message) => message.content.trim().length > 0);
  history.forEach((message, index) => {
    const recency = index; // 0 = 最早
    layers.push(
      makeLayer({
        id: `history:${historySeq++}`,
        kind: 'history',
        title: `${message.role === 'user' ? userName : charName}`,
        content: substitute(message.content, charName, userName),
        priority: PRIORITY.historyBase + recency,
        splittable: false,
        meta: { role: message.role, index, name: message.name },
      }),
    );
  });

  // 7. 历史后指令：放在历史之后，用来压制模型跑偏
  if (character.postHistoryInstructions?.trim()) {
    layers.push(
      makeLayer({
        id: 'post_history',
        kind: 'post_history',
        title: '历史后指令',
        content: substitute(character.postHistoryInstructions.trim(), charName, userName),
        priority: PRIORITY.postHistory,
        splittable: false,
      }),
    );
  }

  // 8. 本轮输入：永远保留
  layers.push(
    makeLayer({
      id: 'user_input',
      kind: 'user_input',
      title: '本轮输入',
      content: substitute(wrapUserInput(input, userName), charName, userName),
      priority: PRIORITY.userInput,
      splittable: false,
    }),
  );

  return layers.filter((layer): layer is ContextLayer => layer !== null);
}

/**
 * 按预算裁剪层。
 *
 * 策略：按优先级从高到低塞，塞不下时——
 *   - 高优先级层（人设/世界书这类长文本）尝试截断后塞进去
 *   - 低优先级层（历史）整层丢弃
 * 这样「人设尽量完整、历史能丢就丢」，符合角色扮演的直觉。
 */
function applyBudget(
  layers: readonly ContextLayer[],
  budget: ContextBudget,
): { kept: ContextLayer[]; dropped: ContextLayer[]; notes: string[] } {
  const totalTokens = layers.reduce((sum, layer) => sum + layer.tokens, 0);
  if (totalTokens <= budget.available) {
    return { kept: [...layers], dropped: [], notes: [] };
  }

  const notes: string[] = [];
  const dropped: ContextLayer[] = [];

  // 依据优先级降序；同优先级保持原顺序（稳定排序）
  const ordered = layers
    .map((layer, index) => ({ layer, index }))
    .sort((left, right) => right.layer.priority - left.layer.priority || left.index - right.index);

  const accepted = new Map<string, ContextLayer>();
  let remaining = budget.available;

  for (const { layer } of ordered) {
    if (layer.tokens <= remaining) {
      accepted.set(layer.id, layer);
      remaining -= layer.tokens;
      continue;
    }

    // 塞不下：高价值的长文本尝试截断
    if (layer.priority >= TRUNCATE_FLOOR && remaining >= MIN_TRUNCATED_TOKENS) {
      const content = truncateToTokens(layer.content, remaining);
      if (content.length > 0) {
        accepted.set(`${layer.id}:truncated`, {
          ...layer,
          id: `${layer.id}:truncated`,
          content,
          tokens: estimateTokens(content),
        });
        notes.push(`${layer.title} 超出预算，已截断到约 ${remaining} token`);
        remaining = 0;
        continue;
      }
    }

    dropped.push(layer);
  }

  // 恢复原始顺序（拼装顺序必须稳定）
  const kept = layers
    .flatMap((layer) => [accepted.get(layer.id), accepted.get(`${layer.id}:truncated`)])
    .filter((layer): layer is ContextLayer => layer !== undefined);

  // 被裁掉的层也按原始顺序返回：界面上「丢了哪些」要按对话顺序读得通
  const orderOf = new Map(layers.map((layer, index) => [layer.id, index]));
  dropped.sort((left, right) => (orderOf.get(left.id) ?? 0) - (orderOf.get(right.id) ?? 0));

  const droppedHistory = dropped.filter((layer) => layer.kind === 'history').length;
  if (droppedHistory > 0) {
    notes.push(`上下文超预算，最早 ${droppedHistory} 条历史被裁掉`);
  }

  return { kept, dropped, notes };
}

/** 把层拼成真正要发出去的消息数组。 */
function buildMessages(layers: readonly ContextLayer[]): ChatMessage[] {
  const systemParts = layers
    .filter(
      (layer) =>
        layer.kind === 'system' ||
        layer.kind === 'persona' ||
        layer.kind === 'user_persona' ||
        layer.kind === 'scenario' ||
        layer.kind === 'scene' ||
        layer.kind === 'motive' ||
        layer.kind === 'event' ||
        layer.kind === 'fact' ||
        layer.kind === 'worldbook' ||
        layer.kind === 'summary',
    )
    .map((layer) => layer.content);

  const messages: ChatMessage[] = [];
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  for (const layer of layers) {
    if (layer.kind !== 'history') continue;
    messages.push({
      role: (layer.meta?.role as ChatMessage['role'] | undefined) ?? 'user',
      content: layer.content,
      ...(layer.meta?.name ? { name: String(layer.meta.name) } : {}),
    });
  }

  /**
   * 剧本事件并进最前面那条 system。
   *
   * 试过把它单独成条、插在历史之后（更贴近输入、通常更「显眼」），
   * 但这个 provider 在「两条 system 相邻」时会出现只返回用量、没有正文的情况，
   * 所以退回合并方案 —— 稳妥优先，指令本身已经写得够强硬。
   */
  for (const layer of layers) {
    if (layer.kind !== 'post_history') continue;
    // 历史之后插一条 system：与 OpenAI 兼容层普遍支持，也能被模型明确读到
    messages.push({ role: 'system', content: layer.content });
  }

  for (const layer of layers) {
    if (layer.kind !== 'user_input') continue;
    messages.push({ role: 'user', content: layer.content });
  }

  return messages;
}

/** 组装入口。 */
export function assembleContext(input: AssembleInput): AssembledContext {
  const charName = input.character.name.trim() || '角色';
  /**
   * 玩家称呼的优先级：显式传入 > 身份里的名字 > 「你」。
   * 设定身份时通常也会设名字，两者不一致时以显式传入为准。
   */
  const userName = input.userName?.trim() || input.player?.name?.trim() || '你';

  const layers = collectLayers(input, charName, userName);

  const contextWindow = input.budget?.contextWindow ?? DEFAULT_BUDGET.contextWindow;
  const reservedForOutput = input.budget?.reservedForOutput ?? DEFAULT_BUDGET.reservedForOutput;
  const safetyMargin = input.budget?.safetyMargin ?? DEFAULT_BUDGET.safetyMargin;

  const budget: ContextBudget = {
    contextWindow,
    reservedForOutput,
    safetyMargin,
    available: Math.max(0, contextWindow - reservedForOutput - safetyMargin),
    used: 0,
    dropped: [],
    truncated: false,
  };

  const { kept, dropped, notes } = applyBudget(layers, budget);
  const used = kept.reduce((sum, layer) => sum + layer.tokens, 0);

  budget.used = used;
  budget.dropped = dropped;
  budget.truncated = dropped.length > 0 || notes.length > 0;

  if (used > budget.available) {
    notes.push('裁剪后仍超出预算：本轮输入可能过长，建议调大 contextWindow 或缩短输入');
  }

  return {
    messages: buildMessages(kept),
    layers: kept,
    budget,
    notes,
  };
}
