import { AgentBridge, type AgentBridgeStartOptions } from './agent-bridge.js'
import type { AgentConfig, BridgeConfig } from './config.js'
import { describeBridgeError, describeBridgeEventError } from './errors.js'

export interface BridgeStartOptions {
  quiet?: boolean
  onEvent?: (event: BridgeRuntimeEvent) => void
  debug?: boolean
}

export type BridgeRuntimeEvent =
  | { type: 'bridge.starting'; bridge: 'acp-bridge'; aampHost: string; agentCount: number }
  | { type: 'bridge.running'; bridge: 'acp-bridge'; agentCount: number; agents: Array<{ name: string; email: string }>; durationMs: number }
  | { type: 'bridge.stopped'; bridge: 'acp-bridge' }
  | { type: 'agent.starting'; bridge: 'acp-bridge'; agent: string }
  | { type: 'agent.started'; bridge: 'acp-bridge'; agent: string; email: string; connected: boolean; pollingFallback: boolean; durationMs: number }
  | { type: 'agent.failed'; bridge: 'acp-bridge'; agent: string; message: string; durationMs: number }
  | { type: 'agent.stopping'; bridge: 'acp-bridge'; agent: string }
  | { type: 'agent.identity'; bridge: 'acp-bridge'; agent: string; email: string; acpCommand: string }
  | { type: 'agent.connected'; bridge: 'acp-bridge'; agent: string; email: string; pollingFallback: boolean }
  | { type: 'agent.disconnected'; bridge: 'acp-bridge'; agent: string; email: string; reason: string; pollingFallback: boolean }
  | { type: 'agent.error'; bridge: 'acp-bridge'; agent: string; email: string; message: string }
  | { type: 'agent.reconciled'; bridge: 'acp-bridge'; agent: string; email: string; count: number }
  | { type: 'agent.session.ready'; bridge: 'acp-bridge'; agent: string; email: string; sessionName: string }
  | { type: 'agent.session.deferred'; bridge: 'acp-bridge'; agent: string; email: string; message: string }
  | { type: 'task.received'; bridge: 'acp-bridge'; agent: string; email: string; taskId: string; title: string; from: string }
  | { type: 'task.rejected'; bridge: 'acp-bridge'; agent: string; email: string; taskId: string; reason: string }
  | { type: 'task.completed'; bridge: 'acp-bridge'; agent: string; email: string; taskId: string; status: 'completed' | 'help_needed' | 'rejected' }
  | { type: 'pair.request'; bridge: 'acp-bridge'; agent: string; email: string; taskId: string; from: string }
  | { type: 'pair.completed'; bridge: 'acp-bridge'; agent: string; email: string; taskId: string; sender: string; success: boolean; reason?: string }

export interface AgentBridgeHandle {
  readonly email: string
  readonly isConnected: boolean
  readonly isUsingPollingFallback: boolean
  readonly isBusy: boolean
  start(options?: AgentBridgeStartOptions): Promise<void>
  stop(): Promise<void>
}

export interface AampAcpBridgeOptions {
  maxAgentConcurrency?: number
  createAgentBridge?: (
    config: AgentConfig,
    aampHost: string,
    rejectUnauthorized: boolean,
  ) => AgentBridgeHandle
  now?: () => number
}

type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<Settled<R>>> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('concurrency limit must be a positive integer')
  }
  const results = new Array<Settled<R>>(items.length)
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  const width = Math.min(items.length, limit)
  await Promise.all(Array.from({ length: width }, () => run()))
  return results
}

/**
 * Manages multiple ACP agent bridges, each with its own AAMP identity.
 */
export class AampAcpBridge {
  private agents = new Map<string, AgentBridgeHandle>()
  private config: BridgeConfig
  private onEvent: ((event: BridgeRuntimeEvent) => void) | undefined
  private maxAgentConcurrency: number
  private createAgentBridge: NonNullable<AampAcpBridgeOptions['createAgentBridge']>
  private now: () => number
  private startPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined
  private stopRequested = false

  constructor(config: BridgeConfig, options: AampAcpBridgeOptions = {}) {
    this.config = config
    this.maxAgentConcurrency = options.maxAgentConcurrency ?? 4
    this.createAgentBridge = options.createAgentBridge
      ?? ((agent, host, rejectUnauthorized) => new AgentBridge(agent, host, rejectUnauthorized))
    this.now = options.now ?? Date.now
  }

  private emit(event: BridgeRuntimeEvent): void {
    this.onEvent?.(event)
  }

  private timestamp(): number {
    const timestamp = this.now()
    return Number.isFinite(timestamp) ? timestamp : 0
  }

  private durationSince(startedAt: number): number {
    return Math.max(0, this.timestamp() - startedAt)
  }

  /**
   * Start all configured agents.
   */
  async start(options: BridgeStartOptions = {}): Promise<void> {
    if (this.stopPromise) throw new Error('Bridge is stopping')
    if (this.startPromise) return this.startPromise
    this.stopRequested = false
    const startPromise = this.startConfiguredAgents(options)
    this.startPromise = startPromise
    try {
      await startPromise
    } catch (error) {
      await this.requestStop().catch(() => {})
      throw error
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined
    }
  }

