import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  type AgentApp,
  type AgentContext,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse as AcpPromptResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';

import type { AimeTransport } from '../aime/transport.js';
import { AimeAcpError, toSafeError } from '../errors.js';
import {
  AIME_ACP_PACKAGE_NAME,
  AIME_ACP_PACKAGE_VERSION,
} from '../package-info.js';
import { OrderedNotifications } from './notifications.js';
import { convertPromptContent } from './prompt-content.js';

export interface HandlerSessionManager {
  create(): Promise<{ readonly sessionId: string }>;
}

export interface HandlerRuntime {
  load(sessionId: string): Promise<{
    readonly history: readonly {
      readonly role: 'user' | 'assistant';
      readonly messageId: string;
      readonly text: string;
    }[];
  }>;
  prompt(
    sessionId: string,
    content: string,
  ): Promise<{ readonly stopReason: 'end_turn' | 'cancelled' }>;
  cancel(sessionId: string): boolean;
}

export interface HandlerDependencies {
  readonly transport: Pick<AimeTransport, 'checkCompatibility'>;
  readonly manager: HandlerSessionManager;
  readonly runtime: HandlerRuntime;
  readonly notifications: RequestScopedNotifications;
  readonly warnIgnoredMcp: (count: number) => void;
  readonly authLoginCommand?: string;
}

interface NotificationRegistration {
  readonly client: AgentContext;
}

export class RequestScopedNotifications {
  readonly #clients = new Map<string, NotificationRegistration>();

  readonly notifications = new OrderedNotifications(
    async ({ sessionId, update }) => {
      const registration = this.#clients.get(sessionId);
      if (registration === undefined) {
        throw new AimeAcpError(
          'AIME_PROTOCOL_DRIFT',
          'The ACP prompt request client is unavailable.',
          false,
        );
      }
      await registration.client.notify('session/update', {
        sessionId,
        update,
      });
    },
  );

  async withClient<T>(
    sessionId: string,
    client: AgentContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.#clients.has(sessionId)) {
      throw new AimeAcpError(
        'SESSION_BUSY',
        'The AIME session is busy.',
        false,
      );
    }
    const registration: NotificationRegistration = { client };
    this.#clients.set(sessionId, registration);
    try {
      return await operation();
    } finally {
      if (this.#clients.get(sessionId) === registration)
        this.#clients.delete(sessionId);
    }
  }
}

export interface AcpHandlers {
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  loadSession(
    params: LoadSessionRequest,
    client: AgentContext,
  ): Promise<Record<string, never>>;
  prompt(
    params: PromptRequest,
    client: AgentContext,
  ): Promise<AcpPromptResponse>;
  cancel(params: CancelNotification): void;
}

function ignoredMcpCount(params: {
  readonly mcpServers?: readonly unknown[];
}): number {
  return Array.isArray(params.mcpServers) ? params.mcpServers.length : 0;
}

function requestError(error: unknown, authLoginCommand?: string): never {
  if (error instanceof AimeAcpError) {
    const safe = toSafeError(error);
    const command =
      safe.code === 'AUTH_REQUIRED' &&
      /^aime-acp auth login --site (?:cn|i18n-tt)$/.test(authLoginCommand ?? '')
        ? authLoginCommand
        : undefined;
    const message =
      command === undefined
        ? safe.message
        : `${safe.message} Run \`${command}\`.`;
    throw new RequestError(-32001, message, {
      code: safe.code,
      retryable: safe.retryable,
      ...safe.safeMetadata,
    });
  }
  throw error;
}

function textUpdate(
  role: 'user' | 'assistant',
  messageId: string,
  text: string,
): SessionUpdate {
  return {
    sessionUpdate:
      role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
    messageId,
    content: { type: 'text', text },
  };
}

export function createAcpHandlers(deps: HandlerDependencies): AcpHandlers {
  return {
    async initialize(_params) {
      try {
        await deps.transport.checkCompatibility();
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {},
          },
          agentInfo: {
            name:
              AIME_ACP_PACKAGE_NAME.split('/').at(-1) ?? AIME_ACP_PACKAGE_NAME,
            version: AIME_ACP_PACKAGE_VERSION,
          },
        };
      } catch (error) {
        return requestError(error, deps.authLoginCommand);
      }
    },

    async newSession(params) {
      try {
        const mcpCount = ignoredMcpCount(params);
        if (mcpCount > 0) deps.warnIgnoredMcp(mcpCount);
        const session = await deps.manager.create();
        return { sessionId: session.sessionId };
      } catch (error) {
        return requestError(error, deps.authLoginCommand);
      }
    },

    async loadSession(params, client) {
      try {
        return await deps.notifications.withClient(
          params.sessionId,
          client,
          async () => {
            const loaded = await deps.runtime.load(params.sessionId);
            for (const message of loaded.history) {
              await deps.notifications.notifications.send(
                params.sessionId,
                textUpdate(message.role, message.messageId, message.text),
              );
            }
            return {};
          },
        );
      } catch (error) {
        return requestError(error, deps.authLoginCommand);
      }
    },

    async prompt(params, client) {
      try {
        const content = convertPromptContent(params.prompt);
        return await deps.notifications.withClient(
          params.sessionId,
          client,
          () => deps.runtime.prompt(params.sessionId, content),
        );
      } catch (error) {
        return requestError(error, deps.authLoginCommand);
      }
    },

    cancel(params) {
      deps.runtime.cancel(params.sessionId);
    },
  };
}

export function createAcpApp(deps: HandlerDependencies): AgentApp {
  const handlers = createAcpHandlers(deps);
  return agent({
    name: AIME_ACP_PACKAGE_NAME.split('/').at(-1) ?? AIME_ACP_PACKAGE_NAME,
  })
    .onRequest('initialize', ({ params }) => handlers.initialize(params))
    .onRequest('session/new', ({ params }) => handlers.newSession(params))
    .onRequest('session/load', ({ params, client }) =>
      handlers.loadSession(params, client),
    )
    .onRequest('session/prompt', ({ params, client }) =>
      handlers.prompt(params, client),
    )
    .onNotification('session/cancel', ({ params }) => handlers.cancel(params));
}
