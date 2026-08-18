import { describe, expect, it } from 'vitest';

import { OrderedNotifications } from '../../src/acp/notifications.js';
import { EventCursor } from '../../src/session/event-cursor.js';
import type { NormalizedAimeEvent } from '../../src/aime/event-types.js';

function deltaAt(offset: number, eventId: string, content = 'A') {
  return {
    kind: 'message.delta',
    eventId,
    offset,
    timestampMs: offset,
    rawType: 'synthetic.delta',
    messageId: 'message-1',
    content,
    finished: false,
  } satisfies NormalizedAimeEvent;
}

describe('EventCursor', () => {
  it('leaves ping events entirely alone', () => {
    const cursor = new EventCursor();
    const ping = cursor.prepare({ kind: 'ping' });
    expect(ping.update).toBeUndefined();
    ping.commit();
    expect(cursor.nextEventOffset).toBe(0);
  });

  it('does not mutate until its prepared update commits', () => {
    const cursor = new EventCursor();
    const prepared = cursor.prepare(deltaAt(7, 'evt-7'));

    expect(prepared.update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
    });
    expect(cursor.nextEventOffset).toBe(0);
    prepared.commit();
    expect(cursor.nextEventOffset).toBe(8);
  });

  it('treats a known ID or an offset-only stale replay as a no-op', () => {
    const cursor = new EventCursor();
    cursor.prepare(deltaAt(7, 'evt-7')).commit();

    expect(cursor.prepare(deltaAt(7, 'evt-7')).update).toBeUndefined();
    const { eventId: _ignored, ...offsetOnlyReplay } = deltaAt(7, 'ignored');
    expect(cursor.prepare(offsetOnlyReplay).update).toBeUndefined();
  });

  it('fails closed for an unseen ID at a stale offset while allowing forward gaps', () => {
    const cursor = new EventCursor();
    cursor.prepare(deltaAt(7, 'evt-7')).commit();
    expect(() => cursor.prepare(deltaAt(6, 'unseen'))).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );

    const gap = cursor.prepare(deltaAt(20, 'evt-20'));
    gap.commit();
    expect(cursor.nextEventOffset).toBe(21);
  });

  it('accepts distinct event IDs in the latest inclusive offset group', () => {
    const cursor = new EventCursor();
    cursor.prepare(deltaAt(18, 'evt-18-a', 'first')).commit();

    const sameOffset = cursor.prepare(deltaAt(18, 'evt-18-b', ' second'));
    expect(sameOffset.update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { text: ' second' },
    });
    sameOffset.commit();

    expect(cursor.nextEventOffset).toBe(19);
    expect(() => cursor.prepare(deltaAt(17, 'evt-17-unseen'))).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
  });

  it('accepts an out-of-order event inside an explicit turn replay floor', () => {
    const cursor = new EventCursor();
    cursor.prepare(deltaAt(0, 'progress-0', 'first')).commit();
    cursor.prepare(deltaAt(16, 'progress-16', ' second')).commit();

    const late = cursor.prepare(deltaAt(0, 'user-create-0', ' late'), 0);
    expect(late.update).toMatchObject({ content: { text: ' late' } });
    late.commit();

    expect(cursor.nextEventOffset).toBe(17);
    expect(() => cursor.prepare(deltaAt(0, 'too-old'), 1)).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
  });

  it('fails closed when a known ID appears at a new offset', () => {
    const cursor = new EventCursor();
    cursor.prepare(deltaAt(0, 'evt-0')).commit();

    expect(() => cursor.prepare(deltaAt(1, 'evt-0'))).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
    expect(cursor.nextEventOffset).toBe(1);
  });

  it('refreshes a replayed ID so the next-oldest LRU entry is evicted', () => {
    const cursor = new EventCursor();
    for (let offset = 0; offset < 4096; offset += 1) {
      cursor.prepare(deltaAt(offset, `evt-${offset}`)).commit();
    }

    const replay = cursor.prepare(deltaAt(0, 'evt-0'));
    replay.commit();
    expect(() => replay.commit()).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
    cursor.prepare(deltaAt(4096, 'evt-4096')).commit();

    expect(cursor.prepare(deltaAt(0, 'evt-0')).update).toBeUndefined();
    expect(() => cursor.prepare(deltaAt(1, 'evt-1'))).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
  });

  it('does not touch a replay cache entry until its prepared replay commits', () => {
    const cursor = new EventCursor();
    for (let offset = 0; offset < 4096; offset += 1) {
      cursor.prepare(deltaAt(offset, `evt-${offset}`)).commit();
    }

    const replay = cursor.prepare(deltaAt(0, 'evt-0'));
    cursor.prepare(deltaAt(4096, 'evt-4096')).commit();

    expect(() => cursor.prepare(deltaAt(0, 'evt-0'))).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
    expect(() => replay.commit()).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
  });

  it('does not touch a known ID when its new offset is illegal', () => {
    const cursor = new EventCursor();
    for (let offset = 0; offset < 4096; offset += 1) {
      cursor.prepare(deltaAt(offset, `evt-${offset}`)).commit();
    }

    expect(() => cursor.prepare(deltaAt(4096, 'evt-0'))).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
    cursor.prepare(deltaAt(4096, 'evt-4096')).commit();
    expect(() => cursor.prepare(deltaAt(0, 'evt-0'))).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
  });

  it('accepts the largest offset that can advance exactly and rejects overflow', () => {
    const cursor = new EventCursor();
    cursor.prepare(deltaAt(Number.MAX_SAFE_INTEGER - 1, 'last-safe')).commit();
    expect(cursor.nextEventOffset).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      cursor.prepare(deltaAt(Number.MAX_SAFE_INTEGER, 'unsafe-next')),
    ).toThrowError(expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }));
  });

  it('does not expose an uncommitted state transition to another prepare', () => {
    const cursor = new EventCursor();
    const reference = cursor.prepare({
      kind: 'reference',
      eventId: 'reference',
      offset: 0,
      timestampMs: 0,
      rawType: 'reference',
      references: [
        {
          id: 'ref',
          title: 'Guide',
          uri: 'https://example.test/g',
          snippet: '',
        },
      ],
    });
    const terminal = cursor.prepare({
      kind: 'progress',
      eventId: 'terminal',
      offset: 1,
      timestampMs: 1,
      rawType: 'progress',
      status: 'waiting_for_next',
    });

    expect(terminal.update).toBeUndefined();
    reference.commit();
    expect(cursor.nextEventOffset).toBe(1);
    expect(() => terminal.commit()).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
  });

  it.each([
    { ...deltaAt(0, 'missing'), offset: undefined },
    { ...deltaAt(0, 'fraction'), offset: 1.5 },
    { ...deltaAt(0, 'negative'), offset: -1 },
    { ...deltaAt(0, 'infinite'), offset: Infinity },
    {
      kind: 'message.delta',
      messageId: 'message-1',
      content: 'a',
      finished: false,
    },
  ])('rejects invalid offsets for visible events', (event) => {
    expect(() => new EventCursor().prepare(event as never)).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
  });

  it('keeps reducer state unchanged when mapping throws and rejects double commits', () => {
    const cursor = new EventCursor();
    cursor.prepare(deltaAt(0, 'evt-0', 'alpha')).commit();
    const before = cursor.nextEventOffset;
    expect(() =>
      cursor.prepare({
        ...deltaAt(1, 'evt-1', 'beta'),
        kind: 'message.create',
        message: { id: 'message-1', role: 'assistant', content: 'beta' },
      } as NormalizedAimeEvent),
    ).toThrowError(expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }));
    expect(cursor.nextEventOffset).toBe(before);

    const prepared = cursor.prepare(deltaAt(1, 'evt-1', ' gamma'));
    expect(prepared.update).toMatchObject({ content: { text: ' gamma' } });
    prepared.commit();
    expect(() => prepared.commit()).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
  });

  it('preserves source, plan, and tool snapshots across committed reductions', () => {
    const cursor = new EventCursor();
    cursor
      .prepare({
        kind: 'reference',
        eventId: 'reference',
        offset: 0,
        timestampMs: 0,
        rawType: 'reference',
        references: [
          {
            id: 'ref',
            title: 'Guide',
            uri: 'https://example.test/g',
            snippet: '',
          },
        ],
      })
      .commit();
    const terminal = cursor.prepare({
      kind: 'progress',
      eventId: 'terminal',
      offset: 1,
      timestampMs: 1,
      rawType: 'progress',
      status: 'waiting_for_next',
    });
    expect(terminal.update).toMatchObject({
      content: { text: 'Sources:\n- [Guide](https://example.test/g)' },
    });
    terminal.commit();

    cursor
      .prepare({
        kind: 'plan.update',
        eventId: 'plan',
        offset: 2,
        timestampMs: 2,
        rawType: 'plan',
        plan: { id: 'plan-1', status: 'running' },
      })
      .commit();
    const planStep = cursor.prepare({
      kind: 'step.update',
      eventId: 'step',
      offset: 3,
      timestampMs: 3,
      rawType: 'step',
      step: { id: 'step-1', title: 'Plan step', status: 'completed' },
    });
    expect(planStep.update).toMatchObject({
      sessionUpdate: 'plan',
      entries: [{ content: 'Plan step', status: 'completed' }],
    });
    planStep.commit();

    cursor
      .prepare({
        kind: 'action.use_tool',
        eventId: 'tool-1',
        offset: 4,
        timestampMs: 4,
        rawType: 'tool',
        tool: { id: 'tool', name: 'lookup', status: 'running' },
      })
      .commit();
    const toolUpdate = cursor.prepare({
      kind: 'action.use_tool',
      eventId: 'tool-2',
      offset: 5,
      timestampMs: 5,
      rawType: 'tool',
      tool: { id: 'tool', name: 'lookup', status: 'completed' },
    });
    expect(toolUpdate.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
    });
  });

  it('keeps only 4096 replay IDs and fails closed after deterministic eviction', () => {
    const cursor = new EventCursor();
    for (let offset = 0; offset <= 4096; offset += 1) {
      cursor.prepare(deltaAt(offset, `evt-${offset}`)).commit();
    }
    expect(cursor.prepare(deltaAt(4096, 'evt-4096')).update).toBeUndefined();
    expect(() => cursor.prepare(deltaAt(0, 'evt-0'))).toThrowError(
      expect.objectContaining({ code: 'AIME_PROTOCOL_DRIFT' }),
    );
  });

  it('does not commit a prepared event when its notification fails', async () => {
    const cursor = new EventCursor();
    const prepared = cursor.prepare(deltaAt(0, 'evt-0'));
    if (prepared.update === undefined) throw new Error('expected an update');
    const notifications = new OrderedNotifications(async () => {
      throw new Error('closed');
    });

    await expect(
      notifications.send('session-1', prepared.update),
    ).rejects.toThrow('closed');
    expect(cursor.nextEventOffset).toBe(0);
  });

  it('uses the notify-then-commit integration sequence', async () => {
    const cursor = new EventCursor();
    const prepared = cursor.prepare(deltaAt(0, 'evt-0'));
    if (prepared.update === undefined) throw new Error('expected an update');
    const notifications = new OrderedNotifications(async () => {});

    await notifications.send('session-1', prepared.update);
    expect(cursor.nextEventOffset).toBe(0);
    prepared.commit();
    expect(cursor.nextEventOffset).toBe(1);
  });
});
