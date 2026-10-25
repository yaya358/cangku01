import type { Character, ChatMessage } from '@tavern/shared';
import { scanWorldbook, toWorldbookLayers } from '../worldbook/scan.js';
import type { ScanResult, WorldbookEntry } from '../worldbook/scan.js';
import { assembleContext } from './pipeline.js';
import type { AssembledContext, ContextBudget } from './types.js';

/**
 * 把「角色 + 世界书 + 对话」准备成一次请求。
 *
 * 这一层是路由与纯组装管线之间的胶水：
 *   - 拆分「历史」与「本轮输入」
 *   - 用最近若干条对话去扫世界书（不只扫本轮，避免「上一句提到的地名」漏触发）
 *   - 调用 assembleContext 做预算裁剪
 *
 * 聊天接口与预览接口共用它，保证「预览看到的」就是「实际发出去的」。
 */

export interface PrepareInput {
  character: Character;
  /** 该角色可用的世界书条目（全局 + 专属） */
  entries: readonly WorldbookEntry[];
  /** 完整对话，最后一条应当是本次用户输入 */
  messages: readonly ChatMessage[];
  userName?: string;
  /** 玩家身份：你是谁、你图什么。不传时角色会把你当陌生人 */
  player?: { name?: string; role?: string; goal?: string };
  /** 本轮触发的剧本事件（到点发生的剧情） */
  events?: readonly { id: string; title: string; content: string; turn?: number }[];
  /** 已经成立的剧情事实（例如「他已经承认了」），每轮都注入 */
  facts?: readonly string[];
  budget?: Partial<Pick<ContextBudget, 'contextWindow' | 'reservedForOutput' | 'safetyMargin'>>;
  /** 扫描世界书时往回看几条历史，默认 6 */
  historyScanDepth?: number;
  /** 世界书单轮最多注入多少条 */
  maxWorldbookEntries?: number;
}

export interface PreparedContext extends AssembledContext {
  /** 本轮用户输入 */
  userInput: string;
  /** 本轮之前的对话 */
  history: ChatMessage[];
  /** 世界书扫描结果 */
  worldbook: ScanResult;
}

const DEFAULT_HISTORY_SCAN_DEPTH = 6;

/** 取最后一条用户消息作为本轮输入。 */
function splitLastUserMessage(messages: readonly ChatMessage[]): {
  history: ChatMessage[];
  userInput: string;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'user') {
      return { history: messages.slice(0, index), userInput: message.content };
    }
  }
  // 没有用户消息（例如只发了系统提示）：整段当历史，本轮输入为空
  return { history: [...messages], userInput: '' };
}

export function prepareConversationContext(input: PrepareInput): PreparedContext {
  const { history, userInput } = splitLastUserMessage(input.messages);

  // 世界书扫描文本：本轮输入 + 最近几条历史。
  // 只看本轮会漏掉「上一句提到的地名，这一句在回应它」的情况。
  const depth = input.historyScanDepth ?? DEFAULT_HISTORY_SCAN_DEPTH;
  const recentHistory = history.slice(-depth).map((message) => message.content);
  const scanText = [userInput, ...recentHistory]
    .filter((text) => text.trim().length > 0)
    .join('\n');

  // 世界书是增强而不是必需：扫描出错也不该让整轮对话挂掉
  let worldbook: ScanResult;
  try {
    worldbook = scanWorldbook(
      input.entries,
      scanText,
      input.maxWorldbookEntries === undefined ? {} : { maxEntries: input.maxWorldbookEntries },
    );
  } catch {
    worldbook = { hits: [], passes: 0, skipped: 0 };
  }

  const assembled = assembleContext({
    character: {
      name: input.character.name,
      description: input.character.description,
      personality: input.character.personality,
      scenario: input.character.scenario,
      systemPrompt: input.character.systemPrompt,
      postHistoryInstructions: input.character.postHistoryInstructions,
      mesExample: input.character.mesExample,
      secret: input.character.secret,
      goal: input.character.goal,
    },
    history,
    userInput,
    worldbook: toWorldbookLayers(worldbook.hits),
    ...(input.events && input.events.length > 0 ? { events: input.events } : {}),
    ...(input.facts && input.facts.length > 0 ? { facts: input.facts } : {}),
    userName: input.userName,
    ...(input.player ? { player: input.player } : {}),
    budget: input.budget,
  });

  return { ...assembled, userInput, history, worldbook };
}
