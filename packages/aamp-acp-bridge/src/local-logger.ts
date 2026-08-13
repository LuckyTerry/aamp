import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { inspect } from 'node:util'
import pino, { type Logger as PinoLogger } from 'pino'

type ConsoleMethod = 'log' | 'warn' | 'error'
type ConsoleTarget = Record<ConsoleMethod, (...values: unknown[]) => void>
type PinoLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LocalBridgeLoggerOptions {
  bridge: string
  component?: string
  env?: NodeJS.ProcessEnv
  level?: string
  logFile?: string
  mirrorToConsole?: boolean
}

export interface InstalledLocalBridgeLogger {
  enabled: boolean
  logFile?: string
  event: (event: Record<string, unknown>) => void
  flush: () => void
  restore: () => void
}

function resolveLogFile(options: LocalBridgeLoggerOptions): string | undefined {
  const env = options.env ?? process.env
  return options.logFile || env.AAMP_LOG_FILE || env.AAMP_BRIDGE_LOG_FILE
}

function shouldMirrorToConsole(options: LocalBridgeLoggerOptions): boolean {
  if (options.mirrorToConsole !== undefined) return options.mirrorToConsole
  const env = options.env ?? process.env
  return env.AAMP_LOG_TERMINAL === 'true'
}

function formatConsoleValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || value.message
  return inspect(value, { depth: 6, breakLength: Infinity, compact: true })
}

function isLogMetadata(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !(value instanceof Error)
    && !Array.isArray(value)
}

function splitConsoleValues(values: unknown[]): { message: string; metadata: Record<string, unknown> } {
  const normalizedValues = values.length > 1 && values.at(-1) === undefined
    ? values.slice(0, -1)
    : values
  const last = normalizedValues.at(-1)
  const hasMetadata = normalizedValues.length > 1 && isLogMetadata(last)
  const messageValues = hasMetadata ? normalizedValues.slice(0, -1) : normalizedValues
  return {
    message: messageValues.map(formatConsoleValue).join(' '),
    metadata: hasMetadata ? last : {},
  }
}

function extractTaskId(message: string): string | undefined {
  const patterns = [
    /\b(?:aamp_task|task_id|taskId|aampTaskId)=([A-Za-z0-9._:-]+)/,
    /\bTask ID:\s*([A-Za-z0-9._:-]+)/,
    /\b(feishu-task-[A-Za-z0-9._:-]+)/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(message)
    if (match?.[1]) return match[1]
  }
  return undefined
}

function stripLeadingLogLevelPrefix(message: string): string {
  return message.replace(/^\[(?:trace|debug|info|warn|error|fatal)\s*\]\s*/i, '')
}

function inferMessageLogLevel(message: string | undefined, fallback: PinoLogLevel): PinoLogLevel {
  if (!message) return fallback
  const match = /^\[(trace|debug|info|warn|error|fatal)\s*\]/i.exec(message)
  const level = match?.[1]?.toLowerCase()
  if (
    level === 'trace'
    || level === 'debug'
    || level === 'info'
    || level === 'warn'
    || level === 'error'
    || level === 'fatal'
  ) {
    return level
  }
  return fallback
}

function inferFeishuTaskStage(message: string): string | undefined {
  const match = /^\[feishu task (?!subscription\b)[^\]]+\]\s*(.*)$/i.exec(message)
  if (!match) return undefined

  const detail = match[1] ?? ''
  if (/\b(?:loading base details|loaded base|hydrated|prepared attachments)\b/i.test(detail)) return 'aamp.load'
  if (/\b(?:marking in progress|marked in progress|marked in_progress)\b/i.test(detail)) return 'aamp.ack'
  if (/\b(?:completing|completed|completion already recorded)\b/i.test(detail)) return 'aamp.result'
  if (/\b(?:marking blocked|marked blocked|blocked state already recorded)\b/i.test(detail)) return 'aamp.help'
  return 'aamp.load'
}

