import type { BridgeConfig } from './config.js'
import { AgentBridge } from './agent-bridge.js'

export interface BridgeStartOptions {
  quiet?: boolean
  onEvent?: (event: BridgeRuntimeEvent) => void
  debug?: boolean
}

export type BridgeRuntimeEvent =
  | { type: 'bridge.starting'; bridge: 'acp-bridge'; aampHost: string; agentCount: number }
  | { type: 'bridge.running'; bridge: 'acp-bridge'; agentCount: number; agents: Array<{ name: string; email: string }> }
  | { type: 'bridge.stopped'; bridge: 'acp-bridge' }
  | { type: 'agent.starting'; bridge: 'acp-bridge'; agent: string }
  | { type: 'agent.started'; bridge: 'acp-bridge'; agent: string; email: string; connected: boolean; pollingFallback: boolean }
  | { type: 'agent.failed'; bridge: 'acp-bridge'; agent: string; message: string }
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

/**
 * Manages multiple ACP agent bridges, each with its own AAMP identity.
 */
export class AampAcpBridge {
  private agents = new Map<string, AgentBridge>()
  private config: BridgeConfig
  private onEvent: ((event: BridgeRuntimeEvent) => void) | undefined

  constructor(config: BridgeConfig) {
    this.config = config
  }

  private emit(event: BridgeRuntimeEvent): void {
    this.onEvent?.(event)
  }

  /**
   * Start all configured agents.
   */
  async start(options: BridgeStartOptions = {}): Promise<void> {
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

    for (const agentConfig of this.config.agents) {
      this.emit({ type: 'agent.starting', bridge: 'acp-bridge', agent: agentConfig.name })
      const bridge = new AgentBridge(agentConfig, this.config.aampHost, this.config.rejectUnauthorized)
      try {
        await bridge.start({
          quiet: options.quiet,
          onEvent: options.onEvent,
          debug: options.debug,
        })
        this.agents.set(agentConfig.name, bridge)
        this.emit({
          type: 'agent.started',
          bridge: 'acp-bridge',
          agent: agentConfig.name,
          email: bridge.email,
          connected: bridge.isConnected,
          pollingFallback: bridge.isUsingPollingFallback,
        })
      } catch (err) {
        this.emit({
          type: 'agent.failed',
          bridge: 'acp-bridge',
          agent: agentConfig.name,
          message: (err as Error).message,
        })
        console.error(`[${agentConfig.name}] Failed to start: ${(err as Error).message}`)
      }
    }

    if (this.agents.size === 0) {
      throw new Error('No agents started successfully')
    }

    console.log(`${options.quiet ? '' : '\n'}Bridge running with ${this.agents.size} agent(s):`)
    for (const [name, bridge] of this.agents) {
      console.log(`   ${name}: ${bridge.email}`)
    }
    this.emit({
      type: 'bridge.running',
      bridge: 'acp-bridge',
      agentCount: this.agents.size,
      agents: [...this.agents].map(([name, bridge]) => ({ name, email: bridge.email })),
    })
    if (!options.quiet) {
      console.log(`\nPress Ctrl+C to stop.\n`)
    }
  }

  /**
   * Stop all agents.
   */
  async stop(): Promise<void> {
    for (const [name, bridge] of this.agents) {
      this.emit({ type: 'agent.stopping', bridge: 'acp-bridge', agent: name })
      console.log(`[${name}] Stopping...`)
      await bridge.stop()
    }
    this.agents.clear()
    this.emit({ type: 'bridge.stopped', bridge: 'acp-bridge' })
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
