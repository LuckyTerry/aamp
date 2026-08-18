import {
  RuntimeDeadlineExceeded,
  type RuntimeClock,
} from '../../src/session/turn-runtime.js';

interface Waiter {
  readonly due: number;
  readonly kind: 'sleep' | 'deadline';
  readonly onDue: () => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  settled: boolean;
}

export class ManualClock implements RuntimeClock {
  #now = 0;
  readonly #waiters: Waiter[] = [];
  readonly sleepDurations: number[] = [];
  readonly deadlineDurations: number[] = [];

  now(): number {
    return this.#now;
  }

  get pendingSleeps(): number {
    return this.#waiters.filter(
      (waiter) => !waiter.settled && waiter.kind === 'sleep',
    ).length;
  }

  get pendingDeadlines(): number {
    return this.#waiters.filter(
      (waiter) => !waiter.settled && waiter.kind === 'deadline',
    ).length;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleepDurations.push(ms);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        due: this.#now + ms,
        kind: 'sleep',
        onDue: resolve,
        settled: false,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal !== undefined) {
        const onAbort = () => this.#settle(waiter, () => reject(signal.reason));
        Object.assign(waiter, { onAbort });
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  async deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    this.deadlineDurations.push(ms);
    let waiter!: Waiter;
    const timeout = new Promise<never>((_resolve, reject) => {
      waiter = {
        due: this.#now + ms,
        kind: 'deadline',
        onDue: () => reject(new RuntimeDeadlineExceeded()),
        settled: false,
      };
      this.#waiters.push(waiter);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      this.#settle(waiter, () => undefined);
    }
  }

  async advance(ms: number): Promise<void> {
    this.#now += ms;
    for (const waiter of this.#waiters) {
      if (!waiter.settled && waiter.due <= this.#now) {
        this.#settle(waiter, waiter.onDue);
      }
    }
    await this.flush();
  }

  async flush(rounds = 50): Promise<void> {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  }

  #settle(waiter: Waiter, settle: () => void): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    settle();
  }
}
