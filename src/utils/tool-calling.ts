/**
 * OpenAI 兼容工具调用（function calling）适配层。
 *
 * 由于上游 Kimi 网页接口仅接收单条文本消息，本模块通过 Prompt 工程将
 * OpenAI tools schema 注入 system 指令，并解析模型输出中的 <tool_call>
 * 片段，转换为标准的 OpenAI tool_calls 协议。
 *
 * 与 Python 版 app/utils/tool_calling.py 一一对应。
 */
import type { ToolCall } from "./sse";

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: unknown;
  user?: string;
  stream?: boolean;
}

/** 判断本次请求是否启用了 tools 协议（含历史中的 tool_calls / role:tool）。 */
export function hasToolsRequest(req: ChatRequest): boolean {
  if (req.tools && req.tools.length > 0) return true;
  for (const m of req.messages || []) {
    if (m.role === "tool") return true;
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) return true;
  }
  return false;
}

/** 把 OpenAI tools schema 编译成 system 指令文本。 */
export function buildToolsSystemPrompt(tools: OpenAITool[]): string {
  const fnTools = tools.filter((t) => t.type === "function" && t.function);
  if (fnTools.length === 0) return "";

  const schema = fnTools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters ?? { type: "object", properties: {} },
  }));
  const schemaJson = JSON.stringify(schema, null, 2);

  return [
    "你具备调用外部工具（function calling）的能力。可用工具列表（JSON Schema 数组）：",
    "<tools>",
    schemaJson,
    "</tools>",
    "",
    "调用规则（必须严格遵守，否则调用将被拒绝）：",
    "1. 当且仅当需要调用工具时，**输出必须以 <tool_call> 标签包裹**，严格格式如下，不允许任何解释文字、不允许 Markdown：",
    "   <tool_call>",
    `   {"name": "工具名", "arguments": {参数JSON对象}}`,
    "   </tool_call>",
    "2. **绝对不要**直接输出裸 JSON（如 {\"name\":...,\"arguments\":...}），也不要用 ```json``` 包裹；必须是 <tool_call>...</tool_call> 块。",
    "3. 如需并行调用多个工具，可连续输出多个 <tool_call>...</tool_call> 块。",
    "4. arguments 必须是合法 JSON 对象，键名与 parameters.properties 完全一致，类型严格匹配。",
    "5. 如果不需要调用工具，请直接以普通自然语言回答用户，**禁止**输出 <tool_call> 标签。",
    "6. 工具执行结果会以 “工具返回[tool_call_id]: <内容>” 的形式提供，你应基于该结果继续作答，此时请不要重复调用同一工具。",
  ].join("\n");
}

/** 把含 tool_calls / role:tool 的 OpenAI messages 数组线性化为单条 prompt。 */
export function linearizeMessagesWithTools(messages: OpenAIMessage[]): {
  systemSegment: string;
  conversationSegment: string;
} {
  const sysParts: string[] = [];
  const convo: string[] = [];

  for (const m of messages) {
    const content = m.content ?? "";
    if (m.role === "system") {
      if (content) sysParts.push(content);
    } else if (m.role === "user") {
      convo.push(`用户: ${content}`);
    } else if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const rendered = m.tool_calls.map((tc) => {
          const args = tc.function.arguments || "{}";
          return `<tool_call>\n{"id": "${tc.id}", "name": "${tc.function.name}", "arguments": ${args}}\n</tool_call>`;
        });
        convo.push("模型: " + rendered.join("\n"));
      } else if (content) {
        convo.push(`模型: ${content}`);
      }
    } else if (m.role === "tool") {
      const tcId = m.tool_call_id ?? "";
      convo.push(`工具返回[${tcId}]: ${content}`);
    }
  }

  return {
    systemSegment: sysParts.join("\n\n").trim(),
    conversationSegment: convo.join("\n").trim(),
  };
}

