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
  }), undefined, { agentName: 'codex' })

  assert.match(prompt, /Execution rules:\n- Use dispatchContext\.required_skill before producing a final answer\./)
  assert.doesNotMatch(prompt.replaceAll('required_skill: example-required-skill', ''), /example-required-skill/)
  assert.doesNotMatch(prompt, /For simple chat messages that are fully present in the prompt, answer them directly/i)
  assert.doesNotMatch(prompt, /Please complete this task and output your result directly/)
  assert.doesNotMatch(prompt, /Structured result handoff:/)
})

test('buildPrompt keeps simple direct-answer guidance when no required skill is present', () => {
  const prompt = buildPrompt(buildTask({ dispatchContext: { source: 'feishu-task' } }), undefined, { agentName: 'codex' })

  assert.doesNotMatch(prompt, /Required skill execution:/)
  assert.match(prompt, /For simple chat messages that are fully present in the prompt, answer them directly/i)
})

test('buildPrompt requires the Feishu lark-cli profile when provided by dispatch context', () => {
  const prompt = buildPrompt(buildTask({
    dispatchContext: {
      source: 'feishu',
      feishu_lark_cli_profile: 'aamp-feishu-task-cli_aacddfe1d7b21cb6',
      feishu_lark_cli_bin: '/Users/bytedance/.local/bin/lark-cli',
    },
  }), undefined, { agentName: 'codex' })

  assert.match(prompt, /Feishu lark-cli profile rules:/)
  assert.match(prompt, /'\/Users\/bytedance\/\.local\/bin\/lark-cli' --profile aamp-feishu-task-cli_aacddfe1d7b21cb6/)
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
  }), undefined, { agentName: 'codex' })

  assert.match(prompt, /Feishu task rules:\n- Use the Feishu task runtime before any direct answer\./)
  assert.match(prompt, /- Return HELP when the runtime cannot load the task\./)
  assert.match(prompt, /- Do not emit structured AAMP output unless explicitly requested\./)
  assert.doesNotMatch(prompt, /Treat the Description section and any prior thread context below as the only task context/)
  assert.doesNotMatch(prompt, /Please complete this task and output your result directly/)
  assert.doesNotMatch(prompt, /Structured result handoff:/)
})

test('buildPrompt default remote instructions exclude local artifact result guidance', () => {
  const userText = 'User-authored text stays verbatim: attachments path attachmentFilenames email attachments FILE:/user/provided.txt'
  const remotePrompt = buildPrompt(buildTask({
    bodyText: userText,
    dispatchContext: {
      source: 'feishu-task',
    },
  }), undefined, {
    agentName: 'aime',
    executionLocation: 'remote',
  })

  assert.match(remotePrompt, /runs in a remote sandbox/i)
  assert.match(remotePrompt, /own remote-native capabilities/i)
  assert.equal(remotePrompt.includes(userText), true)
  const generatedPrompt = remotePrompt.replace(userText, '')
  assert.match(generatedPrompt, /may include only output and non-file structuredResult/i)
  assert.match(generatedPrompt, /Do not include attachments, file paths, attachmentFilenames, FILE references/i)
  assert.doesNotMatch(generatedPrompt, /"attachments"\s*:/)
  assert.doesNotMatch(generatedPrompt, /"path"\s*:/)
  assert.doesNotMatch(generatedPrompt, /also reference attached files with attachmentFilenames/i)
  assert.doesNotMatch(generatedPrompt, /sends attachments as email attachments/i)
  assert.doesNotMatch(remotePrompt, /current working directory/i)
  assert.doesNotMatch(remotePrompt, /FILE:\/absolute\/path/i)
  assert.doesNotMatch(remotePrompt, /Feishu lark-cli profile rules/i)

  const localPrompt = buildPrompt(buildTask(), undefined, {
    agentName: 'codex',
    executionLocation: 'local',
  })
  assert.match(localPrompt, /current working directory/i)
  assert.match(localPrompt, /FILE:\/absolute\/path/i)
})

