# kimi-ai-2api · Cloudflare Workers

把 kimi-ai.chat 转换成 OpenAI 兼容 API 的 Cloudflare Workers 网关。

支持的模型：`kimi-k2-instruct-0905`、`kimi-k2-instruct`。


## 特性

- OpenAI 协议兼容：`/v1/models`、`/v1/chat/completions`，stream / 非流式自动切换。
- 多轮对话：客户端传 `user` 字段即可启用，会话上下文落 KV，TTL 可配。
- 工具调用：网关层用 prompt 工程模拟 OpenAI tool_calls，三层兜底解析。
- 上游容错：5xx / 超时指数退避重试，nonce 失效自动刷新。
- 健康检查与运维端点：`/v1/health`、`/v1/admin/refresh-nonce`、`/v1/admin/reset-session`。
- 全链路 request_id：错误体含 `request_id`，对话响应头含 `X-Request-Id`，方便对账日志。


## 部署

依赖：Node.js 18+、一个 Cloudflare 账号。

```bash
git clone <repo>
cd cfworker
npm install

npx wrangler login
npm run kv:create                     # 输出 KV id
# 把上一步 id 写入 wrangler.toml 的 YOUR_KV_NAMESPACE_ID

echo "sk-your-key" | npx wrangler secret put API_MASTER_KEY
npm run deploy
```

部署完成后会输出 worker 地址，例如 `https://kimi-ai-2api.<sub>.workers.dev`。

如果不设置 `API_MASTER_KEY`，等价于禁用鉴权，不要在公网这样跑。


## API

### `GET /`

存活探针，返回欢迎语。

### `GET /v1/health`

公开访问，无需鉴权。返回示例：

```json
{
  "status": "ok",
  "version": "1.0.0",
  "time": "2026-01-01T00:00:00.000Z",
  "kv": { "ok": true },
  "nonce": {
    "cached": true,
    "age_seconds": 109,
    "failure_count": 0,
    "stale": false
  }
}
```

`status` 取值 `ok` 或 `degraded`。`degraded` 时仍返回 200，监控按 body 判定。

### `GET /v1/models`

OpenAI 模型列表。

### `POST /v1/chat/completions`

OpenAI 对话接口。请求体字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `model` | 否 | 不传则用 `DEFAULT_MODEL` |
| `messages` | 是 | OpenAI 标准消息数组 |
| `stream` | 否 | `true` 返回 SSE，否则返回 JSON |
| `user` | 否 | 传则启用 stateful 多轮，会话上下文落 KV |
| `tools` | 否 | 传则启用 function calling |

工作模式判定：

```
有 tools / role:tool / assistant.tool_calls   →  工具调用模式（不走 stateful）
无 tools 但有 user                             →  stateful 多轮模式
都没有                                          →  无状态单轮
```

工具调用响应：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "kimi-k2-instruct-0905",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_...",
        "type": "function",
        "function": {"name": "get_weather", "arguments": "{\"city\":\"上海\"}"},
        "index": 0
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": { ... }
}
```

### `POST /v1/admin/refresh-nonce`

强制刷新上游 nonce，需要鉴权。

```bash
curl -X POST https://your.worker/v1/admin/refresh-nonce \
  -H "Authorization: Bearer $API_KEY"
```

返回 `{ nonce_preview, refreshed_at, request_id }`。

### `POST /v1/admin/reset-session`

清除指定 user 的多轮上下文，需要鉴权。

```bash
curl -X POST https://your.worker/v1/admin/reset-session \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user":"alice@example.com"}'
```

返回 `{ deleted, user, request_id }`。

### 错误响应格式

所有 4xx/5xx 都是统一结构：

```json
{
  "error": {
    "message": "无效的 API Key。",
    "type": "auth_error",
    "request_id": "req-mpmlnp3d-9dgtd6n5"
  }
}
```


## 客户端接入

### Cherry Studio / ChatBox / LobeChat / NextChat / OpenWebUI

| 项 | 值 |
|---|---|
| API 类型 | OpenAI |
| Base URL | `https://your.worker/v1` |
| API Key | 你设置的 `API_MASTER_KEY` |
| 模型 ID | `kimi-k2-instruct-0905` 或 `kimi-k2-instruct` |

### One API / New API

| 项 | 值 |
|---|---|
| 渠道类型 | OpenAI |
| 代理地址 | `https://your.worker`（**不要带 /v1**） |
| 密钥 | 你的 `API_MASTER_KEY` |
| 模型 | `kimi-k2-instruct-0905,kimi-k2-instruct` |

### Python

```python
from openai import OpenAI

client = OpenAI(base_url="https://your.worker/v1", api_key="sk-your-key")

resp = client.chat.completions.create(
    model="kimi-k2-instruct-0905",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

### Node.js

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://your.worker/v1",
  apiKey:  "sk-your-key",
});

const res = await client.chat.completions.create({
  model: "kimi-k2-instruct-0905",
  messages: [{ role: "user", content: "你好" }],
});
console.log(res.choices[0].message.content);
```

### curl

```bash
curl https://your.worker/v1/chat/completions \
     -H "Authorization: Bearer sk-your-key" \
     -H "Content-Type: application/json" \
     -d '{"model":"kimi-k2-instruct-0905","messages":[{"role":"user","content":"你好"}]}'
```


## 配置

### wrangler.toml `[vars]`（普通变量，可改后重新部署）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SESSION_CACHE_TTL` | `3600` | stateful 会话 TTL（秒） |
| `CONTEXT_MAX_LENGTH` | `1000` | 上游单次输入字符数上限，超了走滑窗 |
| `DEFAULT_MODEL` | `kimi-k2-instruct-0905` | 客户端没传 model 时用 |
| `STREAM_INTERVAL_MS` | `20` | 流式逐字节间隔（毫秒），Free Plan 设 `0` 省 CPU |

