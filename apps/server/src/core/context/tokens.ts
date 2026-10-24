/**
 * token 估算。
 *
 * 为什么不引 tiktoken：那是几 MB 的 wasm + 只对 OpenAI 的分词器准确，
 * 而我们面对的是 DeepSeek / 中转站 / 本地模型，各自分词器都不同。
 * 与其"精确地算错别人的 token"，不如给一个明确规则的估算，
 * 再加一个安全余量（见 types.ts 里的 safetyMargin），简单且可解释。
 */

export interface TokenEstimateOptions {
  /** 中日韩字符按多少个 token 计（默认 1：汉字基本 1 char ≈ 1 token） */
  cjkPerChar?: number;
  /** 拉丁字母/数字多少个字符折算 1 token（默认 4） */
  asciiCharsPerToken?: number;
  /** 换行/标点等符号的权重（默认按 ascii 算） */
  symbolWeight?: number;
}

/** 中日韩文字（含日文假名、韩文谚文）判定。 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

const DEFAULT_OPTIONS: Required<TokenEstimateOptions> = {
  cjkPerChar: 1,
  asciiCharsPerToken: 4,
  symbolWeight: 0.5,
};

/**
 * 估算一段文本的 token 数。
 *
 * 规则：CJK 每字 1 token；ASCII 字母数字每 4 字符 1 token；
 * 空白与符号按半个 token 计。最后向上取整——宁可高估，别低估导致超窗被上游截断。
 */
export function estimateTokens(text: string, options: TokenEstimateOptions = {}): number {
  const config = { ...DEFAULT_OPTIONS, ...options };
  if (text.length === 0) return 0;

  let score = 0;
  for (const char of text) {
    if (CJK_PATTERN.test(char)) {
      score += config.cjkPerChar;
    } else if (/[A-Za-z0-9]/.test(char)) {
      score += 1 / config.asciiCharsPerToken;
    } else if (/\s/.test(char)) {
      // 空白几乎不占 token，但大量缩进也要计入一点
      score += 1 / 8;
    } else {
      score += config.symbolWeight;
    }
  }

  return Math.max(1, Math.ceil(score));
}

/** 估算一组消息的 token 数（每条额外 +4 的结构开销，经验值）。 */
export function estimateMessagesTokens(messages: readonly { content: string }[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
}
