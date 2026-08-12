const {
  FRAME_TYPES,
  decodeFramesFromBuffer,
  parseJSONPayload,
  decodeFrameStream
} = require('./frameCodec')
const { PoOFrameError, PoOProofMissingError, PoOProofSchemaError } = require('./errors')

function collectResponse(buffer, options = {}) {
  const frames = decodeFramesFromBuffer(buffer, options)
  const state = createResponseState(options)

  for (const frame of frames) {
    applyFrame(state, frame)
  }

  return finalizeResponse(state)
}

async function consumeFrameStream(readable, callbacks = {}, options = {}) {
  const state = createResponseState(options)

  for await (const frame of decodeFrameStream(readable, options)) {
    applyFrame(state, frame)

    if (frame.type === FRAME_TYPES.RESP_HEAD && callbacks.onHead) {
      await callbacks.onHead(state.head)
    } else if (frame.type === FRAME_TYPES.RESP_CHUNK && callbacks.onChunk) {
      await callbacks.onChunk(frame.payload)
    } else if (frame.type === FRAME_TYPES.RESP_TRAILER && callbacks.onProof) {
      await callbacks.onProof(state.proofJSON)
    } else if (frame.type === FRAME_TYPES.ERR && callbacks.onError) {
      await callbacks.onError(state.err)
    }
  }

  const result = finalizeResponse(state)
  if (callbacks.onDone) {
    await callbacks.onDone(result)
  }
  return result
}

function createResponseState(options = {}) {
  return {
    head: null,
    chunks: [],
    proofJSON: null,
    trailerSeen: false,
    err: null,
    collectBody: options.collectBody !== false,
    required: options.required !== false,
    supportedProofVersions: options.supportedProofVersions || [2]
  }
}

function applyFrame(state, frame) {
  switch (frame.type) {
    case FRAME_TYPES.RESP_HEAD:
      if (state.head) {
        throw new PoOFrameError('duplicate RESP_HEAD frame', { submitted: true })
      }
      state.head = normalizeRespHead(parseJSONPayload(frame.payload, 'RESP_HEAD'))
      break
    case FRAME_TYPES.RESP_CHUNK:
      if (!state.head) {
        throw new PoOFrameError('RESP_CHUNK before RESP_HEAD', { submitted: true })
      }
      if (state.trailerSeen) {
        throw new PoOFrameError('RESP_CHUNK after RESP_TRAILER', { submitted: true })
      }
      if (state.collectBody) {
        state.chunks.push(frame.payload)
      }
      break
    case FRAME_TYPES.RESP_TRAILER:
      if (!state.head) {
        throw new PoOFrameError('RESP_TRAILER before RESP_HEAD', { submitted: true })
      }
      if (state.trailerSeen) {
        throw new PoOFrameError('duplicate RESP_TRAILER frame', { submitted: true })
      }
      state.trailerSeen = true
      state.proofJSON = extractProofJSON(frame.payload, state)
      break
    case FRAME_TYPES.ERR:
      state.err = parseErrFrame(frame.payload)
      throw new PoOFrameError(state.err.message || 'PoO Enclave returned ERR frame', {
        submitted: true
      })
    default:
      throw new PoOFrameError(`unexpected frame type: 0x${frame.type.toString(16)}`, {
        submitted: true
      })
  }
}

function finalizeResponse(state) {
  if (!state.head) {
    throw new PoOFrameError('missing RESP_HEAD frame', { submitted: true })
  }
  if (!state.trailerSeen) {
    throw new PoOProofMissingError('missing RESP_TRAILER frame')
  }
  if (state.required && !state.proofJSON) {
    throw new PoOProofMissingError()
  }

  return {
    statusCode: state.head.statusCode,
    headers: state.head.headers,
    body: Buffer.concat(state.chunks).toString('utf8'),
    proofJSON: state.proofJSON
  }
}

function normalizeRespHead(obj) {
  const statusCode = Number(obj.status_code ?? obj.statusCode ?? obj.status)
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) {
    throw new PoOFrameError('RESP_HEAD status code is invalid', { submitted: true })
  }
  const headers = {}
  const rawHeaders = obj.headers && typeof obj.headers === 'object' ? obj.headers : {}
  for (const [key, value] of Object.entries(rawHeaders)) {
    headers[String(key).toLowerCase()] = value
  }
  return { statusCode, headers }
}

