import { z } from 'zod'

export type ZCodeRequestId = string | number

export interface ZCodeRequest {
  id: ZCodeRequestId
  method: string
  params?: unknown
  trace?: unknown
}

export interface ZCodeNotification {
  method: string
  params?: unknown
  trace?: unknown
}

export interface ZCodeSuccessResponse {
  id: ZCodeRequestId
  result: unknown
}

export interface ZCodeErrorBody {
  code: number
  message: string
  data?: unknown
}

export interface ZCodeErrorResponse {
  id: ZCodeRequestId
  error: ZCodeErrorBody
}

export type ZCodeInboundEnvelope =
  | ZCodeRequest
  | ZCodeNotification
  | ZCodeSuccessResponse
  | ZCodeErrorResponse

export interface ZCodeProtocolMarker {
  protocol: {
    name: 'ZCode Protocol'
    version: 1
  }
}

export class ZCodeProtocolError extends Error {
  override readonly name = 'ZCodeProtocolError'
}

const requestIdSchema = z.union([
  z.string().min(1),
  z.number().int(),
])

const requestSchema = z.object({
  id: requestIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
  trace: z.unknown().optional(),
}).strict()

const notificationSchema = z.object({
  method: z.string().min(1),
  params: z.unknown().optional(),
  trace: z.unknown().optional(),
}).strict()

const successSchema = z.object({
  id: requestIdSchema,
  result: z.unknown(),
}).strict()

const errorSchema = z.object({
  id: requestIdSchema,
  error: z.object({
    code: z.number().int(),
    message: z.string().min(1),
    data: z.unknown().optional(),
  }).strict(),
}).strict()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function parseZcodeEnvelope(value: unknown): ZCodeInboundEnvelope {
  if (!isRecord(value)) {
    throw new ZCodeProtocolError('Invalid ZCode Protocol envelope')
  }
  if (hasOwn(value, 'jsonrpc')) {
    throw new ZCodeProtocolError('ZCode Protocol envelopes must not contain jsonrpc')
  }

  const hasMethod = hasOwn(value, 'method')
  const hasId = hasOwn(value, 'id')
  const hasResult = hasOwn(value, 'result')
  const hasError = hasOwn(value, 'error')

  try {
    if (hasMethod) {
      if (hasResult || hasError) {
        throw new ZCodeProtocolError('Invalid ZCode Protocol envelope')
      }
      return hasId
        ? requestSchema.parse(value) as ZCodeRequest
        : notificationSchema.parse(value) as ZCodeNotification
    }

    if (!hasId || hasResult === hasError) {
      throw new ZCodeProtocolError('Invalid ZCode Protocol envelope')
    }
    return hasResult
      ? successSchema.parse(value) as ZCodeSuccessResponse
      : errorSchema.parse(value) as ZCodeErrorResponse
  } catch (error) {
    if (error instanceof ZCodeProtocolError) throw error
    throw new ZCodeProtocolError('Invalid ZCode Protocol envelope')
  }
}

export function assertZcodeProtocolV1(
  value: unknown,
  cliVersion: string,
): asserts value is ZCodeProtocolMarker {
  const protocol = isRecord(value) && isRecord(value.protocol)
    ? value.protocol
    : undefined
  if (protocol?.name === 'ZCode Protocol' && protocol.version === 1) return

  const receivedName = typeof protocol?.name === 'string' ? protocol.name : 'unknown protocol'
  const receivedVersion = typeof protocol?.version === 'number'
    || typeof protocol?.version === 'string'
    ? String(protocol.version)
    : 'unknown'
  throw new ZCodeProtocolError(
    `Unsupported ZCode protocol: expected ZCode Protocol v1, received ${receivedName} version ${receivedVersion} from CLI ${cliVersion}`,
  )
}
