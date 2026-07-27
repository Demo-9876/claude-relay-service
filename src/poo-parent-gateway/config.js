const fs = require('fs')
const { PoOConfigError } = require('./errors')

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:15005/v1/proof/relay'
const DEFAULT_TIMEOUT_MS = 600000
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024

function getConfig(appConfig = {}) {
  const raw = appConfig.pooParentGateway || {}
  const enabled = boolFromEnvOrValue(process.env.POO_PARENT_GATEWAY_ENABLED, raw.enabled, false)
  const required = boolFromEnvOrValue(process.env.POO_PARENT_GATEWAY_REQUIRED, raw.required, true)
  const url = process.env.POO_PARENT_GATEWAY_URL || raw.url || DEFAULT_GATEWAY_URL
  const authMode = process.env.POO_PARENT_GATEWAY_AUTH_MODE || raw.authMode || 'none'
  const timeoutMs = intFromEnvOrValue(
    process.env.POO_PARENT_GATEWAY_TIMEOUT_MS,
    raw.timeoutMs,
    DEFAULT_TIMEOUT_MS
  )
  const maxBodyBytes = intFromEnvOrValue(
    process.env.POO_PARENT_GATEWAY_MAX_BODY_BYTES,
    raw.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES
  )
  const mtlsRaw = raw.mtls || {}
  const mtls = {
    caFile: process.env.POO_PARENT_GATEWAY_CA_FILE || mtlsRaw.caFile || '',
    certFile: process.env.POO_PARENT_GATEWAY_CERT_FILE || mtlsRaw.certFile || '',
    keyFile: process.env.POO_PARENT_GATEWAY_KEY_FILE || mtlsRaw.keyFile || '',
    servername: process.env.POO_PARENT_GATEWAY_SERVER_NAME || mtlsRaw.servername || ''
  }

  return {
    enabled,
    required,
    url,
    authMode,
    timeoutMs,
    maxBodyBytes,
    mtls,
    supportedProofVersions: raw.supportedProofVersions || [2]
  }
}

function validateConfig(cfg) {
  if (!cfg.enabled) {
    return
  }

  if (!['none', 'mtls'].includes(cfg.authMode)) {
    throw new PoOConfigError(`invalid PoO Parent Gateway authMode: ${cfg.authMode}`)
  }

  let parsed
  try {
    parsed = new URL(cfg.url)
  } catch (error) {
    throw new PoOConfigError(`invalid PoO Parent Gateway url: ${cfg.url}`, { cause: error })
  }

  if (cfg.authMode === 'none') {
    if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname)) {
      throw new PoOConfigError('authMode=none is only allowed for loopback http Gateway URLs')
    }
    return
  }

  if (parsed.protocol !== 'https:') {
    throw new PoOConfigError('authMode=mtls requires an https Gateway URL')
  }

  const missingFiles = []
  for (const field of ['caFile', 'certFile', 'keyFile']) {
    if (!cfg.mtls[field]) {
      missingFiles.push(field)
    } else {
      try {
        fs.accessSync(cfg.mtls[field], fs.constants.R_OK)
      } catch (error) {
        throw new PoOConfigError(`PoO mTLS file is not readable: ${field}`, { cause: error })
      }
    }
  }
  if (missingFiles.length > 0) {
    throw new PoOConfigError(`PoO mTLS config missing: ${missingFiles.join(', ')}`)
  }
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname || '').toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  )
}

function boolFromEnvOrValue(envValue, value, fallback) {
  if (envValue !== undefined && envValue !== '') {
    return envValue === 'true' || envValue === '1'
  }
  if (typeof value === 'boolean') {
    return value
  }
  return fallback
}

function intFromEnvOrValue(envValue, value, fallback) {
  const source = envValue !== undefined && envValue !== '' ? envValue : value
  const parsed = parseInt(source, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  getConfig,
  validateConfig,
  isLoopbackHost
}
