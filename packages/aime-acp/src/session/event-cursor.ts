import type { SessionUpdate } from '@agentclientprotocol/sdk';

import { AimeAcpError } from '../errors.js';
import {
  initialAimeEventState,
  reduceAimeEvent,
  type AimeEventState,
} from '../aime/event-mapper.js';
import type { NormalizedAimeEvent } from '../aime/event-types.js';

export interface PreparedEvent {
  readonly update?: SessionUpdate;
  readonly terminal?: 'idle' | 'awaiting_user';
  commit(): void;
}

class BoundedLruSet {
  readonly #entries = new Map<string, undefined>();

  constructor(private readonly limit: number) {}

  has(value: string): boolean {
    return this.#entries.has(value);
  }

  touch(value: string): boolean {
    if (!this.#entries.has(value)) return false;
    this.#entries.delete(value);
    this.#entries.set(value, undefined);
    return true;
  }

  add(value: string): void {
    this.#entries.delete(value);
    this.#entries.set(value, undefined);
    if (this.#entries.size > this.limit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }
}

function protocolDrift(message: string): never {
  throw new AimeAcpError('AIME_PROTOCOL_DRIFT', message, false);
}

function isPing(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as { kind?: unknown }).kind === 'ping'
  );
}

function eventOffset(event: NormalizedAimeEvent): number {
  const offset = (event as { offset?: unknown }).offset;
  if (
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= Number.MAX_SAFE_INTEGER
  ) {
    return protocolDrift('AIME event offset is invalid.');
  }
  return offset;
}

function eventId(event: NormalizedAimeEvent): string | undefined {
  const value = (event as { eventId?: unknown }).eventId;
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function noOpPrepared(): PreparedEvent {
  let committed = false;
  return {
    commit() {
      if (committed) protocolDrift('AIME event was committed more than once.');
      committed = true;
    },
  };
}

/**
 * Reduces AIME events transactionally: callers must notify first, then commit.
 * A stale offset without a known event ID is rejected to prevent state corruption.
 */
export class EventCursor {
  #nextEventOffset = 0;
  #state: AimeEventState = initialAimeEventState();
  #seen = new BoundedLruSet(4096);
  #version = 0;

  get nextEventOffset(): number {
    return this.#nextEventOffset;
  }

  /** Inclusive offset used when reopening a stream after a partial group. */
  get replayEventOffset(): number {
    return Math.max(0, this.#nextEventOffset - 1);
  }

  /** Advances only when a previously unseen event commits. */
  get version(): number {
    return this.#version;
  }

  #prepareReplay(id: string): PreparedEvent {
    const preparedVersion = this.#version;
    let committed = false;
    return {
      commit: () => {
        if (committed)
          protocolDrift('AIME event was committed more than once.');
        committed = true;
        if (this.#version !== preparedVersion || !this.#seen.touch(id)) {
          protocolDrift('AIME replay commit is stale.');
        }
      },
    };
  }

  prepare(
    event: NormalizedAimeEvent,
    replayFloor = Math.max(0, this.#nextEventOffset - 1),
  ): PreparedEvent {
    return this.#prepare(event, replayFloor, true);
  }

  /**
   * Commits correlation-pending events to the cursor without letting their
   * provisional message content taint the authoritative reducer snapshot.
   */
  prepareUncorrelated(
    event: NormalizedAimeEvent,
    replayFloor = Math.max(0, this.#nextEventOffset - 1),
  ): PreparedEvent {
    return this.#prepare(event, replayFloor, false);
  }

  #prepare(
    event: NormalizedAimeEvent,
    replayFloor: number,
    reduce: boolean,
  ): PreparedEvent {
    if (isPing(event)) return noOpPrepared();

    if (
      !Number.isSafeInteger(replayFloor) ||
      replayFloor < 0 ||
      replayFloor > this.#nextEventOffset
    ) {
      return protocolDrift('AIME event replay floor is invalid.');
    }

    const offset = eventOffset(event);
    const id = eventId(event);
    if (offset < this.#nextEventOffset) {
      if (id === undefined) return noOpPrepared();
      if (this.#seen.has(id)) return this.#prepareReplay(id);
      if (offset < replayFloor) {
        return protocolDrift(
          'AIME event offset is stale for an unseen event ID.',
        );
      }
    }
    if (id !== undefined && this.#seen.has(id)) {
      return protocolDrift('AIME event ID was replayed at a new offset.');
    }

    const reduction = reduce
      ? reduceAimeEvent(this.#state, event)
      : { nextState: this.#state };
    const preparedVersion = this.#version;
    let committed = false;
    return {
      ...(reduction.update === undefined ? {} : { update: reduction.update }),
      ...(reduction.terminal === undefined
        ? {}
        : { terminal: reduction.terminal }),
      commit: () => {
        if (committed)
          protocolDrift('AIME event was committed more than once.');
        committed = true;
        if (this.#version !== preparedVersion) {
          protocolDrift('AIME event commit is stale.');
        }
        this.#state = reduction.nextState;
        if (id !== undefined) this.#seen.add(id);
        this.#nextEventOffset = Math.max(this.#nextEventOffset, offset + 1);
        this.#version += 1;
      },
    };
  }
}
