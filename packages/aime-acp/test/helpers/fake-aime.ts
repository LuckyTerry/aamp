import type { AimeSession, AimeTransport } from '../../src/aime/transport.js';
import type { NormalizedAimeEvent } from '../../src/aime/event-types.js';

type ScriptedItem = NormalizedAimeEvent | Error | Promise<void>;

async function waitForGate(
  gate: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([gate, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

interface ScriptedSession {
  readonly id: string;
  readonly sourceSpaceId: string;
  readonly status?: string;
  readonly messages?: AimeSession['messages'];
}

export class ScriptedAimeTransport implements AimeTransport {
  readonly calls: Array<{ method: string; input?: unknown }> = [];
  readonly sendCalls: Parameters<AimeTransport['sendMessage']>[0][] = [];
  readonly streamCalls: Array<{
    readonly sessionId: string;
    readonly eventOffset: number;
  }> = [];
  readonly #events: ScriptedItem[][];
  #streamConfigured: boolean;
  readonly #sends: Array<{ messageId: string; createdAt: string }> = [];
  readonly #sessionReads: ScriptedSession[] = [];
  #onStreamPause?: () => void;
  #spaceId = 'scripted-space';
  #session: ScriptedSession = {
    id: 'scripted-session',
    sourceSpaceId: 'scripted-space',
  };

  constructor(events: readonly ScriptedItem[] = []) {
    this.#events = [[...events]];
    this.#streamConfigured = events.length > 0;
  }

  onSession(session: ScriptedSession): this {
    this.#session = session;
    return this;
  }

  onSpace(spaceId: string): this {
    this.#spaceId = spaceId;
    return this;
  }

  onGetSession(session: ScriptedSession): this {
    this.#sessionReads.push(session);
    return this;
  }

  onSend(sent: { messageId: string; createdAt: string }): this {
    this.#sends.push(sent);
    return this;
  }

  onStream(events: readonly ScriptedItem[]): this {
    if (!this.#streamConfigured) {
      this.#events.pop();
    }
    this.#events.push([...events]);
    this.#streamConfigured = true;
    return this;
  }

  onStreamPause(callback: () => void): this {
    this.#onStreamPause = callback;
    return this;
  }

  async checkCompatibility(): Promise<void> {
    this.calls.push({ method: 'checkCompatibility' });
  }

  async resolveSpace(): Promise<{ id: string }> {
    this.calls.push({ method: 'resolveSpace' });
    return { id: this.#spaceId };
  }

  async resolveModel(): Promise<{ name: string } | undefined> {
    this.calls.push({ method: 'resolveModel' });
    return undefined;
  }

  async createSession(): Promise<{ id: string; sourceSpaceId: string }> {
    this.calls.push({ method: 'createSession' });
    return { id: 'scripted-session', sourceSpaceId: 'scripted-space' };
  }

  async getSession(
    sessionId: string,
    options?: { withMessages?: boolean },
  ): Promise<AimeSession> {
    this.calls.push({ method: 'getSession', input: { sessionId, options } });
    const session = this.#sessionReads.shift() ?? this.#session;
    return {
      id: session.id,
      status: session.status ?? 'waiting_for_next',
      sourceSpaceId: session.sourceSpaceId,
      messages: session.messages ?? [],
    };
  }

  async sendMessage(
    input: Parameters<AimeTransport['sendMessage']>[0],
  ): Promise<{ messageId: string; createdAt: string }> {
    this.calls.push({ method: 'sendMessage', input });
    this.sendCalls.push(input);
    return (
      this.#sends.shift() ?? {
        messageId: 'scripted-message',
        createdAt: '2030-01-01T00:00:00.000Z',
      }
    );
  }

  async *streamEvents(input: {
    sessionId: string;
    eventOffset: number;
    signal: AbortSignal;
  }): AsyncIterable<NormalizedAimeEvent> {
    this.calls.push({ method: 'streamEvents' });
    this.streamCalls.push({
      sessionId: input.sessionId,
      eventOffset: input.eventOffset,
    });
    for (const item of this.#events.shift() ?? []) {
      if (item instanceof Error) throw item;
      if (item instanceof Promise) {
        this.#onStreamPause?.();
        await waitForGate(item, input.signal);
      } else yield item;
    }
  }
}
