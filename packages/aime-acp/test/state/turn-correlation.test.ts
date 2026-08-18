import { describe, expect, it } from 'vitest';

import { OrderedNotifications } from '../../src/acp/notifications.js';
import type { NormalizedAimeEvent } from '../../src/aime/event-types.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { TurnRuntime } from '../../src/session/turn-runtime.js';
import { ScriptedAimeTransport } from '../helpers/fake-aime.js';

const sentAt = '2026-08-13T00:00:00.000Z';

function event<
  T extends Omit<NormalizedAimeEvent, 'offset' | 'timestampMs' | 'rawType'>,
>(
  offset: number,
  value: T,
  timestampMs = Date.parse(sentAt) + offset,
): NormalizedAimeEvent {
  return {
    ...value,
    offset,
    timestampMs,
    rawType: 'synthetic',
  } as NormalizedAimeEvent;
}

async function runtimeFor(events: readonly NormalizedAimeEvent[]) {
  const fake = new ScriptedAimeTransport()
    .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
    .onSend({ messageId: 'user-1', createdAt: sentAt })
    .onStream(events);
  const manager = new SessionManager(fake);
  await manager.load('session-1');
  const values: unknown[] = [];
  const runtime = new TurnRuntime(
    manager,
    fake,
    new OrderedNotifications(async ({ update }) => {
      values.push(update);
    }),
  );
  return { manager, runtime, values };
}

