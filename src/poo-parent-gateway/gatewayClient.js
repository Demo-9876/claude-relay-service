const fs = require('fs')
const http = require('http')
const https = require('https')
const { CONTENT_TYPE_FRAMES, buildRelayRequestFrames } = require('./frameCodec')
const { fromProxyConfig } = require('./proxyUrl')
const { collectResponse, consumeFrameStream } = require('./responseAdapter')
const { PoOFrameError, PoOGatewayProblemError, PoOGatewayUnavailableError } = require('./errors')

let cachedAgent = null
let cachedAgentKey = ''

function relayOnce(options, cfg) {
  return sendGatewayRequest(options, cfg, async (res, responseOptions) => {
    const chunks = []
    for await (const chunk of res) {
      chunks.push(chunk)
    }
    return collectResponse(Buffer.concat(chunks), responseOptions)
  })
}

function relayStream(options, cfg) {
  return sendGatewayRequest(options, cfg, async (res, responseOptions) =>
    consumeFrameStream(
      res,
      {
        onHead: options.onHead,
        onChunk: options.onChunk,
        onProof: options.onProof,
        onError: options.onError,
        onDone: options.onDone
      },
      { ...responseOptions, collectBody: false }
    )
  )
}

async function sendGatewayRequest(options, cfg, handleFrames) {
  const gatewayUrl = new URL(cfg.url)
  const bodyBuffer = Buffer.isBuffer(options.bodyBuffer)
    ? options.bodyBuffer
    : Buffer.from(options.bodyBuffer || '')
  if (bodyBuffer.length > cfg.maxBodyBytes) {
    throw new PoOFrameError(`request body exceeds PoO maxBodyBytes: ${bodyBuffer.length}`)
  }

  const relayRequest = buildRelayRequestFrames({
    method: options.method || 'POST',
    url: options.url,
    headers: options.headers || {},
    bodyBuffer
  })

  const proxyURL = fromProxyConfig(options.proxyConfig)
  const headers = {
    'Content-Type': CONTENT_TYPE_FRAMES,
    'Content-Length': String(relayRequest.buffer.length)
  }
  if (proxyURL) {
    headers['X-PoO-Proxy-URL'] = proxyURL
  }
  if (options.tenantId) {
    headers['X-PoO-Tenant-ID'] = String(options.tenantId)
  }
  if (options.accountId) {
    headers['X-PoO-Account-ID'] = String(options.accountId)
  }
  if (options.requestId) {
    headers['X-PoO-Request-ID'] = String(options.requestId)
  }

  let submitted = false
  const transport = gatewayUrl.protocol === 'https:' ? https : http
  const requestOptions = {
    protocol: gatewayUrl.protocol,
    hostname: gatewayUrl.hostname,
    port: gatewayUrl.port || (gatewayUrl.protocol === 'https:' ? 443 : 80),
    path: gatewayUrl.pathname + gatewayUrl.search,
    method: 'POST',
    headers,
    timeout: options.timeoutMs || cfg.timeoutMs,
    agent: buildAgent(gatewayUrl, cfg)
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(requestOptions, async (res) => {
      try {
        submitted = true
        const contentType = String(res.headers['content-type'] || '')
          .split(';')[0]
          .trim()
        if (res.statusCode < 200 || res.statusCode >= 300 || contentType !== CONTENT_TYPE_FRAMES) {
          const problem = await readProblemResponse(res)
          reject(
            new PoOGatewayProblemError(problem.message || 'PoO Gateway rejected request', problem, {
              statusCode: res.statusCode,
              submitted
            })
          )
          return
        }

        const result = await handleFrames(res, {
          required: cfg.required,
          maxFrameBytes: cfg.maxBodyBytes,
          supportedProofVersions: cfg.supportedProofVersions,
          collectBody: options.collectBody !== false
        })
        resolve(result)
      } catch (error) {
        reject(markSubmitted(error, submitted))
      }
    })

    req.on('error', (error) => {
      reject(
        new PoOGatewayUnavailableError(error.message || 'PoO Gateway request failed', {
          cause: error,
          submitted
        })
      )
    })

    req.on('timeout', () => {
      req.destroy()
      reject(
        new PoOGatewayUnavailableError('PoO Gateway request timeout', {
          code: 'poo_gateway_timeout',
          submitted
        })
      )
    })

    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new Error('request aborted'))
      } else {
        options.signal.addEventListener(
          'abort',
          () => {
            req.destroy(new Error('request aborted'))
          },
          { once: true }
        )
      }
    }

    req.write(relayRequest.buffer, () => {
      submitted = true
      req.end()
    })
  })
}

function buildAgent(gatewayUrl, cfg) {
  if (cfg.authMode !== 'mtls') {
    return undefined
  }

  const agentKey = JSON.stringify({
    url: `${gatewayUrl.protocol}//${gatewayUrl.host}`,
    caFile: getFileCacheKey(cfg.mtls.caFile),
    certFile: getFileCacheKey(cfg.mtls.certFile),
    keyFile: getFileCacheKey(cfg.mtls.keyFile),
    servername: cfg.mtls.servername || gatewayUrl.hostname
  })
  if (cachedAgent && cachedAgentKey === agentKey) {
    return cachedAgent
  }

  if (cachedAgent) {
    cachedAgent.destroy()
  }
  cachedAgentKey = agentKey
  cachedAgent = new https.Agent({
    ca: fs.readFileSync(cfg.mtls.caFile),
    cert: fs.readFileSync(cfg.mtls.certFile),
    key: fs.readFileSync(cfg.mtls.keyFile),
    servername: cfg.mtls.servername || gatewayUrl.hostname,
    keepAlive: true
  })
  return cachedAgent
}

function getFileCacheKey(file) {
  const stat = fs.statSync(file)
  return `${file}:${stat.size}:${stat.mtimeMs}`
}

function resetAgentCache() {
  if (cachedAgent) {
    cachedAgent.destroy()
  }
  cachedAgent = null
  cachedAgentKey = ''
}

async function readProblemResponse(res) {
  const chunks = []
  for await (const chunk of res) {
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) {
    return { message: `PoO Gateway returned HTTP ${res.statusCode}` }
  }
  try {
    const parsed = JSON.parse(raw)
    return {
      code: parsed.code || parsed.type || 'poo_gateway_problem',
      message: parsed.message || parsed.detail || parsed.title || raw,
      requestId: parsed.request_id || parsed.requestId,
      retryable: parsed.retryable
    }
  } catch {
    return { message: raw }
  }
}

function markSubmitted(error, submitted) {
  if (error && typeof error === 'object' && error.submitted === undefined) {
    error.submitted = submitted
  }
  return error
}

module.exports = {
  relayOnce,
  relayStream,
  sendGatewayRequest,
  buildAgent,
  resetAgentCache
}
