const {
  FRAME_TYPES,
  encodeFrame,
  encodeJSONFrame
} = require('../../src/poo-parent-gateway/frameCodec')
const {
  collectResponse,
  injectProofIntoJSON
} = require('../../src/poo-parent-gateway/responseAdapter')

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

describe('poo-parent-gateway responseAdapter', () => {
  test('collects RESP_HEAD, chunks and RESP_TRAILER proof', () => {
    const raw = Buffer.concat([
      encodeJSONFrame(FRAME_TYPES.RESP_HEAD, {
        status_code: 200,
        headers: { 'Content-Type': 'application/json' }
      }),
      encodeFrame(FRAME_TYPES.RESP_CHUNK, Buffer.from('{"ok":')),
      encodeFrame(FRAME_TYPES.RESP_CHUNK, Buffer.from('true}')),
      encodeJSONFrame(FRAME_TYPES.RESP_TRAILER, { proof })
    ])

    const response = collectResponse(raw)
    expect(response.statusCode).toBe(200)
    expect(response.headers).toEqual({ 'content-type': 'application/json' })
    expect(response.body).toBe('{"ok":true}')
    expect(response.proofJSON).toEqual(proof)
  })

  test('rejects missing v2 proof fields in required mode', () => {
    const raw = Buffer.concat([
      encodeJSONFrame(FRAME_TYPES.RESP_HEAD, { status_code: 200, headers: {} }),
      encodeFrame(FRAME_TYPES.RESP_CHUNK, Buffer.from('{}')),
      encodeJSONFrame(FRAME_TYPES.RESP_TRAILER, {})
    ])

    expect(() => collectResponse(raw)).toThrow(/proof/)
  })

  test('injects proof into top-level JSON object', () => {
    expect(injectProofIntoJSON({ id: 'msg_1' }, proof)).toEqual({ id: 'msg_1', proof })
  })
})
