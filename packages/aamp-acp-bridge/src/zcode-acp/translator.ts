import { isAbsolute, resolve } from 'node:path'
import type {
  ContentBlock,
  McpServer,
  SessionConfigOption,
  SessionInfo,
  SessionMode,
  SessionModeState,
  SessionUpdate,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk'
import { renderZcodeLoginCommand } from './app-locator.js'

export interface ZCodeWorkspace {
  workspacePath: string
  workspaceKey: string
}

export interface ZCodeModelRef {
  providerId: string
  modelId: string
  variant?: string
}

const ZCODE_MODES: SessionMode[] = [
  { id: 'plan', name: 'Plan' },
  { id: 'build', name: 'Build' },
  { id: 'edit', name: 'Edit' },
  { id: 'yolo', name: 'Yolo' },
  { id: 'auto', name: 'Auto' },
]
const ZCODE_MODE_IDS = new Set(ZCODE_MODES.map((mode) => mode.id))

export class ZCodeValidationError extends Error {
  override readonly name = 'ZCodeValidationError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function getSettings(snapshot: unknown): Record<string, unknown> {
  if (!isRecord(snapshot)) throw new Error('Invalid ZCode snapshot')
  return isRecord(snapshot.settings) ? snapshot.settings : {}
}

function readModelRef(value: unknown): ZCodeModelRef | undefined {
  if (!isRecord(value)) return undefined
  const providerId = nonEmptyString(value.providerId)
  const modelId = nonEmptyString(value.modelId)
  if (!providerId || !modelId) return undefined
  const variant = nonEmptyString(value.variant)
  return {
    providerId,
    modelId,
    ...(variant ? { variant } : {}),
  }
}

export function toZcodeWorkspace(
  cwd: string,
  additionalDirectories: string[] = [],
): ZCodeWorkspace {
  if (!isAbsolute(cwd)) {
    throw new ZCodeValidationError('ACP cwd must be an absolute path')
  }
  if (additionalDirectories.length > 0) {
    throw new ZCodeValidationError(
      'ACP additionalDirectories are not supported by ZCode',
    )
  }
  const workspacePath = resolve(cwd)
  return {
    workspacePath,
    workspaceKey: workspacePath,
  }
}

export function toZcodePrompt(blocks: ContentBlock[]): string {
  if (blocks.length === 0) {
    throw new ZCodeValidationError(
      'ACP prompt must contain at least one content block',
    )
  }
  return blocks.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'resource_link') {
      return `[Resource link: ${block.name}]\nURI: ${block.uri}`
    }
    throw new ZCodeValidationError(
      `Unsupported ACP prompt content type: ${block.type}`,
    )
  }).join('\n\n')
}

export function toZcodeMcpServers(servers: McpServer[]): unknown[] {
  return servers.map((server) => {
    if ('type' in server && server.type === 'acp') {
      throw new ZCodeValidationError(
        `ACP-transport MCP server "${server.name}" is not supported by ZCode`,
      )
    }
    if ('type' in server && (server.type === 'http' || server.type === 'sse')) {
      return {
        name: server.name,
        type: server.type,
        url: server.url,
        headers: server.headers.map(({ name, value }) => ({ name, value })),
      }
    }
    if (!('type' in server)) {
      return {
        name: server.name,
        command: server.command,
        args: [...server.args],
        env: server.env.map(({ name, value }) => ({ name, value })),
      }
    }
    throw new ZCodeValidationError(
      `Unsupported MCP transport for "${server.name}"`,
    )
  })
}

export function encodeModelRef(model: ZCodeModelRef): string {
  const parts = [model.providerId, model.modelId]
  if (!parts.every((part) => part.length > 0)
    || (model.variant !== undefined && model.variant.length === 0)) {
    throw new ZCodeValidationError('Invalid ZCode model reference')
  }
  if (model.variant !== undefined) parts.push(model.variant)
  return parts.map(encodeURIComponent).join('/')
}

export function decodeModelRef(value: string): ZCodeModelRef {
  const encodedParts = value.split('/')
  if (encodedParts.length < 2 || encodedParts.length > 3
    || encodedParts.some((part) => part.length === 0)) {
    throw new ZCodeValidationError(
      'A model reference must contain two or three segments',
    )
  }

  let parts: string[]
  try {
    parts = encodedParts.map(decodeURIComponent)
  } catch {
    throw new ZCodeValidationError('Invalid encoded model reference')
  }
  if (parts.some((part) => part.length === 0)) {
    throw new ZCodeValidationError('Invalid encoded model reference')
  }
  return {
    providerId: parts[0],
    modelId: parts[1],
    ...(parts[2] ? { variant: parts[2] } : {}),
  }
}

