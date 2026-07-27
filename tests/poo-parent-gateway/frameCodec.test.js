const {
  FRAME_TYPES,
  encodeFrame,
  decodeFramesFromBuffer,
  buildRelayRequestFrames
} = require('../../src/poo-parent-gateway/frameCodec')

describe('poo-parent-gateway frameCodec', () => {
  test('encodes and decodes frames with 1 byte type and 4 byte length', () => {
    const raw = encodeFrame(FRAME_TYPES.REQ_BODY, Buffer.from('hello'))
    expect(raw[0]).toBe(FRAME_TYPES.REQ_BODY)
    expect(raw.readUInt32BE(1)).toBe(5)

    const frames = decodeFramesFromBuffer(raw)
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe(FRAME_TYPES.REQ_BODY)
    expect(frames[0].payload.toString()).toBe('hello')
  })

  test('builds REQ_HEAD with hostname, path query and bearer token', () => {
    const { head, buffer } = buildRelayRequestFrames({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages/count_tokens?x=1',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        Host: 'evil.example',
        Connection: 'keep-alive',
        'Content-Length': '2'
      },
      bodyBuffer: Buffer.from('{}')
    })

    expect(head.upstream.host).toBe('api.anthropic.com')
    expect(head.upstream.path).toBe('/v1/messages/count_tokens?x=1')
    expect(head.upstream.headers).toEqual({ 'content-type': 'application/json' })
    expect(head.token).toBe('test-token')
    expect(buffer[0]).toBe(FRAME_TYPES.REQ_HEAD)
  })

  test('rejects non-443 upstream URLs for gateway v1', () => {
    expect(() =>
      buildRelayRequestFrames({
        url: 'https://api.anthropic.com:8443/v1/messages',
        headers: {},
        bodyBuffer: Buffer.from('{}')
      })
    ).toThrow(/port 443/)
  })
})
