# PoO Parent Gateway 接入技术方案

## 背景

`claude-relay-service` 当前直接向上游模型服务发起请求；如果账号配置了代理，则通过本进程内的 proxy agent 访问上游：

- 无代理：`中转站 -> 上游模型`
- 有代理：`中转站 -> 代理 -> 上游模型`

接入 PoO Parent Gateway 后，请求链路调整为：

- 无代理：`中转站 -> PoO Parent Gateway -> Enclave/PoO -> 上游模型`
- 有代理：`中转站 -> PoO Parent Gateway -> Enclave/PoO -> PoO Parent Gateway egress -> 代理 -> 上游模型`

PoO Parent Gateway 已负责 route/lane 分配、`REQ_HEAD.egress_port` 改写、Enclave response frame 透明转发，以及按请求接入代理。`claude-relay-service` 侧只需要把原本将要发给上游的 HTTP 请求封装为 PoO Relay Frame Protocol，并在调用 Gateway 时把账号代理地址放入 `X-PoO-Proxy-URL`。

本方案的对外响应格式以 PoO 同步上线的请求/响应字段级 proof 为基线能力。也就是说，中转站可以在 Enclave 返回后继续执行现有 JSON 解析、usage 统计、错误 envelope 生成和 OpenAI compatible 协议转换，再把字段级 proof 放入最终 JSON 或 SSE 尾部。proof 的语义由字段级 proof / verifier 证明“最终对外字段与 TEE 内观察到的上游请求、响应字段之间的绑定关系”，而不是要求最终客户端收到的 JSON bytes 与上游原始 response bytes 完全一致。

## 目标

1. 在不改造 Parent Gateway 接口和本仓库以外组件的前提下，依赖支持字段级 proof 的 PoO 版本，让 Claude 请求默认走 proof 签名链路。
2. 保留原有账号选择、专属账号、sticky session、队列、并发、限流、计费和错误保护逻辑。
3. 账号原有代理配置继续由中转站负责管理和校验；接入 PoO 后仅把该代理序列化为 proxy URL 透传给 Gateway。
4. 新增接入逻辑尽量集中在一个独立代码包内，方便提供给采用同一套开源代码的第三方中转站自行接入。
5. 现有业务代码只在真正发起上游请求的关键位置调用新包，不把 PoO frame、Gateway HTTP、proof 解析细节散落到 relay service 中。

## 非目标

1. 不在 `claude-relay-service` 内注册 Gateway egress route；route/lane 由 Parent Gateway 在一次 `/v1/proof/relay` 调用内完成。
2. 不让 proof statement 声明或证明使用了哪个代理出口。
3. 不在中转站侧新增代理 allowlist、CIDR、连通性探测或有效性校验；代理配置有效性仍由中转站账号体系负责。
4. 不替换账号调度、计费、限流、自动保护、客户端协议转换等现有业务逻辑。
5. 不支持旧的 L4 透明 tcp/vsock bridge 完成按请求代理；按请求代理只能走 Parent Gateway HTTP 接入。

## 现有代码链路

### Claude OAuth 账号

核心文件：`src/services/relay/claudeRelayService.js`

- `relayRequest(...)` 处理非流式请求。
- `_makeClaudeRequest(...)` 使用 `https.request` 发起非流式上游请求。
- `relayStreamRequestWithUsageCapture(...)` 处理流式请求的账号选择、队列和状态管理。
- `_makeClaudeStreamRequestWithUsageCapture(...)` 使用 `https.request` 发起流式上游请求并将 SSE chunk 写回客户端。
- `_prepareRequestHeadersAndPayload(...)` 是请求进入上游前的关键公共点，负责构造最终 body、headers、认证、`anthropic-beta`、`User-Agent` 和工具名兼容转换。
- `_getProxyAgent(accountId)` 当前读取账号 `proxy` 字段并创建本地 proxy agent。

### Claude Console / CCR 同构链路

核心文件：

- `src/services/relay/claudeConsoleRelayService.js`
- `src/services/relay/ccrRelayService.js`

它们使用 `axios` 发送请求，代理来源也是账号上的 `account.proxy`。这些链路与官方 Claude OAuth 请求结构相近，适合在官方 Claude 链路稳定后复用同一个 PoO 包接入。

### 代理配置

核心文件：`src/utils/proxyHelper.js`

当前代理配置支持对象或 JSON 字符串，主要字段：

```json
{
  "type": "http|https|socks5",
  "host": "127.0.0.1",
  "port": 7890,
  "username": "optional",
  "password": "optional"
}
```

接入 PoO 后，请求不再把该配置转成本地 `httpAgent/httpsAgent`，而是把它序列化为 Gateway 能识别的 URL 并放入 `X-PoO-Proxy-URL`。

