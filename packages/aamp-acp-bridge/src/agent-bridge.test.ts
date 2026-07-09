import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatDebugPromptLog,
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
