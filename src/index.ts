/**
 * Worker 入口：路由、鉴权、错误处理。
 *
 * 与 Python 版 main.py 一一对应。
 *
 * 路由清单：
 *   公开:
 *     GET  /                            → 欢迎信息
 *     GET  /v1/health                   → 健康检查（KV/nonce 状态）
 *   鉴权（Bearer API_MASTER_KEY）:
 *     GET  /v1/models                   → 模型列表
 *     POST /v1/chat/completions         → 对话补全（流式 / 非流式 / 工具调用）
 *     POST /v1/admin/refresh-nonce      → 强制刷新 nonce
 *     POST /v1/admin/reset-session      → 重置指定 user 的 stateful 会话
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { APP_NAME, APP_VERSION, readEnv, type Env } from "./config";
import {
  chatCompletion,
  listModels,
  HttpError,
  healthCheck,
  forceRefreshNonce,
  resetSession,
} from "./providers/kimi";
import type { ChatRequest } from "./utils/tool-calling";

const app = new Hono<{ Bindings: Env }>();

// CORS：允许任意来源（如对接前端浏览器，可按需收紧）
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

/** 生成本次请求的追踪 ID，用于客户端报错时定位上下文。 */
function newRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── 根路径：欢迎 ──
app.get("/", (c) =>
  c.json({
    message: `欢迎来到 ${APP_NAME} v${APP_VERSION}（Cloudflare Workers）。服务运行正常。`,
  }),
);

// ── 健康检查（公开，便于监控）──
app.get("/v1/health", async (c) => {
  try {
    const r = await healthCheck(c.env);
    // status=degraded 时返回 200 但内容标记降级（监控系统按 body 判定）
    return c.json(r);
  } catch (e) {
    return c.json(
      {
        status: "error",
        message: (e as Error).message,
        time: new Date().toISOString(),
      },
      500,
    );
  }
});

// ── 鉴权中间件：仅 /v1/* 中除 /v1/health 外的所有路径 ──
app.use("/v1/*", async (c, next) => {
  // 健康检查不鉴权（已在上面注册，到这里时已经返回；保留 path 判断作为兜底）
  if (c.req.path === "/v1/health") return next();

  const cfg = readEnv(c.env);
  // API_MASTER_KEY=="1" 视为禁用鉴权（与 Python 版一致）
  if (cfg.apiKey && cfg.apiKey !== "1") {
    const auth = c.req.header("Authorization") ?? "";
    if (!auth.toLowerCase().includes("bearer")) {
      return c.json(
        { error: { message: "需要 Bearer Token 认证。", request_id: newRequestId() } },
        401,
      );
    }
    const token = auth.split(/\s+/).pop();
    if (token !== cfg.apiKey) {
      return c.json(
        { error: { message: "无效的 API Key。", request_id: newRequestId() } },
        403,
      );
    }
  }
  await next();
});

// ── /v1/models ──
app.get("/v1/models", () => listModels());

// ── /v1/chat/completions ──
app.post("/v1/chat/completions", async (c) => {
  const requestId = newRequestId();
  let body: ChatRequest;
  try {
    body = (await c.req.json()) as ChatRequest;
  } catch {
    return c.json(
      { error: { message: "请求体必须为合法 JSON。", request_id: requestId } },
      400,
    );
  }

  try {
    const resp = await chatCompletion(c.env, body);
    // 给响应附加 trace 头便于客户端排查
    resp.headers.set("X-Request-Id", requestId);
    return resp;
  } catch (e) {
    console.error(`[${requestId}] chat error:`, e);
    if (e instanceof HttpError) {
      return c.json(
        { error: { message: e.message, request_id: requestId } },
        e.status as 400 | 401 | 403 | 502 | 503,
      );
    }
    const msg = (e as Error).message ?? String(e);
    return c.json(
      { error: { message: `内部错误: ${msg}`, request_id: requestId } },
      500,
    );
  }
});

// ── /v1/admin/refresh-nonce：强制刷新 nonce ──
app.post("/v1/admin/refresh-nonce", async (c) => {
  const requestId = newRequestId();
  try {
    const r = await forceRefreshNonce(c.env);
    return c.json({ ...r, request_id: requestId });
  } catch (e) {
    console.error(`[${requestId}] refresh-nonce error:`, e);
    return c.json(
      { error: { message: (e as Error).message, request_id: requestId } },
      500,
    );
  }
});

// ── /v1/admin/reset-session：重置某 user 的 stateful 会话 ──
app.post("/v1/admin/reset-session", async (c) => {
  const requestId = newRequestId();
  let userKey = "";
  try {
    const body = (await c.req.json().catch(() => ({}))) as { user?: string };
    userKey = (body.user ?? "").toString().trim();
  } catch {
    /* fall-through */
  }
  if (!userKey) {
    return c.json(
      {
        error: {
          message: "请求体须为 JSON：{\"user\":\"<key>\"}",
          request_id: requestId,
        },
      },
      400,
    );
  }
  try {
    const r = await resetSession(c.env, userKey);
    return c.json({ ...r, user: userKey, request_id: requestId });
  } catch (e) {
    console.error(`[${requestId}] reset-session error:`, e);
    return c.json(
      { error: { message: (e as Error).message, request_id: requestId } },
      500,
    );
  }
});

// ── 404 ──
app.notFound((c) =>
  c.json({ error: { message: "Not Found", request_id: newRequestId() } }, 404),
);

// ── 全局兜底 ──
app.onError((err, c) => {
  const requestId = newRequestId();
  console.error(`[${requestId}] [onError]`, err);
  return c.json(
    { error: { message: `内部错误: ${err.message}`, request_id: requestId } },
    500,
  );
});

export default app;
