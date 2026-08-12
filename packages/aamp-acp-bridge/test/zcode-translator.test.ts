import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContentBlock, McpServer } from '@agentclientprotocol/sdk'
import { ZCodeRpcError } from '../src/zcode-acp/rpc-client.js'
import {
  decodeModelRef,
  encodeModelRef,
  redactForLog,
  replaySnapshot,
  rewriteZcodeError,
  toAcpConfigOptions,
  toAcpModes,
  toAcpSessionInfo,
  toZcodeMcpServers,
  toZcodePrompt,
  toZcodeWorkspace,
} from '../src/zcode-acp/translator.js'

test('exports the ACP and ZCode translation boundary', async () => {
  const translator = await import('../src/zcode-acp/translator.js').catch(() => ({})) as
    Record<string, unknown>

  for (const name of [
    'toZcodeWorkspace',
    'toZcodePrompt',
    'toZcodeMcpServers',
    'encodeModelRef',
    'decodeModelRef',
    'toAcpModes',
    'toAcpConfigOptions',
    'toAcpSessionInfo',
    'replaySnapshot',
    'rewriteZcodeError',
    'redactForLog',
  ]) {
    assert.equal(typeof translator[name], 'function', name)
  }
})

test('maps one absolute ACP workspace and rejects unsupported roots', () => {
  assert.deepEqual(toZcodeWorkspace('/tmp/zcode-project'), {
    workspacePath: '/tmp/zcode-project',
    workspaceKey: '/tmp/zcode-project',
  })
  assert.deepEqual(toZcodeWorkspace('/tmp/zcode-project', []), {
    workspacePath: '/tmp/zcode-project',
    workspaceKey: '/tmp/zcode-project',
  })
  assert.throws(
    () => toZcodeWorkspace('relative/project'),
    /cwd must be an absolute path/,
  )
  assert.throws(
    () => toZcodeWorkspace('/tmp/zcode-project', ['/tmp/second-root']),
    /additionalDirectories are not supported/,
  )
})

test('preserves ordered text and resource links in a ZCode prompt', () => {
  assert.equal(toZcodePrompt([
    { type: 'text', text: 'Review this' },
    { type: 'resource_link', name: 'spec', uri: 'file:///tmp/spec.md' },
  ]), 'Review this\n\n[Resource link: spec]\nURI: file:///tmp/spec.md')
})

test('rejects every unsupported prompt block before producing content', () => {
  for (const block of [
    { type: 'image', data: 'AA==', mimeType: 'image/png' },
    { type: 'audio', data: 'AA==', mimeType: 'audio/wav' },
    {
      type: 'resource',
      resource: { uri: 'file:///tmp/spec.md', text: 'private' },
    },
  ] as ContentBlock[]) {
    assert.throws(
      () => toZcodePrompt([
        { type: 'text', text: 'must not be returned' },
        block,
      ]),
      new RegExp(`Unsupported ACP prompt content type: ${block.type}`),
    )
  }
  assert.throws(() => toZcodePrompt([]), /at least one content block/)
})

test('maps stdio, HTTP, and SSE MCP servers and rejects ACP transport', () => {
  const servers: McpServer[] = [
    {
      name: 'local',
      command: 'node',
      args: ['server.mjs'],
      env: [{ name: 'API_TOKEN', value: 'secret-value' }],
    },
    {
      type: 'http',
      name: 'remote-http',
      url: 'https://mcp.example/http',
      headers: [{ name: 'Authorization', value: 'Bearer secret-value' }],
    },
    {
      type: 'sse',
      name: 'remote-sse',
      url: 'https://mcp.example/sse',
      headers: [{ name: 'X-Tenant', value: 'tenant-a' }],
    },
  ]

  assert.deepEqual(toZcodeMcpServers(servers), servers)
  assert.throws(
    () => toZcodeMcpServers([{
      type: 'acp',
      name: 'nested-acp',
      id: 'mcp_1',
    }]),
    /ACP-transport MCP server "nested-acp" is not supported/,
  )
})

test('round-trips encoded model references including reserved characters', () => {
  const model = {
    providerId: 'z.ai/cloud',
    modelId: 'glm 4.5',
    variant: 'high/thinking',
  }
  const encoded = encodeModelRef(model)

  assert.equal(encoded, 'z.ai%2Fcloud/glm%204.5/high%2Fthinking')
  assert.deepEqual(decodeModelRef(encoded), model)
  assert.throws(() => decodeModelRef('one-segment'), /two or three segments/)
  assert.throws(() => decodeModelRef('provider/model/variant/extra'), /two or three segments/)
  assert.throws(() => decodeModelRef('provider/%E0%A4%A'), /Invalid encoded model reference/)
})

const snapshot = {
  protocol: { name: 'ZCode Protocol', version: 1 },
  settings: {
    mode: { current: 'build' },
    model: {
      current: {
        providerId: 'zai',
        modelId: 'glm-4.5',
        variant: 'thinking',
      },
      available: [
        {
          ref: {
            providerId: 'zai',
            modelId: 'glm-4.5',
            variant: 'thinking',
          },
          label: 'GLM 4.5 Thinking',
          description: 'Reasoning model',
        },
        {
          ref: { providerId: 'other', modelId: 'disabled' },
          label: 'Disabled',
          disabledReason: 'not configured',
        },
      ],
    },
  },
}