function extractProofJSON(payload, state) {
  if (!payload || payload.length === 0) {
    if (state.required) {
      throw new PoOProofMissingError('empty RESP_TRAILER proof')
    }
    return null
  }

  const trailer = parseJSONPayload(payload, 'RESP_TRAILER')
  const proof =
    trailer && typeof trailer === 'object' && !Array.isArray(trailer)
      ? trailer.proof || trailer.tee_proof || trailer.teeProof || trailer['tee.proof'] || trailer
      : trailer

  validateFieldLevelProof(proof, state)
  return proof
}

function validateFieldLevelProof(proof, state = {}) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    throw new PoOProofSchemaError('PoO proof must be a JSON object')
  }

  const supported = state.supportedProofVersions || []
  if (supported.length > 0 && !supported.includes(proof.v)) {
    throw new PoOProofSchemaError(`unsupported PoO proof.v: ${String(proof.v)}`)
  }
  if (proof.alg !== 'ed25519') {
    throw new PoOProofSchemaError(`unsupported PoO proof.alg: ${String(proof.alg)}`)
  }

  const requiredStringFields = [
    'public_key',
    'nonce',
    'upstream_host',
    'upstream_path',
    'http_method',
    'resp_content_type',
    'request_body_sha256',
    'response_body_sha256',
    'signature',
    'attestation'
  ]
  for (const field of requiredStringFields) {
    if (typeof proof[field] !== 'string' || !proof[field]) {
      throw new PoOProofSchemaError(`PoO proof.${field} must be a non-empty string`)
    }
  }

  if (
    typeof proof.http_status !== 'number' ||
    !Number.isInteger(proof.http_status) ||
    proof.http_status < 100 ||
    proof.http_status > 599
  ) {
    throw new PoOProofSchemaError('PoO proof.http_status must be an integer HTTP status code')
  }
  if (proof.profile !== undefined && typeof proof.profile !== 'string') {
    throw new PoOProofSchemaError('PoO proof.profile must be string when present')
  }
  if (
    proof.evidence !== undefined &&
    (!proof.evidence || typeof proof.evidence !== 'object' || Array.isArray(proof.evidence))
  ) {
    throw new PoOProofSchemaError('PoO proof.evidence must be an object when present')
  }
  if (!/^[0-9a-f]{64}$/.test(proof.request_body_sha256)) {
    throw new PoOProofSchemaError('PoO proof.request_body_sha256 must be lowercase hex sha256')
  }
  if (!/^[0-9a-f]{64}$/.test(proof.response_body_sha256)) {
    throw new PoOProofSchemaError('PoO proof.response_body_sha256 must be lowercase hex sha256')
  }
}

function injectProofIntoJSON(value, proofJSON) {
  if (!proofJSON) {
    return value
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PoOFrameError('cannot inject proof into non-object JSON response', {
      submitted: true
    })
  }
  return { ...value, proof: proofJSON }
}

function appendProofSSE(responseStream, proofJSON) {
  if (!proofJSON) {
    return
  }
  responseStream.write(`event: tee.proof\ndata: ${JSON.stringify(proofJSON)}\n\n`)
}

function appendErrorSSE(responseStream, error) {
  responseStream.write('event: tee.error\n')
  responseStream.write(
    `data: ${JSON.stringify({
      error: error.code || 'poo_relay_failed',
      message: error.message,
      timestamp: new Date().toISOString()
    })}\n\n`
  )
}

function parseErrFrame(payload) {
  if (!payload || payload.length === 0) {
    return { message: 'PoO Enclave returned ERR frame' }
  }
  try {
    const parsed = JSON.parse(payload.toString('utf8'))
    return typeof parsed === 'object' && parsed ? parsed : { message: String(parsed) }
  } catch {
    return { message: payload.toString('utf8') }
  }
}

module.exports = {
  collectResponse,
  consumeFrameStream,
  extractProofJSON,
  validateFieldLevelProof,
  injectProofIntoJSON,
  appendProofSSE,
  appendErrorSSE
}