### Secret（敏感数据，用 `wrangler secret put` 注入）

| 变量 | 说明 |
|---|---|
| `API_MASTER_KEY` | 客户端 Bearer Token；设为 `1` 等价禁用鉴权 |

### 自定义域名

```toml
[[routes]]
pattern   = "kimi.example.com/*"
zone_name = "example.com"
```


## 本地开发

```bash
cp .dev.vars.example .dev.vars       # 编辑写本地 key
npm run dev                          # http://localhost:8787
npm run typecheck                    # 类型检查
npm run deploy:dry                   # 只打包不部署
npm run tail                         # 看线上实时日志
```


## 常见问题

**部署后报 502 / 上游错误**

通常是 nonce 失效或上游抖动。已有自动重试和强制刷新机制，必要时手动触发：

```bash
curl -X POST https://your.worker/v1/admin/refresh-nonce \
  -H "Authorization: Bearer $API_KEY"
```

仍然不行就 `npm run tail` 看日志，关注 nonce 抓取和上游响应。如果上游页面结构变了，可能要改 `src/providers/kimi.ts` 里 `fetchNonce()` 的正则。

**One API / New API 渠道测试失败**

1. 代理地址不要带 `/v1`，One API 会自己加。
2. `*.workers.dev` 域名在某些网络下被 DNS 污染，建议绑自定义域名。
3. 密钥要和 `API_MASTER_KEY` 完全一致。

**Free Plan 提示 CPU time exceeded**

把 `STREAM_INTERVAL_MS` 改成 `"0"`，重新部署。

**工具调用没触发**

按三层兜底顺序解析：`<tool_call>` 标签 → ```json``` 围栏 → 平衡括号裸 JSON。

排查：
- `tools.parameters` JSON Schema 是否合法
- 用户提问是否够明确
- `npm run tail` 看上游原始返回

**多轮对话越来越慢 / 出错**

上下文太长，触发上游限流。直接重置：

```bash
curl -X POST https://your.worker/v1/admin/reset-session \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user":"<user-id>"}'
```

**轮换 API Key**

```bash
echo "<new-key>" | npx wrangler secret put API_MASTER_KEY
```

不用重新部署，几秒内全球生效。

**完全卸载**

```bash
npx wrangler delete
npx wrangler kv namespace delete --binding KIMI_KV
```


## 实现说明

### 上游协议

kimi-ai.chat 是基于 WordPress 的 ChatGPT 镜像，没有原生 OpenAI API。请求形如：

```
POST https://kimi-ai.chat/wp-admin/admin-ajax.php
Content-Type: application/x-www-form-urlencoded

action=kimi_send_message&nonce=<dynamic>&message=<text>&model=<id>&session_id=<id>
```

`nonce` 从 `https://kimi-ai.chat/chat/` 页面 HTML 抓取：

```js
var kimi_ajax = {"ajax_url":"...","nonce":"<32-hex>"};
```

### 容错策略

- 单次上游调用超时 45s（`API_REQUEST_TIMEOUT_MS`）。
- 5xx / AbortError / 网络错误触发指数退避，最多 3 次（600ms / 1.5s / 3s + 抖动）。
- nonce 主动 6 小时过期，连续 3 次失败计数自动刷新，期间 KV 写入做阈值节流。
- 留足 wall-clock 60s 内最多 1~2 轮重试时间窗，避免被 CF Worker 平台超时截断。

### 工具调用模拟

上游只吃单个 `message` 字符串，function calling 全在网关层完成：

```
1. 检测到 tools  →  进入工具调用模式（绕过 stateful）
2. tools schema 编译成 system 指令拼到 prompt 里
3. 要求模型输出 <tool_call>{"name":"...","arguments":{...}}</tool_call>
4. 收到上游回复后按下面顺序兜底解析：
     a. <tool_call>...</tool_call> 标签
     b. ```json ... ``` 围栏
     c. 平衡括号扫描裸 JSON（必须含 name 和 arguments）
5. 命中  →  返回 OpenAI tool_calls 协议
   未命中 →  退回普通文本
```


## 项目结构

```
cfworker/
├── src/
│   ├── index.ts                  路由 / 鉴权 / 错误处理 / request_id
│   ├── config.ts                 Env 类型 / 模型映射 / 超时
│   ├── providers/
│   │   └── kimi.ts               nonce 自治 / 会话 / 上游调用 / 重试 / 健康检查
│   └── utils/
│       ├── sse.ts                SSE 与 chat.completion 构造
│       └── tool-calling.ts       工具调用 prompt 编译 + 三层解析
├── wrangler.toml
├── package.json
├── tsconfig.json
├── .gitignore
├── .dev.vars.example
├── LICENSE
└── README.md
```

## 命令清单

| 命令 | 说明 |
|---|---|
| `npm install` | 装依赖 |
| `npm run dev` | 本地 Miniflare（:8787） |
| `npm run typecheck` | 类型检查 |
| `npm run deploy:dry` | 只打包不部署 |
| `npm run deploy` | 部署 |
| `npm run tail` | 实时日志 |
| `npm run kv:create` | 创建 KV |
| `npm run secret:set` | 设置 API_MASTER_KEY |


## 友链

- LinuxDo 社区：<https://linux.do>
- 上游服务：<https://kimi-ai.chat>
- Cloudflare Workers：<https://workers.cloudflare.com>
- Hono 框架：<https://hono.dev>


## License

MIT，见 [LICENSE](./LICENSE)。

仅供学习研究。请遵守 kimi-ai.chat 的服务条款，不要拿去商用或干别的违法事。
