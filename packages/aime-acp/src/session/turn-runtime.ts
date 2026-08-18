import type { SessionUpdate } from '@agentclientprotocol/sdk';

import type { OrderedNotifications } from '../acp/notifications.js';
import type {
  NormalizedAimeEvent,
  NormalizedReference,
} from '../aime/event-types.js';
import type { AimeTransport } from '../aime/transport.js';
import { AimeAcpError, normalizeAimeError } from '../errors.js';
import type { PreparedEvent } from './event-cursor.js';
import type {
  ActiveTurn,
  SessionManager,
  SessionRuntimeState,
  TurnFailureSafety,
} from './session-manager.js';

export interface TurnRuntimeConfig {
  readonly model?: string;
  readonly locale?: string;
  readonly executionMode?: 'fast' | 'max';
}

export interface PromptResponse {
  readonly stopReason: 'end_turn' | 'cancelled';
}

export interface RuntimeClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  deadline<T>(promise: Promise<T>, ms: number): Promise<T>;
}

export class RuntimeDeadlineExceeded extends Error {
  constructor() {
    super('runtime deadline exceeded');
    this.name = 'RuntimeDeadlineExceeded';
  }
}

export interface RuntimeDiagnosticEvent {
  readonly event: 'aime.late_send_settlement';
  readonly outcome: 'resolved' | 'rejected';
}

export interface RuntimeDiagnostics {
  record(event: RuntimeDiagnosticEvent): void;
}

const noDiagnostics: RuntimeDiagnostics = { record: () => undefined };

export interface LoadResult {
  readonly session: SessionRuntimeState;
  readonly history: readonly {
    readonly role: 'user' | 'assistant';
    readonly messageId: string;
    readonly text: string;
  }[];
}

export const systemClock: RuntimeClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const settle = (callback: () => void) => {
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const timer = setTimeout(() => settle(resolve), ms);
      const onAbort = () => {
        clearTimeout(timer);
        settle(() => reject(signal?.reason));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  deadline: async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RuntimeDeadlineExceeded()), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
};

const EMPTY_TERMINAL = Symbol('empty-terminal');
const CANCELLED = Symbol('cancelled');

function protocolDrift(message: string): AimeAcpError {
  return new AimeAcpError('AIME_PROTOCOL_DRIFT', message, false);
}

function streamInterrupted(): AimeAcpError {
  return new AimeAcpError(
    'AIME_STREAM_INTERRUPTED',
    'AIME response stream ended before its terminal event.',
    true,
  );
}

function emptyResponse(): AimeAcpError {
  return new AimeAcpError(
    'AIME_EMPTY_RESPONSE',
    'AIME returned an empty response.',
    false,
  );
}

function nonRetryableAimeError(error: unknown): boolean {
  return error instanceof AimeAcpError && !error.retryable;
}

function remoteRunning(status: string): boolean {
  return status === 'queued' || status === 'running';
}

function definitelyNotMutated(error: unknown): boolean {
  return (
    error instanceof AimeAcpError &&
    (error.code === 'AUTH_REQUIRED' ||
      error.code === 'AUTH_IDENTITY_CHANGED' ||
      error.code === 'AUTH_IDENTITY_UNAVAILABLE' ||
      error.code === 'AUTH_SOURCE_UNSUPPORTED' ||
      error.code === 'AUTH_CONFIGURATION_UNSUPPORTED' ||
      error.code === 'AIME_ACCESS_DENIED' ||
      error.code === 'AIME_MODEL_NOT_FOUND' ||
      error.code === 'AIME_UNSUPPORTED_CONTENT')
  );
}

