jest.mock('../config/config', () => ({ requestTimeout: 1000 }), { virtual: true })

jest.mock('axios', () => jest.fn())

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'proxy')
}))

jest.mock('../src/utils/headerFilter', () => ({
  filterForOpenAI: jest.fn((headers) =>
    Object.fromEntries(
      Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'authorization')
    )
  )
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  updateAccountUsage: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordUsage: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  markAccountRateLimited: jest.fn(),
  _deleteSessionMapping: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(() => Promise.resolve()),
  parseRetryAfter: jest.fn(() => null),
  sanitizeErrorForClient: jest.fn((value) => value)
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => null),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))

jest.mock('../src/poo-parent-gateway', () => ({
  isEnabled: jest.fn(() => true),
  isRequired: jest.fn(() => true),
  relayOnce: jest.fn(),
  relayStream: jest.fn(),
  injectProofIntoJSON: jest.fn((value, proof) => ({ ...value, proof })),
  appendProofSSE: jest.fn(),
  appendErrorSSE: jest.fn()
}))

const axios = require('axios')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const pooParentGateway = require('../src/poo-parent-gateway')
const service = require('../src/services/relay/openaiResponsesRelayService')

function createReq() {
  return {
    method: 'POST',
    path: '/v1/responses',
    headers: {
      authorization: 'Bearer cr-test',
      'user-agent': 'curl/8.0',
      'x-request-id': 'req-1'
    },
    body: {
      model: 'qwen3.7-plus',
      input: [{ role: 'user', content: 'hi' }],
      stream: false
    },
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn()
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    destroyed: false,
    once: jest.fn(),
    removeListener: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn((chunk) => {
      res.headersSent = true
      return chunk
    }),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.payload = payload
      return res
    }),
    end: jest.fn()
  }
  return res
}

