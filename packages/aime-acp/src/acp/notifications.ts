import type {
  SessionNotification,
  SessionUpdate,
} from '@agentclientprotocol/sdk';

/** Serializes ACP writes so callers can commit their prepared state after each write. */
export class OrderedNotifications {
  #tail: Promise<void> = new Promise<void>((complete) => {
    complete();
  });

  constructor(
    private readonly notify: (params: SessionNotification) => Promise<void>,
  ) {}

  send(sessionId: string, update: SessionUpdate): Promise<void> {
    const next = this.#tail.then(() => this.notify({ sessionId, update }));
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
