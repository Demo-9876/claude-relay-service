class PoOError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = options.code || 'poo_error'
    this.statusCode = options.statusCode || 502
    this.submitted = Boolean(options.submitted)
    this.retryable = Boolean(options.retryable)
    this.cause = options.cause
  }
}

class PoOConfigError extends PoOError {
  constructor(message, options = {}) {
    super(message, { code: 'poo_config_error', statusCode: 500, ...options })
  }
}

class PoOGatewayUnavailableError extends PoOError {
  constructor(message, options = {}) {
    super(message, {
      code: 'poo_gateway_unavailable',
      statusCode: 503,
      retryable: true,
      ...options
    })
  }
}

class PoOGatewayProblemError extends PoOError {
  constructor(message, problem = {}, options = {}) {
    super(message, {
      code: problem.code || 'poo_gateway_problem',
      statusCode: options.statusCode || 503,
      retryable: Boolean(problem.retryable),
      ...options
    })
    this.problem = problem
  }
}

class PoOFrameError extends PoOError {
  constructor(message, options = {}) {
    super(message, { code: 'poo_frame_error', statusCode: 502, ...options })
  }
}

class PoOProofMissingError extends PoOError {
  constructor(message = 'PoO proof is missing', options = {}) {
    super(message, { code: 'poo_proof_missing', statusCode: 502, submitted: true, ...options })
  }
}

class PoOProofSchemaError extends PoOError {
  constructor(message = 'PoO proof schema is invalid', options = {}) {
    super(message, {
      code: 'poo_proof_schema_invalid',
      statusCode: 502,
      submitted: true,
      ...options
    })
  }
}

module.exports = {
  PoOError,
  PoOConfigError,
  PoOGatewayUnavailableError,
  PoOGatewayProblemError,
  PoOFrameError,
  PoOProofMissingError,
  PoOProofSchemaError
}