export function toAcpModes(snapshot: unknown): SessionModeState {
  const settings = getSettings(snapshot)
  const modeSettings = settings.mode
  const current = typeof modeSettings === 'string'
    ? modeSettings
    : isRecord(modeSettings)
      ? nonEmptyString(modeSettings.current)
      : undefined
  const currentModeId = current ?? 'build'
  if (!ZCODE_MODE_IDS.has(currentModeId)) {
    throw new ZCodeValidationError(`Unknown ZCode mode: ${currentModeId}`)
  }
  return {
    currentModeId,
    availableModes: ZCODE_MODES.map((mode) => ({ ...mode })),
  }
}

export function toAcpConfigOptions(snapshot: unknown): SessionConfigOption[] {
  const settings = getSettings(snapshot)
  const modelSettings = isRecord(settings.model) ? settings.model : undefined
  if (!modelSettings) return []

  const current = readModelRef(modelSettings.current)
  if (!current) return []

  const available = Array.isArray(modelSettings.available)
    ? modelSettings.available
    : []
  const options = available.flatMap((entry) => {
    if (!isRecord(entry) || nonEmptyString(entry.disabledReason)) return []
    const ref = readModelRef(entry.ref)
    if (!ref) return []
    return [{
      value: encodeModelRef(ref),
      name: nonEmptyString(entry.label) ?? ref.modelId,
      ...(nonEmptyString(entry.description)
        ? { description: nonEmptyString(entry.description) }
        : {}),
    }]
  })

  const currentValue = encodeModelRef(current)
  if (!options.some((option) => option.value === currentValue)) {
    options.unshift({
      value: currentValue,
      name: current.modelId,
    })
  }

  return [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options,
  }]
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const timestamp = typeof value === 'number' && value < 1_000_000_000_000
    ? value * 1000
    : value
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function toAcpSessionInfo(session: unknown): SessionInfo {
  if (!isRecord(session)) throw new Error('Invalid ZCode session metadata')
  const sessionId = nonEmptyString(session.sessionId) ?? nonEmptyString(session.id)
  if (!sessionId) throw new Error('ZCode session metadata is missing a session ID')

  const workspace = isRecord(session.workspace) ? session.workspace : {}
  const cwd = nonEmptyString(workspace.workspacePath)
    ?? nonEmptyString(session.workspacePath)
    ?? nonEmptyString(session.directory)
    ?? nonEmptyString(session.cwd)
  if (!cwd || !isAbsolute(cwd)) {
    throw new Error('ZCode session metadata is missing an absolute workspace path')
  }

  const time = isRecord(session.time) ? session.time : {}
  const updatedAt = toIsoTimestamp(
    session.updatedAt ?? session.updated ?? time.updated,
  )
  const title = nonEmptyString(session.title)
  return {
    sessionId,
    cwd,
    ...(title ? { title } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

export function inferToolKind(toolName: string): ToolKind {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]+/gu, '_')
  if (normalized.includes('read')) return 'read'
  if (normalized.includes('search') || normalized.includes('find')) return 'search'
  if (normalized.includes('fetch') || normalized.includes('http')) return 'fetch'
  if (normalized.includes('delete') || normalized.includes('remove')) return 'delete'
  if (normalized.includes('move') || normalized.includes('rename')) return 'move'
  if (normalized.includes('edit') || normalized.includes('write')
    || normalized.includes('patch')) return 'edit'
  if (normalized.includes('execute') || normalized.includes('shell')
    || normalized.includes('command') || normalized.includes('terminal')) return 'execute'
  if (normalized.includes('think') || normalized.includes('reason')) return 'think'
  if (normalized.includes('mode')) return 'switch_mode'
  return 'other'
}

function mapToolStatus(value: unknown): ToolCallStatus {
  switch (value) {
    case 'running':
    case 'started':
    case 'progress':
      return 'in_progress'
    case 'completed':
    case 'result':
      return 'completed'
    case 'error':
    case 'failed':
      return 'failed'
    default:
      return 'pending'
  }
}

export function replaySnapshot(snapshot: unknown): SessionUpdate[] {
  if (!isRecord(snapshot)) throw new Error('Invalid ZCode snapshot')
  if (snapshot.messages === undefined) return []
  if (!Array.isArray(snapshot.messages)) {
    throw new Error('ZCode snapshot must contain a messages array')
  }

  const updates: SessionUpdate[] = []
  for (const message of snapshot.messages) {
    if (!isRecord(message)) continue
    const info = isRecord(message.info) ? message.info : {}
    const role = info.role
    const messageId = nonEmptyString(info.messageId)
    if ((role !== 'user' && role !== 'assistant') || !Array.isArray(message.parts)) {
      continue
    }

    for (const part of message.parts) {
      if (!isRecord(part)) continue
      if (part.type === 'text' && typeof part.text === 'string') {
        updates.push({
          sessionUpdate: role === 'user'
            ? 'user_message_chunk'
            : 'agent_message_chunk',
          ...(messageId ? { messageId } : {}),
          content: { type: 'text', text: part.text },
        })
        continue
      }
      if (part.type === 'reasoning' && typeof part.text === 'string') {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          ...(messageId ? { messageId } : {}),
          content: { type: 'text', text: part.text },
        })
        continue
      }
      if (part.type === 'file') {
        const uri = nonEmptyString(part.url)
        if (!uri) continue
        updates.push({
          sessionUpdate: role === 'user'
            ? 'user_message_chunk'
            : 'agent_message_chunk',
          ...(messageId ? { messageId } : {}),
          content: {
            type: 'resource_link',
            name: nonEmptyString(part.filename) ?? uri,
            uri,
            ...(nonEmptyString(part.mime) ? { mimeType: nonEmptyString(part.mime) } : {}),
          },
        })
        continue
      }
      if (part.type === 'tool') {
        const callId = nonEmptyString(part.callId)
        const tool = isRecord(part.tool) ? part.tool : {}
        const state = isRecord(part.state) ? part.state : {}
        const toolName = nonEmptyString(tool.name) ?? 'tool'
        if (!callId) continue
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId: callId,
          title: toolName,
          kind: inferToolKind(toolName),
          status: mapToolStatus(state.status),
          ...(tool.input !== undefined ? { rawInput: tool.input } : {}),
          ...(state.result !== undefined ? { rawOutput: state.result } : {}),
        })
      }
    }
  }
  return updates
}

