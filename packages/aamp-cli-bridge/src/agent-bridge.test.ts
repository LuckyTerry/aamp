import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  formatDebugPromptLog,
  materializePromptIfNeeded,
  resolveTaskSessionKey,
  stripAampInternalDispatchContext,
} from './agent-bridge.js'

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

test('resolveTaskSessionKey falls back to dispatch context compatibility field', () => {
  assert.equal(resolveTaskSessionKey({
    taskId: 'task-123',
    dispatchContext: {
      source: 'feishu-task',
      aamp_session_key: 'feishu-task:task-guid-123',
    },
  }, {
    dispatchContext: {
      source: 'feishu-task',
    },
  }), 'feishu-task:task-guid-123')
  assert.equal(resolveTaskSessionKey({
    taskId: 'task-123',
    sessionKey: 'feishu-task:canonical-guid',
    dispatchContext: {
      aamp_session_key: 'feishu-task:shadow-guid',
    },
  }, {
    dispatchContext: {
      aamp_session_key: 'feishu-task:hydrated-shadow-guid',
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

test('materializePromptIfNeeded keeps short prompts inline', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'aamp-cli-prompt-short-'))
  try {
    const prompt = 'Short AAMP prompt'

    const result = materializePromptIfNeeded({
      taskId: 'task-123',
      prompt,
      thresholdChars: 100,
      baseDir,
      now: new Date('2026-07-08T00:00:00.000Z'),
    })

    assert.equal(result.prompt, prompt)
    assert.equal(result.materializedPath, undefined)
    assert.equal(existsSync(join(baseDir, 'prompt-files')), false)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('materializePromptIfNeeded writes long prompts to a private file and returns a wrapper', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'aamp-cli-prompt-long-'))
  try {
    const prompt = [
      '## AAMP Task',
      '',
      'Description:',
      'A'.repeat(120),
      '',
      'Final Result Contract:',
      '- Always finish with AAMP_RESULT_JSON.',
    ].join('\n')

    const result = materializePromptIfNeeded({
      taskId: 'feishu-task/foo:bar',
      prompt,
      thresholdChars: 20,
      baseDir,
      now: new Date('2026-07-08T00:00:00.000Z'),
    })

    assert.ok(result.materializedPath)
    assert.equal(dirname(result.materializedPath), baseDir)
    assert.match(basename(result.materializedPath), /^p-[a-f0-9]{12}\.md$/)
    assert.equal(result.materializedPath.includes('feishu-task'), false)
    assert.equal(result.materializedPath.includes('2026-07-08'), false)
    assert.equal(readFileSync(result.materializedPath, 'utf8'), prompt)
    assert.equal(statSync(result.materializedPath).mode & 0o777, 0o600)
    assert.match(result.prompt, /^## AAMP Prompt File/)
    assert.match(result.prompt, /Read the entire file before acting/)
    assert.match(result.prompt, new RegExp(`cat ${result.materializedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(result.prompt, /follow all instructions, rules, and final-result contracts/)
    assert.match(result.prompt, /AAMP_RESULT_JSON: \{"output":"Unable to read materialized AAMP prompt file: <exact read failure>"\}/)
    assert.equal(result.prompt.includes('HELP:'), false)
    assert.match(result.prompt, new RegExp(result.materializedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(result.prompt.includes('A'.repeat(80)), false)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})