function inferLogStage(record: Record<string, unknown>, message?: string): string | undefined {
  if (typeof record.stage === 'string' && record.stage) return record.stage

  const eventType = typeof record.event_type === 'string'
    ? record.event_type
    : (typeof record.type === 'string' ? record.type : undefined)
  if (eventType) {
    if (eventType.startsWith('pair.')) return 'bridge.pair'
    if (eventType === 'task.received') return 'aamp.dispatch'
    if (eventType === 'task.rejected' || eventType === 'task.completed' || eventType === 'task.result') return 'aamp.result'
    if (eventType.startsWith('agent.') || eventType.startsWith('bridge.')) return 'bridge.init'
  }

  if (!message) return undefined
  const searchableMessage = stripLeadingLogLevelPrefix(message)
  if (/^\[task [^\]]+\]\s*(?:received|dispatch)\b/.test(searchableMessage)) return 'aamp.dispatch'
  if (/^\[aamp dispatch(?:\s|\])/.test(searchableMessage) || /\bdispatch (sent|failure|payload|comment)/.test(searchableMessage)) return 'aamp.dispatch'
  if (/^\[aamp ack(?:\s|\])/.test(searchableMessage) || /\b(?:ack (received|comment|commented)|marked in_progress)\b/.test(searchableMessage)) return 'aamp.ack'
  if (/^\[aamp stream(?:\s|\])/.test(searchableMessage) || /\b(stream opened|steps flushed|stream=|appended \d+ .*step)\b/.test(searchableMessage)) return 'aamp.stream'
  if (/^\[aamp help(?:\s|\])/.test(searchableMessage) || /\b(help-needed|blocked parent=\d+ children=\d+)\b/.test(searchableMessage)) return 'aamp.help'
  if (/^\[aamp result(?:\s|\])/.test(searchableMessage) || /\b(result|completed parent=\d+ children=\d+)\b/.test(searchableMessage)) return 'aamp.result'
  if (/^\[feishu event(?:\s|\])/.test(searchableMessage) || /^\[task [^\]]+ event [^\]]+\]/.test(searchableMessage)) return 'feishu.event'
  const feishuTaskStage = inferFeishuTaskStage(searchableMessage)
  if (feishuTaskStage) return feishuTaskStage
  if (/\b(loading base details|loaded base|hydrated|prepared attachments)\b/.test(searchableMessage)) return 'aamp.load'
  if (/^\[(?:feishu agent|feishu task subscription|feishu app)(?:\s|\])/.test(searchableMessage) || /^\[feishu\]/.test(searchableMessage)) return 'feishu.init'
  if (/^\[(?:bridge|state|aamp)(?:\s|\])/.test(searchableMessage)) return 'bridge.init'
  if (/\b(pairing|pair request|pair\.request|pair\.completed)\b/i.test(searchableMessage)) return 'bridge.pair'
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripStagePrefixFromMessage(message: string): string {
  return message
    .replace(/^(\[(?:trace|debug|info|warn|error|fatal)\s*\]\s*)?\[(?:aamp dispatch|aamp ack|aamp stream|aamp help|aamp result|aamp load|bridge init|bridge pair|feishu init|feishu event|bridge|state|aamp|feishu|feishu agent|feishu task subscription|feishu task (?!subscription\b)[^\]]+)\]\s*/i, '$1')
    .trim()
}

function stripTaskIdFromMessage(message: string, taskId: string): string {
  const escapedTaskId = escapeRegExp(taskId)
  let next = message
  next = next.replace(new RegExp(`\\s*\\b(?:aamp_task|task_id|taskId|aampTaskId|task)=["']?${escapedTaskId}["']?(?=$|[\\s,}\\]])`, 'g'), '')
  next = next.replace(/\s*\[task [^\]]+\]\s*/g, ' ')
  next = next.replace(/\s*\b(?:task_guid|taskGuid|event_id|eventId)=["']?[A-Za-z0-9._:-]+["']?(?=$|[\s,}\]])/g, '')
  next = next.replace(new RegExp(`\\s*\\bTask ID:\\s*${escapedTaskId}(?=$|[\\s,}\\]])`, 'g'), '')
  next = next.replace(new RegExp(`\\[aamp (ack|stream|help|result|dispatch) ${escapedTaskId}\\]`, 'g'), '[aamp $1]')
  next = next.replace(new RegExp(escapedTaskId, 'g'), '<task>')
  return next
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/\[\s+/g, '[')
    .trim()
}

function shouldStripStagePrefix(message: string, taskId: string | undefined): boolean {
  if (!taskId && /^\[(?:trace|debug|info|warn|error|fatal)\s*\]\s*\[feishu task (?!subscription\b)[^\]]+\]/i.test(message)) return false
  if (!taskId && /^\[feishu task (?!subscription\b)[^\]]+\]/i.test(message)) return false
  return true
}

