import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import {
  parseZcodeEnvelope,
  ZCodeProtocolError,
  type ZCodeErrorBody,
  type ZCodeInboundEnvelope,
  type ZCodeNotification,
  type ZCodeRequest,
  type ZCodeRequestId,
} from './protocol.js'
import { redactForLog } from './translator.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 32 * 1024
const GRACEFUL_CLOSE_MS = 250
const FORCE_CLOSE_MS = 500

export interface ZCodeRpcClientOptions {
  cliPath: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  maxFrameBytes?: number
  maxStderrBytes?: number
  logger?: (message: string) => void
}

export interface ZCodeInboundRequestContext {
  method: string
  params: unknown
  respond: (result: unknown) => Promise<void>
  reject: (error: ZCodeErrorBody) => Promise<void>
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class ZCodeRpcError extends Error {
  override readonly name = 'ZCodeRpcError'
  readonly code: number
  readonly data?: unknown
  readonly method: string

  constructor(method: string, error: ZCodeErrorBody) {
    super(`ZCode request ${method} failed: ${error.message}`)
    this.method = method
    this.code = error.code
    this.data = error.data
  }
}

export class ZCodeRequestTimeoutError extends Error {
  override readonly name = 'ZCodeRequestTimeoutError'

  constructor(method: string, timeoutMs: number) {
    super(`ZCode request ${method} timed out after ${timeoutMs}ms`)
  }
}

export class ZCodeChildExitedError extends Error {
  override readonly name = 'ZCodeChildExitedError'
}

export class ZCodeTransportClosedError extends Error {
  override readonly name = 'ZCodeTransportClosedError'
}

type TransportState = 'idle' | 'running' | 'closing' | 'closed' | 'failed'

function redactStderr(value: string): string {
  return value.split('\n').map((line) => {
    try {
      return JSON.stringify(redactForLog(JSON.parse(line)))
    } catch {
      return line
        .replace(
          /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s]+/giu,
          '$1[REDACTED]',
        )
        .replace(
          /((?:api[-_]?key|token|password|secret|cookie)\s*[:=]\s*)[^\s]+/giu,
          '$1[REDACTED]',
        )
    }
  }).join('\n')
}

function waitBounded(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) resolve(false)
    }, timeoutMs)
    timer.unref()
    promise.then(
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      },
    )
  })
}

export class ZCodeRpcClient {
  private readonly options: Required<Pick<
    ZCodeRpcClientOptions,
    'requestTimeoutMs' | 'maxFrameBytes' | 'maxStderrBytes'
  >> & ZCodeRpcClientOptions

  private state: TransportState = 'idle'
  private child?: ChildProcessWithoutNullStreams
  private childClosed = false
  private childClosedPromise: Promise<void> = Promise.resolve()
  private resolveChildClosed: (() => void) | undefined
  private stdoutFrame = Buffer.alloc(0)
  private stderrTail = Buffer.alloc(0)
  private nextRequestId = 1
  private readonly pending = new Map<ZCodeRequestId, PendingRequest>()
  private readonly notificationListeners = new Set<
    (notification: ZCodeNotification) => void
  >()
  private readonly requestListeners = new Set<
    (request: ZCodeInboundRequestContext) => void | Promise<void>
  >()
  private readonly closeListeners = new Set<(error: Error) => void>()
  private writeChain: Promise<void> = Promise.resolve()
  private closePromise?: Promise<void>