  private async startConfiguredAgents(options: BridgeStartOptions): Promise<void> {
    this.onEvent = options.onEvent
    this.emit({
      type: 'bridge.starting',
      bridge: 'acp-bridge',
      aampHost: this.config.aampHost,
      agentCount: this.config.agents.length,
    })
    if (!options.quiet) {
      console.log(`\nAAMP ACP Bridge`)
      console.log(`   Host: ${this.config.aampHost}`)
      console.log(`   Agents: ${this.config.agents.length}\n`)
    }

    const startedAt = this.timestamp()
    const results = await settleWithConcurrency(this.config.agents, this.maxAgentConcurrency, async (agentConfig) => {
      const agentStartedAt = this.timestamp()
      let bridge: AgentBridgeHandle | undefined
      let callbackError: unknown | undefined
      try {
        try {
          this.emit({ type: 'agent.starting', bridge: 'acp-bridge', agent: agentConfig.name })
        } catch (error) {
          callbackError = error
          throw error
        }
        bridge = this.createAgentBridge(
          agentConfig,
          this.config.aampHost,
          this.config.rejectUnauthorized,
        )
        await bridge.start({ quiet: options.quiet, onEvent: options.onEvent, debug: options.debug })
        this.agents.set(agentConfig.name, bridge)
        try {
          this.emit({
            type: 'agent.started',
            bridge: 'acp-bridge',
            agent: agentConfig.name,
            email: bridge.email,
            connected: bridge.isConnected,
            pollingFallback: bridge.isUsingPollingFallback,
            durationMs: this.durationSince(agentStartedAt),
          })
        } catch (error) {
          callbackError = error
          throw error
        }
      } catch (error) {
        this.agents.delete(agentConfig.name)
        if (bridge) {
          await bridge.stop().catch((cleanupError) => {
            console.warn(`[${agentConfig.name}] Failed to clean up after startup: ${describeBridgeError(cleanupError)}`)
          })
        }
        console.error(`[${agentConfig.name}] Failed to start: ${describeBridgeError(error)}`)
        this.emit({
          type: 'agent.failed',
          bridge: 'acp-bridge',
          agent: agentConfig.name,
          message: describeBridgeEventError(error),
          durationMs: this.durationSince(agentStartedAt),
        })
        if (callbackError !== undefined) throw callbackError
      }
    })

    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    if (this.stopRequested) return

    if (this.agents.size === 0) {
      throw new Error('No agents started successfully')
    }

    const orderedEntries = this.config.agents.flatMap(({ name }) => {
      const bridge = this.agents.get(name)
      return bridge ? [[name, bridge] as const] : []
    })
    this.agents = new Map(orderedEntries)
    const orderedAgents = orderedEntries.map(([name, bridge]) => ({ name, email: bridge.email }))
    console.log(`${options.quiet ? '' : '\n'}Bridge running with ${orderedAgents.length} agent(s):`)
    for (const { name, email } of orderedAgents) {
      console.log(`   ${name}: ${email}`)
    }
    this.emit({
      type: 'bridge.running',
      bridge: 'acp-bridge',
      agentCount: orderedAgents.length,
      agents: orderedAgents,
      durationMs: this.durationSince(startedAt),
    })
    if (!options.quiet) {
      console.log(`\nPress Ctrl+C to stop.\n`)
    }
  }

  /**
   * Stop all agents.
   */
  async stop(): Promise<void> {
    await this.requestStop()
  }

  private requestStop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopRequested = true
    const stopPromise = this.stopConfiguredAgents()
    this.stopPromise = stopPromise
    void stopPromise.then(
      () => {
        if (this.stopPromise === stopPromise) this.stopPromise = undefined
      },
      () => {
        if (this.stopPromise === stopPromise) this.stopPromise = undefined
      },
    )
    return stopPromise
  }

  private async stopConfiguredAgents(): Promise<void> {
    const starting = this.startPromise
    if (starting) await starting.catch(() => {})
    const entries = [...this.agents.entries()]
    const results = await settleWithConcurrency(entries, this.maxAgentConcurrency, async ([name, bridge]) => {
      let callbackError: unknown | undefined
      try {
        this.emit({ type: 'agent.stopping', bridge: 'acp-bridge', agent: name })
      } catch (error) {
        callbackError = error
      }
      console.log(`[${name}] Stopping...`)
      try {
        await bridge.stop()
      } catch (error) {
        console.warn(`[${name}] Failed to stop cleanly: ${describeBridgeError(error)}`)
      }
      if (callbackError !== undefined) throw callbackError
    })
    this.agents.clear()
    const rejected = results.find((result) => result.status === 'rejected')
    let callbackError = rejected?.status === 'rejected' ? rejected.reason : undefined
    try {
      this.emit({ type: 'bridge.stopped', bridge: 'acp-bridge' })
    } catch (error) {
      callbackError ??= error
    }
    if (callbackError !== undefined) throw callbackError
  }

  /**
   * List all agents and their status.
   */
  list(): void {
    if (this.agents.size === 0) {
      console.log('No agents running.')
      return
    }
    console.log(`\nAgents (${this.agents.size}):`)
    for (const [name, bridge] of this.agents) {
      const status = bridge.isConnected
        ? (bridge.isUsingPollingFallback ? 'connected (polling fallback)' : 'connected')
        : 'disconnected'
      const busy = bridge.isBusy ? ' (processing)' : ''
      console.log(`  ${name}: ${bridge.email} -- ${status}${busy}`)
    }
    console.log()
  }
}
