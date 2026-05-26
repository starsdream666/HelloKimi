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
// Nonce 管理：内存缓存 + KV 持久化 + 主动过期 + 失败自愈
// ────────────────────────────────────────────────────────────
const NONCE_KV_KEY = "kimi:nonce_v2";
const NONCE_KV_TTL_S = 60 * 60 * 24; // 24h KV 兜底寿命
const NONCE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h 主动刷新阈值
const NONCE_FAILURE_THRESHOLD = 3; // 连续失败 N 次自动失效

interface NonceCache {
  value: string;
  createdAt: number; // ms 时间戳
  failureCount: number; // 自创建以来的连续失败计数
}

let memNonce: NonceCache | null = null;

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

/** 读取当前 nonce 缓存（内存优先 → KV）。 */
async function readNonceCache(env: Env): Promise<NonceCache | null> {
  if (memNonce) return memNonce;
  const raw = await env.KIMI_KV.get(NONCE_KV_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as NonceCache;
    memNonce = parsed;
    return parsed;
  } catch {
    return null;
  }
}

/** 持久化 nonce 缓存（内存 + KV）。 */
async function writeNonceCache(env: Env, cache: NonceCache): Promise<void> {
  memNonce = cache;
  await env.KIMI_KV.put(NONCE_KV_KEY, JSON.stringify(cache), {
    expirationTtl: NONCE_KV_TTL_S,
  });
}

/**
 * 获取可用 nonce。三层失效条件触发重抓：
 *   - forceRefresh = true
 *   - 缓存年龄 > NONCE_MAX_AGE_MS（主动过期）
 *   - 累计失败 ≥ NONCE_FAILURE_THRESHOLD（健康度降级）
 */
async function getNonce(env: Env, forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh) {
    const cache = await readNonceCache(env);
    if (cache) {
      const stale = now - cache.createdAt > NONCE_MAX_AGE_MS;
      const broken = cache.failureCount >= NONCE_FAILURE_THRESHOLD;
      if (!stale && !broken) return cache.value;
    }
  }
  const fresh = await fetchNonce();
  await writeNonceCache(env, { value: fresh, createdAt: now, failureCount: 0 });
  return fresh;
}

/** 上游报告 nonce 相关失败：累加计数，触达阈值后下次 getNonce 会自动重抓。 */
async function reportNonceFailure(env: Env): Promise<void> {
  const cache = await readNonceCache(env);
  if (!cache) return;
  cache.failureCount += 1;
  // 仅当跨越阈值（如 1→3）时持久化，避免每次失败都写 KV
  if (
    cache.failureCount === NONCE_FAILURE_THRESHOLD ||
    cache.failureCount === 1
  ) {
    await writeNonceCache(env, cache);
  } else {
    memNonce = cache; // 中间态仅保留在内存
  }
}

/** 上游成功后清零失败计数（仅在非零时落盘，节省 KV 写入）。 */
async function reportNonceSuccess(env: Env): Promise<void> {
  const cache = await readNonceCache(env);
  if (!cache || cache.failureCount === 0) return;
  cache.failureCount = 0;
  await writeNonceCache(env, cache);
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
  /** 单次上游调用。对 5xx / 超时抛出可重试错误。 */
  const sendOnce = async (n: string) => {
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

  /** 判断错误是否可重试（上游 5xx / 网络超时）。 */
  const isRetryable = (e: unknown): boolean => {
    if (e instanceof HttpError && e.status >= 500) return true;
    const name = (e as Error)?.name;
    if (name === "AbortError" || name === "TimeoutError") return true;
    const msg = String((e as Error)?.message ?? e);
    return /network|timeout|fetch failed|ECONN|abort/i.test(msg);
  };

  /** 指数退避重试：对 5xx / 网络错误最多重试 maxAttempts 次。 */
  const sendWithRetry = async (n: string, maxAttempts = 3) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await sendOnce(n);
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e)) throw e;
        if (attempt < maxAttempts - 1) {
          // 600ms / 1.5s / 3s 退避，带随机抖动避免雪崩
          const delay = 600 * Math.pow(2.2, attempt) + Math.random() * 200;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new HttpError(502, "上游持续失败");
  };

  let nonce = await getNonce(env);
  let json: { success: boolean; data: unknown };

  try {
    json = await sendWithRetry(nonce);
  } catch (e) {
    // 最后一拍：可能是 nonce 失效叠加 5xx → 计入失败 + 刷新后再试一轮
    if (!isRetryable(e)) throw e;
    await reportNonceFailure(env);
    nonce = await getNonce(env, true);
    json = await sendWithRetry(nonce, 2);
  }

  if (!json.success) {
    // success=false → nonce 失效，计入失败 + 刷新后重试
    await reportNonceFailure(env);
    nonce = await getNonce(env, true);
    try {
      json = await sendWithRetry(nonce, 2);
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(502, `上游请求失败: ${(e as Error).message}`);
    }
    if (!json.success) {
      const detail = typeof json.data === "string" ? json.data : JSON.stringify(json.data);
      throw new HttpError(502, `上游请求失败: ${detail}`);
    }
  }

  // 走到这里 = 至少有一次成功 → 清零失败计数
  await reportNonceSuccess(env);

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
// 公开 API：运维 / 健康检查
// ────────────────────────────────────────────────────────────