describe('openaiResponsesRelayService PoO Gateway', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      name: 'Qwen Responses',
      apiKey: 'sk-upstream',
      baseApi: 'https://dashscope.example.com/compatible-mode',
      providerEndpoint: 'responses',
      proxy: { type: 'http', host: '127.0.0.1', port: 7890 }
    })
    openaiResponsesAccountService.updateAccount.mockResolvedValue()
    openaiResponsesAccountService.updateAccountUsage.mockResolvedValue()
    apiKeyService.recordUsage.mockResolvedValue()
    pooParentGateway.injectProofIntoJSON.mockImplementation((value, proof) => ({
      ...value,
      proof
    }))
    pooParentGateway.appendProofSSE.mockImplementation((responseStream, proof) => {
      responseStream.write(`event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`)
    })
    pooParentGateway.appendErrorSSE.mockImplementation((responseStream, error) => {
      responseStream.write(`event: tee.error\ndata: ${JSON.stringify({ error: error.code })}\n\n`)
    })
  })

  test('relays non-stream responses through PoO and injects proof into JSON response', async () => {
    const proof = { v: 2, alg: 'ed25519', signature: 'sig' }
    pooParentGateway.relayOnce.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        object: 'response',
        model: 'qwen3.7-plus',
        output: [],
        usage: {
          input_tokens: 3,
          output_tokens: 5,
          total_tokens: 8
        }
      }),
      proofJSON: proof
    })

    const req = createReq()
    const res = createRes()

    await service.handleRequest(
      req,
      res,
      { id: 'resp-1', name: 'Qwen Responses' },
      { id: 'key-1', name: 'demo' }
    )

    expect(axios).not.toHaveBeenCalled()
    expect(pooParentGateway.relayOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://dashscope.example.com/compatible-mode/v1/responses',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-upstream'
        }),
        proxyConfig: { type: 'http', host: '127.0.0.1', port: 7890 },
        tenantId: 'claude-relay-service',
        accountId: 'resp-1',
        requestId: 'req-1'
      })
    )
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.payload).toEqual(
      expect.objectContaining({
        object: 'response',
        proof
      })
    )
    expect(pooParentGateway.relayOnce.mock.calls[0][0].headers).not.toHaveProperty('authorization')
  })

  test('relays stream responses through PoO streaming API and appends proof SSE', async () => {
    const proof = { v: 2, alg: 'ed25519', signature: 'sig' }
    const chunk = Buffer.from(
      'data: {"type":"response.completed","response":{"model":"qwen3.7-plus","usage":{"input_tokens":3,"output_tokens":5,"total_tokens":8}}}\n\n'
    )
    let endResolve
    const ended = new Promise((resolve) => {
      endResolve = resolve
    })

    pooParentGateway.relayStream.mockImplementation(async (options) => {
      await options.onHead({ statusCode: 200, headers: { 'content-type': 'text/event-stream' } })
      await options.onChunk(chunk)
      await options.onProof(proof)
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        proofJSON: proof
      }
    })

    const req = createReq()
    req.body.stream = true
    const res = createRes()
    res.end.mockImplementation(() => {
      endResolve()
      return res
    })

    await service.handleRequest(
      req,
      res,
      { id: 'resp-1', name: 'Qwen Responses' },
      { id: 'key-1', name: 'demo' }
    )
    await ended

    expect(pooParentGateway.relayOnce).not.toHaveBeenCalled()
    expect(pooParentGateway.relayStream).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://dashscope.example.com/compatible-mode/v1/responses',
        proxyConfig: { type: 'http', host: '127.0.0.1', port: 7890 }
      })
    )
    expect(res.write).toHaveBeenCalledWith(chunk)
    expect(pooParentGateway.appendProofSSE).toHaveBeenCalledWith(res, proof)
  })

  test('appends tee.error when PoO stream fails after response starts', async () => {
    const error = new Error('PoO proof is missing')
    error.code = 'poo_proof_missing'
    error.statusCode = 502
    error.submitted = true
    const chunk = Buffer.from('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')
    let endResolve
    const ended = new Promise((resolve) => {
      endResolve = resolve
    })

    pooParentGateway.relayStream.mockImplementation(async (options) => {
      await options.onHead({ statusCode: 200, headers: { 'content-type': 'text/event-stream' } })
      await new Promise((resolve) => setImmediate(resolve))
      await options.onChunk(chunk)
      await new Promise((resolve) => setImmediate(resolve))
      throw error
    })

    const req = createReq()
    req.body.stream = true
    const res = createRes()
    res.end.mockImplementation(() => {
      endResolve()
      return res
    })

    await service.handleRequest(
      req,
      res,
      { id: 'resp-1', name: 'Qwen Responses' },
      { id: 'key-1', name: 'demo' }
    )
    await ended

    expect(res.write).toHaveBeenCalledWith(chunk)
    expect(pooParentGateway.appendErrorSSE).toHaveBeenCalledWith(res, error)
  })

  test('waits for proof before returning PoO stream 429 errors', async () => {
    const proof = { v: 2, alg: 'ed25519', signature: 'sig' }
    const errorBody = {
      error: {
        message: 'Rate limit exceeded',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        resets_in_seconds: 30
      }
    }

    pooParentGateway.relayStream.mockImplementation(async (options) => {
      await options.onHead({ statusCode: 429, headers: { 'content-type': 'text/event-stream' } })
      await options.onChunk(Buffer.from(JSON.stringify(errorBody)))
      await options.onProof(proof)
      return {
        statusCode: 429,
        headers: { 'content-type': 'text/event-stream' },
        proofJSON: proof
      }
    })

    const req = createReq()
    req.body.stream = true
    const res = createRes()

    await service.handleRequest(
      req,
      res,
      { id: 'resp-1', name: 'Qwen Responses' },
      { id: 'key-1', name: 'demo' }
    )

    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.payload).toEqual(expect.objectContaining({ error: errorBody.error, proof }))
  })

  test('returns PoO error when stream 429 fails proof validation', async () => {
    const error = new Error('PoO proof is missing')
    error.code = 'poo_proof_missing'
    error.statusCode = 502
    error.submitted = true

    pooParentGateway.relayStream.mockImplementation(async (options) => {
      await options.onHead({ statusCode: 429, headers: { 'content-type': 'text/event-stream' } })
      await options.onChunk(
        Buffer.from(
          JSON.stringify({
            error: {
              message: 'Rate limit exceeded',
              type: 'rate_limit_error',
              code: 'rate_limit_exceeded'
            }
          })
        )
      )
      throw error
    })

    const req = createReq()
    req.body.stream = true
    const res = createRes()

    await service.handleRequest(
      req,
      res,
      { id: 'resp-1', name: 'Qwen Responses' },
      { id: 'key-1', name: 'demo' }
    )

    expect(res.status).toHaveBeenCalledWith(502)
    expect(res.payload).toEqual({
      error: {
        message: 'PoO proof is missing',
        type: 'poo_error',
        code: 'poo_proof_missing'
      }
    })
  })

  test('returns PoO error status and code when required gateway path fails', async () => {
    const error = new Error('PoO proof is missing')
    error.code = 'poo_proof_missing'
    error.statusCode = 502
    error.submitted = true
    pooParentGateway.relayOnce.mockRejectedValue(error)

    const req = createReq()
    const res = createRes()

    await service.handleRequest(
      req,
      res,
      { id: 'resp-1', name: 'Qwen Responses' },
      { id: 'key-1', name: 'demo' }
    )

    expect(res.status).toHaveBeenCalledWith(502)
    expect(res.payload).toEqual({
      error: {
        message: 'PoO proof is missing',
        type: 'poo_error',
        code: 'poo_proof_missing'
      }
    })
  })

  test('keeps proof visible when JSON proof injection rejects', async () => {
    const proof = { v: 2, alg: 'ed25519', signature: 'sig' }
    pooParentGateway.relayOnce.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify('plain text'),
      proofJSON: proof
    })
    pooParentGateway.injectProofIntoJSON.mockImplementation(() => {
      throw new Error('cannot inject proof into non-object JSON response')
    })

    const req = createReq()
    const res = createRes()

    await service.handleRequest(
      req,
      res,
      { id: 'resp-1', name: 'Qwen Responses' },
      { id: 'key-1', name: 'demo' }
    )

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.payload).toEqual({ value: 'plain text', proof })
  })
})
