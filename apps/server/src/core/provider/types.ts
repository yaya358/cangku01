import type { Extension, ExtensionMeta } from '../extension/index.js';

/**
 * 模型接入层的类型契约。
 *
 * 这一层只描述「一次对话请求长什么样」，不关心具体是哪家服务。
 * 所有厂商差异都被压在上游适配器（openai-compatible、anthropic、本地推理…）里，
 * 上层（上下文引擎、聊天接口）只面向 ProviderAdapter 编程。
 */

/** 对话角色。注意这里只有三种：工具调用与多模态等扩展能力后续单开字段。 */
export type ChatRole = 'system' | 'user' | 'assistant';

/** 一条消息。name 用于群聊里区分「哪个角色说的」。 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
}

/** 采样参数。不同厂商支持度不同，不支持的会被适配器丢弃而不是报错。 */
export interface SamplingParams {
  /** 0~2，越高越发散 */
  temperature?: number;
  /** 0~1，核采样 */
  topP?: number;
  /** 回复上限；不填则用服务端默认 */
  maxTokens?: number;
  /** 遇到这些串就停 */
  stop?: readonly string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  /** 固定种子，便于复现（部分厂商不支持） */
  seed?: number;
}

/** 一次对话请求。 */
export interface ChatRequest {
  /** 上游模型名，例如 gpt-4o-mini / deepseek-chat */
  model: string;
  messages: readonly ChatMessage[];
  params?: SamplingParams;
  /**
   * 透传给上游的私有字段。
   * 用途：厂商特有的开关（如 ollama 的 keep_alive）不必污染公共类型。
   */
  extra?: Record<string, unknown>;
}

/** token 用量。上游不返回时整体为 undefined，不做本地估算冒充。 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 非流式调用的结果。 */
export interface ChatResult {
  text: string;
  /** 例如 stop / length / content_filter */
  finishReason: string | null;
  usage?: TokenUsage;
  /** 上游回报的实际模型名（可能与请求不同，例如被映射到快照版本） */
  model: string;
  durationMs: number;
}

/**
 * 流式事件。
 *
 * 用可辨识联合而不是回调，是为了让上层能 `switch (event.type)` 穷尽处理，
 * 加事件类型时编译器会提醒所有使用点。
 */
export type ChatStreamEvent =
  | { type: 'start'; model: string; at: number }
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | {
      type: 'done';
      finishReason: string | null;
      usage?: TokenUsage;
      durationMs: number;
      /** 首字延迟：体感快慢的关键指标，比总耗时重要 */
      firstTokenMs: number | null;
    }
  | {
      type: 'error';
      error: { code: string; message: string; retryable: boolean };
    };

/** 适配器能力声明。上层据此决定 UI 是否显示某些开关。 */
export interface ProviderCapabilities {
  streaming: boolean;
  /** 是否支持返回 usage（OpenAI 需要 stream_options.include_usage） */
  usageInStream?: boolean;
  /** 上下文窗口，用于 token 预算分配 */
  maxContextTokens?: number;
  jsonMode?: boolean;
}

/** 单次调用的运行时选项，与业务参数分离。 */
export interface ChatCallOptions {
  /** 外部取消信号（用户点「停止生成」） */
  signal?: AbortSignal;
  /** 整体超时；流式下指「从发起请求到流结束」的硬上限 */
  timeoutMs?: number;
  /** 首字超时：超过这个时间没有任何 delta 就判定卡死 */
  firstTokenTimeoutMs?: number;
  /** 仅用于日志关联 */
  requestId?: string;
}

/**
 * provider 适配器。
 *
 * 它同时是一个扩展点（kind 固定为 'provider'），因此能直接被注册表管理：
 * 初始化顺序、失败隔离、逆序释放全部复用 core/extension 的机制。
 */
export interface ProviderAdapter extends Extension {
  readonly meta: ExtensionMeta & { kind: 'provider' };
  readonly capabilities: ProviderCapabilities;
  /** 未显式指定 model 时用它 */
  readonly defaultModel: string;
  /**
   * 是否已配置凭据。
   *
   * 故意不在 setup 里因为「没配 Key」就抛错：那会让刚 clone 下来的项目
   * 整个健康检查变降级、页面红一片。没 Key 也能启动，只是真正调用时
   * 返回 NO_CREDENTIALS，UI 用这个字段标出来即可。
   */
  readonly hasCredentials?: boolean;

  /** 非流式：一次性拿到完整回复。 */
  chat(request: ChatRequest, options?: ChatCallOptions): Promise<ChatResult>;

  /**
   * 流式：边生成边吐出 delta。
   *
   * 约定：正常结束必须以一个 done 事件收尾；出错则以 error 事件收尾后结束迭代，
   * 不要 throw —— 否则上层得同时处理「迭代异常」和「error 事件」两种路径。
   */
  stream(request: ChatRequest, options?: ChatCallOptions): AsyncIterable<ChatStreamEvent>;
}
