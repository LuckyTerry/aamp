import { describe, expect, it } from 'vitest';

import { OrderedNotifications } from '../../src/acp/notifications.js';
import type { NormalizedAimeEvent } from '../../src/aime/event-types.js';
import { AimeAcpError } from '../../src/errors.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { TurnRuntime } from '../../src/session/turn-runtime.js';
import { ScriptedAimeTransport } from '../helpers/fake-aime.js';
import { ManualClock } from '../helpers/manual-clock.js';

const sentAt = '2026-08-13T00:00:00.000Z';

function event<
  T extends Omit<NormalizedAimeEvent, 'offset' | 'timestampMs' | 'rawType'>,
>(offset: number, value: T): NormalizedAimeEvent {
  return {
    ...value,
    offset,
    timestampMs: Date.parse(sentAt) + offset,
    rawType: 'test',
  } as NormalizedAimeEvent;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function initialEvents(
  gate: Promise<void>,
): Array<NormalizedAimeEvent | Promise<void>> {
  return [
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
      content: 'partial',
      finished: false,
    }),
    gate,
  ];
}

function drainEvents(offset = 3): NormalizedAimeEvent[] {
  return [
    event(offset, {
      kind: 'message.delta',
      messageId: 'assistant-1',
      content: ' hidden',
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

describe('TurnRuntime soft cancellation', () => {
  it.each([
    [
      'waiting_for_next',
      event(0, { kind: 'progress', status: 'waiting_for_next' }),
      'Idle',
    ],
    [
      'tool_call_required',
      event(0, {
        kind: 'action.tool_call_required',
        question: 'Choose?',
        options: ['A'],
      }),
      'AwaitingUserInput',
    ],
  ] as const)(
    'closes the cancelled drain iterator after %s terminal state',
    async (_terminal, terminalEvent, expectedState) => {
      const clock = new ManualClock();
      const send = deferred<{ messageId: string; createdAt: string }>();
      const cleanup: Array<{ aborted: boolean }> = [];
      const fake = new ScriptedAimeTransport().onSession({
        id: 'session-1',
        sourceSpaceId: 'space-1',
      });
      fake.sendMessage = async (input) => {
        fake.sendCalls.push(input);
        return send.promise;
      };
      fake.streamEvents = async function* (input) {
        this.calls.push({ method: 'streamEvents' });
        this.streamCalls.push({
          sessionId: input.sessionId,
          eventOffset: input.eventOffset,
        });
        try {
          yield terminalEvent;
        } finally {
          cleanup.push({ aborted: input.signal.aborted });
        }
      };
      const { manager, runtime } = await setup(fake, clock);

      const prompt = runtime.prompt('session-1', 'work');
      await clock.flush();
      expect(runtime.cancel('session-1')).toBe(true);
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
      send.resolve({ messageId: 'user-1', createdAt: sentAt });
      await clock.flush();
      await expect(manager.drainFor('session-1')).resolves.toBeUndefined();

      expect(manager.get('session-1').turnState).toBe(expectedState);
      expect(cleanup).toEqual([{ aborted: true }]);
      expect(clock.pendingDeadlines).toBe(0);
    },
  );

  it('returns cancelled during streaming and drains silently before releasing the session', async () => {
    const clock = new ManualClock();
    const gate = deferred<void>();
    const drainGate = deferred<void>();
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream(initialEvents(gate.promise))
      .onStream([drainGate.promise, ...drainEvents()]);
    const { manager, runtime, values } = await setup(fake, clock);

    const prompt = runtime.prompt('session-1', 'work');
    await clock.flush();
    expect(runtime.cancel('session-1')).toBe(true);
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    expect(manager.get('session-1').turnState).toBe('Draining');
    await expect(runtime.prompt('session-1', 'too soon')).rejects.toMatchObject(
      { code: 'SESSION_BUSY' },
    );
    drainGate.resolve();
    await expect(manager.drainFor('session-1')).resolves.toBeUndefined();
    expect(manager.get('session-1').turnState).toBe('Idle');
    expect(
      values.filter((value) => JSON.stringify(value).includes('hidden')),
    ).toEqual([]);
    expect(fake.sendCalls).toHaveLength(1);
    expect(clock.pendingSleeps).toBe(0);
    expect(clock.pendingDeadlines).toBe(0);
    gate.resolve();
  });

  it('aborts reconnect sleep and starts the drain from the committed offset', async () => {
    const clock = new ManualClock();
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt })
      .onStream([
        event(0, {
          kind: 'message.create',
          message: { id: 'user-1', role: 'user', content: 'work' },
        }),
        new Error('disconnect'),
      ])
      .onStream([
        event(1, {
          kind: 'message.create',
          message: { id: 'assistant-1', role: 'assistant', content: '' },
          replyMessageId: 'user-1',
        }),
        ...drainEvents(2),
      ]);
    const { manager, runtime } = await setup(fake, clock);

    const prompt = runtime.prompt('session-1', 'work');
    await clock.flush();
    expect(manager.get('session-1').turnState).toBe('Reconnecting');
    expect(runtime.cancel('session-1')).toBe(true);
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    await expect(manager.drainFor('session-1')).resolves.toBeUndefined();
    expect(fake.streamCalls.map((call) => call.eventOffset)).toEqual([0, 0]);
    expect(manager.get('session-1').turnState).toBe('Idle');
  });

  it('continues an unresolved send once, then drains with returned metadata', async () => {
    const clock = new ManualClock();
    const send = deferred<{ messageId: string; createdAt: string }>();
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
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
        ...drainEvents(2),
      ]);
    fake.sendMessage = async (input) => {
      fake.sendCalls.push(input);
      return send.promise;
    };
    const { manager, runtime } = await setup(fake, clock);

    const prompt = runtime.prompt('session-1', 'work');
    await clock.flush();
    expect(runtime.cancel('session-1')).toBe(true);
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    send.resolve({ messageId: 'user-1', createdAt: sentAt });
    await clock.flush();
    await expect(manager.drainFor('session-1')).resolves.toBeUndefined();
    expect(fake.sendCalls).toHaveLength(1);
    expect(manager.get('session-1').turnState).toBe('Idle');
  });

  it('safely releases a definitely failed unresolved send', async () => {
    const clock = new ManualClock();
    const send = deferred<{ messageId: string; createdAt: string }>();
    const fake = new ScriptedAimeTransport().onSession({
      id: 'session-1',
      sourceSpaceId: 'space-1',
    });
    fake.sendMessage = async () => send.promise;
    const { manager, runtime } = await setup(fake, clock);

    const prompt = runtime.prompt('session-1', 'work');
    await clock.flush();
    runtime.cancel('session-1');
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    send.reject(new AimeAcpError('AUTH_REQUIRED', 'logged out', false));
    await clock.flush();
    await expect(manager.drainFor('session-1')).resolves.toBeUndefined();
    expect(manager.get('session-1').turnState).toBe('Idle');
  });

  it('desyncs after a 30 second unresolved-send timeout and ignores a late result', async () => {
    const clock = new ManualClock();
    const send = deferred<{ messageId: string; createdAt: string }>();
    const fake = new ScriptedAimeTransport().onSession({
      id: 'session-1',
      sourceSpaceId: 'space-1',
    });
    fake.sendMessage = async () => send.promise;
    const { manager, runtime } = await setup(fake, clock);

    const prompt = runtime.prompt('session-1', 'work');
    await clock.flush();
    runtime.cancel('session-1');
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    await clock.advance(30_000);
    await expect(manager.drainFor('session-1')).resolves.toBeUndefined();
    expect(manager.get('session-1').turnState).toBe('Desynced');
    send.resolve({ messageId: 'user-1', createdAt: sentAt });
    await clock.flush();
    expect(manager.get('session-1').turnState).toBe('Desynced');
    expect(runtime.cancel('session-1')).toBe(false);
    expect(runtime.cancel('missing')).toBe(false);
  });

  it.each([
    ['waiting', 'Idle'],
    ['question', 'AwaitingUserInput'],
  ] as const)(
    'does not drain after a gated %s terminal wins cancellation',
    async (kind, expectedState) => {
      const clock = new ManualClock();
      const notificationEntered = deferred<void>();
      const releaseNotification = deferred<void>();
      const terminalEvents: NormalizedAimeEvent[] =
        kind === 'waiting'
          ? [
              event(2, {
                kind: 'reference',
                references: [
                  {
                    id: 'source-1',
                    title: 'Source',
                    uri: 'https://example.test/source',
                    snippet: '',
                  },
                ],
              }),
              event(3, { kind: 'progress', status: 'waiting_for_next' }),
            ]
          : [
              event(2, {
                kind: 'action.tool_call_required',
                question: 'Choose?',
                options: ['A'],
              }),
            ];
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
          ...terminalEvents,
        ]);
      const manager = new SessionManager(fake);
      await manager.load('session-1');
      const notifications = new OrderedNotifications(async () => {
        notificationEntered.resolve();
        await releaseNotification.promise;
      });
      const runtime = new TurnRuntime(manager, fake, notifications, {}, clock);

      const prompt = runtime.prompt('session-1', 'work');
      await notificationEntered.promise;
      expect(runtime.cancel('session-1')).toBe(true);
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
      releaseNotification.resolve();
      await clock.flush();
      await expect(manager.drainFor('session-1')).resolves.toBeUndefined();
      expect(manager.get('session-1').turnState).toBe(expectedState);
      expect(manager.pendingDrainCount).toBe(0);
      expect(fake.streamCalls).toHaveLength(1);
    },
  );

  it('skips draining when a committed empty terminal wins cancellation', async () => {
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
        event(2, { kind: 'progress', status: 'waiting_for_next' }),
      ]);
    const { manager, runtime } = await setup(fake, clock);
    const prompt = runtime.prompt('session-1', 'work');
    const active = manager.get('session-1').activeTurn;
    if (active === undefined) throw new Error('active turn missing');
    const cancelAtTerminal = active.foregroundDone.then(() =>
      runtime.cancel('session-1'),
    );

    await expect(prompt).rejects.toMatchObject({ code: 'AIME_EMPTY_RESPONSE' });
    expect(await cancelAtTerminal).toBe(false);
    await clock.flush();
    await expect(manager.drainFor('session-1')).resolves.toBeUndefined();
    expect(manager.get('session-1').turnState).toBe('Idle');
    expect(manager.pendingDrainCount).toBe(0);
    expect(fake.streamCalls).toHaveLength(1);
  });

  it('releases a cancelled turn when an in-flight empty terminal commits', async () => {
    const clock = new ManualClock();
    const beforeTerminal = deferred<void>();
    const releaseTerminal = deferred<void>();
    const fake = new ScriptedAimeTransport()
      .onSession({ id: 'session-1', sourceSpaceId: 'space-1' })
      .onSend({ messageId: 'user-1', createdAt: sentAt });
    fake.streamEvents = async function* (input) {
      this.calls.push({ method: 'streamEvents' });
      this.streamCalls.push({
        sessionId: input.sessionId,
        eventOffset: input.eventOffset,
      });
      yield event(0, {
        kind: 'message.create',
        message: { id: 'user-1', role: 'user', content: 'work' },
      });
      yield event(1, {
        kind: 'message.create',
        message: { id: 'assistant-1', role: 'assistant', content: '' },
        replyMessageId: 'user-1',
      });
      beforeTerminal.resolve();
      await releaseTerminal.promise;
      yield event(2, { kind: 'progress', status: 'waiting_for_next' });
    };
    const { manager, runtime } = await setup(fake, clock);

    const prompt = runtime.prompt('session-1', 'work');
    await beforeTerminal.promise;
    expect(runtime.cancel('session-1')).toBe(true);
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    releaseTerminal.resolve();
    await expect(manager.drainFor('session-1')).resolves.toBeUndefined();

    expect(manager.get('session-1').turnState).toBe('Idle');
    expect(manager.get('session-1').activeTurn).toBeUndefined();
    expect(fake.streamCalls).toHaveLength(1);
  });

  it.each(['resolve', 'reject'] as const)(
    'emits one safe diagnostic for a late send %s',
    async (settlement) => {
      const clock = new ManualClock();
      const send = deferred<{ messageId: string; createdAt: string }>();
      const diagnostics: unknown[] = [];
      const output: unknown[] = [];
      const fake = new ScriptedAimeTransport().onSession({
        id: 'session-1',
        sourceSpaceId: 'space-1',
      });
      fake.sendMessage = async (input) => {
        fake.sendCalls.push(input);
        return send.promise;
      };
      const manager = new SessionManager(fake);
      await manager.load('session-1');
      const runtime = new TurnRuntime(
        manager,
        fake,
        new OrderedNotifications(async ({ update }) => {
          output.push(update);
        }),
        {},
        clock,
        { record: (diagnostic: unknown) => diagnostics.push(diagnostic) },
      );
      const prompt = runtime.prompt('session-1', 'work');
      await clock.flush();
      runtime.cancel('session-1');
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
      await clock.advance(30_000);
      await expect(manager.drainFor('session-1')).resolves.toBeUndefined();

      if (settlement === 'resolve') {
        send.resolve({
          messageId: 'SECRET_SENTINEL',
          createdAt: '2030-01-01T00:00:00.000Z',
        });
      } else {
        send.reject(new Error('SECRET_SENTINEL'));
      }
      await clock.flush();

      expect(diagnostics).toEqual([
        {
          event: 'aime.late_send_settlement',
          outcome: settlement === 'resolve' ? 'resolved' : 'rejected',
        },
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain('SECRET_SENTINEL');
      expect(output).toEqual([]);
      expect(fake.sendCalls).toHaveLength(1);
      expect(manager.get('session-1').turnState).toBe('Desynced');
    },
  );
});
