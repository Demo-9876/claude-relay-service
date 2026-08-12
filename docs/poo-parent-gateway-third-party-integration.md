# PoO Parent Gateway 第三方中转站接入指南

本文面向第三方中转站开发人员，说明如何把现有“中转站直接请求上游模型”的链路接入 PoO Parent Gateway。

接入后链路变为：

```text
无代理：中转站 -> PoO Parent Gateway -> Enclave/PoO -> 上游模型
有代理：中转站 -> PoO Parent Gateway -> Enclave/PoO -> PoO Parent Gateway egress -> 代理 -> 上游模型
```

具体哪些接口接入 PoO、哪些账号或租户开启 PoO、是否灰度、是否强制要求 proof，均由第三方中转站自行决定。本文只给出可复用代码包的接入方式和示例代码。

## 前置条件

1. 已部署 PoO Parent Gateway，并能访问 `POST /v1/proof/relay`。
2. PoO / Enclave 已支持字段级 proof，响应最终会通过 `RESP_TRAILER` 返回 proof。
3. 中转站运行环境为 Node.js 18+。
4. 上游请求为 HTTPS 443。当前 PoO Gateway v1 不支持非 HTTPS 上游或非 443 端口。
5. 如中转站和 Parent Gateway 不在同一父 VM / 同一可信本机网络内，生产环境应使用 HTTPS + mTLS。

## 引入代码包

将本仓库的目录复制到第三方中转站项目中：

```text
src/poo-parent-gateway/
```

该包包含：

```text
src/poo-parent-gateway/
  index.js
  config.js
  errors.js
  frameCodec.js
  gatewayClient.js
  proxyUrl.js
  responseAdapter.js
```

如果你的项目配置文件不是 `config/config.js`，需要调整 `src/poo-parent-gateway/index.js` 顶部的配置引入路径：

```js
const appConfig = require('../../config/config')
```

例如你的项目使用 `src/config.js`，可以改成：

```js
const appConfig = require('../config')
```

业务代码只需要依赖 `index.js` 暴露的 API，不需要直接理解 PoO frame 格式。

## 配置

在中转站配置中增加 `pooParentGateway`：

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

`.env` 示例：

```bash
# 是否启用 PoO 链路。具体对哪些接口生效，由业务代码自行判断。
POO_PARENT_GATEWAY_ENABLED=true

# true：Gateway 不可用、proof 缺失、proof schema 错误时请求失败。
# false：仅在确认请求尚未提交给 Gateway/Enclave 时允许回退原链路，适合灰度。
POO_PARENT_GATEWAY_REQUIRED=true

# 父 VM 本机部署示例。
POO_PARENT_GATEWAY_URL=http://127.0.0.1:15005/v1/proof/relay
POO_PARENT_GATEWAY_AUTH_MODE=none

POO_PARENT_GATEWAY_TIMEOUT_MS=600000
POO_PARENT_GATEWAY_MAX_BODY_BYTES=67108864

# 远程部署示例改用 HTTPS + mTLS。
# POO_PARENT_GATEWAY_URL=https://poo-parent-gateway.example.com/v1/proof/relay
# POO_PARENT_GATEWAY_AUTH_MODE=mtls
# POO_PARENT_GATEWAY_CA_FILE=/etc/poo-parent-gateway/ca.pem
# POO_PARENT_GATEWAY_CERT_FILE=/etc/poo-parent-gateway/client.pem
# POO_PARENT_GATEWAY_KEY_FILE=/etc/poo-parent-gateway/client-key.pem
# POO_PARENT_GATEWAY_SERVER_NAME=poo-parent-gateway.internal
```

配置约束：

- `authMode=none` 只允许 `http://127.0.0.1`、`http://localhost`、`http://[::1]` 这类 loopback URL。
- 远程 Gateway 必须使用 `authMode=mtls` 和 HTTPS URL。
- `required=true` 是生产推荐值。
- 代理地址由中转站账号系统负责管理和校验；PoO 包只负责把账号代理配置转换为 `X-PoO-Proxy-URL` 传给 Gateway。

