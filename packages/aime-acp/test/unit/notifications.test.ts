import { describe, expect, it } from 'vitest';

import { OrderedNotifications } from '../../src/acp/notifications.js';

function message(text: string) {
  return {
    sessionUpdate: 'agent_message_chunk' as const,
    content: { type: 'text' as const, text },
  };
}

describe('OrderedNotifications', () => {
  it('waits for each notification before entering the next one', async () => {
    let releaseFirst: (() => void) | undefined;
    const entered: string[] = [];
    const notifications = new OrderedNotifications(async ({ update }) => {
      if (
        update.sessionUpdate !== 'agent_message_chunk' ||
        update.content.type !== 'text'
      ) {
        throw new Error('unexpected update');
      }
      entered.push(update.content.text);
      if (update.content.text === 'first') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    });

    const first = notifications.send('session-1', message('first'));
    const second = notifications.send('session-1', message('second'));
    await Promise.resolve();
    expect(entered).toEqual(['first']);

    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(entered).toEqual(['first', 'second']);
  });

  it('propagates one rejection without poisoning later sends', async () => {
    const failure = new Error('write failed');
    const entered: string[] = [];
    const notifications = new OrderedNotifications(async ({ update }) => {
      if (
        update.sessionUpdate !== 'agent_message_chunk' ||
        update.content.type !== 'text'
      ) {
        throw new Error('unexpected update');
      }
      entered.push(update.content.text);
      if (update.content.text === 'first') throw failure;
    });

    await expect(
      notifications.send('session-1', message('first')),
    ).rejects.toBe(failure);
    await expect(
      notifications.send('session-1', message('second')),
    ).resolves.toBeUndefined();
    expect(entered).toEqual(['first', 'second']);
  });
});
