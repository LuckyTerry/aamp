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

function updates() {
  const values: unknown[] = [];
  return {
    notifications: new OrderedNotifications(async ({ update }) => {
      values.push(update);
    }),
    values,
  };
}

describe('TurnRuntime happy path', () => {
  it('accepts the RFC3339 positive-offset timestamp returned by AIME', async () => {
    const offsetSentAt = '2026-08-14T03:12:42+08:00';
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: offsetSentAt })
      .onStream([
        event(
          0,
          { kind: 'progress', status: 'preparing' },
          Date.parse(offsetSentAt),
        ),
        {
          ...event(
            16,
            { kind: 'progress', status: 'thinking' },
            Date.parse(offsetSentAt) + 1,
          ),
          eventId: 'progress-thinking',
        } as NormalizedAimeEvent,
        {
          ...event(
            0,
            {
              kind: 'message.create',
              message: { id: 'user-1', role: 'user', content: 'question' },
            },
            Date.parse(offsetSentAt),
          ),
          eventId: 'user-create',
        } as NormalizedAimeEvent,
        {
          ...event(
            16,
            {
              kind: 'message.create',
              message: { id: 'assistant-1', role: 'assistant', content: '' },
              replyMessageId: 'user-1',
            },
            Date.parse(offsetSentAt) + 1,
          ),
          eventId: 'assistant-create',
        } as NormalizedAimeEvent,
        event(
          19,
          {
            kind: 'message.delta',
            messageId: 'assistant-1',
            content: 'answer',
            finished: true,
          },
          Date.parse(offsetSentAt) + 2,
        ),
        event(
          22,
          { kind: 'progress', status: 'waiting_for_next' },
          Date.parse(offsetSentAt) + 3,
        ),
      ]);
    const manager = new SessionManager(fake);
    await manager.load('session-1');

    await expect(
      new TurnRuntime(manager, fake, updates().notifications).prompt(
        'session-1',
        'question',
      ),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(fake.streamCalls).toEqual([
      { sessionId: 'session-1', eventOffset: 0 },
    ]);
  });

  it('uses one remote session across turns without replaying a prior chunk', async () => {
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([
        event(0, {
          kind: 'message.create',
          message: { id: 'user-1', role: 'user', content: 'question' },
        }),
        event(1, {
          kind: 'message.create',
          message: { id: 'assistant-1', role: 'assistant', content: '' },
          replyMessageId: 'user-1',
        }),
        event(2, {
          kind: 'message.delta',
          messageId: 'assistant-1',
          content: 'hello',
          finished: true,
        }),
        event(3, { kind: 'progress', status: 'waiting_for_next' }),
      ])
      .onSend({ messageId: 'user-2', createdAt: '2026-08-13T00:01:00.000Z' })
      .onStream([
        event(
          4,
          {
            kind: 'message.create',
            message: { id: 'user-2', role: 'user', content: 'again' },
          },
          Date.parse('2026-08-13T00:01:00.000Z') + 4,
        ),
        event(
          5,
          {
            kind: 'message.create',
            message: { id: 'assistant-2', role: 'assistant', content: '' },
            replyMessageId: 'user-2',
          },
          Date.parse('2026-08-13T00:01:00.000Z') + 5,
        ),
        event(
          6,
          {
            kind: 'message.delta',
            messageId: 'assistant-2',
            content: 'again',
            finished: true,
          },
          Date.parse('2026-08-13T00:01:00.000Z') + 6,
        ),
        event(
          7,
          { kind: 'progress', status: 'waiting_for_next' },
          Date.parse('2026-08-13T00:01:00.000Z') + 7,
        ),
      ]);
    const manager = new SessionManager(fake);
    await manager.load('session-1');
    const sink = updates();
    const runtime = new TurnRuntime(manager, fake, sink.notifications, {
      model: 'model-1',
      locale: 'en-US',
      executionMode: 'fast',
    });

    await expect(runtime.prompt('session-1', 'question')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    const beforeReload = manager.get('session-1');
    await expect(manager.load('session-1')).resolves.toBe(beforeReload);
    expect(
      fake.calls.filter((call) => call.method === 'getSession'),
    ).toHaveLength(1);
    await expect(runtime.prompt('session-1', 'again')).resolves.toEqual({
      stopReason: 'end_turn',
    });

    expect(fake.sendCalls).toHaveLength(2);
    expect(fake.sendCalls.map((call) => call.sessionId)).toEqual([
      'session-1',
      'session-1',
    ]);
    expect(fake.streamCalls).toEqual([
      { sessionId: 'session-1', eventOffset: 0 },
      { sessionId: 'session-1', eventOffset: 4 },
    ]);
    expect(sink.values).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'assistant-1',
        content: { type: 'text', text: 'hello' },
      }),
    );
    expect(
      sink.values.filter((value) => JSON.stringify(value).includes('hello')),
    ).toHaveLength(1);
    expect(manager.get('session-1').turnState).toBe('Idle');
  });

  it('accepts a follow-up user create at the prior inclusive offset after a forward event', async () => {
    const followupSentAt = '2026-08-13T00:01:00.000Z';
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([
        {
          ...event(0, {
            kind: 'message.create',
            message: { id: 'user-1', role: 'user', content: 'question' },
          }),
          eventId: 'user-create-1',
        } as NormalizedAimeEvent,
        {
          ...event(16, {
            kind: 'message.create',
            message: {
              id: 'assistant-1',
              role: 'assistant',
              content: 'first answer',
            },
            replyMessageId: 'user-1',
          }),
          eventId: 'assistant-create-1',
        } as NormalizedAimeEvent,
        {
          ...event(31, { kind: 'progress', status: 'waiting_for_next' }),
          eventId: 'waiting-1',
        } as NormalizedAimeEvent,
      ])
      .onSend({ messageId: 'user-2', createdAt: followupSentAt })
      .onStream([
        {
          ...event(
            49,
            { kind: 'progress', status: 'thinking' },
            Date.parse(followupSentAt) + 1_000,
          ),
          eventId: 'thinking-2',
        } as NormalizedAimeEvent,
        {
          ...event(
            31,
            {
              kind: 'message.create',
              message: { id: 'user-2', role: 'user', content: 'follow up' },
            },
            Date.parse(followupSentAt),
          ),
          eventId: 'user-create-2',
        } as NormalizedAimeEvent,
        {
          ...event(
            49,
            {
              kind: 'message.create',
              message: {
                id: 'assistant-2',
                role: 'assistant',
                content: 'second answer',
              },
              replyMessageId: 'user-2',
            },
            Date.parse(followupSentAt) + 1_000,
          ),
          eventId: 'assistant-create-2',
        } as NormalizedAimeEvent,
        {
          ...event(
            52,
            { kind: 'progress', status: 'waiting_for_next' },
            Date.parse(followupSentAt) + 2_000,
          ),
          eventId: 'waiting-2',
        } as NormalizedAimeEvent,
      ]);
    const manager = new SessionManager(fake);
    await manager.load('session-1');
    const runtime = new TurnRuntime(manager, fake, updates().notifications);

    await expect(runtime.prompt('session-1', 'question')).resolves.toEqual({
      stopReason: 'end_turn',
    });
    await expect(runtime.prompt('session-1', 'follow up')).resolves.toEqual({
      stopReason: 'end_turn',
    });

    expect(fake.streamCalls).toEqual([
      { sessionId: 'session-1', eventOffset: 0 },
      { sessionId: 'session-1', eventOffset: 32 },
    ]);
    expect(manager.get('session-1').turnState).toBe('Idle');
  });

  it('keeps streaming after a finished delta and emits current sources last', async () => {
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([
        event(0, {
          kind: 'message.create',
          message: { id: 'user-1', role: 'user', content: 'question' },
        }),
        event(1, {
          kind: 'message.create',
          message: { id: 'assistant-1', role: 'assistant', content: '' },
          replyMessageId: 'user-1',
        }),
        event(2, {
          kind: 'message.delta',
          messageId: 'assistant-1',
          content: 'answer',
          finished: true,
        }),
        event(3, {
          kind: 'reference',
          references: [
            {
              id: 'ref-1',
              title: 'Guide',
              uri: 'https://example.test/guide',
              snippet: '',
            },
          ],
        }),
        event(4, {
          kind: 'action.use_tool',
          tool: { id: 'tool-1', name: 'lookup', description: 'Checked guide' },
        }),
        event(5, { kind: 'progress', status: 'waiting_for_next' }),
      ]);
    const manager = new SessionManager(fake);
    await manager.load('session-1');
    const sink = updates();

    await expect(
      new TurnRuntime(manager, fake, sink.notifications).prompt(
        'session-1',
        'question',
      ),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(sink.values.at(-1)).toEqual(
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'aime-sources',
        _meta: { 'aime.acp.message_kind': 'sources' },
        content: {
          type: 'text',
          text: 'Sources:\n- [Guide](https://example.test/guide)',
        },
      }),
    );
  });

  it('allows exactly one active turn per loaded session', async () => {
    const fake = new ScriptedAimeTransport().onSession({
      id: 'session-1',
      sourceSpaceId: 'space-1',
    });
    const manager = new SessionManager(fake);
    await manager.load('session-1');

    manager.beginTurn('session-1');
    expect(() => manager.beginTurn('session-1')).toThrowError(
      expect.objectContaining({ code: 'SESSION_BUSY' }),
    );
    expect(() => manager.beginTurn('missing')).toThrowError(
      expect.objectContaining({ code: 'AIME_SESSION_NOT_FOUND' }),
    );
  });

  it('awaits user input for a current tool question', async () => {
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([
        event(0, {
          kind: 'message.create',
          message: { id: 'user-1', role: 'user', content: 'question' },
        }),
        event(1, {
          kind: 'action.tool_call_required',
          question: 'Which environment?',
          options: ['Test'],
        }),
      ]);
    const manager = new SessionManager(fake);
    await manager.load('session-1');
    const sink = updates();

    await expect(
      new TurnRuntime(manager, fake, sink.notifications).prompt(
        'session-1',
        'question',
      ),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(manager.get('session-1').turnState).toBe('AwaitingUserInput');
    expect(JSON.stringify(sink.values)).toContain('Which environment?');
  });

  it('fails an empty terminal turn after committing its terminal cursor event', async () => {
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([
        event(0, {
          kind: 'message.create',
          message: { id: 'user-1', role: 'user', content: 'question' },
        }),
        event(1, {
          kind: 'message.create',
          message: { id: 'assistant-1', role: 'assistant', content: '' },
          replyMessageId: 'user-1',
        }),
        event(2, { kind: 'progress', status: 'waiting_for_next' }),
      ]);
    const manager = new SessionManager(fake);
    await manager.load('session-1');

    await expect(
      new TurnRuntime(manager, fake, updates().notifications).prompt(
        'session-1',
        'question',
      ),
    ).rejects.toMatchObject({ code: 'AIME_EMPTY_RESPONSE' });
    expect(manager.get('session-1').cursor.nextEventOffset).toBe(3);
    expect(manager.get('session-1').turnState).toBe('Idle');
  });

  it('does not commit a notification-rejected delta', async () => {
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([
        event(0, {
          kind: 'message.create',
          message: { id: 'user-1', role: 'user', content: 'question' },
        }),
        event(1, {
          kind: 'message.create',
          message: { id: 'assistant-1', role: 'assistant', content: '' },
          replyMessageId: 'user-1',
        }),
        event(2, {
          kind: 'message.delta',
          messageId: 'assistant-1',
          content: 'answer',
          finished: true,
        }),
      ]);
    const manager = new SessionManager(fake);
    await manager.load('session-1');
    const notifications = new OrderedNotifications(async () => {
      throw new Error('closed');
    });
    const runtime = new TurnRuntime(manager, fake, notifications);

    await expect(runtime.prompt('session-1', 'question')).rejects.toMatchObject(
      { code: 'AIME_STREAM_INTERRUPTED' },
    );
    expect(manager.get('session-1').cursor.nextEventOffset).toBe(2);
    expect(manager.get('session-1').turnState).toBe('Desynced');
    await expect(runtime.prompt('session-1', 'retry')).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
  });

  it('desyncs after an unconfirmed send attempt but keeps a model failure idle', async () => {
    const sendFailure = new ScriptedAimeTransport().onSession({
      id: 'session-1',
      sourceSpaceId: 'space-1',
    });
    sendFailure.sendMessage = async () => {
      throw new Error('connection closed after request');
    };
    const desynced = new SessionManager(sendFailure);
    await desynced.load('session-1');

    await expect(
      new TurnRuntime(desynced, sendFailure, updates().notifications).prompt(
        'session-1',
        'question',
      ),
    ).rejects.toMatchObject({ code: 'AIME_SEND_FAILED' });
    expect(desynced.get('session-1').turnState).toBe('Desynced');

    const modelFailure = new ScriptedAimeTransport().onSession({
      id: 'session-2',
      sourceSpaceId: 'space-1',
    });
    modelFailure.resolveModel = async () => {
      throw new Error('model lookup unavailable');
    };
    const idle = new SessionManager(modelFailure);
    await idle.load('session-2');

    await expect(
      new TurnRuntime(idle, modelFailure, updates().notifications).prompt(
        'session-2',
        'question',
      ),
    ).rejects.toMatchObject({ code: 'AIME_SEND_FAILED' });
    expect(idle.get('session-2').turnState).toBe('Idle');
  });

  it('returns the owned state without fetching while a stream is active', async () => {
    let releaseStream: (() => void) | undefined;
    let streamPaused: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const pauseObserved = new Promise<void>((resolve) => {
      streamPaused = resolve;
    });
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStreamPause(() => streamPaused?.())
      .onStream([
        event(0, {
          kind: 'message.create',
          message: { id: 'user-1', role: 'user', content: 'question' },
        }),
        paused,
        event(1, {
          kind: 'message.create',
          message: { id: 'assistant-1', role: 'assistant', content: '' },
          replyMessageId: 'user-1',
        }),
        event(2, {
          kind: 'message.delta',
          messageId: 'assistant-1',
          content: 'answer',
          finished: true,
        }),
        event(3, { kind: 'progress', status: 'waiting_for_next' }),
      ]);
    const manager = new SessionManager(fake);
    await manager.load('session-1');
    const runtime = new TurnRuntime(manager, fake, updates().notifications);
    const prompt = runtime.prompt('session-1', 'question');
    await pauseObserved;

    const active = manager.get('session-1');
    expect(active.turnState).toBe('Streaming');
    await expect(manager.load('session-1')).resolves.toBe(active);
    expect(
      fake.calls.filter((call) => call.method === 'getSession'),
    ).toHaveLength(1);

    releaseStream?.();
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
  });
});
