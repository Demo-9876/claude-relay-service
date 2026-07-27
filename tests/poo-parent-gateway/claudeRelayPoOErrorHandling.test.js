const mockClaudeAccountService = {
  markAccountModelRateLimited: jest.fn(),
  markAccountOverloaded: jest.fn()
}

const mockUnifiedClaudeScheduler = {
  markAccountRateLimited: jest.fn(),
  clearSessionMapping: jest.fn(),
  markAccountBlocked: jest.fn()
}

const mockUpstreamErrorHelper = {
  markTempUnavailable: jest.fn(),
  parseRetryAfter: jest.fn(() => 600)
}

jest.mock(
  '../../config/config',
  () => ({
    claude: {
      apiVersion: '2023-06-01',
      betaHeader: '',
      systemPrompt: '',
      overloadHandling: { enabled: 0 }
    }
  }),
  { virtual: true }
)

jest.mock('../../src/utils/proxyHelper', () => ({}))
jest.mock('../../src/utils/headerFilter', () => ({
  filterForClaude: jest.fn((headers) => headers)
}))
jest.mock('../../src/services/account/claudeAccountService', () => mockClaudeAccountService)
jest.mock('../../src/services/scheduler/unifiedClaudeScheduler', () => mockUnifiedClaudeScheduler)
jest.mock('../../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../../src/services/claudeCodeHeadersService', () => ({ storeAccountHeaders: jest.fn() }))
jest.mock('../../src/models/redis', () => ({}))
jest.mock('../../src/validators/clients/claudeCodeValidator', () => jest.fn())
jest.mock('../../src/services/requestIdentityService', () => ({}))
jest.mock('../../src/utils/testPayloadHelper', () => ({ createClaudeTestPayload: jest.fn() }))
jest.mock('../../src/services/userMessageQueueService', () => ({}))
jest.mock('../../src/utils/upstreamErrorHelper', () => mockUpstreamErrorHelper)
jest.mock('../../src/utils/metadataUserIdHelper', () => ({}))
jest.mock('../../src/poo-parent-gateway', () => ({
  appendProofSSE: jest.fn((stream, proof) => {
    stream.write(`event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`)
  })
}))
jest.mock('../../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: jest.fn(),
  getHttpsAgentForNonStream: jest.fn(),
  getPricingData: jest.fn()
}))

const claudeRelayService = require('../../src/services/relay/claudeRelayService')

function createResponseStream() {
  return {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    socket: { destroyed: false },
    chunks: [],
    write(chunk) {
      this.headersSent = true
      this.chunks.push(String(chunk))
      return true
    },
    end() {
      this.writableEnded = true
    },
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader: jest.fn()
  }
}

describe('Claude relay PoO stream error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpstreamErrorHelper.markTempUnavailable.mockResolvedValue()
    mockUnifiedClaudeScheduler.markAccountRateLimited.mockResolvedValue()
    mockUnifiedClaudeScheduler.clearSessionMapping.mockResolvedValue()
    mockUnifiedClaudeScheduler.markAccountBlocked.mockResolvedValue()
    mockClaudeAccountService.markAccountModelRateLimited.mockResolvedValue()
    mockClaudeAccountService.markAccountOverloaded.mockResolvedValue()
  })

  test('does not mark Extra Usage Required 429 as rate limited or temp unavailable', async () => {
    const responseStream = createResponseStream()

    await expect(
      claudeRelayService._handlePoOStreamErrorResponse({
        statusCode: 429,
        headers: {},
        errorBody: JSON.stringify({
          error: { message: 'Extra usage is required for this request.' }
        }),
        responseStream,
        account: { name: 'acct' },
        accountId: 'acct-1',
        accountType: 'claude-official',
        sessionHash: 'session-1',
        requestModelFamily: 'sonnet',
        body: { model: 'claude-sonnet-4-5' },
        clientHeaders: {},
        isOpusModelRequest: false,
        isDedicatedOfficialAccount: false,
        toolNameStreamTransformer: null,
        proofJSON: null
      })
    ).rejects.toMatchObject({
      code: 'poo_upstream_error',
      statusCode: 429,
      submitted: true
    })

    expect(mockClaudeAccountService.markAccountModelRateLimited).not.toHaveBeenCalled()
    expect(mockUnifiedClaudeScheduler.markAccountRateLimited).not.toHaveBeenCalled()
    expect(mockUpstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
  })

  test('records model-family 429 with reset header without marking account temp unavailable', async () => {
    const responseStream = createResponseStream()

    await expect(
      claudeRelayService._handlePoOStreamErrorResponse({
        statusCode: 429,
        headers: { 'anthropic-ratelimit-unified-reset': '1800000000' },
        errorBody: JSON.stringify({
          error: { message: "You have exceed your account's rate limit." }
        }),
        responseStream,
        account: { name: 'acct' },
        accountId: 'acct-1',
        accountType: 'claude-official',
        sessionHash: 'session-1',
        requestModelFamily: 'sonnet',
        body: { model: 'claude-sonnet-4-5' },
        clientHeaders: {},
        isOpusModelRequest: false,
        isDedicatedOfficialAccount: false,
        toolNameStreamTransformer: null,
        proofJSON: null
      })
    ).rejects.toMatchObject({
      code: 'poo_upstream_error',
      statusCode: 429,
      submitted: true
    })

    expect(mockClaudeAccountService.markAccountModelRateLimited).toHaveBeenCalledWith(
      'acct-1',
      'sonnet',
      1800000000
    )
    expect(mockUnifiedClaudeScheduler.markAccountRateLimited).not.toHaveBeenCalled()
    expect(mockUpstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
  })
})
