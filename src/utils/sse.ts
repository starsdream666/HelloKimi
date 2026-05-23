/**
 * SSE 协议工具：构造 OpenAI 兼容流式块。
 *
 * 与 Python 版 app/utils/sse_utils.py 一一对应。
 */

export const DONE_CHUNK = "data: [DONE]\n\n";

export function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export interface ToolCall {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
}

/** 文本内容流式块。 */
export function chatChunk(
  id: string,
  model: string,
  content: string,
  finishReason: string | null = null,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: finishReason,
      },
    ],
  };
}

/** 工具调用流式块。 */
export function toolCallsChunk(
  id: string,
  model: string,
  toolCalls: ToolCall[],
  options: {
    finishReason?: string | null;
    includeRole?: boolean;
    emptyDelta?: boolean;
  } = {},
): ChatCompletionChunk {
  const delta: Record<string, unknown> = options.emptyDelta
    ? {}
    : { tool_calls: toolCalls };
  if (options.includeRole && !options.emptyDelta) {
    delta.role = "assistant";
    delta.content = null;
  }
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: options.finishReason ?? null,
      },
    ],
  };
}

// ───────────────────────────────────────────────────────────
// 非流式响应体（OpenAI chat.completion）
// ───────────────────────────────────────────────────────────
export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 粗略估算 token 数（足以让 New API 等严格客户端不报错）。 */
function approxTokens(s: string): number {
  if (!s) return 0;
  // 中文/CJK 走 ~1.5 字符/token；ASCII 走 ~4 字符/token。取中间值 3。
  return Math.max(1, Math.ceil(s.length / 3));
}

/** 文本输出的非流式响应。 */
export function chatCompletionResponse(
  id: string,
  model: string,
  content: string,
  promptText: string,
): ChatCompletionResponse {
  const promptTokens = approxTokens(promptText);
  const completionTokens = approxTokens(content);
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/** 工具调用的非流式响应。 */
export function chatCompletionToolCallsResponse(
  id: string,
  model: string,
  toolCalls: ToolCall[],
  promptText: string,
): ChatCompletionResponse {
  const promptTokens = approxTokens(promptText);
  const argsLen = toolCalls.reduce((acc, t) => acc + (t.function.arguments?.length ?? 0), 0);
  const completionTokens = approxTokens("x".repeat(argsLen));
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: toolCalls },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}
