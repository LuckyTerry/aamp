import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDebugPromptLog } from './agent-bridge.js'

test('formatDebugPromptLog prints metadata and the full prompt body', () => {
  const prompt = [
    '## AAMP Task',
    '',
    'Execution rules:',
    '- Use the requested runtime.',
  ].join('\n')

  const log = formatDebugPromptLog({
    agentName: 'codem',
    taskId: 'task-123',
    sessionKey: 'feishu-task:task-123',
    prompt,
  })

  assert.match(log, /^\[codem\] CLI prompt debug task=task-123 session=feishu-task:task-123\n/)
  assert.match(log, /--- BEGIN CLI PROMPT ---\n## AAMP Task/)
  assert.match(log, /Execution rules:\n- Use the requested runtime\./)
  assert.match(log, /\n--- END CLI PROMPT ---$/)
})
