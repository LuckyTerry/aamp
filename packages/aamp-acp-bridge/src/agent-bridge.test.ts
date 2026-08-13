import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AgentBridge,
  formatDebugPromptLog,
  formatAgentReadinessError,
  formatTaskAgentError,
  requiresStartupReadinessProbe,
  resolveTaskSessionKey,
  stripAampInternalDispatchContext,
  threadAlreadyTerminal,
} from './agent-bridge.js'

test('formatDebugPromptLog prints metadata and the full prompt body', () => {
  const prompt = [
    '## AAMP Task',
    '',
    'Execution rules:',
    '- Use the requested runtime.',
  ].join('\n')

  const log = formatDebugPromptLog({
    agentName: 'codex',
    taskId: 'task-123',
    sessionName: 'feishu-task:task-123',
    prompt,
  })

  assert.match(log, /^\[codex\] ACP prompt debug task=task-123 session=feishu-task:task-123\n/)
  assert.match(log, /--- BEGIN ACP PROMPT ---\n## AAMP Task/)
  assert.match(log, /Execution rules:\n- Use the requested runtime\./)
  assert.match(log, /\n--- END ACP PROMPT ---$/)
})

test('threadAlreadyTerminal treats help-needed threads as closed for historical reconcile', () => {
  assert.equal(threadAlreadyTerminal([
    {
      intent: 'task.help_needed',
      from: 'agent@meshmail.ai',
      to: 'bridge@meshmail.ai',
      createdAt: '2026-07-06T00:00:00.000Z',
    },
  ]), true)
})

test('resolveTaskSessionKey falls back to dispatch context compatibility field', () => {
  assert.equal(resolveTaskSessionKey({
    dispatchContext: {
      source: 'feishu-task',
      aamp_session_key: 'feishu-task:task-guid-123',
    },
  }), 'feishu-task:task-guid-123')
  assert.equal(resolveTaskSessionKey({
    sessionKey: 'feishu-task:canonical-guid',
    dispatchContext: {
      source: 'feishu-task',
      aamp_session_key: 'feishu-task:shadow-guid',
    },
  }), 'feishu-task:canonical-guid')
})

test('stripAampInternalDispatchContext removes session compatibility field without mutating task', () => {
  const task = {
    dispatchContext: {
      source: 'feishu-task',
      aamp_session_key: 'feishu-task:task-guid-123',
    },
  }

  const stripped = stripAampInternalDispatchContext(task)

  assert.deepEqual(stripped.dispatchContext, { source: 'feishu-task' })
  assert.deepEqual(task.dispatchContext, {
    source: 'feishu-task',
    aamp_session_key: 'feishu-task:task-guid-123',
  })
})

test('both WorkBuddy products require the startup ACP readiness probe', () => {
  assert.equal(requiresStartupReadinessProbe({ name: 'workbuddy' }), true)
  assert.equal(requiresStartupReadinessProbe({ name: 'workbuddy_ai' }), true)
  assert.equal(requiresStartupReadinessProbe({ name: 'traex' }), false)
  assert.equal(requiresStartupReadinessProbe({ name: 'codex' }), false)
})

test('WorkBuddy authentication failures have actionable startup and task messages', () => {
  const failure = new Error('acpx failed (1): stderr: Authentication required')

  assert.equal(
    formatAgentReadinessError('workbuddy', failure),
    'WorkBuddy is not logged in. Open WorkBuddy and sign in, then retry.',
  )
  assert.equal(
    formatTaskAgentError('workbuddy', failure),
    'WorkBuddy login expired. Open WorkBuddy and sign in, then retry the task.',
  )
})

test('WorkBuddy AI authentication failures name the international app', () => {
  const failure = new Error('acpx failed (1): stderr: Authentication required')
  assert.equal(
    formatAgentReadinessError('workbuddy_ai', failure),
    'WorkBuddy AI is not logged in. Open WorkBuddy AI and sign in, then retry.',
  )
  assert.equal(
    formatTaskAgentError('workbuddy_ai', failure),
    'WorkBuddy AI login expired. Open WorkBuddy AI and sign in, then retry the task.',
  )
  assert.equal(
    formatAgentReadinessError('workbuddy_ai', new Error('ACP readiness probe timed out after 15000ms')),
    'WorkBuddy AI ACP readiness check failed: ACP readiness probe timed out after 15000ms',
  )
})

test('other readiness failures retain their diagnostic details', () => {
  assert.equal(
    formatAgentReadinessError('workbuddy', new Error('ACP readiness probe timed out after 15000ms')),
    'WorkBuddy ACP readiness check failed: ACP readiness probe timed out after 15000ms',
  )
  assert.equal(
    formatTaskAgentError('traex', new Error('transport closed')),
    'transport closed',
  )
})

test('WorkBuddy readiness failure aborts startup before AAMP identity resolution', async () => {
  const bridge = new AgentBridge({
    name: 'workbuddy',
    acpCommand: 'fake-codebuddy --acp',
    credentialsFile: '/path/that/must/not/be/read.json',
  }, 'https://meshmail.ai', false)
  ;(bridge as unknown as { acpx: { probeAgent: () => Promise<void> } }).acpx = {
    probeAgent: async () => {
      throw new Error('Authentication required')
    },
  }

  await assert.rejects(
    bridge.start({ quiet: true }),
    /WorkBuddy is not logged in\. Open WorkBuddy and sign in, then retry\./,
  )
})
