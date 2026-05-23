/**
 * Worker 入口：路由、鉴权、错误处理。
 *
 * 与 Python 版 main.py 一一对应。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { APP_NAME, APP_VERSION, readEnv, type Env } from "./config";
import { chatCompletion, listModels, HttpError } from "./providers/kimi";
import type { ChatRequest } from "./utils/tool-calling";

const app = new Hono<{ Bindings: Env }>();

// CORS：允许任意来源（如对接前端浏览器，可按需收紧）
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

// ── 根路径：健康检查 ──
app.get("/", (c) =>
  c.json({
    message: `欢迎来到 ${APP_NAME} v${APP_VERSION}（Cloudflare Workers）。服务运行正常。`,
  }),
);

// ── 鉴权中间件：仅 /v1/* ──
app.use("/v1/*", async (c, next) => {
  const cfg = readEnv(c.env);
  // API_MASTER_KEY=="1" 视为禁用鉴权（与 Python 版一致）
  if (cfg.apiKey && cfg.apiKey !== "1") {
    const auth = c.req.header("Authorization") ?? "";
    if (!auth.toLowerCase().includes("bearer")) {
      return c.json({ error: { message: "需要 Bearer Token 认证。" } }, 401);
    }
    const token = auth.split(/\s+/).pop();
    if (token !== cfg.apiKey) {
      return c.json({ error: { message: "无效的 API Key。" } }, 403);
    }
  }
  await next();
});

// ── /v1/models ──
app.get("/v1/models", () => listModels());

// ── /v1/chat/completions ──
app.post("/v1/chat/completions", async (c) => {
  let body: ChatRequest;
  try {
    body = (await c.req.json()) as ChatRequest;
  } catch {
    return c.json({ error: { message: "请求体必须为合法 JSON。" } }, 400);
  }

  try {
    return await chatCompletion(c.env, body);
  } catch (e) {
    if (e instanceof HttpError) {
      return c.json({ error: { message: e.message } }, e.status as 400 | 401 | 403 | 502 | 503);
    }
    const msg = (e as Error).message ?? String(e);
    return c.json({ error: { message: `内部错误: ${msg}` } }, 500);
  }
});

// ── 404 ──
app.notFound((c) => c.json({ error: { message: "Not Found" } }, 404));

// ── 全局兜底 ──
app.onError((err, c) => {
  console.error("[onError]", err);
  return c.json({ error: { message: `内部错误: ${err.message}` } }, 500);
});

export default app;
