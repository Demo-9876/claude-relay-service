const appConfig = require('../../../config/config')
const { getConfig, validateConfig } = require('./config')
const gatewayClient = require('./gatewayClient')
const responseAdapter = require('./responseAdapter')

let cachedConfig = null
let validated = false

function currentConfig() {
  if (!cachedConfig) {
    cachedConfig = getConfig(appConfig)
  }
  if (!validated) {
    validateConfig(cachedConfig)
    validated = true
  }
  return cachedConfig
}

function resetForTests() {
  cachedConfig = null
  validated = false
  gatewayClient.resetAgentCache()
}

function isEnabled() {
  return currentConfig().enabled
}

function isRequired() {
  return currentConfig().required
}

function initialize() {
  currentConfig()
}

async function relayOnce(options) {
  return gatewayClient.relayOnce(options, currentConfig())
}

async function relayStream(options) {
  return gatewayClient.relayStream(options, currentConfig())
}

function injectProofIntoJSON(value, proofJSON) {
  return responseAdapter.injectProofIntoJSON(value, proofJSON)
}

function appendProofSSE(responseStream, proofJSON) {
  return responseAdapter.appendProofSSE(responseStream, proofJSON)
}

function appendErrorSSE(responseStream, error) {
  return responseAdapter.appendErrorSSE(responseStream, error)
}

module.exports = {
  isEnabled,
  isRequired,
  initialize,
  relayOnce,
  relayStream,
  injectProofIntoJSON,
  appendProofSSE,
  appendErrorSSE,
  _resetForTests: resetForTests,
  _currentConfig: currentConfig
}
