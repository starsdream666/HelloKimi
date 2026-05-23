/**
 * KimiAIProvider：核心业务逻辑。
 *
 * 职责：
 *   1. 抓取 / 缓存动态 nonce（双层缓存：isolate 内存 + KV）
 *   2. 维护 stateful 会话（KV，原生 expirationTtl）
 *   3. 上下文截断（≤ CONTEXT_MAX_LENGTH 字符）
 *   4. 调用上游 ajax 接口（失败时 nonce 自动刷新重试一次）
 *   5. 伪流式 SSE 输出 + OpenAI tool_calls 协议适配
 *
 * 与 Python 版 app/providers/kimi_ai_provider.py 一一对应。
 */
import {
  UPSTREAM_URL,
  CHAT_PAGE_URL,
  MODEL_MAP,
  KNOWN_MODELS,
  API_REQUEST_TIMEOUT_MS,
  type Env,
  readEnv,
} from "../config";
import { sse, DONE_CHUNK, chatChunk, toolCallsChunk, chatCompletionResponse, chatCompletionToolCallsResponse } from "../utils/sse";
import {
  hasToolsRequest,
  buildToolAwarePrompt,
  parseToolCalls,
  type ChatRequest,
  type OpenAIMessage,
} from "../utils/tool-calling";

// ────────────────────────────────────────────────────────────
// 错误类型
// ────────────────────────────────────────────────────────────
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ────────────────────────────────────────────────────────────
// HTTP 头：模拟现代浏览器，避免被简单 UA 过滤拦截
// ────────────────────────────────────────────────────────────
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://kimi-ai.chat/chat/",
  Origin: "https://kimi-ai.chat",
};

// ────────────────────────────────────────────────────────────
// Nonce 管理：内存缓存 + KV 持久化
// ────────────────────────────────────────────────────────────
const NONCE_KV_KEY = "kimi:nonce";
const NONCE_KV_TTL_S = 60 * 60 * 24; // 24h
let memNonce: string | null = null;

async function fetchNonce(): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(CHAT_PAGE_URL, {
      headers: BROWSER_HEADERS,
      signal: ctrl.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!res.ok) throw new HttpError(503, `抓取聊天页失败: HTTP ${res.status}`);
    const html = await res.text();
    const match = html.match(/var kimi_ajax = (\{.*?\});/);
    if (!match) throw new HttpError(503, "页面 HTML 中未发现 'kimi_ajax' 变量");
    const ajax = JSON.parse(match[1]);
    if (!ajax.nonce) throw new HttpError(503, "'kimi_ajax' 中无 nonce 字段");
    return String(ajax.nonce);
  } finally {
    clearTimeout(timer);
  }
}

async function getNonce(env: Env, forceRefresh = false): Promise<string> {
  if (!forceRefresh && memNonce) return memNonce;
  if (!forceRefresh) {
    const cached = await env.KIMI_KV.get(NONCE_KV_KEY);
    if (cached) {
      memNonce = cached;
      return cached;
    }
  }
  const fresh = await fetchNonce();
  memNonce = fresh;
  await env.KIMI_KV.put(NONCE_KV_KEY, fresh, { expirationTtl: NONCE_KV_TTL_S });
  return fresh;
}

// ────────────────────────────────────────────────────────────
// 会话上下文：KV 持久化（替代 Python TTLCache）
// ────────────────────────────────────────────────────────────
interface SessionData {
  kimi_session_id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

const sessionKey = (k: string) => `session:${k}`;

function newSessionId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 11);
  return `session_${ts}_${rand}`;
}

async function getOrCreateSession(env: Env, userKey: string, ttlS: number): Promise<SessionData> {
  const raw = await env.KIMI_KV.get(sessionKey(userKey));
  if (raw) {
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      /* 损坏 → 新建 */
    }
  }
  const fresh: SessionData = { kimi_session_id: newSessionId(), messages: [] };
  await env.KIMI_KV.put(sessionKey(userKey), JSON.stringify(fresh), { expirationTtl: ttlS });
  return fresh;
}

async function saveSession(env: Env, userKey: string, data: SessionData, ttlS: number) {
  await env.KIMI_KV.put(sessionKey(userKey), JSON.stringify(data), { expirationTtl: ttlS });
}

// ────────────────────────────────────────────────────────────
// 上下文构造与截断（智能滑动窗口）
// ────────────────────────────────────────────────────────────
function buildContextualPrompt(
  history: SessionData["messages"],
  newMessage: string,
  maxLen: number,
): string {
  const render = () => {
    const lines = history.map(
      (m) => `${m.role === "user" ? "用户" : "模型"}: ${m.content}`,
    );
    return [...lines, `用户: ${newMessage}`].join("\n").trim();
  };
  let prompt = render();
  while (prompt.length > maxLen && history.length > 0) {
    history.shift();
    if (history.length > 0) history.shift();
    prompt = render();
  }
  return prompt;
}

// ────────────────────────────────────────────────────────────
// 上游调用（含 nonce 失效重试）
// ────────────────────────────────────────────────────────────
function preparePayload(
  prompt: string,
  model: string,
  sessionId: string,
  nonce: string,
): URLSearchParams {
  const upstream = MODEL_MAP[model];
  if (!upstream) throw new HttpError(400, `不支持的模型: ${model}`);
  const params = new URLSearchParams();
  params.set("action", "kimi_send_message");
  params.set("nonce", nonce);
  params.set("message", prompt);
  params.set("model", upstream);
  params.set("session_id", sessionId);
  return params;
}