/** 构造启用工具调用时发送给上游的最终单条 prompt。 */
export function buildToolAwarePrompt(req: ChatRequest): string {
  const tools = req.tools ?? [];
  const directive = buildToolsSystemPrompt(tools);
  const { systemSegment, conversationSegment } = linearizeMessagesWithTools(req.messages);

  const segments: string[] = [];
  if (directive) segments.push(directive);
  if (systemSegment) segments.push(`[系统指令]\n${systemSegment}`);
  if (conversationSegment) segments.push(conversationSegment);
  segments.push("模型:");

  return segments.filter(Boolean).join("\n\n");
}

// ────────────────────────────────────────────────────────────
// 解析模型输出中的 tool_call（三层兜底）
// ────────────────────────────────────────────────────────────

const TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
const TOOL_CALL_FENCED_RE =
  /```(?:json|tool_call)?\s*(\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\})\s*```/g;

type CallShape = Omit<ToolCall, "index">;

function coerceToolCall(obj: unknown): CallShape | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const name =
    (typeof o.name === "string" && o.name) ||
    (typeof o.tool === "string" && o.tool) ||
    (typeof o.function === "string" && o.function);
  if (!name) return null;
  if (!("arguments" in o) && !("args" in o) && !("parameters" in o)) return null;
  const rawArgs = o.arguments ?? o.args ?? o.parameters ?? {};
  const argsStr = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
  const id =
    (typeof o.id === "string" && o.id) ||
    `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  return { id, type: "function", function: { name, arguments: argsStr } };
}

/** 平衡括号扫描：返回所有顶层 { ... } 区段。 */
function scanBalancedJson(text: string): Array<{ start: number; end: number; raw: string }> {
  const out: Array<{ start: number; end: number; raw: string }> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i++;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    const start = i;
    let j = i;
    let closed = false;
    while (j < text.length) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            out.push({ start, end: j + 1, raw: text.slice(start, j + 1) });
            i = j + 1;
            closed = true;
            break;
          }
        }
      }
      j++;
    }
    if (!closed) break;
  }
  return out;
}

/**
 * 从模型输出中解析 tool_call，三层兜底：
 *   1) <tool_call>...</tool_call> 标签
 *   2) ```json {...} ``` 围栏
 *   3) 平衡括号扫描裸 JSON
 */
export function parseToolCalls(text: string): { toolCalls: ToolCall[]; residual: string } {
  if (!text) return { toolCalls: [], residual: "" };

  const collected: Array<{ start: number; end: number; calls: CallShape[] }> = [];

  const tryConsume = (start: number, end: number, raw: string): boolean => {
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return false;
    }
    const list = Array.isArray(obj)
      ? obj.map(coerceToolCall).filter((c): c is CallShape => c !== null)
      : ([coerceToolCall(obj)].filter((c): c is CallShape => c !== null));
    if (list.length === 0) return false;
    collected.push({ start, end, calls: list });
    return true;
  };

  // 1) <tool_call>
  for (const m of text.matchAll(TOOL_CALL_RE)) {
    tryConsume(m.index!, m.index! + m[0].length, m[1].trim());
  }

  // 2) ```json``` 围栏
  if (collected.length === 0) {
    for (const m of text.matchAll(TOOL_CALL_FENCED_RE)) {
      tryConsume(m.index!, m.index! + m[0].length, m[1].trim());
    }
  }

  // 3) 裸 JSON 平衡括号扫描
  if (collected.length === 0) {
    for (const span of scanBalancedJson(text)) {
      tryConsume(span.start, span.end, span.raw);
    }
  }

  if (collected.length === 0) return { toolCalls: [], residual: text };

  // 重新编号 index
  collected.sort((a, b) => a.start - b.start);
  const toolCalls: ToolCall[] = [];
  let idx = 0;
  for (const c of collected) {
    for (const tc of c.calls) {
      toolCalls.push({ ...tc, index: idx++ });
    }
  }

  // 拼接残余文本
  let residual = "";
  let prev = 0;
  for (const c of collected) {
    residual += text.slice(prev, c.start);
    prev = c.end;
  }
  residual += text.slice(prev);

  return { toolCalls, residual: residual.trim() };
}
