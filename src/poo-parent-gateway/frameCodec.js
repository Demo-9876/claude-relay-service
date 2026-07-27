const { randomBytes } = require('crypto')
const { PoOFrameError } = require('./errors')

const FRAME_TYPES = Object.freeze({
  REQ_HEAD: 0x01,
  REQ_BODY: 0x02,
  RESP_HEAD: 0x10,
  RESP_CHUNK: 0x11,
  RESP_TRAILER: 0x12,
  ERR: 0x1f
})

const CONTENT_TYPE_FRAMES = 'application/vnd.poo.frames'
const HEADER_SIZE = 5

const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'authorization',
  'content-length',
  'connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
  'keep-alive',
  'expect'
])

function encodeFrame(type, payload) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '')
  if (payloadBuffer.length > 0xffffffff) {
    throw new PoOFrameError(`frame payload too large: ${payloadBuffer.length}`)
  }

  const out = Buffer.allocUnsafe(HEADER_SIZE + payloadBuffer.length)
  out[0] = type
  out.writeUInt32BE(payloadBuffer.length, 1)
  payloadBuffer.copy(out, HEADER_SIZE)
  return out
}

function encodeJSONFrame(type, value) {
  return encodeFrame(type, Buffer.from(JSON.stringify(value), 'utf8'))
}

function decodeFramesFromBuffer(buffer, options = {}) {
  const maxFrameBytes = options.maxFrameBytes || 64 * 1024 * 1024
  const frames = []
  let offset = 0

  while (offset < buffer.length) {
    if (buffer.length - offset < HEADER_SIZE) {
      throw new PoOFrameError('truncated frame header', { submitted: true })
    }
    const type = buffer[offset]
    const length = buffer.readUInt32BE(offset + 1)
    if (length > maxFrameBytes) {
      throw new PoOFrameError(`frame length ${length} exceeds limit ${maxFrameBytes}`, {
        submitted: true
      })
    }
    const start = offset + HEADER_SIZE
    const end = start + length
    if (end > buffer.length) {
      throw new PoOFrameError('truncated frame payload', { submitted: true })
    }
    frames.push({ type, payload: buffer.subarray(start, end) })
    offset = end
  }

  return frames
}

async function* decodeFrameStream(readable, options = {}) {
  const maxFrameBytes = options.maxFrameBytes || 64 * 1024 * 1024
  let buffer = Buffer.alloc(0)

  for await (const chunk of readable) {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])

    while (buffer.length >= HEADER_SIZE) {
      const type = buffer[0]
      const length = buffer.readUInt32BE(1)
      if (length > maxFrameBytes) {
        throw new PoOFrameError(`frame length ${length} exceeds limit ${maxFrameBytes}`, {
          submitted: true
        })
      }
      const frameLength = HEADER_SIZE + length
      if (buffer.length < frameLength) {
        break
      }
      const payload = buffer.subarray(HEADER_SIZE, frameLength)
      yield { type, payload }
      buffer = buffer.subarray(frameLength)
    }
  }

  if (buffer.length > 0) {
    throw new PoOFrameError('truncated frame stream', { submitted: true })
  }
}

function buildRelayRequestFrames({ method = 'POST', url, headers = {}, bodyBuffer }) {
  const upstreamUrl = normalizeUpstreamUrl(url)
  const token = extractBearerToken(headers)
  const reqHead = {
    nonce: randomBytes(32).toString('base64'),
    egress_port: 0,
    upstream: {
      host: upstreamUrl.hostname,
      method,
      path: upstreamUrl.pathname + upstreamUrl.search,
      headers: filterUpstreamHeaders(headers)
    }
  }

  if (token) {
    reqHead.token = token
  }

  const body = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer || '')
  return {
    head: reqHead,
    body,
    buffer: Buffer.concat([
      encodeJSONFrame(FRAME_TYPES.REQ_HEAD, reqHead),
      encodeFrame(FRAME_TYPES.REQ_BODY, body)
    ])
  }
}

function normalizeUpstreamUrl(input) {
  const url = input instanceof URL ? input : new URL(input)
  if (url.protocol !== 'https:') {
    throw new PoOFrameError('PoO Gateway v1 only supports https upstream URLs')
  }
  if (url.port && url.port !== '443') {
    throw new PoOFrameError('PoO Gateway v1 only supports upstream port 443')
  }
  return url
}

function extractBearerToken(headers) {
  const authorization = findHeaderValue(headers, 'authorization')
  if (!authorization || typeof authorization !== 'string') {
    return ''
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

function filterUpstreamHeaders(headers = {}) {
  const out = {}
  for (const [rawKey, value] of Object.entries(headers || {})) {
    const key = String(rawKey).toLowerCase()
    if (!key || HOP_BY_HOP_HEADERS.has(key) || value === undefined || value === null) {
      continue
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => String(item)).join(', ')
    } else {
      out[key] = String(value)
    }
  }
  return out
}

function findHeaderValue(headers, name) {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value
    }
  }
  return undefined
}

function parseJSONPayload(payload, frameName) {
  try {
    return JSON.parse(payload.toString('utf8'))
  } catch (error) {
    throw new PoOFrameError(`${frameName} payload is not valid JSON`, {
      submitted: true,
      cause: error
    })
  }
}

module.exports = {
  FRAME_TYPES,
  CONTENT_TYPE_FRAMES,
  HEADER_SIZE,
  encodeFrame,
  encodeJSONFrame,
  decodeFramesFromBuffer,
  decodeFrameStream,
  buildRelayRequestFrames,
  normalizeUpstreamUrl,
  filterUpstreamHeaders,
  extractBearerToken,
  parseJSONPayload
}
