import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { createZcodeEventTranslator } from '../src/zcode-acp/event-translator.js'

test('exports a per-session ZCode event translator', async () => {
  const module = await import('../src/zcode-acp/event-translator.js').catch(() => ({})) as
    Record<string, unknown>

  assert.equal(typeof module.createZcodeEventTranslator, 'function')
})

function event(
  seq: number,
  type: string,
  payload: unknown,
  sessionId = 'sess_a',
  eventId = `evt_${seq}`,
) {
  return {
    eventId,
    sessionId,
    seq,
    timestamp: '2026-08-11T00:00:00.000Z',
    type,
    payload,
  }
}

function messageText(updates: SessionUpdate[], updateType: string): string[] {
  return updates.flatMap((update) => {
    if (update.sessionUpdate !== updateType || !('content' in update)
      || update.content.type !== 'text') return []
    return [update.content.text]
  })
}

test('emits text and reasoning exactly once across duplicate streaming sources', () => {
  const translator = createZcodeEventTranslator('sess_a')
  const updates = [
    translator.translate(event(1, 'model.streaming', {
      kind: 'text_delta',
      assistantMessageId: 'msg_1',
      partId: 'part_text',
      delta: 'Hel',
    })),
    translator.translate(event(2, 'model.streaming', {
      kind: 'text_delta',
      assistantMessageId: 'msg_1',
      partId: 'part_text',
      delta: 'lo',
    })),
    translator.translate(event(3, 'part.delta', {
      messageId: 'msg_1',
      partId: 'part_text',
      field: 'text',
      delta: 'Hel',
    })),
    translator.translate(event(4, 'part.delta', {
      messageId: 'msg_1',
      partId: 'part_text',
      field: 'text',
      delta: 'lo',
    })),
    translator.translate(event(5, 'message.upserted', {
      message: {
        info: { role: 'assistant', messageId: 'msg_1' },
        parts: [{ partId: 'part_text', type: 'text', text: 'Hello' }],
      },
    })),
    translator.translate(event(6, 'model.streaming', {
      kind: 'reasoning_delta',
      assistantMessageId: 'msg_1',
      partId: 'part_thought',
      delta: 'Think',
    })),
    translator.translate(event(7, 'part.delta', {
      messageId: 'msg_1',
      partId: 'part_thought',
      field: 'reasoning',
      delta: 'Think',
    })),
  ].flatMap((translation) => translation.updates)

  assert.deepEqual(messageText(updates, 'agent_message_chunk'), ['Hel', 'lo'])
  assert.equal(messageText(updates, 'agent_message_chunk').join(''), 'Hello')
  assert.deepEqual(messageText(updates, 'agent_thought_chunk'), ['Think'])
})

test('does not collapse adjacent identical deltas from one source', () => {
  const translator = createZcodeEventTranslator('sess_a')
  const updates = [
    translator.translate(event(1, 'model.streaming', {
      kind: 'text_delta',
      assistantMessageId: 'msg_1',
      partId: 'part_text',
      delta: 'ha',
    })),
    translator.translate(event(2, 'model.streaming', {
      kind: 'text_delta',
      assistantMessageId: 'msg_1',
      partId: 'part_text',
      delta: 'ha',
    })),
  ].flatMap((translation) => translation.updates)

  assert.deepEqual(messageText(updates, 'agent_message_chunk'), ['ha', 'ha'])
})

test('maps the tool lifecycle into one call followed by updates', () => {
  const translator = createZcodeEventTranslator('sess_a')

  assert.deepEqual(translator.translate(event(1, 'tool.updated', {
    status: 'scheduled',
    toolCallId: 'tool_1',
    toolName: 'read_file',
    input: { path: '/tmp/a.ts' },
  })).updates, [{
    sessionUpdate: 'tool_call',
    toolCallId: 'tool_1',
    title: 'read_file',
    kind: 'read',
    status: 'pending',
    rawInput: { path: '/tmp/a.ts' },
  }])
  assert.deepEqual(translator.translate(event(2, 'tool.updated', {
    status: 'started',
    toolCallId: 'tool_1',
    toolName: 'read_file',
  })).updates, [{
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool_1',
    title: 'read_file',
    kind: 'read',
    status: 'in_progress',
  }])
  assert.deepEqual(translator.translate(event(3, 'tool.updated', {
    status: 'progress',
    toolCallId: 'tool_1',
    toolName: 'read_file',
  })).updates, [{
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool_1',
    title: 'read_file',
    kind: 'read',
    status: 'in_progress',
  }])
  assert.deepEqual(translator.translate(event(4, 'tool.updated', {
    status: 'result',
    toolCallId: 'tool_1',
    toolName: 'read_file',
    result: 'contents',
  })).updates, [{
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool_1',
    title: 'read_file',
    kind: 'read',
    status: 'completed',
    rawOutput: 'contents',
  }])
  assert.deepEqual(translator.translate(event(5, 'tool.updated', {
    status: 'error',
    toolCallId: 'tool_2',
    toolName: 'write_file',
    error: { message: 'denied' },
  })).updates, [{
    sessionUpdate: 'tool_call',
    toolCallId: 'tool_2',
    title: 'write_file',
    kind: 'edit',
    status: 'failed',
    rawOutput: { message: 'denied' },
  }])
})

