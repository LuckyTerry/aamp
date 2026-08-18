import type { AimeTransport } from '../aime/transport.js';
import { AimeAcpError, normalizeAimeError } from '../errors.js';
import { EventCursor } from './event-cursor.js';

export type TurnState =
  | 'Idle'
  | 'AwaitingUserInput'
  | 'Sending'
  | 'Streaming'
  | 'Reconnecting'
  | 'SoftCancelled'
  | 'Draining'
  | 'Desynced';

export interface ActiveTurn {
  readonly abortController: AbortController;
  readonly replayFloor: number;
  userMessageId?: string;
  assistantMessageId?: string;
  sentAtMs: number;
  outputDisabled: boolean;
  emittedPresentableContent: boolean;
  assistantFinished: boolean;
  readonly cancelled: Promise<void>;
  readonly signalCancelled: () => void;
  pendingSend?: Promise<{ messageId: string; createdAt: string }>;
  readonly foregroundDone: Promise<void>;
  readonly signalForegroundDone: () => void;
  foregroundTerminal?: 'empty';
}

export interface SessionRuntimeState {
  readonly sessionId: string;
  readonly sourceSpaceId: string;
  readonly cursor: EventCursor;
  turnState: TurnState;
  activeTurn?: ActiveTurn;
}

export type TurnFailureSafety =
  | 'known-safe-pre-mutation'
  | 'known-terminal'
  | 'ambiguous-after-mutation';

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function unknownSession(): AimeAcpError {
  return new AimeAcpError(
    'AIME_SESSION_NOT_FOUND',
    'The AIME session was not found.',
    false,
  );
}

function busySession(): AimeAcpError {
  return new AimeAcpError('SESSION_BUSY', 'The AIME session is busy.', false);
}

function protocolDrift(message: string): AimeAcpError {
  return new AimeAcpError('AIME_PROTOCOL_DRIFT', message, false);
}

/** Owns only remote sessions that this process created or explicitly loaded. */
export class SessionManager {
  readonly #sessions = new Map<string, SessionRuntimeState>();
  readonly #drains = new Map<string, Promise<void>>();

  constructor(private readonly transport: AimeTransport) {}

  async create(
    input: { readonly sourceSpaceId?: string } = {},
  ): Promise<SessionRuntimeState> {
    try {
      const spaceId =
        input.sourceSpaceId ?? (await this.transport.resolveSpace()).id;
      if (!validId(spaceId))
        throw protocolDrift('AIME source space ID is invalid.');
      const created = await this.transport.createSession({
        spaceId,
        useInternalTools: true,
      });
      if (!validId(created.id) || !validId(created.sourceSpaceId)) {
        throw protocolDrift('AIME created an invalid session.');
      }
      const state = this.makeState(created.id, created.sourceSpaceId);
      this.#sessions.set(state.sessionId, state);
      return state;
    } catch (error) {
      throw normalizeAimeError(error, 'create');
    }
  }

  async load(sessionId: string): Promise<SessionRuntimeState> {
    if (!validId(sessionId)) throw unknownSession();
    const owned = this.#sessions.get(sessionId);
    if (owned !== undefined) return owned;
    try {
      const remote = await this.transport.getSession(sessionId, {
        withMessages: false,
      });
      if (remote.id !== sessionId || !validId(remote.sourceSpaceId)) {
        throw protocolDrift('AIME returned a different or invalid session.');
      }
      const state = this.makeState(remote.id, remote.sourceSpaceId);
      this.#sessions.set(state.sessionId, state);
      return state;
    } catch (error) {
      throw normalizeAimeError(error, 'session-read');
    }
  }

  get(sessionId: string): SessionRuntimeState {
    const state = this.#sessions.get(sessionId);
    if (state === undefined) throw unknownSession();
    return state;
  }

  owned(sessionId: string): SessionRuntimeState | undefined {
    return this.#sessions.get(sessionId);
  }

  createRecoveryCandidate(
    sessionId: string,
    sourceSpaceId: string,
  ): SessionRuntimeState {
    if (!validId(sessionId) || !validId(sourceSpaceId)) {
      throw protocolDrift('AIME returned a different or invalid session.');
    }
    return this.makeState(sessionId, sourceSpaceId);
  }

  publishRecovery(
    candidate: SessionRuntimeState,
    expected: SessionRuntimeState | undefined,
  ): SessionRuntimeState {
    const current = this.#sessions.get(candidate.sessionId);
    if (
      current !== expected ||
      (current !== undefined &&
        current.turnState !== 'Idle' &&
        current.turnState !== 'AwaitingUserInput' &&
        current.turnState !== 'Desynced')
    ) {
      throw busySession();
    }
    this.#sessions.set(candidate.sessionId, candidate);
    return candidate;
  }

  beginTurn(sessionId: string): SessionRuntimeState {
    const state = this.get(sessionId);
    if (state.turnState !== 'Idle' && state.turnState !== 'AwaitingUserInput') {
      throw busySession();
    }
    let signalCancelled!: () => void;
    let signalForegroundDone!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      signalCancelled = resolve;
    });
    const foregroundDone = new Promise<void>((resolve) => {
      signalForegroundDone = resolve;
    });
    state.activeTurn = {
      abortController: new AbortController(),
      replayFloor: state.cursor.replayEventOffset,
      sentAtMs: 0,
      outputDisabled: false,
      emittedPresentableContent: false,
      assistantFinished: false,
      cancelled,
      signalCancelled,
      foregroundDone,
      signalForegroundDone,
    };
    state.turnState = 'Sending';
    return state;
  }

  trackDrain(sessionId: string, promise: Promise<void>): void {
    const tracked = promise.catch(() => undefined);
    this.#drains.set(sessionId, tracked);
    void tracked.finally(() => {
      if (this.#drains.get(sessionId) === tracked)
        this.#drains.delete(sessionId);
    });
  }

  async drainFor(sessionId: string): Promise<void> {
    await this.#drains.get(sessionId);
  }

  get pendingDrainCount(): number {
    return this.#drains.size;
  }

  async waitForDrains(): Promise<void> {
    await Promise.all([...this.#drains.values()]);
  }

  completeTurn(
    state: SessionRuntimeState,
    next: 'Idle' | 'AwaitingUserInput',
  ): void {
    delete state.activeTurn;
    state.turnState = next;
  }

  failTurn(state: SessionRuntimeState, safety: TurnFailureSafety): void {
    delete state.activeTurn;
    state.turnState =
      safety === 'known-safe-pre-mutation' || safety === 'known-terminal'
        ? 'Idle'
        : 'Desynced';
  }

  private makeState(
    sessionId: string,
    sourceSpaceId: string,
  ): SessionRuntimeState {
    return {
      sessionId,
      sourceSpaceId,
      cursor: new EventCursor(),
      turnState: 'Idle',
    };
  }
}