建议服务启动时主动校验配置：

```js
const poo = require('./poo-parent-gateway')

async function start() {
  poo.initialize()
  // init redis / routes / server...
}
```

## 对外 API

```js
const poo = require('./poo-parent-gateway')

poo.initialize()
poo.isEnabled()
poo.isRequired()

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
  onDone
})

poo.injectProofIntoJSON(jsonObject, proofJSON)
poo.appendProofSSE(responseStream, proofJSON)
poo.appendErrorSSE(responseStream, error)
```

`relayOnce` 返回：

```js
{
  statusCode: 200,
  headers: {
    'content-type': 'application/json'
  },
  body: '{"id":"msg_..."}',
  proofJSON: {
    v: 2,
    // ...
  }
}
```

`relayStream` 不会自动写客户端响应。它会按 frame 顺序调用回调：

- `onHead(head)`：收到上游响应头。
- `onChunk(buffer)`：收到上游响应 body chunk。
- `onProof(proofJSON)`：收到 `RESP_TRAILER` proof。
- `onDone(result)`：frame stream 完整结束后使用。

如果 Enclave 返回 `ERR` frame，或 frame / proof 校验失败，`relayStream` 会直接抛错，应在外层 `try/catch` 中处理。

## 账号代理格式

第三方中转站只需要把账号上的代理配置作为 `proxyConfig` 传入：

```js
const account = {
  id: 'account-1',
  proxy: {
    type: 'http',
    host: 'proxy.example.com',
    port: 8080,
    username: 'user',
    password: 'pass'
  }
}
```

支持：

```js
{ type: 'http', host: 'proxy.example.com', port: 8080 }
{ type: 'https', host: 'proxy.example.com', port: 8443 }
{ type: 'socks5', host: '127.0.0.1', port: 1080 }
```

`socks5` 会转换为 `socks5h://...`，由代理侧解析目标域名。没有代理时传 `null`、`undefined`、空对象或空字符串即可。

不要在日志、APM 或反向代理 access log 中记录 `X-PoO-Proxy-URL` 原值，因为其中可能包含代理用户名和密码。

## 非流式接入示例

下面示例展示如何把原来的 HTTPS 上游请求切到 PoO。业务层可以自行决定是否只对部分接口、模型、账号或租户启用。

```js
const https = require('https')
const poo = require('./poo-parent-gateway')

async function callUpstreamNonStream({
  upstreamUrl,
  headers,
  body,
  account,
  requestId,
  shouldUsePoO
}) {
  const bodyString = typeof body === 'string' ? body : JSON.stringify(body)

  const usePoO = shouldUsePoO && poo.isEnabled()

  if (usePoO) {
    let upstream
    try {
      upstream = await poo.relayOnce({
        method: 'POST',
        url: new URL(upstreamUrl),
        headers,
        bodyBuffer: Buffer.from(bodyString, 'utf8'),
        proxyConfig: account?.proxy,
        tenantId: 'your-relay-name',
        accountId: account?.id,
        requestId
      })
    } catch (error) {
      if (poo.isRequired() || error.submitted) {
        throw error
      }

      // required=false 灰度模式：只有未提交给 Gateway/Enclave 的错误才回退直连，
      // 避免一个用户请求重复调用上游模型。
    }

    if (upstream) {
      const json = JSON.parse(upstream.body)
      if (upstream.proofJSON) {
        json.proof = upstream.proofJSON
      }

      return {
        statusCode: upstream.statusCode,
        headers: upstream.headers,
        body: JSON.stringify(json)
      }
    }
  }

  return callUpstreamDirect({
    upstreamUrl,
    headers,
    bodyString,
    proxyConfig: account?.proxy
  })
}

function callUpstreamDirect({ upstreamUrl, headers, bodyString, proxyConfig }) {
  return new Promise((resolve, reject) => {
    const url = new URL(upstreamUrl)
    // 这里必须复用中转站原有直连 / 本地 proxy agent 逻辑，确保 PoO disabled
    // 或 required=false fallback 时，账号代理行为保持不变。
    const agent = proxyConfig ? createProxyAgentFromExistingRelay(proxyConfig) : undefined
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        agent
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )

    req.on('error', reject)
    req.write(bodyString)
    req.end()
  })
}
```

