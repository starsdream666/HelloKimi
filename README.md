# HelloKimi-Kimi2API

> 🚀 **零成本、零运维、全球边缘部署** —— 把 [kimi-ai.chat](https://kimi-ai.chat) 转换为 OpenAI 兼容 API 的高性能 Cloudflare Workers 网关。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-4.6-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

---

## 技术架构

```
┌─────────────┐    OpenAI Protocol    ┌──────────────────────┐    HTTP    ┌──────────────┐
│  Your App   │ ───────────────────▶  │  Cloudflare Worker   │ ─────────▶ │ kimi-ai.chat │
│ (any SDK)   │ ◀───────────────────  │   (Edge Network)     │ ◀───────── │  (WordPress) │
└─────────────┘   SSE  /  JSON        └──────────────────────┘            └──────────────┘
                                              │
                                       ┌──────┴───────┐
                                       │  KV: KIMI_KV │  ← 会话上下文 + nonce 缓存
                                       └──────────────┘
```

---

## 目录

- [核心特性](#-核心特性)
- [⚡ 5 分钟部署](#-5-分钟部署)
- [API 文档](#-api-文档)
- [客户端接入](#-客户端接入)
- [配置参考](#%EF%B8%8F-配置参考)
- [本地开发](#-本地开发)
- [常见问题](#-常见问题)
- [实现原理](#-实现原理)
- [项目结构](#-项目结构)
- [License](#-license)

---

## ✨ 核心特性

| 能力 | 说明 |
|---|---|
| 🌐 **OpenAI 100% 协议兼容** | `/v1/chat/completions`、`/v1/models`，**自动适配 stream / 非流式两种模式** |
| 🛠️ **Function Calling** | 通过 Prompt 工程在网关层完整模拟 OpenAI tool_calls 协议（三层兜底解析） |
| 💬 **Stateful 多轮对话** | 客户端只需传 `user` 字段，会话上下文自动落盘到 KV，TTL 可配 |
| ⚡ **全球边缘加速** | 320+ Cloudflare 节点就近响应，冷启动 < 15ms |
| 🛡️ **天然反 CF 防护** | Worker 出口走 CF 内网，无需 cloudscraper / 浏览器自动化 |
| 🔐 **Secret 加密存储** | API Key 通过 `wrangler secret` 注入，从不落盘代码或 git |
| 💸 **0 元起步** | Cloudflare Free Plan 每日 100k 次请求免费，KV 1GB 存储免费 |
| 🌊 **真·伪流式** | 按 Unicode 码点切分（正确处理中文/emoji），兼容所有 OpenAI 流式客户端 |
| 🔁 **自愈机制** | 上游 nonce 失效自动刷新重试 |

支持的模型：`kimi-k2-instruct-0905`、`kimi-k2-instruct`

---

## 部署

### 前置要求

- Node.js ≥ 18
- 一个免费 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)

### 步骤 1：克隆并安装

```bash
git clone https://github.com/YOUR_USER/YOUR_REPO.git
cd YOUR_REPO/cfworker     # 如直接放在仓库根则忽略 cfworker
npm install
```

### 步骤 2：登录 Cloudflare

```bash
npx wrangler login
```

浏览器会弹出 OAuth 授权页，确认即可。

### 步骤 3：创建 KV 命名空间

```bash
npm run kv:create
```

输出示例：

```
✨ Success!
[[kv_namespaces]]
binding = "KIMI_KV"
id      = "abc123def456..."   ← 复制这个 id
```

### 步骤 4：填入 KV id

打开 [`wrangler.toml`](./wrangler.toml)，把 `YOUR_KV_NAMESPACE_ID` 替换成上一步返回的真实 id：

```toml
[[kv_namespaces]]
binding = "KIMI_KV"
id      = "abc123def456..."   # ← 你的真实 KV id
```

### 步骤 5：设置 API Key（强烈推荐）

```bash
echo "sk-your-strong-random-key" | npx wrangler secret put API_MASTER_KEY
```

> 留空或不设置时，将退化为 `API_MASTER_KEY="1"`，等价于**禁用鉴权**（仅本地调试可用）。

### 步骤 6：部署

```bash
npm run deploy
```

输出形如：

```
✨ Uploaded kimi-ai-2api (3.42 sec)
🌎 Deployed kimi-ai-2api triggers (0.99 sec)
   https://kimi-ai-2api.<your-subdomain>.workers.dev
```

🎉 **完成。** 立即测试：

```bash
curl https://kimi-ai-2api.<your-subdomain>.workers.dev/v1/models \
     -H "Authorization: Bearer sk-your-strong-random-key"
```

---

## 📡 API 文档

### `GET /`

健康检查。

### `GET /v1/models`

返回支持的模型列表（OpenAI 兼容）。

```json
{
  "object": "list",
  "data": [
    {"id": "kimi-k2-instruct-0905", "object": "model", "created": 1700000000, "owned_by": "lzA6"},
    {"id": "kimi-k2-instruct",       "object": "model", "created": 1700000000, "owned_by": "lzA6"}
  ]
}
```

### `POST /v1/chat/completions`

OpenAI 兼容对话接口。**根据 `stream` 字段自动切换响应格式**：

| `stream` | Content-Type | 响应格式 |
|---|---|---|
| `true` | `text/event-stream` | 多个 `data: {...}` chunk + `data: [DONE]` |
| `false` 或缺省 | `application/json` | 单个 `chat.completion` 对象（含 `usage`） |

**请求体（OpenAI 标准）：**

```json
{
  "model": "kimi-k2-instruct-0905",
  "stream": true,
  "messages": [
    {"role": "system", "content": "你是一个简明的助手"},
    {"role": "user",   "content": "你好"}
  ],
  "user": "alice@example.com",
  "tools": [ ... ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | 见上表，缺省 = `DEFAULT_MODEL` 配置 |
| `messages` | array | OpenAI 标准消息数组 |
| `stream` | bool | `true`=SSE 流式；`false` 或缺省 = JSON |
| `user` | string | **可选**。传则启用 stateful 会话（KV 持久化） |
| `tools` | array | **可选**。传则启用 OpenAI Function Calling |

#### 三种工作模式自动判定

```
有 tools / role:tool / assistant.tool_calls       →  工具调用模式（绕过 stateful）
无 tools 但有 user 字段                             →  Stateful 多轮模式（KV 上下文）
都没有                                              →  无状态单轮模式
```

#### 工具调用响应（`finish_reason=tool_calls`）

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

---

## 🔌 客户端接入

### Cherry Studio / ChatBox / LobeChat / NextChat / OpenWebUI

| 配置项 | 值 |
|---|---|
| API 类型 | `OpenAI` |
| Base URL | `https://kimi-ai-2api.<your-subdomain>.workers.dev/v1` |
| API Key | 你设置的 secret（如 `sk-xxx`） |
| 模型 ID | `kimi-k2-instruct-0905` 或 `kimi-k2-instruct` |

### One API / New API（多 LLM 聚合网关）

| 配置项 | 值 |
|---|---|
| 渠道类型 | `OpenAI` |
| 代理地址 | `https://kimi-ai-2api.<your-subdomain>.workers.dev` *（不要带 `/v1`）* |
| 密钥 | 你的 secret |
| 模型 | `kimi-k2-instruct-0905,kimi-k2-instruct` |

> ⚠️ One API / New API 的"渠道测试"默认发送 `stream:false`，本网关已正确返回 `application/json` chat.completion 对象 + `usage` 字段，测试可一键通过。

### Python OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://kimi-ai-2api.<your-subdomain>.workers.dev/v1",
    api_key="sk-your-strong-random-key",
)

# 流式
for chunk in client.chat.completions.create(
    model="kimi-k2-instruct-0905",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### Node.js

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://kimi-ai-2api.<your-subdomain>.workers.dev/v1",
  apiKey:  "sk-your-strong-random-key",
});

const res = await client.chat.completions.create({
  model: "kimi-k2-instruct-0905",
  messages: [{ role: "user", content: "你好" }],
});
console.log(res.choices[0].message.content);
```

### curl

```bash
curl https://kimi-ai-2api.<your-subdomain>.workers.dev/v1/chat/completions \
     -H "Authorization: Bearer sk-your-strong-random-key" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "kimi-k2-instruct-0905",
       "messages": [{"role":"user","content":"你好"}]
     }'
```

---

## ⚙️ 配置参考

### `wrangler.toml` · `[vars]` 段（可直接修改后重新部署）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SESSION_CACHE_TTL` | `3600` | stateful 会话上下文 TTL（秒） |
| `CONTEXT_MAX_LENGTH` | `1000` | 上游单次输入字符数硬上限（智能滑窗截断） |
| `DEFAULT_MODEL` | `kimi-k2-instruct-0905` | 客户端未指定模型时使用 |
| `STREAM_INTERVAL_MS` | `20` | 流式逐字符间隔（毫秒），**Free Plan 推荐设为 `0`** |

### Secret（敏感数据，必须用 wrangler secret put 注入）

| 变量 | 说明 |
|---|---|
| `API_MASTER_KEY` | 客户端必须携带的 Bearer Token；设为 `"1"` 等价禁用鉴权 |

### 自定义域名（可选）

打开 `wrangler.toml`，取消 `[[routes]]` 注释并填入你的域名：

```toml
[[routes]]
pattern   = "kimi.example.com/*"
zone_name = "example.com"
```

---

## 🧑‍💻 本地开发

```bash
# 1. 准备本地环境变量
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 写入你的本地 Key

# 2. 启动本地 dev server（Miniflare）
npm run dev
# → http://localhost:8787

# 3. 类型检查
npm run typecheck

# 4. 不实际部署，仅打包验证
npm run deploy:dry
```

---

## 💡 常见问题

<details>
<summary><b>Q1: 部署后访问 502 / 上游错误？</b></summary>

通常是 KV 中缓存的 nonce 失效。本网关有自动刷新重试机制，单次失败后会强制刷新 nonce 再试一次。如持续失败：

```bash
npm run tail        # 实时查看日志
```

观察 `nonce` 抓取与上游响应。若上游 [kimi-ai.chat](https://kimi-ai.chat) 主页面规则改变，可能需要更新 [`src/providers/kimi.ts`](./src/providers/kimi.ts) 中 `fetchNonce()` 的正则。

</details>

<details>
<summary><b>Q2: New API / One API 渠道测试失败？</b></summary>

请确认：

1. **代理地址不要带 `/v1`**（One API 内部会自动追加）。
2. 域名能解析到正确的 Cloudflare 边缘节点（部分网络环境下 `*.workers.dev` 可能存在 DNS 异常，建议绑定自定义域名）。
3. 密钥与 `wrangler secret put API_MASTER_KEY` 设置的值完全一致。

本网关已正确实现 `stream:false` 时返回 `application/json` 的 `chat.completion`（含 `usage`），与 One API/New API 的渠道测试协议完全兼容。

</details>

<details>
<summary><b>Q3: Free Plan 提示 CPU time exceeded？</b></summary>

把 `wrangler.toml` 中的 `STREAM_INTERVAL_MS` 设为 `"0"`，避免 `setTimeout` 累计 CPU 时间：

```toml
STREAM_INTERVAL_MS = "0"
```

重新部署后即可。

</details>

<details>
<summary><b>Q4: 工具调用没触发，模型直接返回了文本？</b></summary>

本网关已实现三层兜底解析：

1. `<tool_call>{...}</tool_call>` 标签
2. ` ```json {...} ``` ` 围栏
3. 平衡括号扫描裸 JSON（含 `name` + `arguments` 字段）

若仍未触发，请检查：

- `tools` 数组中 `parameters` JSON Schema 是否合法
- 用户提问是否明确（模型有可能判断不需要调用工具）
- 通过 `npm run tail` 查看上游原始响应

</details>

<details>
<summary><b>Q5: 如何更换 / 轮换 API Key？</b></summary>

```bash
echo "<new-key>" | npx wrangler secret put API_MASTER_KEY
```

无需重新部署，全球边缘节点会在数秒内生效。

</details>

<details>
<summary><b>Q6: 如何完全卸载？</b></summary>

```bash
npx wrangler delete                              # 删除 Worker
npx wrangler kv namespace delete --binding KIMI_KV   # 删除 KV
```

</details>

---

## 🔍 实现原理

### 与 [kimi-ai.chat](https://kimi-ai.chat) 上游的协议适配

上游是基于 WordPress 的 ChatGPT 镜像站，**没有原生 OpenAI API**，请求形如：

```
POST https://kimi-ai.chat/wp-admin/admin-ajax.php
Content-Type: application/x-www-form-urlencoded

action=kimi_send_message&nonce=<dynamic>&message=<text>&model=<id>&session_id=<id>
```

其中 `nonce` 是从 `https://kimi-ai.chat/chat/` 页面 HTML 中通过正则抓取的动态 token：

```js
var kimi_ajax = {"ajax_url":"...","nonce":"<32-hex>"};
```


### 工具调用模拟原理

由于上游接口只接收单个 `message` 字符串，Function Calling 完全在网关层模拟：

```
1. 检测 tools 字段 → 进入工具调用模式（绕过 stateful 缓存）
2. 把 tools schema 编译成 system 指令注入 prompt
3. 要求模型输出格式：<tool_call>{"name":"...","arguments":{...}}</tool_call>
4. 收到上游回复后三层兜底解析：
   ┌─ Layer 1: <tool_call>...</tool_call> 标签
   ├─ Layer 2: ```json ... ``` 围栏
   └─ Layer 3: 平衡括号扫描裸 JSON（必须含 name+arguments 才视为工具调用）
5. 命中 → 输出 OpenAI tool_calls 协议（finish_reason: tool_calls）
   未命中 → 退回普通文本输出
```

---

## 项目结构

```
cfworker/
├── src/
│   ├── index.ts                  ← Hono 路由 / 鉴权 / 错误处理
│   ├── config.ts                 ← Env 类型 / 模型映射 / 上游端点
│   ├── providers/
│   │   └── kimi.ts               ← 核心业务（nonce / 会话 / 上游调用 / 流式输出）
│   └── utils/
│       ├── sse.ts                ← SSE 块 + 非流式 chat.completion 构造器
│       └── tool-calling.ts       ← 工具调用 Prompt 编译 + 三层兜底解析
├── wrangler.toml                 ← Cloudflare Workers 配置
├── package.json                  ← 依赖与脚本
├── tsconfig.json                 ← TypeScript 配置
├── .gitignore
├── .dev.vars.example             ← 本地开发环境变量模板
├── LICENSE                       ← MIT
└── README.md
```

## License

[MIT](./LICENSE) © 2025 kimi-ai-2api contributors

本项目仅供学习与研究使用。请遵守 [kimi-ai.chat](https://kimi-ai.chat) 的服务条款，不得用于任何商业牟利或违反当地法律法规的用途。

---

## 致谢

- 上游服务：[kimi-ai.chat](https://kimi-ai.chat)
- 框架：[Hono](https://hono.dev/) · [Cloudflare Workers](https://workers.cloudflare.com/)
- 灵感来源：本项目的 [Python 版本](../) 完整业务逻辑

如本项目对你有帮助，欢迎 ⭐ Star。
