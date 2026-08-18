import { describe, expect, it } from 'vitest';

import { OrderedNotifications } from '../../src/acp/notifications.js';
import type { NormalizedAimeEvent } from '../../src/aime/event-types.js';
import { AimeAcpError } from '../../src/errors.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { TurnRuntime } from '../../src/session/turn-runtime.js';
import { ScriptedAimeTransport } from '../helpers/fake-aime.js';
import { ManualClock } from '../helpers/manual-clock.js';

const sentAt = '2026-08-13T00:00:00.000Z';
const timestamp = Date.parse(sentAt);

function event<
  T extends Omit<NormalizedAimeEvent, 'offset' | 'timestampMs' | 'rawType'>,
>(offset: number, value: T): NormalizedAimeEvent {
  return {
    ...value,
    offset,
    timestampMs: timestamp + offset,
    rawType: 'test',
  } as NormalizedAimeEvent;
}

function terminal(offset: number): NormalizedAimeEvent[] {
  return [
    event(offset, {
      kind: 'message.delta',
      messageId: 'assistant-1',
      content: ' world',
      finished: true,
    }),
    event(offset + 1, { kind: 'progress', status: 'waiting_for_next' }),
  ];
}

async function setup(fake: ScriptedAimeTransport, clock: ManualClock) {
  const values: unknown[] = [];
  const manager = new SessionManager(fake);
  await manager.load('session-1');
  const runtime = new TurnRuntime(
    manager,
    fake,
    new OrderedNotifications(async ({ update }) => {
      values.push(update);
    }),
    {},
    clock,
  );
  return { manager, runtime, values };
}