test('buildPrompt conversational remote instructions exclude local artifact result guidance', () => {
  const userText = 'Conversation text stays verbatim: attachments path attachmentFilenames email attachments FILE:/user/chat.txt'
  const remotePrompt = buildPrompt(buildTask({
    bodyText: userText,
    dispatchContext: { source: 'feishu' },
  }), undefined, {
    agentName: 'aime',
    executionLocation: 'remote',
  })

  assert.match(remotePrompt, /^## AAMP Conversation Turn/)
  assert.equal(remotePrompt.includes(userText), true)
  const generatedPrompt = remotePrompt.replace(userText, '')
  assert.match(generatedPrompt, /may include only output and non-file structuredResult/i)
  assert.match(generatedPrompt, /Do not include attachments, file paths, attachmentFilenames, FILE references/i)
  assert.doesNotMatch(generatedPrompt, /"attachments"\s*:/)
  assert.doesNotMatch(generatedPrompt, /"path"\s*:/)
  assert.doesNotMatch(generatedPrompt, /also reference attached files with attachmentFilenames/i)
  assert.doesNotMatch(generatedPrompt, /sends attachments as email attachments/i)
  assert.doesNotMatch(generatedPrompt, /FILE:\/absolute\/path/i)
})

test('buildPrompt appends authoritative remote handoff rules after a promptRules override', () => {
  const override = [
    'Custom remote rules:',
    '- Attach /Users/private/OVERRIDE_PATH_SENTINEL.txt.',
    '- Return attachments, attachmentFilenames, and FILE:/Users/private/result.txt.',
  ].join('\n')
  const prompt = buildPrompt(buildTask({
    promptRules: override,
    dispatchContext: { source: 'feishu-task' },
  }), undefined, {
    agentName: 'aime',
    executionLocation: 'remote',
  })

  assert.equal(prompt.includes(override), true)
  const finalPolicyIndex = prompt.lastIndexOf('Structured result handoff:')
  assert.ok(finalPolicyIndex > prompt.indexOf(override))
  const finalPolicy = prompt.slice(finalPolicyIndex)
  assert.match(finalPolicy, /final handoff policy is authoritative/i)
  assert.match(finalPolicy, /Do not include attachments, file paths, attachmentFilenames, FILE references/i)
  const generatedPrompt = prompt.replace(override, '')
  assert.doesNotMatch(generatedPrompt, /OVERRIDE_PATH_SENTINEL|FILE:\/absolute\/path|"attachments"\s*:/i)
})

test('buildPrompt remote task context renders only source while preserving the user body', () => {
  const bodyText = 'REMOTE_TASK_USER_BODY_SENTINEL stays verbatim.'
  const prompt = buildPrompt(buildTask({
    bodyText,
    dispatchContext: {
      source: 'feishu-task',
      aamp_session_key: 'INTERNAL_SESSION_SENTINEL',
      feishu_lark_cli_bin: '/Users/private/REMOTE_CLI_BIN_SENTINEL',
      feishu_lark_cli_profile: 'REMOTE_PROFILE_SENTINEL',
      cwd: '/Users/private/REMOTE_CWD_SENTINEL',
      credentialsFile: '/Users/private/REMOTE_CREDENTIAL_SENTINEL.json',
      mcpServer: 'REMOTE_MCP_SENTINEL',
      localPath: '/Users/private/REMOTE_PATH_SENTINEL',
    },
  }), undefined, {
    agentName: 'aime',
    executionLocation: 'remote',
  })

  assert.match(prompt, /Dispatch Context:\n  - source: feishu-task/)
  assert.equal(prompt.includes(bodyText), true)
  assert.doesNotMatch(
    prompt,
    /INTERNAL_SESSION_SENTINEL|REMOTE_CLI_BIN_SENTINEL|REMOTE_PROFILE_SENTINEL|REMOTE_CWD_SENTINEL|REMOTE_CREDENTIAL_SENTINEL|REMOTE_MCP_SENTINEL|REMOTE_PATH_SENTINEL/,
  )
  assert.doesNotMatch(prompt, /aamp_session_key|feishu_lark_cli_bin|feishu_lark_cli_profile|credentialsFile|mcpServer|localPath/)
})

test('buildPrompt remote conversation context renders only source while preserving the user body', () => {
  const bodyText = 'REMOTE_CONVERSATION_USER_BODY_SENTINEL stays verbatim.'
  const prompt = buildPrompt(buildTask({
    bodyText,
    dispatchContext: {
      source: 'feishu',
      aamp_session_key: 'CHAT_SESSION_SENTINEL',
      feishu_lark_cli_bin: '/Users/private/CHAT_CLI_BIN_SENTINEL',
      feishu_lark_cli_profile: 'CHAT_PROFILE_SENTINEL',
      cwd: '/Users/private/CHAT_CWD_SENTINEL',
      credentialPath: '/Users/private/CHAT_CREDENTIAL_SENTINEL.json',
      mcpServers: 'CHAT_MCP_SENTINEL',
      path: '/Users/private/CHAT_PATH_SENTINEL',
    },
  }), undefined, {
    agentName: 'aime',
    executionLocation: 'remote',
  })

  assert.match(prompt, /^## AAMP Conversation Turn/)
  assert.match(prompt, /Dispatch Context:\n  - source: feishu/)
  assert.equal(prompt.includes(bodyText), true)
  assert.doesNotMatch(
    prompt,
    /CHAT_SESSION_SENTINEL|CHAT_CLI_BIN_SENTINEL|CHAT_PROFILE_SENTINEL|CHAT_CWD_SENTINEL|CHAT_CREDENTIAL_SENTINEL|CHAT_MCP_SENTINEL|CHAT_PATH_SENTINEL/,
  )
  assert.doesNotMatch(prompt, /aamp_session_key|feishu_lark_cli_bin|feishu_lark_cli_profile|credentialPath|mcpServers|path:/)
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
