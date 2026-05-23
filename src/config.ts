/**
 * 全局配置：环境变量解析、模型映射、上游端点。
 *
 * 与 Python 版 app/core/config.py 一一对应。
 */

export interface Env {
  /** KV 命名空间：用于 nonce 与会话上下文缓存 */
  KIMI_KV: KVNamespace;
  API_MASTER_KEY?: string;
  SESSION_CACHE_TTL?: string;
  CONTEXT_MAX_LENGTH?: string;
  DEFAULT_MODEL?: string;
  STREAM_INTERVAL_MS?: string;
}

export const APP_NAME = "kimi-ai-2api";
export const APP_VERSION = "1.0.0-cf";
export const DESCRIPTION =
  "将 kimi-ai.chat 转换为兼容 OpenAI 协议的高性能代理（Cloudflare Workers 版）。";

export const KNOWN_MODELS = ["kimi-k2-instruct-0905", "kimi-k2-instruct"] as const;
export type KnownModel = (typeof KNOWN_MODELS)[number];

export const UPSTREAM_URL = "https://kimi-ai.chat/wp-admin/admin-ajax.php";
export const CHAT_PAGE_URL = "https://kimi-ai.chat/chat/";

/** 上游 ajax 请求超时（毫秒） */
export const API_REQUEST_TIMEOUT_MS = 180_000;

/** 模型名映射：客户端可见名 → 上游真实模型名 */
export const MODEL_MAP: Record<string, string> = {
  "kimi-k2-instruct-0905": "moonshotai/Kimi-K2-Instruct-0905",
  "kimi-k2-instruct": "moonshotai/Kimi-K2-Instruct",
};

export interface RuntimeConfig {
  apiKey: string;
  sessionTtl: number;
  contextMaxLength: number;
  defaultModel: string;
  streamIntervalMs: number;
}

export function readEnv(env: Env): RuntimeConfig {
  return {
    apiKey: env.API_MASTER_KEY ?? "1",
    sessionTtl: toInt(env.SESSION_CACHE_TTL, 3600),
    contextMaxLength: toInt(env.CONTEXT_MAX_LENGTH, 1000),
    defaultModel: env.DEFAULT_MODEL ?? "kimi-k2-instruct-0905",
    streamIntervalMs: toInt(env.STREAM_INTERVAL_MS, 20),
  };
}

function toInt(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