`createProxyAgentFromExistingRelay(proxyConfig)` 代表中转站项目里原本已经存在的代理 agent 创建逻辑，不是 PoO 包提供的 API。接入时应替换为项目自己的实现。

如果中转站会把上游响应转换成 OpenAI compatible 或其它协议格式，可以先完成现有转换，再把 `proof` 放入最终 JSON 顶层：

```js
const upstream = await poo.relayOnce(...)
const upstreamJSON = JSON.parse(upstream.body)
const finalJSON = convertToClientProtocol(upstreamJSON)

if (upstream.proofJSON) {
  finalJSON.proof = upstream.proofJSON
}

res.status(upstream.statusCode).json(finalJSON)
```

非流式不建议返回 `multipart/mixed`，很多客户端不兼容。推荐在原 JSON 顶层增加 `proof` 字段。

## 流式 SSE 接入示例

流式请求的关键点：

1. `RESP_CHUNK` 到达时继续按原方式写给客户端。
2. 不要在上游 SSE 的 `data: [DONE]` 到达时立刻 `res.end()`。
3. 等 `RESP_TRAILER` 到达后，在最后追加 `event: tee.proof`。
4. 如果 PoO frame/proof 出错且已经开始返回内容，追加 `event: tee.error` 后关闭连接。

```js
const https = require('https')
const poo = require('./poo-parent-gateway')

async function relaySSE({
  res,
  upstreamUrl,
  headers,
  body,
  account,
  requestId,
  shouldUsePoO
}) {
  const bodyString = typeof body === 'string' ? body : JSON.stringify(body)

  if (shouldUsePoO && poo.isEnabled()) {
    let upstreamStarted = false
    let upstreamStatusCode = 0
    const upstreamErrorChunks = []

    try {
      await poo.relayStream({
        method: 'POST',
        url: new URL(upstreamUrl),
        headers,
        bodyBuffer: Buffer.from(bodyString, 'utf8'),
        proxyConfig: account?.proxy,
        tenantId: 'your-relay-name',
        accountId: account?.id,
        requestId,
        onHead: async (head) => {
          upstreamStatusCode = head.statusCode
          res.writeHead(upstreamStatusCode, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
        },
        onChunk: async (chunk) => {
          upstreamStarted = true
          if (upstreamStatusCode !== 200) {
            upstreamErrorChunks.push(Buffer.from(chunk))
            return
          }

          // 如需 usage 统计或协议转换，可在这里复用原来的 SSE parser / transformer。
          res.write(chunk)
        },
        onProof: async (proofJSON) => {
          if (upstreamStatusCode !== 200) {
            const errorBody = Buffer.concat(upstreamErrorChunks).toString('utf8')
            res.write('event: error\n')
            res.write(
              `data: ${JSON.stringify({
                error: 'upstream_error',
                status: upstreamStatusCode,
                details: errorBody
              })}\n\n`
            )
            poo.appendProofSSE(res, proofJSON)
            res.end()
            return
          }

          // Anthropic / OpenAI SSE 通常已经由上游写出 data: [DONE]\n\n。
          // 按需求在 [DONE] 之后追加 proof event。
          poo.appendProofSSE(res, proofJSON)
          res.end()
        }
      })

      return
    } catch (error) {
      if (upstreamStarted) {
        poo.appendErrorSSE(res, error)
        res.end()
        return
      }

      if (poo.isRequired() || error.submitted) {
        if (!res.headersSent) {
          res.writeHead(error.statusCode || 502, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
        }
        poo.appendErrorSSE(res, error)
        res.end()
        return
      }

      // required=false 灰度模式：未提交给 Gateway/Enclave 时允许回退原链路。
    }
  }

  return relaySSEDirect({
    res,
    upstreamUrl,
    headers,
    bodyString,
    proxyConfig: account?.proxy
  })
}

function relaySSEDirect({ res, upstreamUrl, headers, bodyString, proxyConfig }) {
  const url = new URL(upstreamUrl)
  // 这里必须复用中转站原有直连 / 本地 proxy agent 逻辑，确保 PoO disabled
  // 或 required=false fallback 时，账号代理行为保持不变。
  const agent = proxyConfig ? createProxyAgentFromExistingRelay(proxyConfig) : undefined
  const req = https.request(
    {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
      agent
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })

      upstream.on('data', (chunk) => res.write(chunk))
      upstream.on('end', () => res.end())
    }
  )

  req.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/event-stream' })
    }
    res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`)
    res.end()
  })
  req.write(bodyString)
  req.end()
}
```

追加后的 SSE 尾部示例：

```text
data: [DONE]