function buildTaskLogPayload(record: Record<string, unknown>, message?: string): { record: Record<string, unknown>; message?: string } {
  const stage = inferLogStage(record, message)
  const taskId = typeof record.taskId === 'string'
    ? record.taskId
    : (message ? extractTaskId(message) : undefined)
  let nextMessage = message
  if (taskId && nextMessage) nextMessage = stripTaskIdFromMessage(nextMessage, taskId)
  if (stage && nextMessage && shouldStripStagePrefix(nextMessage, taskId)) nextMessage = stripStagePrefixFromMessage(nextMessage)
  return {
    record: {
      ...record,
      ...(stage ? { stage } : {}),
      ...(taskId ? { taskId } : {}),
    },
    message: nextMessage,
  }
}

function createPinoFileLogger(options: LocalBridgeLoggerOptions, logFile: string): PinoLogger {
  mkdirSync(dirname(logFile), { recursive: true })
  return pino({
    base: {
      pid: process.pid,
      bridge: options.bridge,
      ...(options.component ? { component: options.component } : {}),
    },
    level: options.level || (options.env ?? process.env).AAMP_LOG_LEVEL || 'trace',
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
  }, pino.destination({ dest: logFile, mkdir: true, sync: true }))
}

function writePinoLog(
  logger: PinoLogger,
  level: PinoLogLevel,
  record: Record<string, unknown>,
  message?: string,
): void {
  switch (level) {
    case 'trace':
      logger.trace(record, message)
      return
    case 'debug':
      logger.debug(record, message)
      return
    case 'warn':
      logger.warn(record, message)
      return
    case 'error':
      logger.error(record, message)
      return
    case 'fatal':
      logger.fatal(record, message)
      return
    case 'info':
    default:
      logger.info(record, message)
  }
}

export function installLocalBridgeConsoleLogger(
  options: LocalBridgeLoggerOptions,
  target: ConsoleTarget = console,
): InstalledLocalBridgeLogger {
  const logFile = resolveLogFile(options)
  if (!logFile) {
    return {
      enabled: false,
      event: () => {},
      flush: () => {},
      restore: () => {},
    }
  }

  const logger = createPinoFileLogger(options, logFile)
  const mirrorToConsole = shouldMirrorToConsole(options)
  const original: ConsoleTarget = {
    log: target.log,
    warn: target.warn,
    error: target.error,
  }

  function write(method: ConsoleMethod, level: 'info' | 'warn' | 'error', values: unknown[]): void {
    const { message, metadata } = splitConsoleValues(values)
    const payload = buildTaskLogPayload({
      stream: method === 'log' ? 'stdout' : 'stderr',
      ...metadata,
    }, message)
    writePinoLog(logger, inferMessageLogLevel(message, level), payload.record, payload.message)
    if (mirrorToConsole) {
      original[method].apply(target, values)
    }
  }

  target.log = (...values: unknown[]) => write('log', 'info', values)
  target.warn = (...values: unknown[]) => write('warn', 'warn', values)
  target.error = (...values: unknown[]) => write('error', 'error', values)

  return {
    enabled: true,
    logFile,
    event: (event) => {
      const payload = buildTaskLogPayload({
        ...event,
        event_type: typeof event.type === 'string' ? event.type : 'bridge.event',
      })
      logger.info(payload.record, 'bridge event')
    },
    flush: () => {
      logger.flush()
    },
    restore: () => {
      target.log = original.log
      target.warn = original.warn
      target.error = original.error
      logger.flush()
    },
  }
}