## 新增代码包设计

新增包建议放在：

```text
src/poo-parent-gateway/
```

该包只依赖 Node.js 标准库和很少的通用工具，不依赖 Redis、账号服务、调度器、计费服务、Express response 等业务对象。建议目录：

```text
src/poo-parent-gateway/
  index.js
  config.js
  frameCodec.js
  gatewayClient.js
  proxyUrl.js
  responseAdapter.js
  errors.js
```

### 模块职责

`config.js`

- 从 `config/config.js` 或 env 读取 PoO Gateway 配置。
- 判断功能是否启用、是否 required、Gateway URL、超时、mTLS 文件路径等。
- 执行启动期配置校验：`authMode=none` 只能配合 loopback HTTP Gateway URL；远程 HTTPS Gateway 必须使用 `authMode=mtls` 并配置 CA、client certificate、client key 和 servername。

`frameCodec.js`

- 编解码 PoO Relay Frame Protocol。
- 写入 `REQ_HEAD`、`REQ_BODY`。
- 读取 `RESP_HEAD`、`RESP_CHUNK`、`RESP_TRAILER`、`ERR`。
- 从最终上游 headers 中过滤 `host`、`authorization`、`content-length`、`connection`、`transfer-encoding`、`te`、`trailer`、`upgrade`、`proxy-connection`、`keep-alive` 等不应进入 `REQ_HEAD.upstream.headers` 的字段。
- frame 格式与已验证的 PoO 协议保持一致：`1 byte type + 4 bytes big-endian length + payload`。

`gatewayClient.js`

- 调用 `POST /v1/proof/relay`。
- 请求头固定包含 `Content-Type: application/vnd.poo.frames`。
- 请求体为 `REQ_HEAD + REQ_BODY` bytes。
- 有代理时追加 `X-PoO-Proxy-URL`。
- 追加可观测 metadata：`X-PoO-Tenant-ID`、`X-PoO-Account-ID`、`X-PoO-Request-ID`。
- 支持本机 loopback HTTP 和远程 HTTPS/mTLS 两种部署方式。

`proxyUrl.js`

- 将现有 `account.proxy` 序列化为 proxy URL。
- 支持对象和 JSON 字符串。
- 不做连通性检查，不做 allowlist，不改变账号系统已有代理语义。
- 日志中只输出脱敏后的代理描述。

`responseAdapter.js`

- 把 Gateway response frame 转换为现有 relay service 需要的响应形态。
- 非流式返回 `{ statusCode, headers, body, proofJSON }`。
- 提供非流式 JSON proof 注入工具：把原上游 JSON body 或转换后的 OpenAI compatible JSON 对象增加 `proof` 字段；无法解析为 JSON 时按错误处理，不返回 multipart。
- `proofJSON` 按字段级 proof 版本透传和注入；adapter 不重新签名、不生成 proof、不把代理地址写入 proof。字段级 proof 的具体字段、版本号和 verifier 规则以 PoO 仓库对应规范为准。
- 校验 `proofJSON` 至少包含字段级 proof 的版本 / 能力标识和必需字段；PoO required 模式下，如果 proof 缺失、不是合法 JSON、字段级 proof schema 不完整或版本不支持，本次请求按 proof 缺失 / proof schema 错误失败。
- 流式只负责解出 `RESP_HEAD` / `RESP_CHUNK` / `RESP_TRAILER`，不绕过现有 SSE usage parser 和 `streamTransformer`；PoO 流式分支必须把“处理并写出上游 SSE chunk”和“结束客户端 responseStream”拆开，等 `RESP_TRAILER` 到达并写完 `tee.proof` 或 `tee.error` 后才调用 `responseStream.end()`。

`errors.js`

- 定义 `PoOGatewayUnavailableError`、`PoOFrameError`、`PoOProofMissingError` 等错误类型。
- 区分“请求尚未交给 Gateway/Enclave”和“请求可能已经提交”的失败，避免业务层错误重试导致上游重复调用。

### 包对外 API

建议暴露三个核心函数：

```js
const poo = require('../../poo-parent-gateway')

poo.isEnabled()

await poo.relayOnce({
  method,
  url,
  headers,
  bodyBuffer,
  proxyConfig,
  tenantId,
  accountId,
  requestId,
  timeoutMs,
  signal
})

await poo.relayStream({
  method,
  url,
  headers,
  bodyBuffer,
  proxyConfig,
  tenantId,
  accountId,
  requestId,
  timeoutMs,
  signal,
  onHead,
  onChunk,
  onProof,
  onError
})
```