function nonBlankId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function strictTimestamp(value: string): number {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (match === null) {
    throw protocolDrift('AIME send timestamp is invalid.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zoneHour = Number(match[7] ?? 0);
  const zoneMinute = Number(match[8] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    zoneHour > 23 ||
    zoneMinute > 59
  ) {
    throw protocolDrift('AIME send timestamp is invalid.');
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) {
    throw protocolDrift('AIME send timestamp is invalid.');
  }
  return parsed;
}

function eventTimestamp(event: NormalizedAimeEvent): number | undefined {
  if (event.kind === 'ping') return undefined;
  const timestamp = (event as { timestampMs?: unknown }).timestampMs;
  if (
    typeof timestamp !== 'number' ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    throw protocolDrift('AIME event timestamp is invalid.');
  }
  return timestamp;
}

function isHttpReference(reference: NormalizedReference): boolean {
  try {
    const url = new URL(reference.uri);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sourceUpdate(
  references: readonly NormalizedReference[],
): SessionUpdate | undefined {
  const unique = new Map<string, NormalizedReference>();
  for (const reference of references) {
    if (
      unique.size >= 20 ||
      !isHttpReference(reference) ||
      unique.has(reference.uri)
    )
      continue;
    unique.set(reference.uri, reference);
  }
  if (unique.size === 0) return undefined;
  return {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'aime-sources',
    _meta: { 'aime.acp.message_kind': 'sources' },
    content: {
      type: 'text',
      text: `Sources:\n${[...unique.values()]
        .map(
          (reference) =>
            `- [${reference.title.replaceAll(']', '\\]')}](${reference.uri})`,
        )
        .join('\n')}`,
    },
  } as SessionUpdate;
}

function presentable(update: SessionUpdate | undefined): boolean {
  if (update === undefined) return false;
  if (
    update.sessionUpdate === 'agent_message_chunk' &&
    update.content.type === 'text'
  ) {
    return update.content.text.trim().length > 0;
  }
  if (
    (update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update') &&
    update.content !== undefined &&
    update.content !== null
  ) {
    return update.content.some(
      (item) =>
        item.type === 'content' &&
        item.content.type === 'text' &&
        item.content.text.trim().length > 0,
    );
  }
  return false;
}

function sideChannelEligible(
  event: NormalizedAimeEvent,
  active: ActiveTurn,
  currentUserSeen: boolean,
): boolean {
  const timestamp = eventTimestamp(event);
  return (
    timestamp !== undefined &&
    timestamp >= active.sentAtMs - 1_000 &&
    (currentUserSeen || active.assistantMessageId !== undefined)
  );
}

/** Runs exactly one correlated remote AIME turn for a process-owned session. */
export class TurnRuntime {
  constructor(
    private readonly sessions: SessionManager,
    private readonly transport: AimeTransport,
    private readonly notifications: OrderedNotifications,
    private readonly config: TurnRuntimeConfig = {},
    private readonly clock: RuntimeClock = systemClock,
    private readonly diagnostics: RuntimeDiagnostics = noDiagnostics,
  ) {}

  async load(sessionId: string): Promise<LoadResult> {
    const expected = this.sessions.owned(sessionId);
    let candidate: SessionRuntimeState | undefined;
    try {
      const remote = await this.transport.getSession(sessionId, {
        withMessages: true,
      });
      if (remote.id !== sessionId || !nonBlankId(remote.sourceSpaceId)) {
        throw protocolDrift('AIME returned a different or invalid session.');
      }
      if (
        expected !== undefined &&
        expected.sourceSpaceId !== remote.sourceSpaceId
      ) {
        throw protocolDrift(
          'AIME session source space changed during recovery.',
        );
      }
      if (expected === undefined) {
        const resolvedSpace = await this.transport.resolveSpace();
        if (
          !nonBlankId(resolvedSpace.id) ||
          resolvedSpace.id !== remote.sourceSpaceId
        ) {
          throw protocolDrift(
            'AIME session is outside the resolved process space.',
          );
        }
      }
      candidate = this.sessions.createRecoveryCandidate(
        remote.id,
        remote.sourceSpaceId,
      );
      const recoveryCandidate = candidate;
      const history = remote.messages.map((message, index) => {
        const possibleId = (message as { id?: unknown }).id;
        return {
          role: message.role,
          messageId: nonBlankId(possibleId) ? possibleId : `history-${index}`,
          text: message.content,
        };
      });

      // A finished session carries its full history already. acpx resumes
      // every prompt through session/load, so keep recovery bounded: replay
      // the event stream once (with a short deadline) to rebuild the cursor
      // and detect a pending terminal, then stop instead of polling an idle
      // autoClose:false stream until the 90s cap.
      if (!remoteRunning(remote.status)) {
        const segmentController = new AbortController();
        let terminal: 'Idle' | 'AwaitingUserInput' | undefined;
        try {
          const stream = this.transport.streamEvents({
            sessionId,
            eventOffset: recoveryCandidate.cursor.nextEventOffset,
            signal: segmentController.signal,
          });
          const iterator = stream[Symbol.asyncIterator]();
          const readSegment = async (): Promise<void> => {
            for await (const item of {
              [Symbol.asyncIterator]: () => iterator,
            }) {
              eventTimestamp(item);
              const prepared = recoveryCandidate.cursor.prepare(item);
              prepared.commit();
              if (
                item.kind === 'progress' &&
                item.status === 'waiting_for_next'
              ) {
                terminal = 'Idle';
              } else if (item.kind === 'action.tool_call_required') {
                terminal = 'AwaitingUserInput';
              } else if (item.kind !== 'ping') {
                terminal = undefined;
              }
            }
          };
          await this.clock.deadline(readSegment(), 1_500);
        } catch (error) {
          segmentController.abort(error);
          if (!(error instanceof RuntimeDeadlineExceeded)) throw error;
        }
        recoveryCandidate.turnState = terminal ?? 'Idle';
        this.sessions.publishRecovery(recoveryCandidate, expected);
        return { session: recoveryCandidate, history };
      }

      const startedAt = this.clock.now();
      const loadBudgetMs = 20_000;
      let emptySegments = 0;
      let segments = 0;
      let firstSegment = true;
      let terminal: 'Idle' | 'AwaitingUserInput' | undefined;
      while (emptySegments < 2) {
        if (segments >= 64 || this.clock.now() - startedAt >= loadBudgetMs) {
          throw streamInterrupted();
        }
        segments += 1;
        const segmentStartVersion = recoveryCandidate.cursor.version;
        const segmentController = new AbortController();
        const stream = this.transport.streamEvents({
          sessionId,
          eventOffset: firstSegment
            ? recoveryCandidate.cursor.nextEventOffset
            : recoveryCandidate.cursor.replayEventOffset,
          signal: segmentController.signal,
        });
        firstSegment = false;
        const iterator = stream[Symbol.asyncIterator]();
        const readSegment = async (): Promise<void> => {
          for await (const item of { [Symbol.asyncIterator]: () => iterator }) {
            eventTimestamp(item);
            const prepared = recoveryCandidate.cursor.prepare(item);
            prepared.commit();
            if (
              item.kind === 'progress' &&
              item.status === 'waiting_for_next'
            ) {
              terminal = 'Idle';
            } else if (item.kind === 'action.tool_call_required') {
              terminal = 'AwaitingUserInput';
            } else if (item.kind !== 'ping') {
              terminal = undefined;
            }
          }
        };
        const reader = readSegment();
        try {
          const remaining = loadBudgetMs - (this.clock.now() - startedAt);
          await this.clock.deadline(reader, Math.min(5_000, remaining));
        } catch (error) {
          segmentController.abort(error);
          await reader.catch(() => undefined);
          if (!(error instanceof RuntimeDeadlineExceeded)) throw error;
        }
        if (this.clock.now() - startedAt >= loadBudgetMs) {
          throw streamInterrupted();
        }
        emptySegments =
          recoveryCandidate.cursor.version > segmentStartVersion
            ? 0
            : emptySegments + 1;
      }

      recoveryCandidate.turnState = terminal ?? 'Draining';
      this.sessions.publishRecovery(recoveryCandidate, expected);
      if (recoveryCandidate.turnState === 'Draining') {
        this.sessions.trackDrain(
          sessionId,
          this.drainCancelled(recoveryCandidate),
        );
      }
      return { session: recoveryCandidate, history };
    } catch (error) {
      if (candidate !== undefined) candidate.turnState = 'Desynced';
      throw normalizeAimeError(error, 'recovery');
    }
  }

  async prompt(sessionId: string, content: string): Promise<PromptResponse> {
    const startedAt = this.clock.now();
    this.debug(`[turn] prompt start session=${sessionId}`);
    const session = this.sessions.beginTurn(sessionId);
    const active = session.activeTurn;
    if (active === undefined) throw protocolDrift('AIME turn state was lost.');
    let operation: 'model' | 'send' | 'stream' = 'model';
    let failureSafety: TurnFailureSafety = 'known-safe-pre-mutation';
    let result: PromptResponse | typeof EMPTY_TERMINAL;
    try {
      const modelResource = await this.raceCancellation(
        active,
        this.transport.resolveModel({
          spaceId: session.sourceSpaceId,
          sessionId,
          ...(this.config.model === undefined
            ? {}
            : { name: this.config.model }),
        }),
      );
      if (modelResource === CANCELLED) return { stopReason: 'cancelled' };
      this.debug(`[turn] model resolved ms=${this.clock.now() - startedAt}`);
      operation = 'send';
      failureSafety = 'ambiguous-after-mutation';
      const pendingSend = this.transport.sendMessage({
        sessionId,
        spaceId: session.sourceSpaceId,
        content,
        ...(modelResource === undefined ? {} : { modelResource }),
        ...(this.config.locale === undefined
          ? {}
          : { locale: this.config.locale }),
        ...(this.config.executionMode === undefined
          ? {}
          : { executionMode: this.config.executionMode }),
      });
      active.pendingSend = pendingSend;
      const sent = await this.raceCancellation(active, pendingSend);
      if (sent === CANCELLED) return { stopReason: 'cancelled' };
      delete active.pendingSend;
      if (!nonBlankId(sent.messageId)) {
        throw protocolDrift('AIME sent an invalid user message ID.');
      }
      active.userMessageId = sent.messageId;
      active.sentAtMs = strictTimestamp(sent.createdAt);
      this.debug(
        `[turn] send ok messageId=${sent.messageId} ms=${this.clock.now() - startedAt}`,
      );
      session.turnState = 'Streaming';
      operation = 'stream';
      const foreground = this.consumeCurrentTurn(session)
        .then((value) => {
          if (value === EMPTY_TERMINAL) active.foregroundTerminal = 'empty';
          return value;
        })
        .finally(() => {
          active.signalForegroundDone();
        });
      const consumed = await this.raceCancellation(active, foreground);
      this.debug(
        `[turn] foreground done result=${consumed === CANCELLED ? 'cancelled' : 'end_turn'} ms=${this.clock.now() - startedAt}`,
      );
      if (consumed === CANCELLED) return { stopReason: 'cancelled' };
      result = consumed;
    } catch (error) {
      if (active.outputDisabled) return { stopReason: 'cancelled' };
      const normalized = normalizeAimeError(error, operation);
      this.sessions.failTurn(session, failureSafety);
      throw normalized;
    }
    if (result === EMPTY_TERMINAL) {
      this.sessions.failTurn(session, 'known-terminal');
      throw emptyResponse();
    }
    return result;
  }

  cancel(sessionId: string): boolean {
    const session = this.sessions.owned(sessionId);
    const active = session?.activeTurn;
    if (
      session === undefined ||
      active === undefined ||
      active.outputDisabled
    ) {
      return false;
    }
    if (active.foregroundTerminal === 'empty') return false;
    active.outputDisabled = true;
    session.turnState = 'SoftCancelled';
    active.signalCancelled();

    let drain: Promise<void>;
    if (
      active.pendingSend !== undefined &&
      active.userMessageId === undefined
    ) {
      drain = this.continueCancelledSend(session, active, active.pendingSend);
    } else if (active.userMessageId === undefined) {
      active.abortController.abort(new Error('AIME turn cancelled'));
      this.sessions.completeTurn(session, 'Idle');
      drain = new Promise<void>((resolve) => resolve());
    } else {
      active.abortController.abort(new Error('AIME turn cancelled'));
      drain = active.foregroundDone.then(async () => {
        if (session.activeTurn !== active) {
          return;
        }
        if (active.foregroundTerminal === 'empty') {
          this.sessions.failTurn(session, 'known-terminal');
          return;
        }
        if (session.turnState !== 'Draining') return;
        await this.drainCancelled(session);
      });
    }
    if (session.activeTurn !== undefined) session.turnState = 'Draining';
    this.sessions.trackDrain(sessionId, drain);
    return true;
  }

  private async raceCancellation<T>(
    active: ActiveTurn,
    promise: Promise<T>,
  ): Promise<T | typeof CANCELLED> {
    void promise.catch(() => undefined);
    return (await Promise.race([
      promise,
      active.cancelled.then((): typeof CANCELLED => CANCELLED),
    ])) as T | typeof CANCELLED;
  }

  private async continueCancelledSend(
    session: SessionRuntimeState,
    active: ActiveTurn,
    pendingSend: Promise<{ messageId: string; createdAt: string }>,
  ): Promise<void> {
    void pendingSend.then(
      () => undefined,
      () => undefined,
    );
    try {
      const sent = await this.clock.deadline(pendingSend, 30_000);
      if (!nonBlankId(sent.messageId)) {
        throw protocolDrift('AIME sent an invalid user message ID.');
      }
      active.userMessageId = sent.messageId;
      active.sentAtMs = strictTimestamp(sent.createdAt);
      delete active.pendingSend;
      await this.drainCancelled(session);
    } catch (error) {
      delete active.pendingSend;
      if (error instanceof RuntimeDeadlineExceeded) {
        this.sessions.failTurn(session, 'ambiguous-after-mutation');
        void pendingSend.then(
          () => this.recordLateSend('resolved'),
          () => this.recordLateSend('rejected'),
        );
      } else if (definitelyNotMutated(error)) {
        this.sessions.completeTurn(session, 'Idle');
      } else {
        this.sessions.failTurn(session, 'ambiguous-after-mutation');
      }
    }
  }

  private recordLateSend(outcome: 'resolved' | 'rejected'): void {
    try {
      this.diagnostics.record({
        event: 'aime.late_send_settlement',
        outcome,
      });
    } catch {
      // Diagnostics must never affect runtime state or surface raw values.
    }
  }

  private async drainCancelled(session: SessionRuntimeState): Promise<void> {
    const startedAt = this.clock.now();
    let retries = 0;
    let backoffIndex = 0;
    while (true) {
      const attemptController = new AbortController();
      let iterator: AsyncIterator<NormalizedAimeEvent> | undefined;
      try {
        const stream = this.transport.streamEvents({
          sessionId: session.sessionId,
          eventOffset:
            session.activeTurn?.replayFloor ?? session.cursor.replayEventOffset,
          signal: attemptController.signal,
        });
        iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const item = await this.clock.deadline(iterator.next(), 20_000);
          if (item.done) break;
          eventTimestamp(item.value);
          const prepared = session.cursor.prepare(item.value);
          prepared.commit();
          retries = 0;
          backoffIndex = 0;
          if (
            item.value.kind === 'progress' &&
            item.value.status === 'waiting_for_next'
          ) {
            this.sessions.completeTurn(session, 'Idle');
            return;
          }
          if (item.value.kind === 'action.tool_call_required') {
            this.sessions.completeTurn(session, 'AwaitingUserInput');
            return;
          }
        }
      } catch (error) {
        if (nonRetryableAimeError(error)) {
          this.sessions.failTurn(session, 'ambiguous-after-mutation');
          return;
        }
      } finally {
        attemptController.abort(
          new Error('AIME cancelled drain segment closed'),
        );
        if (iterator?.return !== undefined) {
          try {
            await this.clock.deadline(iterator.return(), 20_000);
          } catch {
            // Cleanup failure must not change the drain state already selected.
          }
        }
      }
      if (retries >= 8) {
        this.sessions.failTurn(session, 'ambiguous-after-mutation');
        return;
      }
      const delay =
        [250, 500, 1000, 2000, 5000][Math.min(backoffIndex, 4)] ?? 5000;
      if (this.clock.now() - startedAt + delay > 60_000) {
        this.sessions.failTurn(session, 'ambiguous-after-mutation');
        return;
      }
      retries += 1;
      backoffIndex += 1;
      await this.clock.sleep(delay);
    }
  }

  private async commitEvent(
    session: SessionRuntimeState,
    prepared: PreparedEvent,
    update: SessionUpdate | undefined,
  ): Promise<void> {
    if (update !== undefined && !session.activeTurn?.outputDisabled)
      await this.notifications.send(session.sessionId, update);
    prepared.commit();
    if (presentable(update) && session.activeTurn !== undefined) {
      session.activeTurn.emittedPresentableContent = true;
    }
  }

  private async consumeCurrentTurn(
    session: SessionRuntimeState,
  ): Promise<PromptResponse | typeof EMPTY_TERMINAL> {
    const active = session.activeTurn;
    if (active === undefined || !nonBlankId(active.userMessageId)) {
      throw protocolDrift('AIME turn is missing its user message ID.');
    }
    let currentUserSeen = false;
    const currentAssistantMessageIds = new Set<string>();
    const unrelatedAssistantMessageIds = new Set<string>();
    const pendingAssistantMessageIds = new Set<string>();
    const pendingFinishedMessageIds = new Set<string>();
    const currentReferences: NormalizedReference[] = [];
    const startedAt = this.clock.now();
    let retries = 0;
    let backoffIndex = 0;
    let consecutiveEmpty = 0;
    let firstSegment = true;
    let segmentIndex = 0;

    while (true) {
      segmentIndex += 1;
      this.debug(
        `[turn] segment ${segmentIndex} start offset=${firstSegment ? session.cursor.nextEventOffset : active.replayFloor} ms=${this.clock.now() - startedAt}`,
      );
      const segmentStartVersion = session.cursor.version;
      const segmentStartOffset = firstSegment
        ? session.cursor.nextEventOffset
        : active.replayFloor;
      firstSegment = false;
      let segmentError: unknown;
      let localFailure = false;
      session.turnState = retries === 0 ? 'Streaming' : 'Reconnecting';
      const segmentController = new AbortController();
      const abortSegment = () =>
        segmentController.abort(active.abortController.signal.reason);
      active.abortController.signal.addEventListener('abort', abortSegment, {
        once: true,
      });
      try {
        const stream = this.transport.streamEvents({
          sessionId: session.sessionId,
          eventOffset: segmentStartOffset,
          signal: segmentController.signal,
        });
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const item = await this.clock.deadline(iterator.next(), 20_000);
          if (item.done) break;
          this.debug(
            `[turn] segment ${segmentIndex} event kind=${item.value.kind} status=${item.value.kind === 'progress' ? ((item.value as { status?: string }).status ?? '') : ''} ms=${this.clock.now() - startedAt}`,
          );
          let terminal: Awaited<ReturnType<TurnRuntime['consumeEvent']>>;
          try {
            terminal = await this.consumeEvent(
              session,
              item.value,
              active,
              currentReferences,
              currentAssistantMessageIds,
              unrelatedAssistantMessageIds,
              pendingAssistantMessageIds,
              pendingFinishedMessageIds,
              currentUserSeen,
            );
          } catch (error) {
            localFailure = true;
            throw error;
          }
          currentUserSeen = terminal.currentUserSeen;
          if (terminal.result !== undefined) return terminal.result;
        }
      } catch (error) {
        segmentController.abort(error);
        segmentError = error;
      } finally {
        active.abortController.signal.removeEventListener(
          'abort',
          abortSegment,
        );
      }

      if (localFailure) throw segmentError;
      if (active.outputDisabled) throw new Error('AIME turn cancelled');
      if (this.clock.now() - startedAt > 60_000) throw streamInterrupted();
      if (segmentError !== undefined && nonRetryableAimeError(segmentError)) {
        throw segmentError;
      }
      const committedNewEvent = session.cursor.version > segmentStartVersion;
      this.debug(
        `[turn] segment ${segmentIndex} done committed=${committedNewEvent} consecutiveEmpty=${consecutiveEmpty + (committedNewEvent ? 0 : 1)} elapsed=${this.clock.now() - startedAt}ms error=${segmentError ? (segmentError as Error).message.slice(0, 80) : 'none'}`,
      );
      if (committedNewEvent) {
        retries = 0;
        backoffIndex = 0;
        consecutiveEmpty = 0;
      } else {
        consecutiveEmpty += 1;
      }

      if (consecutiveEmpty >= 2) {
        const remote = await this.transport.getSession(session.sessionId, {
          withMessages: true,
        });
        this.debug(
          `[turn] segment ${segmentIndex} session check status=${remote.status} assistantFinished=${active.assistantFinished} emitted=${active.emittedPresentableContent}`,
        );
        if (!remoteRunning(remote.status) && active.assistantFinished) {
          if (!active.emittedPresentableContent) return EMPTY_TERMINAL;
          this.sessions.completeTurn(session, 'Idle');
          return { stopReason: 'end_turn' };
        }
        consecutiveEmpty = 0;
      }

      if (retries >= 8) throw streamInterrupted();
      const delay =
        [250, 500, 1000, 2000, 5000][Math.min(backoffIndex, 4)] ?? 5000;
      if (this.clock.now() - startedAt + delay > 60_000)
        throw streamInterrupted();
      retries += 1;
      backoffIndex += 1;
      session.turnState = 'Reconnecting';
      await this.clock.sleep(delay, active.abortController.signal);
    }
  }

  private debug(message: string): void {
    if (process.env.AIME_ACP_TURN_DEBUG !== 'true') return;
    process.stderr.write(`[aime-acp] ${message}\n`);
  }

  private async consumeEvent(
    session: SessionRuntimeState,
    event: NormalizedAimeEvent,
    active: ActiveTurn,
    currentReferences: NormalizedReference[],
    currentAssistantMessageIds: Set<string>,
    unrelatedAssistantMessageIds: Set<string>,
    pendingAssistantMessageIds: Set<string>,
    pendingFinishedMessageIds: Set<string>,
    currentUserSeen: boolean,
  ): Promise<{
    readonly currentUserSeen: boolean;
    readonly result?: PromptResponse | typeof EMPTY_TERMINAL;
  }> {
    eventTimestamp(event);
    let suppressPendingDelta = false;
    if (event.kind === 'message.delta') {
      if (!nonBlankId(event.messageId)) {
        throw protocolDrift('AIME delta message ID is invalid.');
      }
      suppressPendingDelta =
        currentAssistantMessageIds.size > 0 &&
        !currentAssistantMessageIds.has(event.messageId) &&
        !unrelatedAssistantMessageIds.has(event.messageId) &&
        event.timestampMs >= active.sentAtMs - 1_000;
      if (suppressPendingDelta) {
        pendingAssistantMessageIds.add(event.messageId);
        if (event.finished) pendingFinishedMessageIds.add(event.messageId);
      }
    }
    const prepared = suppressPendingDelta
      ? session.cursor.prepareUncorrelated(event, active.replayFloor)
      : session.cursor.prepare(event, active.replayFloor);
    let update: SessionUpdate | undefined;
    let current = false;

    if (event.kind === 'message.create') {
      if (!nonBlankId(event.message.id)) {
        throw protocolDrift('AIME event message ID is invalid.');
      }
      if (event.message.role === 'user') {
        currentUserSeen ||= event.message.id === active.userMessageId;
      } else {
        if (event.replyMessageId === active.userMessageId) {
          if (
            active.assistantMessageId !== undefined &&
            active.assistantMessageId !== event.message.id
          ) {
            throw protocolDrift(
              'AIME turn has conflicting assistant messages.',
            );
          }
          active.assistantMessageId = event.message.id;
          currentAssistantMessageIds.add(event.message.id);
          pendingAssistantMessageIds.delete(event.message.id);
          if (pendingFinishedMessageIds.delete(event.message.id)) {
            active.assistantFinished = true;
          }
          current = true;
        } else if (
          event.replyMessageId === undefined &&
          active.assistantMessageId !== undefined &&
          event.timestampMs >= active.sentAtMs - 1_000
        ) {
          currentAssistantMessageIds.add(event.message.id);
          pendingAssistantMessageIds.delete(event.message.id);
          if (pendingFinishedMessageIds.delete(event.message.id)) {
            active.assistantFinished = true;
          }
          current = true;
        } else {
          pendingAssistantMessageIds.delete(event.message.id);
          pendingFinishedMessageIds.delete(event.message.id);
          unrelatedAssistantMessageIds.add(event.message.id);
        }
      }
    } else if (event.kind === 'message.delta') {
      if (currentAssistantMessageIds.size > 0) {
        current = currentAssistantMessageIds.has(event.messageId);
      } else if (
        !unrelatedAssistantMessageIds.has(event.messageId) &&
        event.timestampMs >= active.sentAtMs - 1_000
      ) {
        active.assistantMessageId = event.messageId;
        currentAssistantMessageIds.add(event.messageId);
        current = true;
      }
      if (current && event.finished) active.assistantFinished = true;
    } else {
      current = sideChannelEligible(event, active, currentUserSeen);
    }

    if (event.kind === 'reference' && current) {
      currentReferences.push(...event.references);
    }
    if (event.kind === 'progress' && event.status === 'waiting_for_next') {
      if (!current) {
        await this.commitEvent(session, prepared, undefined);
        return { currentUserSeen };
      }
      update = sourceUpdate(currentReferences);
      await this.commitEvent(session, prepared, update);
      if (!active.emittedPresentableContent) {
        return { currentUserSeen, result: EMPTY_TERMINAL };
      }
      this.sessions.completeTurn(session, 'Idle');
      return { currentUserSeen, result: { stopReason: 'end_turn' } };
    }

    update = current ? prepared.update : undefined;
    await this.commitEvent(session, prepared, update);
    if (event.kind === 'action.tool_call_required' && current) {
      this.sessions.completeTurn(session, 'AwaitingUserInput');
      return { currentUserSeen, result: { stopReason: 'end_turn' } };
    }
    return { currentUserSeen };
  }
}