  constructor(options: ZCodeRpcClientOptions) {
    this.options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    }
  }

  async start(): Promise<void> {
    if (this.state === 'running') return
    if (this.state !== 'idle') {
      throw new ZCodeTransportClosedError('ZCode app-server transport is closed')
    }

    const child = spawn(process.execPath, [this.options.cliPath, 'app-server'], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.childClosed = false
    this.childClosedPromise = new Promise((resolve) => {
      this.resolveChildClosed = resolve
    })

    child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.handleStderr(chunk))
    child.stdin.on('error', (error) => {
      if (this.state === 'running') {
        this.failTransport(new ZCodeChildExitedError(
          `ZCode app-server stdin failed: ${error.message}`,
        ))
      }
    })
    child.once('close', (code, signal) => this.handleChildClose(code, signal))

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError)
        resolve()
      }
      const onError = (error: Error) => {
        child.off('spawn', onSpawn)
        reject(error)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    }).catch((error: Error) => {
      this.state = 'failed'
      throw new ZCodeChildExitedError(
        `Failed to start ZCode app-server: ${error.message}`,
      )
    })

    this.state = 'running'
  }

  async request<Result>(
    method: string,
    params: unknown,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<Result> {
    this.assertRunning()
    const id = `client-${this.nextRequestId}`
    this.nextRequestId += 1

    return await new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.reject(new ZCodeRequestTimeoutError(method, timeoutMs))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as Result),
        reject,
        timer,
      })

      this.enqueueWrite({ id, method, params }).catch((error: Error) => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        pending.reject(error)
      })
    })
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.assertRunning()
    await this.enqueueWrite({ method, params })
  }

  onNotification(listener: (notification: ZCodeNotification) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onRequest(
    listener: (request: ZCodeInboundRequestContext) => void | Promise<void>,
  ): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async close(): Promise<void> {
    this.closePromise ??= this.performClose()
    await this.closePromise
  }

  private assertRunning(): void {
    if (this.state !== 'running' || !this.child) {
      throw new ZCodeTransportClosedError('ZCode app-server transport is closed')
    }
  }

  private enqueueWrite(envelope: Record<string, unknown>): Promise<void> {
    const write = async () => {
      this.assertRunning()
      const child = this.child
      if (!child) {
        throw new ZCodeTransportClosedError('ZCode app-server transport is closed')
      }
      const payload = Buffer.from(`${JSON.stringify(envelope)}\n`)
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(payload, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
    const next = this.writeChain.then(write)
    this.writeChain = next.catch(() => {})
    return next
  }

  private handleStdout(chunk: Buffer): void {
    if (this.state !== 'running') return

    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline === -1 ? chunk.length : newline
      const fragment = chunk.subarray(offset, end)
      if (this.stdoutFrame.length + fragment.length > this.options.maxFrameBytes) {
        this.failTransport(new ZCodeProtocolError(
          `ZCode app-server frame exceeded ${this.options.maxFrameBytes} bytes`,
        ))
        return
      }
      if (fragment.length > 0) {
        this.stdoutFrame = this.stdoutFrame.length === 0
          ? Buffer.from(fragment)
          : Buffer.concat([this.stdoutFrame, fragment])
      }

      if (newline === -1) return

      let frame = this.stdoutFrame
      this.stdoutFrame = Buffer.alloc(0)
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1)
      if (frame.length > 0) this.handleFrame(frame)
      if (this.state !== 'running') return
      offset = newline + 1
    }
  }

  private handleFrame(frame: Buffer): void {
    let raw: unknown
    try {
      raw = JSON.parse(frame.toString('utf8'))
    } catch {
      this.failTransport(new ZCodeProtocolError(
        'Invalid JSON from ZCode app-server',
      ))
      return
    }

    let envelope: ZCodeInboundEnvelope
    try {
      envelope = parseZcodeEnvelope(raw)
    } catch (error) {
      this.failTransport(error instanceof Error
        ? error
        : new ZCodeProtocolError('Invalid ZCode Protocol envelope'))
      return
    }
    this.dispatchEnvelope(envelope)
  }

  private dispatchEnvelope(envelope: ZCodeInboundEnvelope): void {
    if ('method' in envelope) {
      if ('id' in envelope) {
        this.dispatchInboundRequest(envelope)
      } else {
        for (const listener of this.notificationListeners) {
          try {
            listener(envelope)
          } catch {
            this.options.logger?.('ZCode notification listener failed')
          }
        }
      }
      return
    }

    const pending = this.pending.get(envelope.id)
    if (!pending) return
    this.pending.delete(envelope.id)
    clearTimeout(pending.timer)
    if ('error' in envelope) {
      pending.reject(new ZCodeRpcError(pending.method, envelope.error))
    } else {
      pending.resolve(envelope.result)
    }
  }

  private dispatchInboundRequest(request: ZCodeRequest): void {
    const listener = this.requestListeners.values().next().value as
      | ((request: ZCodeInboundRequestContext) => void | Promise<void>)
      | undefined
    let answered = false
    const respond = async (result: unknown) => {
      if (answered) return
      answered = true
      await this.enqueueWrite({ id: request.id, result })
    }
    const reject = async (error: ZCodeErrorBody) => {
      if (answered) return
      answered = true
      await this.enqueueWrite({ id: request.id, error })
    }

    if (!listener) {
      void reject({
        code: -32601,
        message: `No handler for ZCode request ${request.method}`,
      })
      return
    }

    void Promise.resolve(listener({
      method: request.method,
      params: request.params,
      respond,
      reject,
    })).catch(async () => {
      if (!answered) {
        await reject({
          code: -32603,
          message: `Handler failed for ZCode request ${request.method}`,
        }).catch(() => {})
      }
    })
  }

  private handleStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.stderrTail, chunk])
    this.stderrTail = combined.length <= this.options.maxStderrBytes
      ? combined
      : combined.subarray(combined.length - this.options.maxStderrBytes)
  }

  private handleChildClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.childClosed = true
    this.resolveChildClosed?.()
    this.resolveChildClosed = undefined

    if (this.state === 'closing' || this.state === 'closed') return

    const status = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`
    const stderr = redactStderr(this.stderrTail.toString('utf8').trim())
    const suffix = stderr ? `; stderr: ${stderr}` : ''
    this.failTransport(new ZCodeChildExitedError(
      `ZCode app-server exited with ${status}${suffix}`,
    ))
  }

  private failTransport(error: Error): void {
    if (this.state === 'failed' || this.state === 'closed') return
    this.state = 'failed'
    this.rejectPending(error)
    for (const listener of this.closeListeners) {
      try {
        listener(error)
      } catch {
        this.options.logger?.('ZCode close listener failed')
      }
    }
    void this.stopChild()
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  private async performClose(): Promise<void> {
    if (this.state === 'closed') return
    if (this.state === 'idle') {
      this.state = 'closed'
      return
    }

    if (this.state !== 'failed') this.state = 'closing'
    this.rejectPending(new ZCodeTransportClosedError(
      'ZCode app-server transport closed',
    ))
    await this.stopChild()
    this.state = 'closed'
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    if (!child || this.childClosed) return

    child.stdin.end()
    if (await waitBounded(this.childClosedPromise, GRACEFUL_CLOSE_MS)) return

    this.signalChild('SIGTERM')
    if (await waitBounded(this.childClosedPromise, FORCE_CLOSE_MS)) return
    this.signalChild('SIGKILL')
    await waitBounded(this.childClosedPromise, FORCE_CLOSE_MS)
  }

  private signalChild(signal: NodeJS.Signals): void {
    const child = this.child
    if (!child?.pid || this.childClosed) return
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}
