const { fromProxyConfig, redactProxyUrl } = require('../../src/poo-parent-gateway/proxyUrl')

describe('poo-parent-gateway proxyUrl', () => {
  test('serializes http proxy config with encoded auth', () => {
    expect(
      fromProxyConfig({
        type: 'http',
        host: 'proxy.example.com',
        port: 8080,
        username: 'u ser',
        password: 'p@ss'
      })
    ).toBe('http://u%20ser:p%40ss@proxy.example.com:8080')
  })

  test('serializes socks5 as socks5h to preserve proxy-side DNS semantics', () => {
    expect(fromProxyConfig('{"type":"socks5","host":"127.0.0.1","port":7890}')).toBe(
      'socks5h://127.0.0.1:7890'
    )
  })

  test('returns empty string for empty proxy config', () => {
    expect(fromProxyConfig(null)).toBe('')
    expect(fromProxyConfig('')).toBe('')
  })

  test('rejects unsafe header characters', () => {
    expect(() =>
      fromProxyConfig({ type: 'http', host: 'proxy.example.com\r\nx: y', port: 8080 })
    ).toThrow(/invalid proxy host/)
  })

  test('redacts credentials for logs', () => {
    expect(redactProxyUrl('http://user:pass@proxy.example.com:8080')).toBe(
      'http://***:***@proxy.example.com:8080'
    )
  })
})