/**
 * 强制刷新 nonce。返回新 nonce 的截断预览（仅供运维端确认）。
 * 触发时机：管理端点 `POST /v1/admin/refresh-nonce`。
 */
export async function forceRefreshNonce(env: Env): Promise<{
  nonce_preview: string;
  refreshed_at: string;
}> {
  const fresh = await getNonce(env, true);
  return {
    nonce_preview: fresh.length > 8 ? `${fresh.slice(0, 4)}***${fresh.slice(-2)}` : "***",
    refreshed_at: new Date().toISOString(),
  };
}

/**
 * 重置指定用户的 stateful session（删除 KV，下次对话自动新建）。
 * 触发时机：管理端点 `POST /v1/admin/reset-session`。
 */
export async function resetSession(env: Env, userKey: string): Promise<{ deleted: boolean }> {
  const k = sessionKey(userKey);
  const existed = await env.KIMI_KV.get(k);
  if (!existed) return { deleted: false };
  await env.KIMI_KV.delete(k);
  return { deleted: true };
}

/**
 * 健康检查：探测 KV 可写、读取 nonce 缓存状态、报告版本与时间。
 * 触发时机：公开端点 `GET /v1/health`（无需鉴权，便于监控接入）。
 */
export interface HealthReport {
  status: "ok" | "degraded";
  version: string;
  time: string;
  kv: { ok: boolean; error?: string };
  nonce: {
    cached: boolean;
    age_seconds: number | null;
    failure_count: number;
    stale: boolean;
  };
}

export async function healthCheck(env: Env): Promise<HealthReport> {
  const result: HealthReport = {
    status: "ok",
    version: "1.0.0",
    time: new Date().toISOString(),
    kv: { ok: false },
    nonce: { cached: false, age_seconds: null, failure_count: 0, stale: false },
  };

  // 1. 探测 KV 可读写
  try {
    const probe = `health:${Date.now()}`;
    await env.KIMI_KV.put(probe, "1", { expirationTtl: 60 });
    await env.KIMI_KV.delete(probe);
    result.kv.ok = true;
  } catch (e) {
    result.kv.ok = false;
    result.kv.error = (e as Error).message;
    result.status = "degraded";
  }

  // 2. 报告 nonce 缓存状态
  try {
    const cache = await readNonceCache(env);
    if (cache) {
      const ageMs = Date.now() - cache.createdAt;
      result.nonce = {
        cached: true,
        age_seconds: Math.floor(ageMs / 1000),
        failure_count: cache.failureCount,
        stale: ageMs > NONCE_MAX_AGE_MS || cache.failureCount >= NONCE_FAILURE_THRESHOLD,
      };
      if (result.nonce.stale) result.status = "degraded";
    }
  } catch {
    /* nonce 状态读取失败不致命 */
  }

  return result;
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