event: tee.proof
data: {"v":2,"alg":"ed25519","public_key":"..."}

```

## 请求头和 token

传给 `relayOnce` / `relayStream` 的 `headers` 应该是“原本准备发给上游模型”的最终 headers，例如：

```js
const headers = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20',
  'User-Agent': 'your-relay/1.0'
}
```

PoO frame 编码时会：

- 从 `Authorization: Bearer ...` 中提取 token，放入 `REQ_HEAD.token`。
- 过滤 hop-by-hop headers，例如 `host`、`authorization`、`content-length`、`connection`、`transfer-encoding`。
- 保留上游需要的业务 headers，例如 `content-type`、`anthropic-version`、`anthropic-beta`、`user-agent`。

因此业务层不需要自己构造 `REQ_HEAD`，也不需要直接处理 frame。

## 错误处理建议

PoO 包抛出的错误会尽量包含：

```js
{
  code: 'poo_gateway_unavailable',
  statusCode: 503,
  submitted: false,
  retryable: true
}
```

字段含义：

- `statusCode`：建议返回给客户端的 HTTP 状态码。
- `code`：错误类型，可进入中转站原有错误 envelope。
- `submitted`：是否可能已经提交给 Gateway / Enclave。`true` 时不要回退直连重试，避免重复调用上游模型。
- `retryable`：是否适合业务层做请求前重试或账号切换，仅供参考。

推荐模式：

```js
try {
  return await callWithPoO(...)
} catch (error) {
  if (poo.isRequired() || error.submitted) {
    throw error
  }
  return await callDirect(...)
}
```

Express JSON 错误响应示例：

```js
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error)
  }

  res.status(error.statusCode || error.status || 500).json({
    error: error.code || 'internal_error',
    message: error.message
  })
})
```

## 接入位置建议

不要在路由入口一开始就把客户端请求直接转给 PoO。推荐接入点是“中转站已经完成账号选择、鉴权、限流、请求改写，并准备向上游模型发起 HTTP 请求”的位置。

也就是说，原代码通常类似：

```js
const account = await selectAccount(req)
const accessToken = await getAccessToken(account)
const upstreamBody = buildUpstreamBody(req.body)
const upstreamHeaders = buildUpstreamHeaders(accessToken, req.headers)

const response = await callUpstreamDirect({
  url: 'https://api.anthropic.com/v1/messages',
  headers: upstreamHeaders,
  body: upstreamBody,
  proxyConfig: account.proxy
})
```

接入后改成：

```js
const usePoO = shouldUsePoOForThisRequest(req, account) && poo.isEnabled()
const response = usePoO
  ? await callUpstreamViaPoO({
      url: 'https://api.anthropic.com/v1/messages',
      headers: upstreamHeaders,
      body: upstreamBody,
      proxyConfig: account.proxy,
      accountId: account.id,
      requestId: req.id
    })
  : await callUpstreamDirect({
      url: 'https://api.anthropic.com/v1/messages',
      headers: upstreamHeaders,
      body: upstreamBody,
      proxyConfig: account.proxy
    })
