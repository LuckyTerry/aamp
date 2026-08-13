import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

export interface AcpEvent {
  eventVersion?: number
  sessionId?: string
  requestId?: string
  seq?: number
  type?: string
  messageId?: string
  content?: unknown
  [key: string]: unknown
}

export type AcpTextChunkChannel = 'assistant' | 'thought'

export interface AcpTextChunk {
  channel: AcpTextChunkChannel
  text: string
  messageId?: string
}

export interface AcpToolUpdate {
  toolCallId?: string
  title?: string
  status?: string
  kind?: string
  text?: string
  locations?: Array<{ path: string; line?: number }>
}

export interface AcpPlanEntry {
  content: string
  status?: string
  priority?: string
}

export interface AcpPromptHandlers {
  onEvent?: (event: AcpEvent) => void
  onTextChunk?: (chunk: AcpTextChunk) => void
  onToolUpdate?: (update: AcpToolUpdate) => void
  onPlanUpdate?: (entries: AcpPlanEntry[]) => void
}

export interface AcpResult {
  output: string
  events: AcpEvent[]
  stopReason?: string
  streamedAssistantText: boolean
}

export interface AcpAgentProbeOptions {
  sessionName?: string
  timeoutMs?: number
}

interface AcpxProcessControl {
  cancel: () => Promise<void>
}

interface AcpxExecution<T> extends AcpxProcessControl {
  promise: Promise<T>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => extractContentText(item)).join('')
  }

  const record = asRecord(content)
  if (!record) return ''

  if (typeof record.text === 'string') return record.text
  if (typeof record.thinking === 'string') return record.thinking

  const resource = asRecord(record.resource)
  if (resource && typeof resource.text === 'string') return resource.text

  return ''
}

function extractToolLocations(value: unknown): Array<{ path: string; line?: number }> | undefined {
  if (!Array.isArray(value)) return undefined

  const locations = value.flatMap((item) => {
    const record = asRecord(item)
    if (!record) return []
    const path = asString(record.path)
    if (!path) return []

    const line = typeof record.line === 'number' && Number.isFinite(record.line)
      ? record.line
      : undefined

    return [{ path, ...(line != null ? { line } : {}) }]
  })

  return locations.length > 0 ? locations : undefined
}

function extractPlanEntries(value: unknown): AcpPlanEntry[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    const record = asRecord(item)
    const content = asString(record?.content)
    if (!content) return []

    return [{
      content,
      ...(asString(record?.status) ? { status: asString(record?.status) } : {}),
      ...(asString(record?.priority) ? { priority: asString(record?.priority) } : {}),
    }]
  })
}

function normalizeLegacyEvent(record: Record<string, unknown>): AcpEvent | null {
  const rawType = asString(record.type)
  if (!rawType) return null

  const mappedType = rawType === 'thinking' ? 'agent_thought_chunk' : rawType
  return {
    ...record,
    type: mappedType,
    ...(asString(record.sessionId) ? { sessionId: asString(record.sessionId) } : {}),
    ...(asString(record.requestId) ? { requestId: asString(record.requestId) } : {}),
    ...(typeof record.seq === 'number' ? { seq: record.seq } : {}),
  }
}

function normalizeJsonRpcEvent(record: Record<string, unknown>): AcpEvent | null {
  if (record.method === 'session/update') {
    const params = asRecord(record.params)
    if (!params) return null

    const explicitUpdate = asRecord(params.update)
    const fallbackUpdate = asString(params.sessionUpdate)
      ? {
        ...params,
        sessionUpdate: params.sessionUpdate,
      }
      : null
    const update = explicitUpdate ?? fallbackUpdate
    if (!update) return null

    const type = asString(update.sessionUpdate)
    if (!type) return null

    const normalized: AcpEvent = {
      type,
      ...(asString(params.sessionId) ? { sessionId: asString(params.sessionId) } : {}),
    }

    for (const [key, value] of Object.entries(update)) {
      if (key === 'sessionUpdate') continue
      normalized[key] = value
    }

    return normalized
  }

  if (record.result) {
    const result = asRecord(record.result)
    if (!result) return null
    return {
      type: 'result',
      ...(asString(record.id) ? { requestId: asString(record.id) } : {}),
      ...result,
    }
  }

  if (record.error) {
    return {
      type: 'error',
      ...(asString(record.id) ? { requestId: asString(record.id) } : {}),
      error: record.error,
    }
  }

  return null
}