test('maps the fixed ZCode mode set and current mode', () => {
  assert.deepEqual(toAcpModes(snapshot), {
    currentModeId: 'build',
    availableModes: [
      { id: 'plan', name: 'Plan' },
      { id: 'build', name: 'Build' },
      { id: 'edit', name: 'Edit' },
      { id: 'yolo', name: 'Yolo' },
      { id: 'auto', name: 'Auto' },
    ],
  })
  assert.throws(
    () => toAcpModes({ settings: { mode: { current: 'unknown' } } }),
    /Unknown ZCode mode/,
  )
})

test('maps available ZCode models into one ACP model selector', () => {
  assert.deepEqual(toAcpConfigOptions(snapshot), [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'zai/glm-4.5/thinking',
    options: [{
      value: 'zai/glm-4.5/thinking',
      name: 'GLM 4.5 Thinking',
      description: 'Reasoning model',
    }],
  }])
  assert.deepEqual(toAcpConfigOptions({ settings: {} }), [])
})

test('maps ZCode session metadata without inventing additional roots', () => {
  assert.deepEqual(toAcpSessionInfo({
    sessionId: 'sess_1',
    workspace: { workspacePath: '/tmp/zcode-project' },
    title: 'Review project',
    updatedAt: 1_786_000_000_000,
  }), {
    sessionId: 'sess_1',
    cwd: '/tmp/zcode-project',
    title: 'Review project',
    updatedAt: new Date(1_786_000_000_000).toISOString(),
  })
  assert.throws(
    () => toAcpSessionInfo({ sessionId: 'sess_1', workspace: {} }),
    /workspace path/,
  )
})

test('replays stored user, assistant, reasoning, file, and tool parts in order', () => {
  assert.deepEqual(replaySnapshot({
    messages: [
      {
        info: { role: 'user', messageId: 'msg_user' },
        parts: [{ type: 'text', text: 'Please review' }],
      },
      {
        info: { role: 'assistant', messageId: 'msg_agent' },
        parts: [
          { type: 'reasoning', text: 'I should inspect it' },
          { type: 'text', text: 'I found one issue' },
          {
            type: 'file',
            filename: 'report.md',
            url: 'file:///tmp/report.md',
            mime: 'text/markdown',
          },
          {
            type: 'tool',
            callId: 'tool_1',
            tool: { name: 'read_file', input: { path: '/tmp/a.ts' } },
            state: { status: 'completed', result: 'contents' },
          },
        ],
      },
    ],
  }), [
    {
      sessionUpdate: 'user_message_chunk',
      messageId: 'msg_user',
      content: { type: 'text', text: 'Please review' },
    },
    {
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'msg_agent',
      content: { type: 'text', text: 'I should inspect it' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_agent',
      content: { type: 'text', text: 'I found one issue' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_agent',
      content: {
        type: 'resource_link',
        name: 'report.md',
        uri: 'file:///tmp/report.md',
        mimeType: 'text/markdown',
      },
    },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool_1',
      title: 'read_file',
      kind: 'read',
      status: 'completed',
      rawInput: { path: '/tmp/a.ts' },
      rawOutput: 'contents',
    },
  ])
  assert.throws(() => replaySnapshot({ messages: 'invalid' }), /messages array/)
})

test('adds the official login command to model_config_missing errors', () => {
  const original = new ZCodeRpcError('session/create', {
    code: -32603,
    message: 'No model provider configured',
    data: { code: 'model_config_missing' },
  })
  const rewritten = rewriteZcodeError(
    original,
    '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
  ) as Error & { code?: unknown; data?: unknown }

  assert.match(rewritten.message, /No model provider configured/)
  assert.match(
    rewritten.message,
    /node "\/Applications\/ZCode\.app\/Contents\/Resources\/glm\/zcode\.cjs" login/,
  )
  assert.equal(rewritten.code, -32603)
  assert.deepEqual(rewritten.data, { code: 'model_config_missing' })

  const nested = new ZCodeRpcError('session/create', {
    code: -32603,
    message: 'Internal error',
    data: {
      name: 'ModelProtocolError',
      code: 'model_config_missing',
    },
  })
  assert.match(
    rewriteZcodeError(
      nested,
      '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    ).message,
    /node "\/Applications\/ZCode\.app\/Contents\/Resources\/glm\/zcode\.cjs" login/,
  )

  const ordinary = new Error('ordinary')
  assert.equal(rewriteZcodeError(ordinary, '/tmp/zcode.cjs'), ordinary)
})

test('redacts nested secret keys and named environment/header values without mutation', () => {
  const source = {
    authorization: 'Bearer secret-value',
    nested: {
      apiKey: 'secret-value',
      keep: 'visible',
    },
    pairs: [
      { name: 'API_TOKEN', value: 'secret-value' },
      { name: 'X-Tenant', value: 'tenant-a' },
    ],
  }

  assert.deepEqual(redactForLog(source), {
    authorization: '[REDACTED]',
    nested: {
      apiKey: '[REDACTED]',
      keep: 'visible',
    },
    pairs: [
      { name: 'API_TOKEN', value: '[REDACTED]' },
      { name: 'X-Tenant', value: 'tenant-a' },
    ],
  })
  assert.equal(source.authorization, 'Bearer secret-value')
  assert.equal(source.pairs[0].value, 'secret-value')
})
