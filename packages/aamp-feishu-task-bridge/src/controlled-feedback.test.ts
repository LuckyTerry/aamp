import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ControlledTaskFeedbackReporter } from './controlled-feedback.js'
import type { ControlledTaskFeedbackTransport, ReportAgentTaskCommandResultBody, ReportAgentTaskExecutionStateBody } from './controlled-feedback.js'

test('controlled Task feedback maps every command and execution state to the proposed IDL body', async () => {
  const commands: ReportAgentTaskCommandResultBody[] = []
  const states: ReportAgentTaskExecutionStateBody[] = []
  const transport: ControlledTaskFeedbackTransport = {
    async reportCommandResult(body) { commands.push(body) },
    async reportExecutionState(body) { states.push(body) },
  }
  const reporter = new ControlledTaskFeedbackReporter(transport)

  await reporter.reportCommandResult({ taskGuid: ' task_1 ', executionId: ' run_1 ', action: 'START', result: 'ACCEPTED' })
  await reporter.reportCommandResult({ taskGuid: 'task_1', executionId: 'run_1', action: 'STOP', result: 'REJECTED', reason: 'already stopped' })
  for (const state of ['RUNNING', 'BLOCKED', 'COMPLETED', 'STOPPED', 'FAILED'] as const) {
    await reporter.reportExecutionState({ taskGuid: 'task_1', executionId: 'run_1', state })
  }

  assert.deepEqual(commands, [
    { task_guid: 'task_1', execution_id: 'run_1', action: 1, result: 1 },
    { task_guid: 'task_1', execution_id: 'run_1', action: 2, result: 2, reason: 'already stopped' },
  ])
  assert.deepEqual(states.map(({ state }) => state), [1, 2, 3, 4, 5])
  assert.ok(states.every(({ task_guid, execution_id, reason }) => task_guid === 'task_1' && execution_id === 'run_1' && reason === undefined))
})

test('legacy tasks without an execution ID cannot report controlled feedback', async () => {
  let calls = 0
  const reporter = new ControlledTaskFeedbackReporter({
    async reportCommandResult() { calls += 1 },
    async reportExecutionState() { calls += 1 },
  })

  await assert.rejects(reporter.reportCommandResult({ taskGuid: 'task_1', executionId: '', action: 'START', result: 'ACCEPTED' }), /requires taskGuid and executionId/)
  await assert.rejects(reporter.reportExecutionState({ taskGuid: 'task_1', executionId: ' ', state: 'RUNNING' }), /requires taskGuid and executionId/)
  assert.equal(calls, 0)
})