function parseAcpLine(line: string): { event: AcpEvent | null; isJson: boolean } {
  const trimmed = line.trim()
  if (!trimmed) return { event: null, isJson: false }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { event: null, isJson: false }
  }

  const record = asRecord(parsed)
  if (!record) return { event: null, isJson: true }

  if (record.jsonrpc === '2.0') {
    return { event: normalizeJsonRpcEvent(record), isJson: true }
  }

  return { event: normalizeLegacyEvent(record), isJson: true }
}

function supportsJsonStreamingFallback(stderr: string): boolean {
  return /unknown option|unknown argument|unexpected argument|invalid value|--format|--json-strict/i.test(stderr)
}

function isCliTranscriptHeader(line: string): boolean {
  return /^\[(acpx|client|tool|done|error|warning)\](?:\s|$)/i.test(line)
}

function extractFinalReplyFromTranscript(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return ''

  const lines = trimmed.replace(/\r\n/g, '\n').split('\n')
  const textBlocks: string[] = []
  let currentBlock: string[] = []
  let skippingTranscriptDetails = false

  const flushBlock = () => {
    const block = currentBlock.join('\n').trim()
    if (block) textBlocks.push(block)
    currentBlock = []
  }

  for (const line of lines) {
    if (isCliTranscriptHeader(line)) {
      flushBlock()
      skippingTranscriptDetails = true
      continue
    }

    if (skippingTranscriptDetails) {
      if (!line || /^[ \t]+/.test(line)) {
        continue
      }
      skippingTranscriptDetails = false
    }

    currentBlock.push(line)
  }

  flushBlock()
  return textBlocks.at(-1) ?? ''
}

function sanitizePromptOutput(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  if (!trimmed.split(/\r?\n/).some((line) => isCliTranscriptHeader(line))) {
    return trimmed
  }
  return extractFinalReplyFromTranscript(trimmed)
}

const AUTHENTICATION_FAILURE_LINE = /^Authentication (?:required|failed)(?:\. Please use \/login command to sign in to your account\.?)?$/i

function findAuthenticationFailureLine(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((line) => line
        .replace(/\u001b\[[0-9;]*m/g, '')
        .trim()
        .replace(/^(?:(?:\[(?:error|warning|acpx|client)\]|error:|stderr:)\s*)+/i, '')
        .trim())
      .find((line) => AUTHENTICATION_FAILURE_LINE.test(line))
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findAuthenticationFailureLine(item)
      if (match) return match
    }
    return undefined
  }

  const record = asRecord(value)
  if (!record) return undefined
  for (const item of Object.values(record)) {
    const match = findAuthenticationFailureLine(item)
    if (match) return match
  }
  return undefined
}

function throwIfAuthenticationFailure(...values: unknown[]): void {
  const failure = findAuthenticationFailureLine(values)
  if (failure) throw new Error(failure)
}

/**
 * Wrapper around acpx CLI.
 * Invokes acpx as a subprocess and parses NDJSON output.
 */
