const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  buildAgent,
  relayOnce,
  resetAgentCache
} = require('../../src/poo-parent-gateway/gatewayClient')
const {
  FRAME_TYPES,
  encodeFrame,
  encodeJSONFrame
} = require('../../src/poo-parent-gateway/frameCodec')

const baseConfig = {
  required: true,
  authMode: 'none',
  timeoutMs: 5000,
  maxBodyBytes: 64 * 1024 * 1024,
  supportedProofVersions: [2]
}

const proof = {
  v: 2,
  alg: 'ed25519',
  public_key: 'public-key-b64',
  nonce: 'nonce-b64',
  upstream_host: 'api.anthropic.com',
  upstream_path: '/v1/messages',
  http_method: 'POST',
  http_status: 200,
  resp_content_type: 'application/json',
  request_body_sha256: 'a'.repeat(64),
  response_body_sha256: 'b'.repeat(64),
  signature: 'signature-b64',
  attestation: 'attestation-b64'
}

function startServer(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}/v1/proof/relay` })
    })
  })
}

describe('poo-parent-gateway gatewayClient', () => {
  afterEach(() => {
    resetAgentCache()
  })

  test('posts frames and proxy metadata to gateway', async () => {
    const seen = {}
    const { server, url } = await startServer((req, res) => {
      seen.contentType = req.headers['content-type']
      seen.proxyURL = req.headers['x-poo-proxy-url']
      seen.accountId = req.headers['x-poo-account-id']
      req.resume()
      res.writeHead(200, { 'Content-Type': 'application/vnd.poo.frames' })
      res.end(
        Buffer.concat([
          encodeJSONFrame(FRAME_TYPES.RESP_HEAD, { status_code: 200, headers: {} }),
          encodeFrame(FRAME_TYPES.RESP_CHUNK, Buffer.from('{"id":"msg_1"}')),
          encodeJSONFrame(FRAME_TYPES.RESP_TRAILER, { proof })
        ])
      )
    })

    try {
      const response = await relayOnce(
        {
          url: 'https://api.anthropic.com/v1/messages',
          headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
          bodyBuffer: Buffer.from('{}'),
          proxyConfig: { type: 'http', host: 'proxy.example.com', port: 8080 },
          accountId: 'acc-1'
        },
        { ...baseConfig, url }
      )

      expect(seen.contentType).toBe('application/vnd.poo.frames')
      expect(seen.proxyURL).toBe('http://proxy.example.com:8080')
      expect(seen.accountId).toBe('acc-1')
      expect(response.body).toBe('{"id":"msg_1"}')
      expect(response.proofJSON).toEqual(proof)
    } finally {
      server.close()
    }
  })

  test('maps problem+json response to gateway problem error', async () => {
    const { server, url } = await startServer((req, res) => {
      req.resume()
      res.writeHead(403, { 'Content-Type': 'application/problem+json' })
      res.end(JSON.stringify({ code: 'target_not_allowed', message: 'target is not allowed' }))
    })

    try {
      await expect(
        relayOnce(
          {
            url: 'https://api.anthropic.com/v1/messages',
            headers: {},
            bodyBuffer: Buffer.from('{}')
          },
          { ...baseConfig, url }
        )
      ).rejects.toMatchObject({ code: 'target_not_allowed', submitted: true })
    } finally {
      server.close()
    }
  })

  test('reuses cached mTLS agent for the same gateway config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poo-mtls-'))
    const caFile = path.join(dir, 'ca.pem')
    const certFile = path.join(dir, 'client.pem')
    const keyFile = path.join(dir, 'client-key.pem')
    fs.writeFileSync(caFile, 'ca')
    fs.writeFileSync(certFile, 'cert')
    fs.writeFileSync(keyFile, 'key')

    const cfg = {
      authMode: 'mtls',
      mtls: {
        caFile,
        certFile,
        keyFile,
        servername: 'poo-parent-gateway.internal'
      }
    }
    const gatewayUrl = new URL('https://gateway.example.com/v1/proof/relay')

    const first = buildAgent(gatewayUrl, cfg)
    const second = buildAgent(gatewayUrl, cfg)

    expect(second).toBe(first)
  })

  test('rebuilds cached mTLS agent when certificate files are rotated in place', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poo-mtls-'))
    const caFile = path.join(dir, 'ca.pem')
    const certFile = path.join(dir, 'client.pem')
    const keyFile = path.join(dir, 'client-key.pem')
    fs.writeFileSync(caFile, 'ca')
    fs.writeFileSync(certFile, 'cert')
    fs.writeFileSync(keyFile, 'key')

    const cfg = {
      authMode: 'mtls',
      mtls: {
        caFile,
        certFile,
        keyFile,
        servername: 'poo-parent-gateway.internal'
      }
    }
    const gatewayUrl = new URL('https://gateway.example.com/v1/proof/relay')

    const first = buildAgent(gatewayUrl, cfg)
    const destroySpy = jest.spyOn(first, 'destroy')
    fs.writeFileSync(certFile, 'rotated-cert')
    const rotatedTime = new Date(Date.now() + 1000)
    fs.utimesSync(certFile, rotatedTime, rotatedTime)

    const second = buildAgent(gatewayUrl, cfg)

    expect(second).not.toBe(first)
    expect(destroySpy).toHaveBeenCalled()
  })
})
