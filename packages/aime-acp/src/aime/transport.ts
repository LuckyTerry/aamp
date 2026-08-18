import type { NormalizedAimeEvent } from './event-types.js';

export interface AimeSession {
  readonly id: string;
  readonly status: string;
  readonly sourceSpaceId: string;
  readonly messages: readonly {
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }[];
}

export interface AimeTransport {
  checkCompatibility(): Promise<void>;
  resolveSpace(): Promise<{ id: string }>;
  resolveModel(input: {
    spaceId: string;
    sessionId?: string;
    name?: string;
  }): Promise<{ name: string } | undefined>;
  createSession(input: {
    spaceId: string;
    useInternalTools: true;
  }): Promise<{ id: string; sourceSpaceId: string }>;
  getSession(
    sessionId: string,
    options?: { withMessages?: boolean },
  ): Promise<AimeSession>;
  sendMessage(input: {
    sessionId: string;
    spaceId?: string;
    content: string;
    modelResource?: { name: string };
    locale?: string;
    executionMode?: 'fast' | 'max';
  }): Promise<{ messageId: string; createdAt: string }>;
  streamEvents(input: {
    sessionId: string;
    eventOffset: number;
    signal: AbortSignal;
  }): AsyncIterable<NormalizedAimeEvent>;
}