```

`shouldUsePoOForThisRequest` 可以由第三方中转站自行实现，例如按 API Key、账号、模型、租户、路径、灰度比例或全局开关判断。

## 与代理链路的关系

原链路：

```text
中转站 -> 代理 -> 上游模型
```

PoO 接入后：

```text
中转站 -> PoO Parent Gateway -> Enclave/PoO -> PoO Parent Gateway egress -> 代理 -> 上游模型
```

因此某个请求确定走 PoO 时，中转站本进程不应该再为同一个上游请求创建本地 proxy agent。否则会变成：

```text
中转站 -> 本地代理 -> PoO Parent Gateway -> ... -> 代理 -> 上游模型
```

推荐做法：

```js
const usePoO = shouldUsePoOForThisRequest(req, account) && poo.isEnabled()
const localProxyAgent = usePoO ? null : createProxyAgent(account.proxy)
```

PoO 包会把 `account.proxy` 转成 `X-PoO-Proxy-URL`，由 Parent Gateway egress 使用。

## 验证清单

接入完成后建议验证：

1. `POO_PARENT_GATEWAY_ENABLED=false` 时，原直连/原本地代理链路行为不变。
2. `POO_PARENT_GATEWAY_ENABLED=true`、无账号代理时，请求链路为 `中转站 -> Gateway -> Enclave -> 上游`。
3. `POO_PARENT_GATEWAY_ENABLED=true`、账号有代理时，请求链路为 `中转站 -> Gateway -> Enclave -> Gateway egress -> 代理 -> 上游`。
4. 非流式 JSON 响应顶层包含 `proof` 字段。
5. 流式响应在 `data: [DONE]` 之后追加 `event: tee.proof`。
6. Gateway 返回 `application/problem+json` 时，中转站能透出合理错误码和错误信息。
7. `required=true` 时，proof 缺失或 schema 错误会失败，不回退直连。
8. `required=false` 时，只有 `submitted=false` 的 Gateway 连接类错误才允许回退直连。
9. 日志中不会出现代理密码、上游 access token、`X-PoO-Proxy-URL` 原文。
10. 远程部署 mTLS 证书轮转后，新请求能使用新证书建立连接。

## 常见问题

### Gateway 是否要求中转站先注册 route？

不需要。中转站只调用一次 `POST /v1/proof/relay`。Parent Gateway 在一次请求内完成 route/lane 分配、Enclave 调用和 egress 代理接入。

### proof 会证明使用了哪个代理吗？

不会。proxy URL 只作为本次 egress 的网络参数传给 Gateway，不进入 proof statement。

### 中转站是否需要理解 PoO frame 格式？

业务代码不需要。`src/poo-parent-gateway` 包内部会把 HTTP 请求编码为 `REQ_HEAD + REQ_BODY`，并把 Gateway 返回解码为 `RESP_HEAD / RESP_CHUNK / RESP_TRAILER`。业务代码只使用 `relayOnce`、`relayStream`、`appendProofSSE` 等 API。

### 非 JSON 响应如何处理？

如果接口要求返回 proof，非流式响应建议必须是可注入 `proof` 的 JSON 对象。无法解析为 JSON 时应返回中转站自己的 502 / upstream invalid response 错误，不建议返回 multipart。

### 可以只给部分接口接入吗？

可以。PoO 包不限制接口范围。第三方中转站可以只接入 chat completions、messages、responses、embeddings 或任何自己认为需要 proof 的接口。

### 可以只给部分账号或 API Key 开启吗？

可以。开关策略由中转站自行决定。常见做法是全局开关 + 租户/账号/API Key 级开关 + 灰度比例。