业务层不直接接触 frame 类型和 Gateway HTTP 细节。

## 配置设计

在 `config/config.js` 中新增 `pooParentGateway` 配置块，并在 `.env.example` / `config/config.example.js` 中补充示例。

```js
pooParentGateway: {
  enabled: process.env.POO_PARENT_GATEWAY_ENABLED === 'true',
  required: process.env.POO_PARENT_GATEWAY_REQUIRED !== 'false',
  url: process.env.POO_PARENT_GATEWAY_URL || 'http://127.0.0.1:15005/v1/proof/relay',
  authMode: process.env.POO_PARENT_GATEWAY_AUTH_MODE || 'none',
  timeoutMs: parseInt(process.env.POO_PARENT_GATEWAY_TIMEOUT_MS) || 600000,
  maxBodyBytes: parseInt(process.env.POO_PARENT_GATEWAY_MAX_BODY_BYTES) || 64 * 1024 * 1024,
  mtls: {
    caFile: process.env.POO_PARENT_GATEWAY_CA_FILE || '',
    certFile: process.env.POO_PARENT_GATEWAY_CERT_FILE || '',
    keyFile: process.env.POO_PARENT_GATEWAY_KEY_FILE || '',
    servername: process.env.POO_PARENT_GATEWAY_SERVER_NAME || ''
  }
}
```

配置语义：

- `POO_PARENT_GATEWAY_ENABLED=false` 时完全保持现有直连/本地代理链路。
- `POO_PARENT_GATEWAY_ENABLED=true` 时，符合条件的 Claude 上游请求默认走 PoO Gateway。
- `POO_PARENT_GATEWAY_REQUIRED=true` 是生产推荐值；Gateway 不可用或 proof 缺失时，本次请求按失败处理。
- `POO_PARENT_GATEWAY_REQUIRED=false` 仅用于灰度；请求尚未提交给 Gateway 时可回退原链路，请求已提交后不回退，避免重复调用上游。
- `POO_PARENT_GATEWAY_URL` 指向 Parent Gateway HTTP endpoint，而不是旧 L4 tcp/vsock bridge。
- `POO_PARENT_GATEWAY_AUTH_MODE=none` 只允许用于父 VM 本机 / loopback 接入，URL 应为 `http://127.0.0.1:15005/v1/proof/relay` 或等价本机地址。
- 远程中转站部署必须使用 `POO_PARENT_GATEWAY_AUTH_MODE=mtls` 和 `https://.../v1/proof/relay`，并配置 `CA / client cert / client key / servername`。Gateway 侧必须把该 client certificate identity 加入 client policy，否则会返回 `403 forbidden`。
- `X-PoO-Proxy-URL` 可能包含代理用户名密码，日志、APM、反向代理 access log 和错误信息都必须脱敏或不记录该 header 原值。

实现要求：

- `authMode=none` 且 `POO_PARENT_GATEWAY_URL` 不是 loopback HTTP URL 时，服务启动时必须报错或禁用 PoO，不能等到请求运行时才失败。
- `authMode=mtls` 时，必须在启动期确认 `caFile`、`certFile`、`keyFile` 均已配置且可读；`https` 远程 URL 未启用 mTLS 时必须报错或禁用 PoO。
- `authMode` 只能接受 `none` 和 `mtls`，其它值视为配置错误。

本仓库侧不新增 upstream host allowlist 和 proxy allowlist。上游访问范围由 Parent Gateway 生产配置控制，代理地址有效性由账号系统负责。

## Gateway 请求格式

### HTTP 请求

```http
POST /v1/proof/relay HTTP/1.1
Content-Type: application/vnd.poo.frames
X-PoO-Proxy-URL: http://user:pass@proxy.example.com:8080
X-PoO-Tenant-ID: claude-relay-service
X-PoO-Account-ID: claude-account-id
X-PoO-Request-ID: request-id
```

无代理时不发送 `X-PoO-Proxy-URL`。

### Gateway 响应格式

Gateway 成功时只返回 Enclave 原始 frame stream：

```http
HTTP/1.1 200 OK
Content-Type: application/vnd.poo.frames
```

response body 仍是 PoO Relay Frame Protocol bytes，包含 `RESP_HEAD`、一个或多个 `RESP_CHUNK`、最终 `RESP_TRAILER`，或 Enclave 原始 `ERR` frame。Gateway 不生成 `tee.proof` SSE event，不生成 multipart，不把响应转换为 JSON；这些转换都在 `claude-relay-service` 的 PoO adapter / response adapter 中完成。

Gateway 在请求尚未转发给 Enclave 前发生自身错误时，可能返回非 2xx 和：

```http
Content-Type: application/problem+json
```