describe('TurnRuntime reconnect', () => {
  it('reopens the latest inclusive offset group without losing a sibling event', async () => {
    const clock = new ManualClock();
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([
        event(0, {
          kind: 'message.create',
          message: { id: 'user-1', role: 'user', content: 'work' },
        }),
        event(1, {
          kind: 'message.create',
          message: { id: 'assistant-1', role: 'assistant', content: '' },
          replyMessageId: 'user-1',
        }),
        {
          ...event(18, {
            kind: 'message.delta',
            messageId: 'assistant-1',
            content: 'hello',
            finished: false,
          }),
          eventId: 'event-18-a',
        } as NormalizedAimeEvent,
        new Error('disconnect'),
      ])
      .onStream([
        {
          ...event(18, {
            kind: 'message.delta',
            messageId: 'assistant-1',
            content: 'hello',
            finished: false,
          }),
          eventId: 'event-18-a',
        } as NormalizedAimeEvent,
        {
          ...event(18, {
            kind: 'message.delta',
            messageId: 'assistant-1',
            content: ' world',
            finished: true,
          }),
          eventId: 'event-18-b',
        } as NormalizedAimeEvent,
        event(19, { kind: 'progress', status: 'waiting_for_next' }),
      ]);
    const { manager, runtime, values } = await setup(fake, clock);

    const prompt = runtime.prompt('session-1', 'work');
    await clock.flush();
    expect(clock.sleepDurations.filter((ms) => ms < 20_000)).toEqual([250]);
    await clock.advance(250);
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });

    expect(fake.streamCalls).toEqual([
      { sessionId: 'session-1', eventOffset: 0 },
      { sessionId: 'session-1', eventOffset: 0 },
    ]);
    expect(
      values.filter((value) => JSON.stringify(value).includes('hello')),
    ).toHaveLength(1);
    expect(
      values.filter((value) => JSON.stringify(value).includes(' world')),
    ).toHaveLength(1);
    expect(manager.get('session-1').cursor.nextEventOffset).toBe(20);
    expect(clock.deadlineDurations).toContain(20_000);
  });

  it('uses capped backoff and resets it only after a newly committed event', async () => {
    const clock = new ManualClock();
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([new Error('one')])
      .onStream([new Error('two')])
      .onStream([new Error('three')])
      .onStream([
        event(0, {
          kind: 'message.create',
          message: { id: 'user-1', role: 'user', content: 'work' },
        }),
        new Error('four'),
      ])
      .onStream([
        event(1, {
          kind: 'message.create',
          message: { id: 'assistant-1', role: 'assistant', content: '' },
          replyMessageId: 'user-1',
        }),
        ...terminal(2),
      ]);
    const { runtime } = await setup(fake, clock);

    const prompt = runtime.prompt('session-1', 'work');
    for (const delay of [250, 500, 1000, 250]) {
      await clock.flush();
      await clock.advance(delay);
    }
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
    expect(clock.sleepDurations.filter((ms) => ms < 20_000)).toEqual([
      250, 500, 1000, 250,
    ]);
  });

  it.each([
    ['AUTH_REQUIRED', 'logged out'],
    ['AUTH_IDENTITY_CHANGED', 'identity switched'],
  ] as const)('does not retry %s from a reconnect', async (code, message) => {
    const clock = new ManualClock();
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([new Error('disconnect')])
      .onStream([new AimeAcpError(code, message, false)]);
    const { manager, runtime } = await setup(fake, clock);

    const prompt = runtime.prompt('session-1', 'work');
    await clock.flush();
    await clock.advance(250);
    await expect(prompt).rejects.toMatchObject({ code });
    expect(fake.streamCalls).toHaveLength(2);
    expect(manager.get('session-1').turnState).toBe('Desynced');
  });

  it.each([
    ['AIME_PROTOCOL_DRIFT', 'bad event'],
    ['AIME_ACCESS_DENIED', 'forbidden'],
  ] as const)(
    'does not retry nonretryable stream error %s',
    async (code, message) => {
      const clock = new ManualClock();
      const fake = new ScriptedAimeTransport()
        .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
        .onSend({ messageId: 'user-1', createdAt: sentAt })
        .onStream([new AimeAcpError(code, message, false)]);
      const { manager, runtime } = await setup(fake, clock);
      let outcome: unknown;
      void runtime.prompt('session-1', 'work').then(
        (value) => {
          outcome = value;
        },
        (error: unknown) => {
          outcome = error;
        },
      );

      await clock.flush();
      expect(outcome).toMatchObject({ code });
      expect(fake.streamCalls).toHaveLength(1);
      expect(manager.get('session-1').turnState).toBe('Desynced');
    },
  );

  it('stops after eight retries and desyncs', async () => {
    const clock = new ManualClock();
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt });
    for (let index = 0; index < 9; index += 1)
      fake.onStream([new Error(`disconnect-${index}`)]);
    const { manager, runtime } = await setup(fake, clock);

    const prompt = runtime.prompt('session-1', 'work');
    for (const delay of [250, 500, 1000, 2000, 5000, 5000, 5000, 5000]) {
      await clock.flush();
      await clock.advance(delay);
    }
    await expect(prompt).rejects.toMatchObject({
      code: 'AIME_STREAM_INTERRUPTED',
    });
    expect(fake.streamCalls).toHaveLength(9);
    expect(manager.get('session-1').turnState).toBe('Desynced');
  });

  it('uses guarded remote state after two empty streams for verified completion', async () => {
    const clock = new ManualClock();
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onGetSession({
        id: 'session-1',
        sourceSpaceId: 'space-1',
        status: 'waiting_for_next',
      })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([
        event(0, {
          kind: 'message.create',
          message: { id: 'user-1', role: 'user', content: 'work' },
        }),
        event(1, {
          kind: 'message.create',
          message: { id: 'assistant-1', role: 'assistant', content: '' },
          replyMessageId: 'user-1',
        }),
        event(2, {
          kind: 'message.delta',
          messageId: 'assistant-1',
          content: 'done',
          finished: true,
        }),
      ])
      .onStream([])
      .onStream([]);
    const { manager, runtime } = await setup(fake, clock);

    const prompt = runtime.prompt('session-1', 'work');
    await clock.flush();
    await clock.advance(250);
    await clock.advance(500);
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
    expect(
      fake.calls.filter((call) => call.method === 'getSession'),
    ).toHaveLength(2);
    expect(manager.get('session-1').turnState).toBe('Idle');
  });

  it('turns verified empty completion into a known-terminal empty response', async () => {
    const clock = new ManualClock();
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onGetSession({
        id: 'session-1',
        sourceSpaceId: 'space-1',
        status: 'waiting_for_next',
      })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([
        event(0, {
          kind: 'message.create',
          message: { id: 'user-1', role: 'user', content: 'work' },
        }),
        event(1, {
          kind: 'message.create',
          message: { id: 'assistant-1', role: 'assistant', content: '' },
          replyMessageId: 'user-1',
        }),
        event(2, {
          kind: 'message.delta',
          messageId: 'assistant-1',
          content: '',
          finished: true,
        }),
      ])
      .onStream([])
      .onStream([]);
    const { manager, runtime } = await setup(fake, clock);
    let outcome: unknown;
    void runtime.prompt('session-1', 'work').then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    await clock.flush();
    await clock.advance(250);
    await clock.advance(500);
    expect(outcome).toMatchObject({ code: 'AIME_EMPTY_RESPONSE' });
    expect(fake.streamCalls).toHaveLength(3);
    expect(manager.get('session-1').turnState).toBe('Idle');
  });

  it('stops on the 60 second wall budget before another reconnect', async () => {
    const clock = new ManualClock();
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt });
    for (let index = 0; index < 8; index += 1) {
      fake.onStream([
        event(index, { kind: 'progress', status: 'thinking' }),
        new Error('disconnect'),
      ]);
    }
    const { manager, runtime } = await setup(fake, clock);
    const prompt = runtime.prompt('session-1', 'work');
    for (let index = 0; index < 7; index += 1) {
      await clock.flush();
      await clock.advance(10_000);
    }
    await expect(prompt).rejects.toMatchObject({
      code: 'AIME_STREAM_INTERRUPTED',
    });
    expect(manager.get('session-1').turnState).toBe('Desynced');
  });
});