async function callUpstream(
  env: Env,
  prompt: string,
  model: string,
  sessionId: string,
): Promise<string> {
  const send = async (n: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers: {
          ...BROWSER_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json, text/javascript, */*; q=0.01",
        },
        body: preparePayload(prompt, model, sessionId, n).toString(),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new HttpError(502, `上游 HTTP ${res.status}`);
      return (await res.json()) as { success: boolean; data: unknown };
    } finally {
      clearTimeout(timer);
    }
  };

  let nonce = await getNonce(env);
  let json = await send(nonce);
  if (!json.success) {
    // nonce 可能失效 → 强制刷新重试一次
    nonce = await getNonce(env, true);
    json = await send(nonce);
    if (!json.success) {
      const detail = typeof json.data === "string" ? json.data : JSON.stringify(json.data);
      throw new HttpError(502, `上游请求失败: ${detail}`);
    }
  }

  const data = json.data as { message?: string } | string | null;
  if (data && typeof data === "object" && "message" in data) {
    return String(data.message ?? "");
  }
  return "";
}

// ────────────────────────────────────────────────────────────
// 公开 API：chatCompletion / listModels
// ────────────────────────────────────────────────────────────
export async function chatCompletion(env: Env, req: ChatRequest): Promise<Response> {
  const cfg = readEnv(env);
  const model = req.model ?? cfg.defaultModel;
  if (!MODEL_MAP[model]) throw new HttpError(400, `不支持的模型: ${model}`);

  const messages = req.messages ?? [];
  if (messages.length === 0) throw new HttpError(400, "'messages' 不能为空");

  const toolMode = hasToolsRequest(req);
  const lastMsg = messages[messages.length - 1] as OpenAIMessage;

  if (!toolMode && lastMsg.role !== "user") {
    throw new HttpError(400, "未启用 tools 时，messages 末尾必须是 user");
  }

  let promptToSend: string;
  let kimiSessionId: string;
  let session: SessionData | null = null;

  if (toolMode) {
    // 工具调用模式：绕过 stateful，由客户端维护完整 messages
    promptToSend = buildToolAwarePrompt(req);
    kimiSessionId = newSessionId();
  } else if (req.user) {
    // 有状态模式
    session = await getOrCreateSession(env, req.user, cfg.sessionTtl);
    promptToSend = buildContextualPrompt(
      session.messages,
      lastMsg.content ?? "",
      cfg.contextMaxLength,
    );
    kimiSessionId = session.kimi_session_id;
  } else {
    // 无状态模式
    promptToSend = lastMsg.content ?? "";
    kimiSessionId = newSessionId();
  }

  const requestId = `chatcmpl-${crypto.randomUUID()}`;
  const upstreamText = await callUpstream(env, promptToSend, model, kimiSessionId);
  // 客户端是否要求 SSE 流式（仅在 stream===true 时走流式）
  const wantStream = req.stream === true;

  // 工具调用模式：先尝试解析输出
  if (toolMode) {
    const { toolCalls, residual } = parseToolCalls(upstreamText);
    if (toolCalls.length > 0) {
      return wantStream
        ? sseToolCallsResponse(requestId, model, toolCalls)
        : Response.json(chatCompletionToolCallsResponse(requestId, model, toolCalls, promptToSend));
    }
    // 未命中工具调用 → 退回文本输出
    const finalText = residual || upstreamText;
    return wantStream
      ? streamText(requestId, model, finalText, cfg.streamIntervalMs)
      : Response.json(chatCompletionResponse(requestId, model, finalText, promptToSend));
  }

  // 有状态：更新会话历史
  if (session && req.user) {
    session.messages.push({ role: "user", content: lastMsg.content ?? "" });
    session.messages.push({ role: "assistant", content: upstreamText });
    await saveSession(env, req.user, session, cfg.sessionTtl);
  }

  return wantStream
    ? streamText(requestId, model, upstreamText, cfg.streamIntervalMs)
    : Response.json(chatCompletionResponse(requestId, model, upstreamText, promptToSend));
}

export function listModels(): Response {
  const data = {
    object: "list",
    data: KNOWN_MODELS.map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "lzA6",
    })),
  };
  return Response.json(data);
}

// ────────────────────────────────────────────────────────────
// SSE 响应构造
// ────────────────────────────────────────────────────────────
function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  };
}

function streamText(
  requestId: string,
  model: string,
  content: string,
  intervalMs: number,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        // 字符级伪流式（按 Unicode 码点切分以正确处理 emoji / 中文）
        for (const ch of content) {
          controller.enqueue(enc.encode(sse(chatChunk(requestId, model, ch))));
          if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
        }
        controller.enqueue(enc.encode(sse(chatChunk(requestId, model, "", "stop"))));
        controller.enqueue(enc.encode(DONE_CHUNK));
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        controller.enqueue(enc.encode(sse(chatChunk(requestId, model, `内部错误: ${msg}`, "stop"))));
        controller.enqueue(enc.encode(DONE_CHUNK));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

function sseToolCallsResponse(
  requestId: string,
  model: string,
  toolCalls: ReturnType<typeof parseToolCalls>["toolCalls"],
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(
        enc.encode(sse(toolCallsChunk(requestId, model, toolCalls, { includeRole: true }))),
      );
      controller.enqueue(
        enc.encode(
          sse(
            toolCallsChunk(requestId, model, [], {
              finishReason: "tool_calls",
              emptyDelta: true,
            }),
          ),
        ),
      );
      controller.enqueue(enc.encode(DONE_CHUNK));
      controller.close();
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}