新包必须先按 HTTP status 和 `Content-Type` 分流：

- `2xx + application/vnd.poo.frames`：进入 frame parser。
- `application/problem+json` 或非 2xx：解析为 Gateway preflight 错误；如果 `required=false` 且确认请求尚未提交给 Gateway/Enclave，可回退原链路，否则按失败返回。
- `2xx` 但不是 `application/vnd.poo.frames`：按协议错误处理，不解析为上游响应。

### REQ_HEAD

`REQ_HEAD` 由新包生成：

```json
{
  "nonce": "base64-32-bytes",
  "egress_port": 0,
  "upstream": {
    "host": "api.anthropic.com",
    "method": "POST",
    "path": "/v1/messages?beta=true",
    "headers": {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,...",
      "User-Agent": "claude-cli/..."
    }
  },
  "token": "oauth-access-token-if-bearer"
}
```

说明：

- `egress_port` 填 `0` 占位，由 Parent Gateway 改写为本次请求分配的 lane port。
- `upstream.host`、`method`、`path` 必须来自业务层最终要请求的上游 URL。
- Gateway v1 只支持上游目标端口 `443`。第一期官方 Claude OAuth 链路固定使用 `https://api.anthropic.com:443`；后续接入 Console / CCR 前，必须确认其 `account.apiUrl` 也是 HTTPS 443 上游，或等待 Gateway 支持非 443 目标后再接入。
- `headers` 必须以 `_prepareRequestHeadersAndPayload(...)` 生成后的最终 headers 为来源，再按 PoO 协议过滤 hop-by-hop 字段、`host`、`authorization` 和 `content-length`。
- `authorization` 不放入 `headers`，而是按现有 PoO 协议提取 Bearer token 放入 `token` 字段。
- `x-api-key` 这类非 Bearer 认证如果后续接入 Console/CCR，需要保留在 `headers` 中。

### 最终上游 URL

PoO 分支必须先生成一个唯一的 `finalUpstreamUrl`，后续原链路请求参数和 PoO `REQ_HEAD.upstream` 都从这个 URL 派生，避免 proof 链路与直连链路在 path/query 上分叉。

生成规则：

- 默认官方 Claude OAuth 链路使用 `this.claudeApiUrl`。
- 存在 `requestOptions.customPath` 时，使用 `new URL(requestOptions.customPath, 'https://api.anthropic.com')` 解析，保留 `customPath` 自身的 `pathname` 和 `search`。
- `REQ_HEAD.upstream.host` 使用 `finalUpstreamUrl.hostname`，不能使用 `finalUpstreamUrl.host`，不能传入 `host:port` authority。
- `REQ_HEAD.upstream.path` 使用 `finalUpstreamUrl.pathname + finalUpstreamUrl.search`。
- `finalUpstreamUrl.protocol` 必须是 `https:`，端口必须为空或 `443`；否则不进入 Gateway v1 PoO 链路。

### REQ_BODY

`REQ_BODY` 为最终上游请求体 bytes。Claude 官方链路中应使用 `_prepareRequestHeadersAndPayload(...)` 返回的 `bodyString` 转成 `Buffer`，保证 proof 覆盖的是实际发送给上游的内容，而不是进入 relay service 时的原始请求体。

## 官方 Claude 链路接入点

### 非流式

改造点：`src/services/relay/claudeRelayService.js`

在 `_makeClaudeRequest(...)` 中，完成 `_prepareRequestHeadersAndPayload(...)` 后增加分支：

1. 如果 PoO 未启用，保持现有 `https.request` 逻辑。
2. 如果 PoO 启用：
   - 构造最终上游 URL。
   - 从账号对象读取 `account.proxy`，传给新包。
   - 调用 `poo.relayOnce(...)`。
   - 将返回值转换为现有 `{ statusCode, headers, body, proofJSON }`。
   - `body` 仍保持上游原始 JSON 字符串，不在 relay service 内改成 multipart。

非流式最终响应由现有 route 层输出，不能返回 `multipart/mixed`，因为很多 Claude / OpenAI compatible 客户端不兼容 multipart。route 层在完成现有 usage 解析和计费后，把 proof 注入原 JSON 对象：

```json
{
  "id": "msg_...",
  "type": "message",
  "content": [],
  "usage": {},
  "proof": {
    "v": 2
  }
}
```

这里依赖字段级 proof 语义：非流式 route 可以 `JSON.parse(response.body)` 后重新序列化并增加 `proof` 字段；OpenAI compatible route 也可以把 Claude 响应转换为 OpenAI JSON envelope。最终 proof 证明的是字段级绑定关系，不要求最终响应体字节与 Enclave 观察到的原始上游 body 逐字节一致。因此生产开启 PoO required 前，必须确认 PoO / verifier 的字段级 proof 能覆盖本 adapter 输出的 JSON 字段映射。

