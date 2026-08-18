import { describe, expect, it } from 'vitest';

import {
  initialAimeEventState,
  reduceAimeEvent,
  type AimeEventState,
} from '../../src/aime/event-mapper.js';
import type { NormalizedAimeEvent } from '../../src/aime/event-types.js';

function meta(offset = 1) {
  return { offset, timestampMs: 1_000 + offset, rawType: 'synthetic.event' };
}

function reduce(state: AimeEventState, event: NormalizedAimeEvent) {
  const result = reduceAimeEvent(state, event);
  expect(result.nextState).not.toBe(state);
  return result;
}

describe('reduceAimeEvent', () => {
  it('does not mutate the input state or expose a mutable tool lifecycle', () => {
    const state = initialAimeEventState();
    const reduction = reduceAimeEvent(state, {
      kind: 'action.use_tool',
      ...meta(),
      tool: { id: 'tool-1', name: 'lookup' },
    });
    expect(state.toolIds).toEqual([]);
    expect(reduction.nextState.toolIds).toEqual(['tool-1']);
    expect(Object.isFrozen(reduction.nextState.toolIds)).toBe(true);
  });

  it('uses a delta as a create fallback and emits only a snapshot suffix later', () => {
    const first = reduce(initialAimeEventState(), {
      kind: 'message.delta',
      ...meta(),
      messageId: 'message-1',
      content: 'Hello',
      finished: false,
    });
    expect(first.update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'message-1',
      content: { type: 'text', text: 'Hello' },
    });
    const second = reduce(first.nextState, {
      kind: 'message.create',
      ...meta(2),
      message: { id: 'message-1', role: 'assistant', content: 'Hello world' },
    });
    expect(second.update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: ' world' },
    });
  });

  it('rejects a contradictory assistant snapshot', () => {
    const first = reduce(initialAimeEventState(), {
      kind: 'message.create',
      ...meta(),
      message: { id: 'message-1', role: 'assistant', content: 'alpha' },
    });
    expect(() =>
      reduceAimeEvent(first.nextState, {
        kind: 'message.create',
        ...meta(2),
        message: { id: 'message-1', role: 'assistant', content: 'beta' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }));
  });

  it('aggregates thought tips immutably as one thought update', () => {
    const first = reduce(initialAimeEventState(), {
      kind: 'think.tips',
      ...meta(),
      text: 'First thought.',
    });
    const second = reduce(first.nextState, {
      kind: 'think.tips',
      ...meta(2),
      text: 'Second thought.',
    });
    expect(second.nextState.thought).toBe('First thought.\nSecond thought.');
    expect(second.update).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '\nSecond thought.' },
    });
  });

  it('gives thought tips and progress distinct message ids so ACP never merges them', () => {
    const thought = reduce(initialAimeEventState(), {
      kind: 'think.tips',
      ...meta(1),
      text: 'First thought.',
    });
    expect(thought.update).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'thought:1:1001',
    });

    const progress = reduce(thought.nextState, {
      kind: 'progress',
      ...meta(2),
      status: 'executing',
    });
    expect(progress.update).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'AIME is executing.' },
      messageId: 'progress:2:1002',
    });
  });

  it('emits full plan snapshots after each step update', () => {
    const plan = reduce(initialAimeEventState(), {
      kind: 'plan.update',
      ...meta(),
      plan: { id: 'plan-1', status: 'running' },
    });
    const step = reduce(plan.nextState, {
      kind: 'step.update',
      ...meta(2),
      step: { id: 'step-1', status: 'completed', title: 'Synthetic step' },
    });
    expect(step.update).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Synthetic step', priority: 'medium', status: 'completed' },
      ],
    });
  });

  it('keeps one agent-step entry across sequential full plan snapshots', () => {
    const first = reduce(initialAimeEventState(), {
      kind: 'step.update',
      ...meta(),
      step: { id: 'agent-step', title: 'Synthetic step', status: 'running' },
    });
    const second = reduce(first.nextState, {
      kind: 'step.update',
      ...meta(2),
      step: { id: 'agent-step', title: 'Synthetic step', status: 'completed' },
    });
    expect(second.update).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Synthetic step', priority: 'medium', status: 'completed' },
      ],
    });
  });

  it('falls back to the step summary when title is absent', () => {
    const step = reduce(initialAimeEventState(), {
      kind: 'step.update',
      ...meta(),
      step: { id: 'agent-step', status: 'running', summary: '定位目标群聊' },
    });
    expect(step.update).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: '定位目标群聊', priority: 'medium', status: 'in_progress' },
      ],
    });
  });

  it('omits plan entries and internal IDs when a step has no title or summary', () => {
    const step = reduce(initialAimeEventState(), {
      kind: 'step.update',
      ...meta(),
      step: { id: 'agent-step', status: 'running' },
    });
    expect(step.update).toBeUndefined();
    expect(step.nextState.steps).toEqual({});
  });

  it('creates then updates a tool using the stable normalized ID and bounded summary only', () => {
    const created = reduce(initialAimeEventState(), {
      kind: 'action.use_tool',
      ...meta(),
      tool: {
        id: 'agent-step-1',
        name: 'lookup',
        status: 'running',
        description: 'Brief status',
      },
    });
    expect(created.update).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'agent-step-1',
      title: 'lookup',
      status: 'in_progress',
      content: [
        { type: 'content', content: { type: 'text', text: 'Brief status' } },
      ],
    });
    const updated = reduce(created.nextState, {
      kind: 'action.use_tool',
      ...meta(2),
      tool: {
        id: 'agent-step-1',
        name: 'lookup',
        status: 'completed',
        description: 'Done',
      },
    });
    expect(updated.update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'agent-step-1',
      title: 'lookup',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Done' } }],
    });
    expect(updated.update).not.toHaveProperty('rawInput');
    expect(updated.update).not.toHaveProperty('rawOutput');
    expect(updated.update).not.toHaveProperty('locations');
  });

  it('maps the real AIME "started" tool status to in_progress', () => {
    const created = reduce(initialAimeEventState(), {
      kind: 'action.use_tool',
      ...meta(),
      tool: {
        id: 'agent-step-1',
        name: 'knowledge_use',
        status: 'started',
        description: 'Viewing related skills',
      },
    });
    expect(created.update).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'agent-step-1',
      title: 'knowledge_use',
      status: 'in_progress',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'Viewing related skills' },
        },
      ],
    });
  });

  it('maps progress states and emits deduplicated HTTP(S) sources immediately before idle', () => {
    const progress = reduce(initialAimeEventState(), {
      kind: 'progress',
      ...meta(),
      status: 'executing',
    });
    expect(progress.update).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'AIME is executing.' },
    });
    const references = reduce(progress.nextState, {
      kind: 'reference',
      ...meta(2),
      references: [
        {
          id: 'one',
          title: 'Guide',
          uri: 'https://example.test/guide',
          snippet: 'a',
        },
        {
          id: 'duplicate',
          title: 'Guide copy',
          uri: 'https://example.test/guide',
          snippet: 'b',
        },
        {
          id: 'local',
          title: 'Ignore',
          uri: 'file:///synthetic',
          snippet: 'c',
        },
      ],
    });
    const terminal = reduce(references.nextState, {
      kind: 'progress',
      ...meta(3),
      status: 'waiting_for_next',
    });
    expect(terminal.terminal).toBe('idle');
    expect(terminal.update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'aime-sources',
      _meta: { 'aime.acp.message_kind': 'sources' },
      content: {
        type: 'text',
        text: 'Sources:\n- [Guide](https://example.test/guide)',
      },
    });
  });

  it('does not terminate or flush sources on a finished message delta', () => {
    const message = reduce(initialAimeEventState(), {
      kind: 'message.delta',
      ...meta(),
      messageId: 'message-1',
      content: 'Final synthetic text.',
      finished: true,
    });
    expect(message.terminal).toBeUndefined();
    expect(message.update).toMatchObject({
      content: { type: 'text', text: 'Final synthetic text.' },
    });
    const refs = reduce(message.nextState, {
      kind: 'reference',
      ...meta(2),
      references: [
        {
          id: 'ref',
          title: 'Guide',
          uri: 'https://example.test/guide',
          snippet: 'synthetic',
        },
      ],
    });
    const tool = reduce(refs.nextState, {
      kind: 'action.use_tool',
      ...meta(3),
      tool: { id: 'tool-1', name: 'lookup' },
    });
    expect(tool.update).toMatchObject({ sessionUpdate: 'tool_call' });
    const terminal = reduce(tool.nextState, {
      kind: 'progress',
      ...meta(4),
      status: 'waiting_for_next',
    });
    expect(terminal).toMatchObject({
      terminal: 'idle',
      update: {
        content: {
          type: 'text',
          text: 'Sources:\n- [Guide](https://example.test/guide)',
        },
      },
    });
  });

  it('bounds descriptions, references, and maps pending and failed tool states', () => {
    const long = reduce(initialAimeEventState(), {
      kind: 'action.use_tool',
      ...meta(),
      tool: {
        id: 'tool-pending',
        name: 'lookup',
        status: 'pending',
        description: 'x'.repeat(501),
      },
    });
    expect(long.update).toMatchObject({
      status: 'pending',
      content: [{ content: { text: 'x'.repeat(500) } }],
    });
    const failed = reduce(long.nextState, {
      kind: 'action.use_tool',
      ...meta(2),
      tool: { id: 'tool-failed', name: 'lookup', status: 'failed' },
    });
    expect(failed.update).toMatchObject({ status: 'failed' });
    const references = Array.from({ length: 21 }, (_, index) => ({
      id: String(index),
      title: `Guide ${index}`,
      uri: `https://example.test/${index}`,
      snippet: 'synthetic',
    }));
    const result = reduce(failed.nextState, {
      kind: 'reference',
      ...meta(3),
      references: [...references, ...references.slice(0, 1)],
    });
    expect(result.nextState.references).toHaveLength(20);
    expect(
      result.nextState.references.map((reference) => reference.id),
    ).toEqual(Array.from({ length: 20 }, (_, index) => String(index)));
  });

  it('renders exact HELP output and awaits a user response', () => {
    const result = reduce(initialAimeEventState(), {
      kind: 'action.tool_call_required',
      ...meta(),
      question: 'Choose one.',
      options: ['One', 'Two'],
    });
    expect(result).toMatchObject({
      terminal: 'awaiting_user',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'HELP: AIME 需要你补充信息：\n\nChoose one.\n\n- One\n- Two\n\n请在下一条消息中直接回答。',
        },
      },
    });
  });

  it('ignores a benign unknown event and never produces more than one update', () => {
    const result = reduce(initialAimeEventState(), {
      kind: 'unknown',
      ...meta(),
    });
    expect(result.update).toBeUndefined();
    expect(result.terminal).toBeUndefined();
  });
});
