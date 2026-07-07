import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskDispatch } from 'aamp-sdk'
import { buildPrompt, parseResponse } from './prompt-builder.js'

function buildTask(overrides: Partial<TaskDispatch> = {}): TaskDispatch {
  return {
    protocolVersion: '1.1',
    intent: 'task.dispatch',
    taskId: 'task-1',
    title: 'Feishu Task: 成都今天的天气怎样？',
    priority: 'normal',
    dispatchContext: overrides.dispatchContext,
    from: 'bridge@meshmail.ai',
    to: 'codex@meshmail.ai',
    messageId: 'message-1',
    subject: 'task dispatch',
    bodyText: 'This Feishu task must be executed through the required runtime.',
    ...overrides,
  }
}

test('buildPrompt requires the dispatchContext required_skill path before direct answers', () => {
  const prompt = buildPrompt(buildTask({
    dispatchContext: {
      source: 'feishu-task',
      required_skill: 'example-required-skill',
    },
    promptRules: [
      'Execution rules:',
      '- Use dispatchContext.required_skill before producing a final answer.',
    ].join('\n'),
  }), undefined, 'codex')

  assert.match(prompt, /Execution rules:\n- Use dispatchContext\.required_skill before producing a final answer\./)
  assert.doesNotMatch(prompt.replaceAll('required_skill: example-required-skill', ''), /example-required-skill/)
  assert.doesNotMatch(prompt, /For simple chat messages that are fully present in the prompt, answer them directly/i)
  assert.doesNotMatch(prompt, /Please complete this task and output your result directly/)
  assert.doesNotMatch(prompt, /Structured result handoff:/)
})

test('buildPrompt keeps simple direct-answer guidance when no required skill is present', () => {
  const prompt = buildPrompt(buildTask({ dispatchContext: { source: 'feishu-task' } }), undefined, 'codex')

  assert.doesNotMatch(prompt, /Required skill execution:/)
  assert.match(prompt, /For simple chat messages that are fully present in the prompt, answer them directly/i)
})

test('buildPrompt requires the Feishu lark-cli profile when provided by dispatch context', () => {
  const prompt = buildPrompt(buildTask({
    dispatchContext: {
      source: 'feishu',
      feishu_lark_cli_profile: 'aamp-feishu-task-cli_aacddfe1d7b21cb6',
    },
  }), undefined, 'codex')

  assert.match(prompt, /Feishu lark-cli profile rules:/)
  assert.match(prompt, /--profile aamp-feishu-task-cli_aacddfe1d7b21cb6/)
  assert.match(prompt, /Do not use the active\/default lark-cli profile/)
})

test('buildPrompt replaces default task prompt rules when promptRules are provided', () => {
  const prompt = buildPrompt(buildTask({
    promptRules: [
      'Feishu task rules:',
      '- Use the Feishu task runtime before any direct answer.',
      '- Return HELP when the runtime cannot load the task.',
      '- Do not emit structured AAMP output unless explicitly requested.',
    ].join('\n'),
  }), undefined, 'codex')

  assert.match(prompt, /Feishu task rules:\n- Use the Feishu task runtime before any direct answer\./)
  assert.match(prompt, /- Return HELP when the runtime cannot load the task\./)
  assert.match(prompt, /- Do not emit structured AAMP output unless explicitly requested\./)
  assert.doesNotMatch(prompt, /Treat the Description section and any prior thread context below as the only task context/)
  assert.doesNotMatch(prompt, /Please complete this task and output your result directly/)
  assert.doesNotMatch(prompt, /Structured result handoff:/)
})

test('parseResponse extracts output-only AAMP_RESULT_JSON blocks', () => {
  const parsed = parseResponse([
    'AAMP_RESULT_JSON:',
    '',
    '',
    '{"output":"ERROR: runtime action qualify_polled_task failed with MISSING_REQUIRED_FIELDS"}',
  ].join('\n'))

  assert.equal(
    parsed.output,
    'ERROR: runtime action qualify_polled_task failed with MISSING_REQUIRED_FIELDS',
  )
  assert.equal(parsed.isHelp, false)
  assert.deepEqual(parsed.files, [])
})