落地约束：

- `claudeRelayService.relayRequest(...)` 只返回上游语义结果和 `proofJSON`，不直接写客户端响应。
- `src/routes/api.js` 的非流式分支在 `JSON.parse(response.body)` 成功、usage 统计完成后，如果 `response.proofJSON` 存在，则设置 `jsonData.proof = compactProofObject`，再调用 `res.json(jsonData)`。
- `src/routes/openaiClaudeRoutes.js` 的 OpenAI compatible 非流式分支也要在转换后的 JSON 响应中增加 `proof` 字段；proof 不参与 usage 计费。该 proof 按字段级 proof 语义证明最终 OpenAI envelope 中关键字段与底层 Claude upstream observation 的绑定关系。
- 上游返回非 2xx 错误 JSON，但 Gateway/Enclave 已返回完整 `RESP_TRAILER` 时，也要在最终返回给客户端的错误 JSON 顶层增加 `proof` 字段，同时继续执行现有账号保护、限流、overload、sticky session 清理等逻辑。
- OpenAI compatible 非流式错误响应当前会把 Claude 错误转换为 OpenAI error envelope；PoO 接入后必须在该 error envelope 顶层增加 `proof` 字段，而不是只在成功响应中注入。
- PoO required 模式下，如果 Gateway/Enclave 没有返回 `proofJSON`，不能把该响应当作已验证响应返回；如果响应尚未写出，应返回 PoO relay/proof 缺失错误。
- 如果上游 body 不是合法 JSON 且 PoO required，本次响应按 `502 invalid_response` 失败，不退回 multipart；如果 PoO disabled，则保持原行为。

### 流式

改造点：`src/services/relay/claudeRelayService.js`

在 `_makeClaudeStreamRequestWithUsageCapture(...)` 中，完成 `_prepareRequestHeadersAndPayload(...)` 后增加分支：

1. 如果 PoO 未启用，保持现有 `https.request` 逻辑。
2. 如果 PoO 启用：
   - 调用 `poo.relayStream(...)`。
   - `onHead` 中复用现有成功响应头处理，并调用 `onResponseStart()`，保持队列锁提前释放语义。
   - 如果 `RESP_HEAD.statusCode !== 200`，PoO 分支必须进入现有 stream upstream error handler 等价逻辑：收集错误 `RESP_CHUNK` body，执行 429 限流识别、403 重试、401/403/529 账号保护、overload/临时不可用标记、sticky session 清理和现有错误输出策略。
   - 非 200 错误响应如果 Gateway/Enclave 返回了完整 `RESP_TRAILER`，仍按字段级 proof 语义把 proof 附加到最终错误输出；如果缺少 proof 且 PoO required，则按 proof 缺失处理。
   - `onChunk` 中拿到的是 Enclave 透传出的上游 SSE bytes，但不能绕过现有 SSE parser、usage 捕获和 `streamTransformer`。
   - native Anthropic `/v1/messages` 请求：`RESP_CHUNK` 按当前 Claude SSE 解析逻辑捕获 usage 后原样写出。
   - OpenAI compatible 请求：`RESP_CHUNK` 必须继续经过现有 `streamTransformer` 转换为 OpenAI SSE chunk 后再写出。
   - `onProof` 中在原 SSE 事件完整结束后追加 `tee.proof`，然后再结束客户端响应流。
   - PoO 流式分支不能复用现有 `dataSource.on('end')` 中直接 `responseStream.end()` 的结束行为；必须把现有 chunk 解析、usage 捕获、`streamTransformer` 写出逻辑抽成可复用 helper，PoO 分支在 `RESP_TRAILER` proof 写完后统一 `end()`。

```text
event: tee.proof
data: <compact proof json>

```

`tee.proof` 事件始终追加在最终客户端 SSE 流末尾：

- native Anthropic 流：Claude 原始 SSE 结束后追加 `event: tee.proof`。
- OpenAI compatible 流：先保持现有协议发送 `data: [DONE]`，随后追加 `event: tee.proof`。最终顺序固定为：

```text
data: [DONE]

event: tee.proof
data: <compact proof json>

```

- `tee.proof` 不参与 usage 统计，不进入 rate limit token 计数。
- 对 OpenAI compatible 流，`tee.proof` 不进入 `streamTransformer`；它由 PoO adapter 在 transformer 已经输出 `data: [DONE]` 后直接写入客户端 SSE。

如果 Gateway/Enclave 在 `RESP_TRAILER` 前返回 `ERR` 或连接关闭：