export class AcpxClient {
  private cwd: string
  private activeProcesses = new Set<ChildProcessWithoutNullStreams>()

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd()
  }

  private isRawAgentCommand(agent: string): boolean {
    return /\s/.test(agent.trim())
  }

  private buildAcpxArgs(agent: string, args: string[], globalArgs: string[] = []): string[] {
    if (this.isRawAgentCommand(agent)) {
      return ['--approve-all', '--cwd', this.cwd, ...globalArgs, '--agent', agent, ...args]
    }
    return ['--approve-all', '--cwd', this.cwd, ...globalArgs, agent, ...args]
  }

  private formatArgForLog(arg: string): string {
    const normalized = arg.replace(/\s+/g, ' ').trim()
    if (normalized.length <= 160) return normalized
    return `${normalized.slice(0, 157)}...`
  }

  private formatFailedCommand(agent: string, args: string[], globalArgs: string[] = []): string {
    return ['acpx', ...this.buildAcpxArgs(agent, args, globalArgs)]
      .map((arg) => this.formatArgForLog(arg))
      .join(' ')
  }

  private acpxEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    const registry = env.npm_config_registry || env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org/'
    const cache = env.npm_config_cache || env.NPM_CONFIG_CACHE || `${tmpdir()}/aamp-acpx-npm-cache`

    for (const key of Object.keys(env)) {
      const lower = key.toLowerCase()
      if (
        lower.startsWith('npm_config_')
        || lower.startsWith('npm_package_')
        || lower.startsWith('npm_lifecycle_')
        || lower === 'npm_command'
        || lower === 'npm_execpath'
        || lower === 'npm_node_execpath'
        || lower === 'init_cwd'
      ) {
        delete env[key]
      }
    }

    mkdirSync(cache, { recursive: true })
    env.PATH = [
      join(this.cwd, 'node_modules', '.bin'),
      process.env.PATH ?? '',
    ].filter(Boolean).join(delimiter)
    env.npm_config_registry = registry
    env.NPM_CONFIG_REGISTRY = registry
    env.npm_config_cache = cache
    env.NPM_CONFIG_CACHE = cache
    return env
  }

  private spawnAcpx(args: string[]): ChildProcessWithoutNullStreams {
    return spawn('acpx', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: this.acpxEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
  }

  private spawnNpxAcpx(args: string[]): ChildProcessWithoutNullStreams {
    return spawn('npx', ['-y', 'acpx', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: this.acpxEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
  }

  private isSpawnNotFoundError(err: unknown): boolean {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }

  private runAcpx(
    args: string[],
    handlers: {
      onStdout?: (chunk: Buffer) => void
      onStderr?: (chunk: Buffer) => void
      onClose: (code: number | null) => void
      onError: (err: Error) => void
    },
  ): AcpxProcessControl {
    let startedFallback = false
    let settled = false
    let cancelled = false
    const ownedProcesses = new Set<ChildProcessWithoutNullStreams>()
    const forcedKillTimers = new Map<ChildProcessWithoutNullStreams, NodeJS.Timeout>()
    let resolveExited: (() => void) | undefined
    const exited = new Promise<void>((resolve) => { resolveExited = resolve })
    const resolveExitedIfComplete = () => {
      if (settled && ownedProcesses.size === 0) resolveExited?.()
    }

    const attach = (proc: ChildProcessWithoutNullStreams) => {
      ownedProcesses.add(proc)
      this.activeProcesses.add(proc)
      const forgetProcess = () => {
        const forcedKillTimer = forcedKillTimers.get(proc)
        if (forcedKillTimer) clearTimeout(forcedKillTimer)
        forcedKillTimers.delete(proc)
        ownedProcesses.delete(proc)
        this.activeProcesses.delete(proc)
      }
      proc.stdout.on('data', (chunk: Buffer) => handlers.onStdout?.(chunk))
      proc.stderr.on('data', (chunk: Buffer) => handlers.onStderr?.(chunk))
      proc.on('close', (code) => {
        forgetProcess()
        if (settled) {
          resolveExitedIfComplete()
          return
        }
        settled = true
        handlers.onClose(code)
        resolveExitedIfComplete()
      })
      proc.on('error', (err) => {
        forgetProcess()
        if (!cancelled && !startedFallback && this.isSpawnNotFoundError(err)) {
          startedFallback = true
          attach(this.spawnNpxAcpx(args))
          return
        }
        if (settled) {
          resolveExitedIfComplete()
          return
        }
        settled = true
        handlers.onError(err)
        resolveExitedIfComplete()
      })
    }

    attach(this.spawnAcpx(args))
    return {
      cancel: async () => {
        if (!cancelled) {
          cancelled = true
          for (const proc of [...ownedProcesses]) {
            this.terminateProcessTree(proc, 'SIGTERM')
            const forcedKillTimer = setTimeout(() => {
              if (ownedProcesses.has(proc)) this.terminateProcessTree(proc, 'SIGKILL')
            }, 1_000)
            forcedKillTimer.unref()
            forcedKillTimers.set(proc, forcedKillTimer)
          }
        }

        resolveExitedIfComplete()
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ])
      },
    }
  }

  stop(): void {
    for (const proc of [...this.activeProcesses]) {
      this.terminateProcessTree(proc)
    }
    this.activeProcesses.clear()
  }

  private terminateProcessTree(
    proc: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals = 'SIGTERM',
  ): void {
    const pid = proc.pid
    if (!pid) return

    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, signal)
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return
      }
    }

    try {
      proc.kill(signal)
    } catch { /* best-effort cleanup */ }
  }

  private formatProcessFailure(
    agent: string,
    args: string[],
    code: number | null,
    stdout: string,
    stderr: string,
    globalArgs: string[] = [],
  ): string {
    const details = [
      stderr.trim() ? `stderr: ${stderr.trim()}` : '',
      stdout.trim() ? `stdout: ${stdout.trim()}` : '',
    ].filter(Boolean)

    return `${this.formatFailedCommand(agent, args, globalArgs)} failed (${code ?? 'unknown'}): ${
      details.join('\n') || 'no output from acpx'
    }`
  }

  /**
   * Ensure a named ACP session exists for the given agent.
   */
  async ensureSession(agent: string, sessionName: string): Promise<string> {
    const result = await this.exec(agent, ['sessions', 'ensure', '--name', sessionName])
    // Try to extract sessionId from the JSON output
    try {
      const data = JSON.parse(result.trim().split('\n').pop() ?? '{}')
      return data.sessionId ?? sessionName
    } catch {
      return sessionName
    }
  }

  /**
   * Start and immediately close a fresh ACP session to verify that the agent
   * can initialize now. Unlike `sessions ensure`, this cannot be satisfied by
   * a stale local acpx session record.
   */
  async probeAgent(agent: string, options: AcpAgentProbeOptions = {}): Promise<void> {
    const sessionName = options.sessionName
      ?? `aamp-readiness-${Date.now()}-${randomUUID().slice(0, 8)}`
    const timeoutMs = options.timeoutMs ?? 15_000

    try {
      await this.execWithTimeout(
        agent,
        ['sessions', 'new', '--name', sessionName],
        timeoutMs,
        `ACP readiness probe timed out after ${timeoutMs}ms`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/^ACP readiness probe timed out after \d+ms$/.test(message)) {
        try {
          await this.execWithTimeout(
            agent,
            ['sessions', 'close', sessionName],
            Math.min(timeoutMs, 5_000),
            'ACP readiness probe timeout cleanup also timed out',
          )
        } catch { /* preserve the original readiness timeout */ }
      }
      throw err
    }

    let cleanupError: unknown
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.execWithTimeout(
          agent,
          ['sessions', 'close', sessionName],
          timeoutMs,
          `ACP readiness probe cleanup timed out after ${timeoutMs}ms`,
        )
        cleanupError = undefined
        break
      } catch (err) {
        cleanupError = err
      }
    }

    if (cleanupError) {
      throw new Error('ACP readiness probe could not close its temporary session', {
        cause: cleanupError,
      })
    }
  }

  /**
   * Send a prompt to an ACP agent and wait for completion.
   * Collects all stdout + stderr output and extracts the agent's response.
   */
  async prompt(
    agent: string,
    sessionName: string,
    text: string,
    handlers?: AcpPromptHandlers,
  ): Promise<AcpResult> {
    try {
      return await this.promptJsonMode(agent, sessionName, text, handlers)
    } catch (err) {
      if (supportsJsonStreamingFallback((err as Error).message)) {
        return await this.promptTextMode(agent, sessionName, text)
      }
      throw err
    }
  }

  private async promptJsonMode(
    agent: string,
    sessionName: string,
    text: string,
    handlers?: AcpPromptHandlers,
  ): Promise<AcpResult> {
    const events: AcpEvent[] = []
    let stopReason: string | undefined
    let streamedAssistantText = false
    const assistantMessages = new Map<string, string>()
    const assistantMessageOrder: string[] = []
    let lastAssistantMessageKey: string | undefined
    let lastThoughtMessageKey: string | undefined
    let thoughtMessageCount = 0
    let previousEventType: string | undefined

    return new Promise<AcpResult>((resolve, reject) => {
      const acpxArgs = this.buildAcpxArgs(agent, [
        'prompt',
        '-s', sessionName,
        text,
      ], ['--format', 'json', '--json-strict'])

      let stdoutBuffer = ''
      let rawStdout = ''
      let stderr = ''

      const processLine = (line: string) => {
        const parsed = parseAcpLine(line)
        const event = parsed.event
        if (!event) {
          if (!parsed.isJson) {
            rawStdout += `${line}\n`
          }
          return
        }

        events.push(event)
        handlers?.onEvent?.(event)

        if (event.type === 'agent_message_chunk') {
          const textChunk = extractContentText(event.content)
          if (textChunk) {
            const explicitMessageId = asString(event.messageId)
            const messageKey = explicitMessageId
              ?? (previousEventType === 'agent_message_chunk' && lastAssistantMessageKey
                ? lastAssistantMessageKey
                : `anonymous:${assistantMessageOrder.length}`)

            if (!assistantMessages.has(messageKey)) {
              assistantMessages.set(messageKey, '')
              assistantMessageOrder.push(messageKey)
            }

            assistantMessages.set(messageKey, `${assistantMessages.get(messageKey) ?? ''}${textChunk}`)
            lastAssistantMessageKey = messageKey
            streamedAssistantText = true
            handlers?.onTextChunk?.({
              channel: 'assistant',
              text: textChunk,
              messageId: messageKey,
            })
          }
          previousEventType = event.type
          return
        }

        if (event.type === 'agent_thought_chunk') {
          const textChunk = extractContentText(event.content)
          if (textChunk) {
            const messageId = asString(event.messageId)
              ?? (previousEventType === 'agent_thought_chunk' && lastThoughtMessageKey
                ? lastThoughtMessageKey
                : `anonymous-thought:${thoughtMessageCount++}`)
            lastThoughtMessageKey = messageId
            handlers?.onTextChunk?.({
              channel: 'thought',
              text: textChunk,
              messageId,
            })
          }
          previousEventType = event.type
          return
        }

        if (event.type === 'tool_call' || event.type === 'tool_call_update') {
          handlers?.onToolUpdate?.({
            toolCallId: asString(event.toolCallId),
            title: asString(event.title),
            status: asString(event.status),
            kind: asString(event.kind),
            text: extractContentText(event.content),
            locations: extractToolLocations(event.locations),
          })
          previousEventType = event.type
          return
        }

        if (event.type === 'plan') {
          const entries = extractPlanEntries(event.entries)
          if (entries.length > 0) {
            handlers?.onPlanUpdate?.(entries)
          }
          previousEventType = event.type
          return
        }

        if (event.type === 'result') {
          stopReason = asString(event.stopReason)
        }

        previousEventType = event.type
      }

      const processStdoutChunk = (chunk: Buffer) => {
        stdoutBuffer += chunk.toString()

        let newlineIndex = stdoutBuffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '')
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
          processLine(line)
          newlineIndex = stdoutBuffer.indexOf('\n')
        }
      }

      this.runAcpx(acpxArgs, {
        onStdout: processStdoutChunk,
        onStderr: (chunk: Buffer) => { stderr += chunk.toString() },
        onClose: (code) => {
          if (stdoutBuffer.trim()) {
            processLine(stdoutBuffer.replace(/\r$/, ''))
          }

          const finalAssistantOutput = [...assistantMessageOrder]
            .reverse()
            .map((messageKey) => assistantMessages.get(messageKey)?.trim() ?? '')
            .find((message) => message.length > 0) ?? ''
          const output = finalAssistantOutput
            || sanitizePromptOutput(rawStdout)
            || sanitizePromptOutput(stderr)

          try {
            throwIfAuthenticationFailure(
              finalAssistantOutput,
              rawStdout,
              stderr,
              events.filter((event) => event.type === 'error').map((event) => event.error),
            )
          } catch (err) {
            reject(err)
            return
          }

          if (code !== 0 && !output) {
            reject(new Error(this.formatProcessFailure(
              agent,
              ['prompt', '-s', sessionName, text],
              code,
              rawStdout,
              stderr,
              ['--format', 'json', '--json-strict'],
            )))
          } else {
            resolve({
              output,
              events,
              ...(stopReason ? { stopReason } : {}),
              streamedAssistantText,
            })
          }
        },
        onError: (err) => {
          reject(new Error(`Failed to spawn acpx or npx acpx: ${err.message}. Is Node/npm available?`))
        },
      })
    })
  }

  private async promptTextMode(agent: string, sessionName: string, text: string): Promise<AcpResult> {
    const events: AcpEvent[] = []

    return await new Promise<AcpResult>((resolve, reject) => {
      // Old acpx builds may not support JSON output yet.
      const acpxArgs = this.buildAcpxArgs(agent, ['prompt', '-s', sessionName, text])

      let stdout = ''
      let stderr = ''

      this.runAcpx(acpxArgs, {
        onStdout: (chunk: Buffer) => { stdout += chunk.toString() },
        onStderr: (chunk: Buffer) => { stderr += chunk.toString() },
        onClose: (code) => {
          const output = sanitizePromptOutput(stdout) || sanitizePromptOutput(stderr)

          try {
            throwIfAuthenticationFailure(stdout, stderr)
          } catch (err) {
            reject(err)
            return
          }

          if (code !== 0 && !output) {
            reject(new Error(this.formatProcessFailure(
              agent,
              ['prompt', '-s', sessionName, text],
              code,
              stdout,
              stderr,
            )))
          } else {
            resolve({
              output,
              events,
              streamedAssistantText: false,
            })
          }
        },
        onError: (err) => {
          reject(new Error(`Failed to spawn acpx or npx acpx: ${err.message}. Is Node/npm available?`))
        },
      })
    })
  }

  /**
   * Cancel the current operation in a session.
   */
  async cancel(agent: string, sessionName: string): Promise<void> {
    await this.exec(agent, ['cancel', '-s', sessionName])
  }

  /**
   * Close a session.
   */
  async close(agent: string, sessionName: string): Promise<void> {
    await this.exec(agent, ['sessions', 'close', sessionName])
  }

  /**
   * Execute an acpx command and return stdout.
   */
  private exec(agent: string, args: string[]): Promise<string> {
    return this.startExec(agent, args).promise
  }

  private startExec(agent: string, args: string[]): AcpxExecution<string> {
    let processControl: AcpxProcessControl | undefined
    const promise = new Promise<string>((resolve, reject) => {
      const acpxArgs = this.buildAcpxArgs(agent, args)

      let stdout = ''
      let stderr = ''

      processControl = this.runAcpx(acpxArgs, {
        onStdout: (chunk: Buffer) => { stdout += chunk.toString() },
        onStderr: (chunk: Buffer) => { stderr += chunk.toString() },
        onClose: (code) => {
          if (code !== 0) reject(new Error(this.formatProcessFailure(agent, args, code, stdout, stderr)))
          else resolve(stdout)
        },
        onError: (err) => {
          reject(new Error(`Failed to spawn acpx or npx acpx: ${err.message}`))
        },
      })
    })

    return {
      promise,
      cancel: async () => { await processControl?.cancel() },
    }
  }

  private async execWithTimeout(
    agent: string,
    args: string[],
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<string> {
    const execution = this.startExec(agent, args)
    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        void execution.cancel().finally(() => reject(new Error(timeoutMessage)))
      }, timeoutMs)

      execution.promise.then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve(value)
        },
        (err) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          reject(err)
        },
      )
    })
  }
}
