const { PoOConfigError } = require('./errors')

const MAX_PROXY_URL_BYTES = 4096

function fromProxyConfig(proxyConfig) {
  if (!proxyConfig) {
    return ''
  }

  const proxy = parseProxyConfig(proxyConfig)
  if (!proxy || !proxy.type || !proxy.host || !proxy.port) {
    return ''
  }

  const rawType = String(proxy.type).toLowerCase()
  const scheme = rawType === 'socks5' ? 'socks5h' : rawType
  if (!['http', 'https', 'socks5h'].includes(scheme)) {
    throw new PoOConfigError(`unsupported proxy type for PoO Gateway: ${proxy.type}`)
  }

  const host = String(proxy.host).trim()
  const port = String(proxy.port).trim()
  if (!host || !port || /[\s/?#@]/.test(host) || !/^\d+$/.test(port)) {
    throw new PoOConfigError('invalid proxy host or port')
  }

  const parsedPort = parseInt(port, 10)
  if (parsedPort < 1 || parsedPort > 65535) {
    throw new PoOConfigError('invalid proxy port')
  }

  let auth = ''
  if (proxy.username || proxy.password) {
    auth = `${encodeURIComponent(proxy.username || '')}:${encodeURIComponent(proxy.password || '')}@`
  }

  const url = `${scheme}://${auth}${host}:${parsedPort}`
  assertHeaderSafe(url)
  return url
}

function parseProxyConfig(proxyConfig) {
  if (typeof proxyConfig === 'string') {
    const trimmed = proxyConfig.trim()
    if (!trimmed) {
      return null
    }
    return JSON.parse(trimmed)
  }
  return proxyConfig
}

function assertHeaderSafe(value) {
  if (Buffer.byteLength(value, 'utf8') > MAX_PROXY_URL_BYTES) {
    throw new PoOConfigError('proxy URL exceeds PoO Gateway header limit')
  }
  if (
    value.trim() !== value ||
    Array.from(value).some((char) => {
      const code = char.charCodeAt(0)
      return code === 0x7f || code < 0x20
    })
  ) {
    throw new PoOConfigError('proxy URL contains unsafe header characters')
  }
}

function redactProxyUrl(value) {
  if (!value) {
    return 'No proxy'
  }
  try {
    const url = new URL(value)
    const auth = url.username || url.password ? '***:***@' : ''
    return `${url.protocol}//${auth}${url.hostname}:${url.port}`
  } catch {
    return 'Invalid proxy URL'
  }
}

module.exports = {
  MAX_PROXY_URL_BYTES,
  fromProxyConfig,
  redactProxyUrl
}