- 响应尚未开始：返回 502/503，不向客户端返回未验证响应。
- 响应已经开始：写出 `event: tee.error` 后关闭连接；业务层记录 proof 缺失。已发送的上游 chunk 无法撤回，这是流式响应的协议限制。

### customPath / count_tokens

PoO 分支必须使用与原链路完全相同的最终上游 URL 生成逻辑：

- 默认：`/v1/messages?beta=true`
- 非流式自定义：`_makeClaudeRequest(...)` 已支持 `requestOptions.customPath`，必须基于 `https://api.anthropic.com` 解析 `customPath`，并保留 `customPath` 自身的 query。
- 流式：`_makeClaudeStreamRequestWithUsageCapture(...)` 当前默认使用 `this.claudeApiUrl`；如果后续给流式路径增加 `customPath`，PoO 分支必须同步复用同一逻辑，不能在 PoO 和非 PoO 两条路径里分叉。

这样 count_tokens 等非默认 endpoint 不会因为接入 PoO 改变路径。

## 代理接入

### 代理 URL 序列化

新增包提供 `proxyUrl.fromProxyConfig(proxyConfig)`：

```js
fromProxyConfig({
  type: 'http',
  host: 'proxy.example.com',
  port: 8080,
  username: 'user',
  password: 'pass'
})
// => "http://user:pass@proxy.example.com:8080"
```

规则：

- 生成结果必须是 RFC 3986 absolute URI。
- `type=http|https` 时生成对应 URL。
- `type=socks5` 时默认生成 `socks5h://...`，保持现有 `SocksProxyAgent` 使用 `socks5h`、DNS 走代理侧解析的行为；如果后续账号配置显式支持 `socks5h`，则原样生成 `socks5h://...`。
- 非空 proxy URL 必须显式包含 `host:port`，不做默认端口补齐。
- 用户名和密码使用 `encodeURIComponent`。
- path、query、fragment 必须为空。
- header 值不能包含 CR/LF、控制字符或前后空白，长度不得超过 Gateway 限制。
- 空代理返回空字符串，不发送 `X-PoO-Proxy-URL`。
- 不探测代理连通性，不做代理目标限制，不把代理 URL 写入 proof。

### 与现有 proxy agent 的关系

PoO 启用时：

- 请求到上游的代理由 Gateway egress 执行。
- `claude-relay-service` 不再为这次上游请求设置 `proxyAgent`。
- `proxyAgent` 仍可用于非 PoO 链路，以及账号刷新、测试、余额检测等非 PoO 请求。

PoO 未启用时：

- 继续使用现有 `_getProxyAgent(...)` 和 `ProxyHelper.createProxyAgent(...)`。

## 响应和 proof 输出

### 非流式响应

默认仍返回原来的 JSON 响应格式，只在 JSON 对象顶层增加 `proof` 字段。

示例：

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [],
  "usage": {},
  "proof": {
    "v": 2
  }
}
```

约束：

- 不返回 `multipart/mixed`。
- 不改变原有 `Content-Type: application/json`。
- `proof` 字段只用于返回 Enclave 生成的 proof JSON，不参与 usage 计费和限流统计。
- `proof` 字段必须是字段级 proof；如果 proof 缺失、格式错误或 schema 不完整，PoO required 模式下不能返回已验证响应。
- 如果上游成功响应不是 JSON，PoO required 模式下按响应格式错误处理；PoO disabled 时保持原行为。

### 流式响应

native Anthropic `/v1/messages` 默认保持上游 SSE chunk 原样透传，并在 Claude 原始 SSE 结束后追加：

```text
event: tee.proof
data: {"v":2,...}

```

OpenAI compatible 路径继续先转换为 OpenAI SSE chunk，并保持最终顺序为：

```text
data: [DONE]

event: tee.proof
data: {"v":2,...}

