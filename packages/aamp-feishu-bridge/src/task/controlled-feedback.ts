import type { ControlledFeedbackPaths } from './types.js'

/** These values match the proposed Task OpenAPI IDL; no route is assumed. */
export type AgentTaskCommandAction = 'START' | 'STOP'
export type AgentTaskCommandResult = 'ACCEPTED' | 'REJECTED'
export type AgentTaskExecutionState = 'RUNNING' | 'BLOCKED' | 'COMPLETED' | 'STOPPED' | 'FAILED'

export interface ControlledTaskCommandResult {
  taskGuid: string
  executionId: string
  action: AgentTaskCommandAction
  result: AgentTaskCommandResult
  reason?: string
}

export interface ControlledTaskExecutionState {
  taskGuid: string
  executionId: string
  state: AgentTaskExecutionState
  reason?: string
}

export interface ReportAgentTaskCommandResultBody {
  task_guid: string
  execution_id: string
  action: 1 | 2
  result: 1 | 2
  reason?: string
}

export interface ReportAgentTaskExecutionStateBody {
  task_guid: string
  execution_id: string
  state: 1 | 2 | 3 | 4 | 5
  reason?: string
}

/** The OpenAPI transport is supplied only after its route and auth are published. */
export interface ControlledTaskFeedbackTransport {
  reportCommandResult(body: ReportAgentTaskCommandResultBody): Promise<void>
  reportExecutionState(body: ReportAgentTaskExecutionStateBody): Promise<void>
}

/** Only relative Task OpenAPI routes may receive this app's bearer token. */
export function normalizeControlledFeedbackPaths(paths: ControlledFeedbackPaths | undefined): ControlledFeedbackPaths | undefined {
  if (!paths) return undefined
  const commandResultPath = paths.commandResultPath?.trim()
  const executionStatePath = paths.executionStatePath?.trim()
  if (!commandResultPath || !executionStatePath) {
    throw new Error('Controlled Task feedback requires both command and execution state paths')
  }
  const safePath = /^\/open-apis\/task\/v2\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/
  if (!safePath.test(commandResultPath) || !safePath.test(executionStatePath)) {
    throw new Error('Controlled Task feedback requires a relative Task OpenAPI path')
  }
  return { commandResultPath, executionStatePath }
}

const COMMAND_ACTION = { START: 1, STOP: 2 } as const
const COMMAND_RESULT = { ACCEPTED: 1, REJECTED: 2 } as const
const EXECUTION_STATE = { RUNNING: 1, BLOCKED: 2, COMPLETED: 3, STOPPED: 4, FAILED: 5 } as const

function requireControlledIdentity(taskGuid: string, executionId: string): { taskGuid: string; executionId: string } {
  const normalizedTaskGuid = taskGuid?.trim()
  const normalizedExecutionId = executionId?.trim()
  if (!normalizedTaskGuid || !normalizedExecutionId) {
    throw new Error('Controlled Task feedback requires taskGuid and executionId')
  }
  return { taskGuid: normalizedTaskGuid, executionId: normalizedExecutionId }
}

function mappedValue<T extends string, V extends number>(mapping: Record<T, V>, key: T, name: string): V {
  const value = mapping[key]
  if (!value) throw new Error(`Unsupported controlled Task ${name}`)
  return value
}

export class ControlledTaskFeedbackReporter {
  constructor(private readonly transport: ControlledTaskFeedbackTransport) {}

  async reportCommandResult(request: ControlledTaskCommandResult): Promise<void> {
    const { taskGuid, executionId } = requireControlledIdentity(request.taskGuid, request.executionId)
    await this.transport.reportCommandResult({
      task_guid: taskGuid,
      execution_id: executionId,
      action: mappedValue(COMMAND_ACTION, request.action, 'action'),
      result: mappedValue(COMMAND_RESULT, request.result, 'result'),
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
    })
  }

  async reportExecutionState(request: ControlledTaskExecutionState): Promise<void> {
    const { taskGuid, executionId } = requireControlledIdentity(request.taskGuid, request.executionId)
    await this.transport.reportExecutionState({
      task_guid: taskGuid,
      execution_id: executionId,
      state: mappedValue(EXECUTION_STATE, request.state, 'state'),
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
    })
  }
}