export class ZCodeAdapterError extends Error {
  readonly code?: unknown
  readonly data?: unknown

  constructor(message: string, source: unknown) {
    super(message, source instanceof Error ? { cause: source } : undefined)
    this.name = 'ZCodeAdapterError'
    if (isRecord(source)) {
      this.code = source.code
      this.data = source.data
    }
  }
}

export function rewriteZcodeError(error: unknown, cliPath: string): Error {
  const record = isRecord(error) ? error : {}
  const data = isRecord(record.data) ? record.data : {}
  const code = record.code
  const nestedCode = data.code
  const message = error instanceof Error
    ? error.message
    : nonEmptyString(record.message) ?? String(error)
  if (code !== 'model_config_missing'
    && nestedCode !== 'model_config_missing'
    && !message.includes('model_config_missing')) {
    return error instanceof Error ? error : new Error(message)
  }

  return new ZCodeAdapterError(
    `${message}\nConfigure ZCode model access with: ${renderZcodeLoginCommand(cliPath)}`,
    error,
  )
}

function isSecretName(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/gu, '')
  return normalized === 'authorization'
    || normalized === 'apikey'
    || normalized.endsWith('token')
    || normalized.includes('password')
    || normalized.includes('secret')
    || normalized.includes('cookie')
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen))
  if (!isRecord(value)) return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  const namedSecret = typeof value.name === 'string' && isSecretName(value.name)
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretName(key) || (namedSecret && key === 'value')) {
      output[key] = '[REDACTED]'
    } else {
      output[key] = redactValue(entry, seen)
    }
  }
  return output
}

export function redactForLog(value: unknown): unknown {
  return redactValue(value, new WeakSet())
}

export function summarizePermissionInput(
  value: unknown,
  maxLength = 4096,
): string {
  const redacted = redactForLog(value)
  let summary: string
  try {
    summary = JSON.stringify(redacted) ?? String(redacted)
  } catch {
    summary = '[Unserializable permission input]'
  }
  if (summary.length <= maxLength) return summary
  return `${summary.slice(0, maxLength)}...[truncated]`
}
