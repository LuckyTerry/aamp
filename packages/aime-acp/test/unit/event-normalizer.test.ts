import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeAimeEvent } from '../../src/aime/event-normalizer.js';

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      fileURLToPath(
        new URL(`../fixtures/aime-events/${name}`, import.meta.url),
      ),
      'utf8',
    ),
  ) as unknown;
}

describe('normalizeAimeEvent', () => {
  it.each([
    ['message-delta.json', 'message.delta'],
    ['think-tips.json', 'think.tips'],
    ['tool-use.json', 'action.use_tool'],
    ['tool-call-required.json', 'action.tool_call_required'],
  ] as const)('normalizes %s as %s', async (name, kind) => {
    expect(normalizeAimeEvent(await fixture(name))).toMatchObject({ kind });
  });

  it.each([
    ['ping.json', 'ping'],
    ['message-create.json', 'message.create'],
    ['progress.json', 'progress'],
    ['reference.json', 'reference'],
    ['plan-update.json', 'plan.update'],
    ['step-update.json', 'step.update'],
    ['unknown.json', 'unknown'],
  ] as const)('normalizes the pinned %s fixture', async (name, kind) => {
    expect(normalizeAimeEvent(await fixture(name))).toMatchObject({ kind });
  });

  it('normalizes timestamps into milliseconds and keeps only safe type metadata', async () => {
    expect(
      normalizeAimeEvent(await fixture('message-delta.json')),
    ).toMatchObject({
      offset: 2,
      timestampMs: 101_000,
      rawType: 'session.message.delta',
      messageId: 'msg-1',
      content: ' Synthetic continuation.',
      finished: false,
    });
  });

  it('treats the empty AIME reply-message sentinel as no parent message', () => {
    expect(
      normalizeAimeEvent({
        type: 'session.message.create',
        data: {
          event_id: 'event-user-create',
          event_offset: 0,
          timestamp: 101,
          event_key: 'user-create',
          message: {
            message_id: 'message-user',
            role: 'user',
            content: 'Synthetic request',
          },
          reply_message_id: '',
        },
      }),
    ).toEqual({
      kind: 'message.create',
      eventId: 'event-user-create',
      offset: 0,
      timestampMs: 101_000,
      rawType: 'session.message.create',
      message: {
        id: 'message-user',
        role: 'user',
        content: 'Synthetic request',
      },
    });
  });

  it('recovers an unknown question only for the exact registered event type', async () => {
    expect(
      normalizeAimeEvent(await fixture('tool-call-required.json')),
    ).toMatchObject({
      kind: 'action.tool_call_required',
      question: 'Which synthetic option should be used?',
      options: ['First option', 'Second option'],
    });
    expect(
      normalizeAimeEvent({
        type: 'unknown',
        data: {
          eventType: 'session.action.tool_call_required.extra',
          event_offset: 13,
          timestamp: 112,
          raw: { question: 'Do not recover.' },
        },
      }),
    ).toMatchObject({ kind: 'unknown' });
  });

  it('takes a tool identifier from tool_call_id before agent_step_id and step_id', async () => {
    expect(normalizeAimeEvent(await fixture('tool-use.json'))).toMatchObject({
      kind: 'action.use_tool',
      tool: { id: 'call-tool-1' },
    });
  });

  it('falls back to agent_step_id when tool_call_id is absent', () => {
    expect(
      normalizeAimeEvent({
        type: 'session.action.use_tool',
        data: {
          event_id: 'event-tool-fallback',
          event_offset: 88,
          timestamp: 119,
          event_key: 'tool-fallback',
          agent_step_id: 'agent-step-tool',
          step_id: 'plan-step',
          tool_name: 'terminal',
          status: 'running',
          summary: 'Fallback synthetic tool call.',
        },
      }),
    ).toMatchObject({
      kind: 'action.use_tool',
      tool: { id: 'agent-step-tool' },
    });
  });

  it('falls back to a non-empty tool description when summary is empty', () => {
    expect(
      normalizeAimeEvent({
        type: 'session.action.use_tool',
        data: {
          event_id: 'event-tool-completed',
          event_offset: 89,
          timestamp: 120,
          event_key: 'tool-completed',
          agent_step_id: 'agent-step-tool',
          step_id: 'plan-step',
          tool_name: 'terminal',
          status: 'completed',
          summary: '',
          description: 'Completed the synthetic tool call.',
        },
      }),
    ).toMatchObject({
      kind: 'action.use_tool',
      tool: {
        id: 'agent-step-tool',
        name: 'terminal',
        status: 'completed',
        description: 'Completed the synthetic tool call.',
      },
    });
  });

  it('takes a step identifier from agent_step_id before step_id and event_id', () => {
    expect(
      normalizeAimeEvent({
        type: 'session.step.update',
        data: {
          event_id: 'event-step',
          event_offset: 14,
          timestamp: 113,
          event_key: 'step',
          agent_step_id: 'agent-step',
          step_id: 'fallback-step',
          title: 'Synthetic step',
        },
      }),
    ).toMatchObject({ kind: 'step.update', step: { id: 'agent-step' } });
  });

  it('extracts a step summary for title-less production step updates', () => {
    expect(
      normalizeAimeEvent({
        type: 'session.step.update',
        data: {
          event_id: 'event-step',
          event_offset: 15,
          timestamp: 114,
          event_key: 'step',
          agent_step_id: 'agent-step',
          status: 'running',
          summary: '定位目标群聊',
        },
      }),
    ).toMatchObject({
      kind: 'step.update',
      step: { id: 'agent-step', status: 'running', summary: '定位目标群聊' },
    });
  });

  it('rejects a recovered help event when pinned raw metadata is missing', () => {
    expect(() =>
      normalizeAimeEvent({
        type: 'unknown',
        data: {
          eventType: 'session.action.tool_call_required',
          raw: { question: 'Choose a synthetic option.' },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }));
  });

  it.each([
    { question: '', options: [] },
    { question: 'Choose synthetic input.', options: [7] },
    { question: 'Choose synthetic input.', options: [{ label: '' }] },
    { question: 'Choose synthetic input.', options: { label: 'wrong shape' } },
  ])('rejects malformed recovered help content %#', (raw) => {
    expect(() =>
      normalizeAimeEvent({
        type: 'unknown',
        data: {
          eventType: 'session.action.tool_call_required',
          raw: {
            event_id: 'help-bad',
            event_offset: 15,
            timestamp: 114,
            event_key: 'help',
            ...raw,
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }));
  });

  it.each(['malformed-offset.json', 'malformed-message.json'])(
    'rejects malformed pinned data in %s without coercion',
    async (name) => {
      const raw = await fixture(name);
      expect(() => normalizeAimeEvent(raw)).toThrowError(
        expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
      );
    },
  );
});
