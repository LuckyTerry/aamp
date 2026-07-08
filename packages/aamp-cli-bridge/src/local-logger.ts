import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { inspect } from 'node:util'
import pino, { type Logger as PinoLogger } from 'pino'

type ConsoleMethod = 'log' | 'warn' | 'error'
type ConsoleTarget = Record<ConsoleMethod, (...values: unknown[]) => void>

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

function enrichTaskMetadata(record: Record<string, unknown>, message?: string): Record<string, unknown> {
  const taskId = typeof record.taskId === 'string'
    ? record.taskId
    : (message ? extractTaskId(message) : undefined)
  if (!taskId) return record
  return {
    ...record,
    taskId,
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
    level: options.level || (options.env ?? process.env).AAMP_LOG_LEVEL || 'info',
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
  }, pino.destination({ dest: logFile, mkdir: true, sync: true }))
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
    logger[level](enrichTaskMetadata({
      stream: method === 'log' ? 'stdout' : 'stderr',
      ...metadata,
    }, message), message)
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
      logger.info(enrichTaskMetadata({
        ...event,
        event_type: typeof event.type === 'string' ? event.type : 'bridge.event',
      }), 'bridge event')
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