```

`tee.proof` 事件不参与账号限流判断和 usage 计费；usage 捕获应继续基于上游原有 message delta / message stop 事件。

## 错误处理语义

### 请求尚未提交给 Gateway/Enclave

例如 Gateway DNS、连接拒绝、mTLS 握手失败、Gateway preflight 返回 `application/problem+json`、请求 body 写入前失败：

- `required=true`：返回 503 `poo_gateway_unavailable`。
- `required=false`：允许回退现有直连/本地代理链路。

### 请求可能已经提交给 Gateway/Enclave

例如 frame body 已写出后连接中断、读取响应 frame 失败、Gateway 返回 `ERR`：

- 不回退直连链路。
- 不自动重试上游请求。
- 返回 502 `poo_relay_failed`，或在流式已开始时发送 `tee.error` 并关闭。

这样可以避免同一用户请求被重复提交到 Anthropic。

### 上游业务错误

如果 Gateway 正常返回 `RESP_HEAD` 和 `RESP_CHUNK`，但上游状态码是 401、403、429、529、5xx：

- 仍交给现有 `claudeRelayService` 处理账号保护、限流、overload、sticky session 清理等逻辑。
- PoO 包不理解 Anthropic 业务错误，只保留 status、headers、body。

## 最小代码改动范围

第一期只建议修改：

```text
config/config.js
config/config.example.js
.env.example
src/routes/api.js
src/routes/openaiClaudeRoutes.js
src/services/relay/claudeRelayService.js
src/poo-parent-gateway/*
tests/poo-parent-gateway/*
tests/poo-parent-gateway-route-integration*
```

可选修改：

```text
src/services/relay/claudeConsoleRelayService.js
src/services/relay/ccrRelayService.js
```

官方 Claude OAuth 链路稳定后，再接入 Console/CCR，避免一次性改动过大。

## 测试计划

### 单元测试

新增 `tests/poo-parent-gateway/`：

- `frameCodec.test.js`
  - 编码 `REQ_HEAD` / `REQ_BODY`。
  - 解码 `RESP_HEAD` / 多个 `RESP_CHUNK` / `RESP_TRAILER`。
  - frame 长度超限、未知 frame type、提前 EOF。
- `proxyUrl.test.js`
  - http、https、socks5、有认证、无认证、JSON 字符串、空代理。
  - 认证信息 URL encode。
  - 日志脱敏不输出密码。
- `gatewayClient.test.js`
  - 调用 URL、Content-Type、metadata headers。
  - `2xx + application/vnd.poo.frames` 进入 frame parser。
  - `application/problem+json` / 非 2xx 映射为 Gateway preflight 错误。
  - 有代理时发送 `X-PoO-Proxy-URL`，无代理时不发送。
  - mTLS agent 配置。
  - `authMode=none` 只允许 loopback HTTP URL，远程 HTTPS URL 必须配置 mTLS。
  - 写出请求后失败时标记为 submitted，业务层不得回退。

### relay service 集成测试

新增或扩展 Claude relay 测试：

- PoO disabled 时，仍走原有 `https.request` 和本地 proxy agent。
- PoO enabled 非流式时，调用新包 `relayOnce`，返回 status/headers/body/proof。
- `/v1/messages` 非流式 route 在原 JSON 响应顶层增加 `proof` 字段，并仍能记录 usage。
- OpenAI compatible 非流式 route 在转换后的 JSON 响应顶层增加 `proof` 字段，并仍能记录 usage。
- 上游非 2xx 错误 JSON 在具备完整 proof 时也会注入 `proof` 字段，并仍触发现有账号保护逻辑。
- PoO enabled native Anthropic 流式时，`RESP_CHUNK` 原样写给客户端，最后追加 `tee.proof`。
- OpenAI compatible 流式请求中，`RESP_CHUNK` 必须经过 `streamTransformer` 后再写客户端，先发送 `data: [DONE]`，再追加 `event: tee.proof`。
- PoO enabled 流式非 200 响应复用现有 stream upstream error handler 语义，覆盖 429、403 retry、401、529、5xx 和字段级 proof 附加 / proof 缺失失败。
- `customPath` 请求生成正确 path。
- `REQ_HEAD.upstream.host` 使用 hostname 而不是 `host:port` authority；`https://api.anthropic.com:443` 生成 `api.anthropic.com`，`:8443` 等非 443 目标不进入 PoO v1。
- 字段级 proof fixture 覆盖非流式 JSON 注入、OpenAI compatible 成功响应和 OpenAI compatible 错误 envelope，确认改写后的最终响应可按字段级 verifier 验证。
- 非 443 上游 URL 不进入 PoO 官方 Claude OAuth 第一期接入；Console/CCR 后续接入前必须补 443 约束测试。
- 上游 429/529/401 经 PoO 返回后，仍触发现有账号保护逻辑。
- Gateway preflight `problem+json` 不进入 frame parser。
- Gateway submitted 后失败不会 fallback 或自动重试。
- `account.proxy` 会被传为 `X-PoO-Proxy-URL`，不会创建本地上游 proxy agent。

### 生产前联调

1. 本机/父 VM 同机部署：`POO_PARENT_GATEWAY_URL=http://127.0.0.1:<port>/v1/proof/relay`。
2. 远程中转站部署：`POO_PARENT_GATEWAY_URL=https://<gateway-domain>/v1/proof/relay`，`POO_PARENT_GATEWAY_AUTH_MODE=mtls`，并配置 CA、client certificate、client key 和 servername；Gateway 侧 client policy 必须允许该客户端证书身份。
3. 无代理账号请求 Claude messages，确认链路为 `relay -> gateway -> enclave -> upstream`。
4. 有代理账号请求 Claude messages，确认链路为 `relay -> gateway -> enclave -> gateway egress -> proxy -> upstream`。
5. 流式请求确认客户端收到正常 Claude SSE 和最后的 `tee.proof`。
6. OpenAI compatible 流式请求确认业务 chunk 仍是 OpenAI SSE 格式，且最终顺序为 `data: [DONE]` 后追加 `event: tee.proof`。
7. 非流式请求确认响应仍为 JSON，且顶层存在 `proof` 字段。
8. 人为关闭 Gateway，确认 required 模式下请求失败且不会走原直连链路。
9. 人为配置错误代理，确认错误由 Gateway/上游链路返回，中转站不在本地做额外代理校验。

## 分阶段落地

### Phase 1：文档和包骨架

- 新增本技术方案。
- 新增 `src/poo-parent-gateway/` 包和单元测试。
- 不接入业务链路。

### Phase 2：官方 Claude OAuth 链路接入

- 在 `_makeClaudeRequest(...)` 和 `_makeClaudeStreamRequestWithUsageCapture(...)` 增加 PoO 分支。
- 在 `src/routes/api.js` 和 `src/routes/openaiClaudeRoutes.js` 中接入 proof 输出：非流式 JSON 注入 `proof`，流式追加 `event: tee.proof`。
- 保持账号调度、队列、限流、计费逻辑不变；proof 字段和 `tee.proof` 事件不参与 usage 计费。
- 完成 disabled/enabled/required/submitted failure 测试。

### Phase 3：代理联调

- 使用现有账号 `proxy` 配置生成 `X-PoO-Proxy-URL`。
- 验证有代理与无代理两条生产链路。
- 确认 proof 不包含代理出口声明。

### Phase 4：Console/CCR 复用接入

- 在 `claudeConsoleRelayService.js` 和 `ccrRelayService.js` 的 axios 上游调用前接入同一 PoO 包。
- 接入前必须确认对应 `account.apiUrl` 使用 HTTPS 443；非 443 上游目标不进入 Gateway v1 接入范围。
- 对 `x-api-key` 和 Bearer 两种认证方式分别补测试。

## 风险和约束

1. 流式响应一旦开始，proof 缺失时无法撤回已发送 chunk，只能发送 `tee.error` 并关闭连接。
2. 非流式响应要求上游成功 body 是 JSON，才能注入字段级 `proof` 字段；如果某个非流式 endpoint 返回非 JSON，需要单独定义该 endpoint 的 proof 输出策略。
3. Gateway URL 配错或 mTLS 配错会导致所有 required 请求失败，因此生产发布前必须先完成健康检查和灰度。
4. 账号刷新、余额检测、定时测试等非 Claude messages 请求不在第一期 PoO 覆盖范围内，仍按现有代理逻辑执行。
5. Parent Gateway 必须使用支持按请求代理的 HTTP relay endpoint；旧 L4 tcp/vsock bridge 无法满足 `X-PoO-Proxy-URL`。
6. Gateway v1 只支持上游 443 端口；自定义 Console / CCR 上游如果不是 HTTPS 443，不能直接接入本期 PoO 链路。
7. 本方案的非流式 JSON 注入和 OpenAI compatible 转换依赖字段级 proof / verifier；生产上线前必须完成 PoO 字段级 proof 与本 adapter 的联调，并确保 PoO required 模式下不会接受缺失或 schema 不完整的 proof。

## 验收标准

1. 开启 `POO_PARENT_GATEWAY_ENABLED=true` 后，官方 Claude messages 非流式和流式请求均通过 `POST /v1/proof/relay`。
2. 无代理账号不发送 `X-PoO-Proxy-URL`，有代理账号按请求发送 `X-PoO-Proxy-URL`。
3. Gateway 返回的上游状态码、headers、body 仍进入现有账号保护和计费逻辑。
4. 非流式响应仍为 JSON，且顶层包含字段级 `proof` 字段；不返回 `multipart/mixed`。
5. 流式响应结束前可收到 `event: tee.proof`；native Anthropic 流在 Claude 原始 SSE 后追加，OpenAI compatible 流在 `data: [DONE]` 之后追加。
6. Gateway submitted 后失败不会触发原直连链路 fallback 或重复上游调用。
7. `authMode=none` 只能用于 loopback HTTP；远程 HTTPS 模式必须使用 mTLS。
8. PoO 关闭后，原有功能和代理链路完全保持不变。
