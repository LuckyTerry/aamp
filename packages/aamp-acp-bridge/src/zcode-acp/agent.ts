import {
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
} from '@agentclientprotocol/sdk'
import type { ZCodeAcpRuntime } from './runtime.js'
import {
  redactForLog,
  ZCodeAdapterError,
  ZCodeValidationError,
} from './translator.js'

interface ErrorWithDetails extends Error {
  code?: unknown
  data?: unknown
}

interface RuntimeRequestContext {
  sessionId?: string
}

function withoutStacks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutStacks)
  if (typeof value !== 'object' || value === null) return value
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.toLowerCase() === 'stack') continue
    output[key] = withoutStacks(entry)
  }
  return output
}

function safeErrorData(
  operation: string,
  context: RuntimeRequestContext,
  error: ErrorWithDetails,
): unknown {
  return withoutStacks(redactForLog({
    operation,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    error: {
      name: error.name,
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.data !== undefined ? { data: error.data } : {}),
    },
  }))
}

function stableErrorCategory(error: Error): string {
  switch (error.name) {
    case 'ZCodeRequestTimeoutError':
    case 'PermissionTimeoutError':
      return 'request timed out'
    case 'ZCodeChildExitedError':
      return 'ZCode app-server exited'
    case 'ZCodeProtocolError':
      return 'ZCode protocol error'
    case 'ZCodeTransportClosedError':
      return 'ZCode transport closed'
    case 'ZCodeRpcError':
      return 'ZCode request failed'
    default:
      return 'unexpected runtime error'
  }
}

async function handleRuntimeRequest<Result>(
  operation: string,
  context: RuntimeRequestContext,
  request: () => Promise<Result>,
): Promise<Result> {
  try {
    return await request()
  } catch (error) {
    if (error instanceof RequestError) throw error
    if (error instanceof ZCodeValidationError) {
      throw RequestError.invalidParams(
        { reason: error.message },
        error.message,
      )
    }
    const runtimeError = error instanceof Error
      ? error as ErrorWithDetails
      : new Error(String(error))
    throw RequestError.internalError(
      safeErrorData(operation, context, runtimeError),
      runtimeError instanceof ZCodeAdapterError
        ? runtimeError.message
        : `${operation} failed${context.sessionId
          ? ` for session ${context.sessionId}`
          : ''}: ${stableErrorCategory(runtimeError)}`,
    )
  }
}

export function createZcodeAcpAgent(
  runtime: ZCodeAcpRuntime,
  version: string,
): AgentApp {
  const app = agent({ name: 'aamp-zcode-acp' })

  app.onConnect((connection) => {
    runtime.attachClient(connection.client)
  })

  app
    .onRequest(methods.agent.initialize, async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
      agentInfo: {
        name: 'aamp-zcode-acp',
        version,
      },
    }))
    .onRequest(methods.agent.session.new, ({ params }) =>
      handleRuntimeRequest('session/new', {}, () => runtime.newSession(params)))
    .onRequest(methods.agent.session.load, ({ params }) =>
      handleRuntimeRequest(
        'session/load',
        { sessionId: params.sessionId },
        () => runtime.loadSession(params),
      ))
    .onRequest(methods.agent.session.resume, ({ params }) =>
      handleRuntimeRequest(
        'session/resume',
        { sessionId: params.sessionId },
        () => runtime.resumeSession(params),
      ))
    .onRequest(methods.agent.session.list, ({ params }) =>
      handleRuntimeRequest('session/list', {}, () => runtime.listSessions(params)))
    .onRequest(methods.agent.session.close, ({ params }) =>
      handleRuntimeRequest(
        'session/close',
        { sessionId: params.sessionId },
        () => runtime.closeSession(params),
      ))
    .onRequest(methods.agent.session.prompt, ({ params }) =>
      handleRuntimeRequest(
        'session/prompt',
        { sessionId: params.sessionId },
        () => runtime.prompt(params),
      ))
    .onRequest(methods.agent.session.setMode, ({ params }) =>
      handleRuntimeRequest(
        'session/set_mode',
        { sessionId: params.sessionId },
        () => runtime.setMode(params),
      ))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) =>
      handleRuntimeRequest(
        'session/set_config_option',
        { sessionId: params.sessionId },
        () => runtime.setConfigOption(params),
      ))
    .onNotification(methods.agent.session.cancel, ({ params }) =>
      handleRuntimeRequest(
        'session/cancel',
        { sessionId: params.sessionId },
        () => runtime.cancel(params.sessionId),
      ))

  return app
}
