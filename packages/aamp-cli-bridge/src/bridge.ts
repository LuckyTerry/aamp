import type { BridgeConfig } from './config.js'
import { AgentBridge } from './agent-bridge.js'

export interface BridgeStartOptions {
  quiet?: boolean
  onEvent?: (event: BridgeRuntimeEvent) => void
}

export type BridgeRuntimeEvent =
  | { type: 'bridge.starting'; bridge: 'cli-bridge'; aampHost: string; agentCount: number }
  | { type: 'bridge.running'; bridge: 'cli-bridge'; agentCount: number; agents: Array<{ name: string; email: string }> }
  | { type: 'bridge.stopped'; bridge: 'cli-bridge' }
  | { type: 'agent.starting'; bridge: 'cli-bridge'; agent: string }
  | { type: 'agent.started'; bridge: 'cli-bridge'; agent: string; email: string; connected: boolean; pollingFallback: boolean }
  | { type: 'agent.failed'; bridge: 'cli-bridge'; agent: string; message: string }
  | { type: 'agent.stopping'; bridge: 'cli-bridge'; agent: string }
  | { type: 'agent.identity'; bridge: 'cli-bridge'; agent: string; email: string; profile: string }
  | { type: 'agent.connected'; bridge: 'cli-bridge'; agent: string; email: string; pollingFallback: boolean }
  | { type: 'agent.disconnected'; bridge: 'cli-bridge'; agent: string; email: string; reason: string; pollingFallback: boolean }
  | { type: 'agent.error'; bridge: 'cli-bridge'; agent: string; email: string; message: string }
  | { type: 'agent.reconciled'; bridge: 'cli-bridge'; agent: string; email: string; count: number }
  | { type: 'task.received'; bridge: 'cli-bridge'; agent: string; email: string; taskId: string; title: string; from: string }
  | { type: 'task.rejected'; bridge: 'cli-bridge'; agent: string; email: string; taskId: string; reason: string }
  | { type: 'task.completed'; bridge: 'cli-bridge'; agent: string; email: string; taskId: string; status: 'completed' | 'help_needed' | 'rejected' }
  | { type: 'pair.request'; bridge: 'cli-bridge'; agent: string; email: string; taskId: string; from: string }
  | { type: 'pair.completed'; bridge: 'cli-bridge'; agent: string; email: string; taskId: string; sender: string; success: boolean; reason?: string }

export class AampCliBridge {
  private agents = new Map<string, AgentBridge>()
  private onEvent: ((event: BridgeRuntimeEvent) => void) | undefined

  constructor(private readonly config: BridgeConfig) {}

  private emit(event: BridgeRuntimeEvent): void {
    this.onEvent?.(event)
  }

  async start(options: BridgeStartOptions = {}): Promise<void> {
    this.onEvent = options.onEvent
    this.emit({
      type: 'bridge.starting',
      bridge: 'cli-bridge',
      aampHost: this.config.aampHost,
      agentCount: this.config.agents.length,
    })
    if (!options.quiet) {
      console.log(`\nAAMP CLI Bridge`)
      console.log(`   Host: ${this.config.aampHost}`)
      console.log(`   Agents: ${this.config.agents.length}\n`)
    }

    for (const agentConfig of this.config.agents) {
      this.emit({ type: 'agent.starting', bridge: 'cli-bridge', agent: agentConfig.name })
      const bridge = new AgentBridge(
        agentConfig,
        this.config.aampHost,
        this.config.rejectUnauthorized,
        this.config.profiles,
      )
      try {
        await bridge.start({ quiet: options.quiet, onEvent: options.onEvent })
        this.agents.set(agentConfig.name, bridge)
        this.emit({
          type: 'agent.started',
          bridge: 'cli-bridge',
          agent: agentConfig.name,
          email: bridge.email,
          connected: bridge.isConnected,
          pollingFallback: bridge.isUsingPollingFallback,
        })
      } catch (err) {
        this.emit({
          type: 'agent.failed',
          bridge: 'cli-bridge',
          agent: agentConfig.name,
          message: (err as Error).message,
        })
        console.error(`[${agentConfig.name}] Failed to start: ${(err as Error).message}`)
      }
    }

    if (this.agents.size === 0) {
      throw new Error('No agents started successfully')
    }

    console.log(`${options.quiet ? '' : '\n'}CLI bridge running with ${this.agents.size} agent(s):`)
    for (const [name, bridge] of this.agents) {
      console.log(`   ${name}: ${bridge.email}`)
    }
    this.emit({
      type: 'bridge.running',
      bridge: 'cli-bridge',
      agentCount: this.agents.size,
      agents: [...this.agents].map(([name, bridge]) => ({ name, email: bridge.email })),
    })
    if (!options.quiet) {
      console.log(`\nPress Ctrl+C to stop.\n`)
    }
  }

  stop(): void {
    for (const [name, bridge] of this.agents) {
      this.emit({ type: 'agent.stopping', bridge: 'cli-bridge', agent: name })
      console.log(`[${name}] Stopping...`)
      bridge.stop()
    }
    this.agents.clear()
    this.emit({ type: 'bridge.stopped', bridge: 'cli-bridge' })
  }

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