test('accepts the ZCode nested tool update variant', () => {
  const translator = createZcodeEventTranslator('sess_a')
  assert.deepEqual(translator.translate(event(1, 'tool.updated', {
    toolCallId: 'tool_nested',
    update: {
      type: 'scheduled',
      toolName: 'search_files',
      input: { query: 'ZCode' },
    },
  })).updates, [{
    sessionUpdate: 'tool_call',
    toolCallId: 'tool_nested',
    title: 'search_files',
    kind: 'search',
    status: 'pending',
    rawInput: { query: 'ZCode' },
  }])
})

test('maps plan, mode, model, title, and usage projection changes', () => {
  const translator = createZcodeEventTranslator('sess_a')
  const translation = translator.translate(event(1, 'session.updated', {
    title: 'Review task',
    settings: {
      mode: { current: 'plan' },
      model: {
        current: { providerId: 'zai', modelId: 'glm-4.5' },
        available: [{
          ref: { providerId: 'zai', modelId: 'glm-4.5' },
          label: 'GLM 4.5',
        }],
      },
    },
    projection: {
      todos: [
        { content: 'Inspect code', status: 'in_progress', priority: 'high' },
        { title: 'Write result', status: 'pending' },
      ],
      usage: { used: 120, size: 8192 },
    },
  }))

  assert.deepEqual(translation.updates, [
    {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect code', status: 'in_progress', priority: 'high' },
        { content: 'Write result', status: 'pending', priority: 'medium' },
      ],
    },
    { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    {
      sessionUpdate: 'config_option_update',
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'zai/glm-4.5',
        options: [{ value: 'zai/glm-4.5', name: 'GLM 4.5' }],
      }],
    },
    { sessionUpdate: 'session_info_update', title: 'Review task' },
    { sessionUpdate: 'usage_update', used: 120, size: 8192 },
  ])
})

test('maps title-only and usage-only events', () => {
  const translator = createZcodeEventTranslator('sess_a')
  assert.deepEqual(translator.translate(event(1, 'session.titleUpdated', {
    title: 'New title',
  })).updates, [{
    sessionUpdate: 'session_info_update',
    title: 'New title',
  }])
  assert.deepEqual(translator.translate(event(2, 'session.usage', {
    used: 42,
    size: 4096,
  })).updates, [{
    sessionUpdate: 'usage_update',
    used: 42,
    size: 4096,
  }])
})

test('maps every supported turn completion result', () => {
  const cases = [
    ['success', 'end_turn'],
    ['cancelled', 'cancelled'],
    ['error_max_turns', 'max_turn_requests'],
    ['error_max_tool_calls', 'max_turn_requests'],
    ['error_max_budget', 'max_tokens'],
  ] as const

  for (const [resultType, stopReason] of cases) {
    const translator = createZcodeEventTranslator('sess_a')
    assert.deepEqual(translator.translate(event(1, 'turn.completed', {
      resultType,
      inputId: 'input_1',
    })).completion, {
      stopReason,
      inputId: 'input_1',
    })
  }

  const executionError = createZcodeEventTranslator('sess_a').translate(
    event(1, 'turn.completed', {
      resultType: 'error_during_execution',
      inputId: 'input_1',
    }),
  )
  assert.match(executionError.failure?.message ?? '', /execution failed.*input_1/)
})

test('converts turn.failed into a contextual failure', () => {
  const translation = createZcodeEventTranslator('sess_a').translate(
    event(1, 'turn.failed', {
      inputId: 'input_1',
      turnPhase: 'tool_execution',
      error: { code: 'tool_failed', message: 'Tool failed' },
    }),
  )

  assert.equal(translation.updates.length, 0)
  assert.match(translation.failure?.message ?? '', /Tool failed.*tool_execution.*input_1/)
})

test('ignores cross-session, duplicate, old, and unknown events', () => {
  const translator = createZcodeEventTranslator('sess_a')
  assert.deepEqual(translator.translate(event(
    1,
    'model.streaming',
    { kind: 'text_delta', delta: 'wrong' },
    'sess_b',
  )), { updates: [] })
  assert.equal(translator.lastSequence(), 0)

  const first = event(2, 'model.streaming', {
    kind: 'text_delta',
    assistantMessageId: 'msg_1',
    partId: 'part_1',
    delta: 'right',
  })
  assert.equal(translator.translate(first).updates.length, 1)
  assert.deepEqual(translator.translate(first), { updates: [] })
  assert.deepEqual(translator.translate(event(1, 'session.updated', {})), { updates: [] })
  assert.deepEqual(translator.translate(event(3, 'future.event', { extra: true })), { updates: [] })
  assert.equal(translator.lastSequence(), 3)

  translator.reset()
  assert.equal(translator.lastSequence(), 0)
  assert.equal(translator.translate(first).updates.length, 1)
})

test('returns failures for malformed tool and completion events', () => {
  const translator = createZcodeEventTranslator('sess_a')
  assert.match(
    translator.translate(event(1, 'tool.updated', {
      status: 'started',
      toolName: 'read_file',
    })).failure?.message ?? '',
    /toolCallId/,
  )
  assert.match(
    translator.translate(event(2, 'turn.completed', {
      inputId: 'input_1',
    })).failure?.message ?? '',
    /resultType/,
  )
})
