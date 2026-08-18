import { describe, expect, it } from 'vitest';

import { OrderedNotifications } from '../../src/acp/notifications.js';
import type { NormalizedAimeEvent } from '../../src/aime/event-types.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { TurnRuntime } from '../../src/session/turn-runtime.js';
import { ScriptedAimeTransport } from '../helpers/fake-aime.js';
import { ManualClock } from '../helpers/manual-clock.js';

function event<
  T extends Omit<NormalizedAimeEvent, 'offset' | 'timestampMs' | 'rawType'>,
>(offset: number, value: T): NormalizedAimeEvent {
  return {
    ...value,
    offset,
    timestampMs: offset + 1,
    rawType: 'test',
  } as NormalizedAimeEvent;
}

function runtimeFor(fake: ScriptedAimeTransport, clock = new ManualClock()) {
  const values: unknown[] = [];
  const manager = new SessionManager(fake);
  const runtime = new TurnRuntime(
    manager,
    fake,
    new OrderedNotifications(async ({ update }) => {
      values.push(update);
    }),
    {},
    clock,
  );
  return { manager, runtime, values, clock };
}

describe('TurnRuntime load recovery', () => {
  it('replays ordered history while silently rebuilding the full cursor', async () => {
    const fake = new ScriptedAimeTransport()
      .onSpace('space-1')
      .onGetSession({
        id: 'session-1',
        sourceSpaceId: 'space-1',
        status: 'waiting_for_next',
        messages: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: 'answer' },
        ],
      })
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
        event(3, { kind: 'progress', status: 'waiting_for_next' }),
        event(4, {
          kind: 'message.create',
          message: { id: 'user-2', role: 'user', content: 'follow-up' },
        }),
        event(5, {
          kind: 'action.tool_call_required',
          question: 'Choose?',
          options: ['A'],
        }),
      ]);
    const { manager, runtime, values, clock } = runtimeFor(fake);

    await expect(runtime.load('session-1')).resolves.toMatchObject({
      history: [
        { role: 'user', messageId: 'history-0', text: 'question' },
        { role: 'assistant', messageId: 'history-1', text: 'answer' },
      ],
      session: { turnState: 'AwaitingUserInput' },
    });
    expect(manager.get('session-1').cursor.nextEventOffset).toBe(6);
    expect(fake.streamCalls.map((call) => call.eventOffset)).toEqual([0]);
    expect(values).toEqual([]);
    expect(clock.deadlineDurations.every((ms) => ms === 1_500)).toBe(true);
  });

  it('rejects a source-space mismatch and preserves the owned state', async () => {
    const fake = new ScriptedAimeTransport().onSession({
      id: 'session-1',
      sourceSpaceId: 'space-1',
    });
    const { manager, runtime } = runtimeFor(fake);
    const owned = await manager.load('session-1');
    fake.onGetSession({ id: 'session-1', sourceSpaceId: 'space-2' });

    await expect(runtime.load('session-1')).rejects.toMatchObject({
      code: 'AIME_PROTOCOL_DRIFT',
    });
    expect(manager.get('session-1')).toBe(owned);
    expect(owned.cursor.nextEventOffset).toBe(0);
  });

  it('discards an over-budget candidate without exposing its cursor', async () => {
    const fake = new ScriptedAimeTransport().onSpace('space-1').onGetSession({
      id: 'session-1',
      sourceSpaceId: 'space-1',
      status: 'running',
    });
    for (let offset = 0; offset < 64; offset += 1) {
      fake.onStream([event(offset, { kind: 'progress', status: 'thinking' })]);
    }
    fake.onStream([event(64, { kind: 'progress', status: 'thinking' })]);
    const { manager, runtime } = runtimeFor(fake);

    await expect(runtime.load('session-1')).rejects.toMatchObject({
      code: 'AIME_STREAM_INTERRUPTED',
    });
    expect(() => manager.get('session-1')).toThrowError(
      expect.objectContaining({ code: 'AIME_SESSION_NOT_FOUND' }),
    );
  });

  it('does not publish over a turn that became active during recovery', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = new ScriptedAimeTransport().onSession({
      id: 'session-1',
      sourceSpaceId: 'space-1',
    });
    const { manager, runtime } = runtimeFor(fake);
    const owned = await manager.load('session-1');
    const originalGet = fake.getSession.bind(fake);
    fake.getSession = async (...args) => {
      await gate;
      return originalGet(...args);
    };

    const load = runtime.load('session-1');
    manager.beginTurn('session-1');
    release?.();
    await expect(load).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(manager.get('session-1')).toBe(owned);
    expect(owned.turnState).toBe('Sending');
  });

  it('publishes running recovery as a tracked drain until terminal', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = new ScriptedAimeTransport()
      .onSpace('space-1')
      .onGetSession({
        id: 'session-1',
        sourceSpaceId: 'space-1',
        status: 'running',
      })
      .onStream([])
      .onStream([])
      .onStream([
        gate,
        event(0, { kind: 'progress', status: 'waiting_for_next' }),
      ]);
    const { manager, runtime } = runtimeFor(fake);

    const loaded = await runtime.load('session-1');
    expect(loaded.session.turnState).toBe('Draining');
    expect(manager.pendingDrainCount).toBe(1);
    await expect(runtime.prompt('session-1', 'too soon')).rejects.toMatchObject(
      { code: 'SESSION_BUSY' },
    );
    release?.();
    await expect(manager.drainFor('session-1')).resolves.toBeUndefined();
    expect(manager.get('session-1').turnState).toBe('Idle');
  });

  it('treats each five-second open idle segment as an empty poll', async () => {
    const never = new Promise<void>(() => undefined);
    const fake = new ScriptedAimeTransport()
      .onSpace('space-1')
      .onGetSession({
        id: 'session-1',
        sourceSpaceId: 'space-1',
        status: 'waiting_for_next',
      })
      .onStream([never]);
    const { manager, runtime, clock } = runtimeFor(fake);

    const load = runtime.load('session-1');
    await clock.flush();
    await clock.advance(1_500);
    expect(fake.streamCalls).toHaveLength(1);
    await clock.advance(1_500);

    await expect(load).resolves.toMatchObject({
      session: { turnState: 'Idle' },
    });
    expect(manager.get('session-1').cursor.nextEventOffset).toBe(0);
    expect(clock.deadlineDurations).toEqual([1_500]);
  });

  it('bounds chatty segments and the whole catch-up independently', async () => {
    const clock = new ManualClock();
    const fake = new ScriptedAimeTransport().onSpace('space-1').onGetSession({
      id: 'session-1',
      sourceSpaceId: 'space-1',
      status: 'running',
    });
    let nextOffset = 0;
    fake.streamEvents = async function* (input) {
      this.calls.push({ method: 'streamEvents' });
      this.streamCalls.push({
        sessionId: input.sessionId,
        eventOffset: input.eventOffset,
      });
      while (!input.signal.aborted) {
        await clock.sleep(1_000, input.signal);
        yield event(nextOffset, { kind: 'progress', status: 'thinking' });
        nextOffset += 1;
      }
    };
    const { manager, runtime } = runtimeFor(fake, clock);
    let outcome: unknown;
    void runtime.load('session-1').then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    await clock.flush();

    for (let second = 0; second < 6; second += 1) {
      await clock.advance(1_000);
    }
    expect(fake.streamCalls.length).toBeGreaterThan(1);
    for (let second = 6; second < 90; second += 1) {
      await clock.advance(1_000);
    }

    expect(outcome).toMatchObject({ code: 'AIME_STREAM_INTERRUPTED' });
    expect(fake.streamCalls.length).toBeLessThanOrEqual(19);
    expect(() => manager.get('session-1')).toThrowError(
      expect.objectContaining({ code: 'AIME_SESSION_NOT_FOUND' }),
    );
  });

  it('rejects a fresh session outside the resolved process space', async () => {
    const fake = new ScriptedAimeTransport()
      .onSpace('space-expected')
      .onGetSession({
        id: 'session-1',
        sourceSpaceId: 'space-other',
        status: 'waiting_for_next',
      })
      .onStream([])
      .onStream([]);
    const { manager, runtime } = runtimeFor(fake);

    await expect(runtime.load('session-1')).rejects.toMatchObject({
      code: 'AIME_PROTOCOL_DRIFT',
    });
    expect(fake.calls.map((call) => call.method)).toEqual([
      'getSession',
      'resolveSpace',
    ]);
    expect(fake.streamCalls).toEqual([]);
    expect(() => manager.get('session-1')).toThrowError(
      expect.objectContaining({ code: 'AIME_SESSION_NOT_FOUND' }),
    );
  });
});