describe('TurnRuntime correlation', () => {
  it('does not emit historical or mismatched assistant events', async () => {
    const { runtime, values } = await runtimeFor([
      event(
        0,
        {
          kind: 'message.create',
          message: { id: 'old', role: 'assistant', content: '' },
          replyMessageId: 'old-user',
        },
        Date.parse(sentAt) - 10_000,
      ),
      event(
        1,
        {
          kind: 'message.delta',
          messageId: 'old',
          content: 'history',
          finished: true,
        },
        Date.parse(sentAt) - 10_000,
      ),
      event(2, {
        kind: 'message.create',
        message: { id: 'user-1', role: 'user', content: 'question' },
      }),
      event(3, {
        kind: 'message.create',
        message: { id: 'wrong', role: 'assistant', content: '' },
        replyMessageId: 'other-user',
      }),
      event(4, {
        kind: 'message.delta',
        messageId: 'wrong',
        content: 'wrong',
        finished: true,
      }),
      event(5, {
        kind: 'message.create',
        message: { id: 'assistant-1', role: 'assistant', content: '' },
        replyMessageId: 'user-1',
      }),
      event(6, {
        kind: 'message.delta',
        messageId: 'another',
        content: 'unrelated',
        finished: true,
      }),
      event(7, {
        kind: 'message.delta',
        messageId: 'assistant-1',
        content: 'current',
        finished: true,
      }),
      event(8, { kind: 'progress', status: 'waiting_for_next' }),
    ]);

    await expect(runtime.prompt('session-1', 'question')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(JSON.stringify(values)).toContain('current');
    expect(JSON.stringify(values)).not.toContain('history');
    expect(JSON.stringify(values)).not.toContain('wrong');
    expect(JSON.stringify(values)).not.toContain('unrelated');
  });

  it('uses only a recent first delta as the no-create fallback', async () => {
    const { runtime, values } = await runtimeFor([
      event(
        0,
        {
          kind: 'message.delta',
          messageId: 'old',
          content: 'history',
          finished: true,
        },
        Date.parse(sentAt) - 1_001,
      ),
      event(1, {
        kind: 'message.delta',
        messageId: 'assistant-1',
        content: 'current',
        finished: true,
      }),
      event(2, { kind: 'progress', status: 'waiting_for_next' }),
    ]);

    await expect(runtime.prompt('session-1', 'question')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(JSON.stringify(values)).toContain('current');
    expect(JSON.stringify(values)).not.toContain('history');
  });

  it('does not let an unrelated recent create suppress delta fallback', async () => {
    const { runtime, values } = await runtimeFor([
      event(0, {
        kind: 'message.create',
        message: { id: 'other-assistant', role: 'assistant', content: '' },
        replyMessageId: 'other-user',
      }),
      event(1, {
        kind: 'message.delta',
        messageId: 'assistant-1',
        content: 'current fallback',
        finished: true,
      }),
      event(2, { kind: 'progress', status: 'waiting_for_next' }),
    ]);

    await expect(runtime.prompt('session-1', 'question')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(JSON.stringify(values)).toContain('current fallback');
  });

  it('emits a reply-less final assistant snapshot after a correlated acknowledgement', async () => {
    const { runtime, values } = await runtimeFor([
      event(0, {
        kind: 'message.create',
        message: { id: 'user-1', role: 'user', content: 'question' },
      }),
      event(1, {
        kind: 'message.create',
        message: {
          id: 'assistant-ack',
          role: 'assistant',
          content: 'acknowledged',
        },
        replyMessageId: 'user-1',
      }),
      event(2, {
        kind: 'message.create',
        message: {
          id: 'assistant-final',
          role: 'assistant',
          content:
            'AAMP_RESULT_JSON: {"output":"FEISHU_TASK_RESULT_JSON: {\\"schema\\":\\"feishu_task_result.v2\\",\\"status\\":\\"answered\\"}"}',
        },
      }),
      event(3, { kind: 'progress', status: 'waiting_for_next' }),
    ]);

    await expect(runtime.prompt('session-1', 'question')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(values).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'acknowledged' },
        messageId: 'assistant-ack',
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'AAMP_RESULT_JSON: {"output":"FEISHU_TASK_RESULT_JSON: {\\"schema\\":\\"feishu_task_result.v2\\",\\"status\\":\\"answered\\"}"}',
        },
        messageId: 'assistant-final',
      },
    ]);
  });

  it('emits a confirmed reply-less snapshot whose live deltas were suppressed', async () => {
    const final =
      'AAMP_RESULT_JSON: {"output":"FEISHU_TASK_RESULT_JSON: {\\"schema\\":\\"feishu_task_result.v2\\",\\"status\\":\\"answered\\"}"}';
    const { runtime, values } = await runtimeFor([
      event(0, {
        kind: 'message.create',
        message: { id: 'user-1', role: 'user', content: 'question' },
      }),
      event(1, {
        kind: 'message.create',
        message: {
          id: 'assistant-ack',
          role: 'assistant',
          content: 'acknowledged',
        },
        replyMessageId: 'user-1',
      }),
      event(2, {
        kind: 'message.delta',
        messageId: 'assistant-final',
        content: final.slice(0, 32),
        finished: false,
      }),
      event(3, {
        kind: 'message.delta',
        messageId: 'assistant-final',
        content: final.slice(32),
        finished: false,
      }),
      event(4, {
        kind: 'message.delta',
        messageId: 'assistant-final',
        content: '',
        finished: true,
      }),
      event(5, {
        kind: 'message.create',
        message: {
          id: 'assistant-final',
          role: 'assistant',
          content: final,
        },
      }),
      event(6, { kind: 'progress', status: 'waiting_for_next' }),
    ]);

    await expect(runtime.prompt('session-1', 'question')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(values).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'acknowledged' },
        messageId: 'assistant-ack',
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: final },
        messageId: 'assistant-final',
      },
    ]);
  });

  it('uses a confirmed reply-less snapshot instead of its suppressed draft deltas', async () => {
    const { runtime, values } = await runtimeFor([
      event(0, {
        kind: 'message.create',
        message: { id: 'user-1', role: 'user', content: 'question' },
      }),
      event(1, {
        kind: 'message.create',
        message: {
          id: 'assistant-ack',
          role: 'assistant',
          content: 'acknowledged',
        },
        replyMessageId: 'user-1',
      }),
      event(2, {
        kind: 'message.delta',
        messageId: 'assistant-final',
        content: 'draft representation',
        finished: true,
      }),
      event(3, {
        kind: 'message.create',
        message: {
          id: 'assistant-final',
          role: 'assistant',
          content: 'authoritative final snapshot',
        },
      }),
      event(4, { kind: 'progress', status: 'waiting_for_next' }),
    ]);

    await expect(runtime.prompt('session-1', 'question')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(values).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'acknowledged' },
        messageId: 'assistant-ack',
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'authoritative final snapshot' },
        messageId: 'assistant-final',
      },
    ]);
  });

  it('updates historical side-channel snapshots without leaking them as prompt output', async () => {
    const { runtime, values } = await runtimeFor([
      event(
        0,
        {
          kind: 'reference',
          references: [
            {
              id: 'old-ref',
              title: 'Old',
              uri: 'https://example.test/old',
              snippet: '',
            },
          ],
        },
        Date.parse(sentAt) - 2_000,
      ),
      event(
        1,
        {
          kind: 'action.use_tool',
          tool: { id: 'old-tool', name: 'lookup', description: 'old tool' },
        },
        Date.parse(sentAt) - 2_000,
      ),
      event(
        2,
        { kind: 'plan.update', plan: { id: 'old-plan', status: 'running' } },
        Date.parse(sentAt) - 2_000,
      ),
      event(3, {
        kind: 'message.create',
        message: { id: 'user-1', role: 'user', content: 'question' },
      }),
      event(4, {
        kind: 'message.create',
        message: { id: 'assistant-1', role: 'assistant', content: '' },
        replyMessageId: 'user-1',
      }),
      event(5, {
        kind: 'message.delta',
        messageId: 'assistant-1',
        content: 'current',
        finished: true,
      }),
      event(6, { kind: 'progress', status: 'waiting_for_next' }),
    ]);

    await expect(runtime.prompt('session-1', 'question')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(JSON.stringify(values)).not.toContain('Old');
    expect(JSON.stringify(values)).not.toContain('old tool');
    expect(JSON.stringify(values)).not.toContain('old-plan');
  });

  it('desyncs a session when a correlated assistant snapshot conflicts', async () => {
    const { manager, runtime } = await runtimeFor([
      event(0, {
        kind: 'message.create',
        message: { id: 'user-1', role: 'user', content: 'question' },
      }),
      event(1, {
        kind: 'message.create',
        message: { id: 'assistant-1', role: 'assistant', content: 'alpha' },
        replyMessageId: 'user-1',
      }),
      event(2, {
        kind: 'message.create',
        message: { id: 'assistant-1', role: 'assistant', content: 'beta' },
        replyMessageId: 'user-1',
      }),
    ]);

    await expect(runtime.prompt('session-1', 'question')).rejects.toMatchObject(
      { code: 'AIME_PROTOCOL_DRIFT' },
    );
    expect(manager.get('session-1').turnState).toBe('Desynced');
  });
});
