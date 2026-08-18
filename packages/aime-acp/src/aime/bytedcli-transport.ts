import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import type { ManagedUserAuthGuard } from '../auth/identity-guard.js';
import type { AuthFacade } from '../auth/provider.js';
import { AimeAcpError, normalizeAimeError } from '../errors.js';
import { normalizeAimeEvent } from './event-normalizer.js';
import type { NormalizedAimeEvent } from './event-types.js';
import type { AimeSession, AimeTransport } from './transport.js';

export interface AimeTransportConfig {
  readonly spaceId?: string;
  readonly model?: string;
  readonly executionMode?: 'fast' | 'max';
}

type AimeApi = {
  listSpaces(options?: {
    limit?: number;
    nextId?: string;
  }): Promise<{ spaces: unknown[]; next_id?: string }>;
  listModels(options: {
    spaceId: string;
    sessionId?: string;
  }): Promise<unknown>;
  createSession(
    spaceId: string,
    options?: { useInternalTool?: boolean },
  ): Promise<unknown>;
  getSession(
    sessionId: string,
    options?: { withMessages?: boolean },
  ): Promise<unknown>;
  sendMessage(
    sessionId: string,
    content: string,
    options?: {
      spaceId?: string;
      modeType?: 'auto';
      modelResource?: { name: string };
      enableModelSelection?: boolean;
      locale?: string;
      executionMode?: 'fast' | 'max';
    },
  ): Promise<unknown>;
  streamEvents(
    sessionId: string,
    options?: {
      eventOffset?: number;
      signal?: AbortSignal;
      autoClose?: boolean;
    },
  ): AsyncIterable<unknown>;
};

export interface BytedcliAimeFacade extends AuthFacade {
  readonly api: { readonly aime: AimeApi };
}

type ImportBytedcli = () => Promise<unknown>;
const require = createRequire(import.meta.url);

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function ownValue(
  source: Readonly<Record<string, unknown>>,
  property: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, property);
  if (descriptor === undefined) return undefined;
  if ('value' in descriptor) return descriptor.value;
  return descriptor.get?.call(source);
}

function incompatible(): AimeAcpError {
  return new AimeAcpError(
    'AIME_SDK_INCOMPATIBLE',
    'The installed AIME SDK interface is incompatible.',
    false,
  );
}

function modelMissing(): AimeAcpError {
  return new AimeAcpError(
    'AIME_MODEL_NOT_FOUND',
    'The requested AIME model was not found.',
    false,
  );
}

function protocolDrift(): AimeAcpError {
  return new AimeAcpError(
    'AIME_PROTOCOL_DRIFT',
    'AIME returned an incompatible response.',
    false,
  );
}

function asFacade(value: unknown): BytedcliAimeFacade {
  const root = record(value);
  const auth = record(root?.auth);
  const utils = record(root?.utils);
  const api = record(root?.api);
  const aime = record(api === undefined ? undefined : ownValue(api, 'aime'));
  const functions = [
    auth?.getExternalBytecloudAuthStatus,
    auth?.byteCloudAuthEnsureAuth,
    auth?.byteCloudAuthUserInfo,
    auth?.byteCloudAuthLogin,
    auth?.byteCloudAuthBeginLogin,
    auth?.byteCloudAuthCompleteLogin,
    utils?.setCloudSite,
    utils?.setAuthAs,
    utils?.setHttpConfig,
    aime?.listSpaces,
    aime?.listModels,
    aime?.createSession,
    aime?.getSession,
    aime?.sendMessage,
    aime?.streamEvents,
  ];
  if (functions.some((value) => typeof value !== 'function'))
    throw incompatible();
  return value as BytedcliAimeFacade;
}

function listedSpace(
  value: unknown,
): { id: string; type: string; status: string } | undefined {
  const source = record(value);
  const id = text(source?.id);
  const type = text(source?.type);
  const status = text(source?.status);
  return id && type && status ? { id, type, status } : undefined;
}

function modelNames(value: unknown, mode: 'fast' | 'max'): readonly string[] {
  const source = record(value);
  const modeLists = record(source?.text_models_by_execution_mode);
  const selected = modeLists?.[mode];
  const candidates = Array.isArray(selected)
    ? selected
    : selected === undefined
      ? source?.text_models
      : undefined;
  if (!Array.isArray(candidates)) throw protocolDrift();
  return candidates.flatMap(
    (candidate) => text(record(record(candidate)?.model_resource)?.name) ?? [],
  );
}

export class BytedcliAimeTransport implements AimeTransport {
  constructor(
    private readonly facade: BytedcliAimeFacade,
    private readonly guard: ManagedUserAuthGuard,
    private readonly config: AimeTransportConfig,
  ) {}

  private async withManagedUser<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.guard.assertStable(operation);
    return fn();
  }

  async checkCompatibility(): Promise<void> {
    try {
      const entryPath = require.resolve('@bytedance-dev/bytedcli');
      const packagePath = resolve(dirname(entryPath), '..', 'package.json');
      const pkg = record(require(packagePath));
      if (text(pkg?.version) !== '0.123.0') throw incompatible();
      asFacade(this.facade);
    } catch (error) {
      throw normalizeAimeError(error, 'compatibility');
    }
  }

  async resolveSpace(): Promise<{ id: string }> {
    if (this.config.spaceId !== undefined) return { id: this.config.spaceId };
    let nextId: string | undefined;
    const seenCursors = new Set<string>();
    let firstPersonal: { id: string } | undefined;
    do {
      let page: { spaces: unknown[]; next_id?: unknown };
      try {
        const response = record(
          await this.withManagedUser('space/list', () =>
            this.facade.api.aime.listSpaces({
              limit: 20,
              ...(nextId === undefined ? {} : { nextId }),
            }),
          ),
        );
        if (!response || !Array.isArray(response.spaces)) throw protocolDrift();
        if (
          response.next_id !== undefined &&
          typeof response.next_id !== 'string'
        )
          throw protocolDrift();
        page = { spaces: response.spaces, next_id: response.next_id };
      } catch (error) {
        throw normalizeAimeError(error, 'session-read');
      }
      for (const raw of page.spaces) {
        const space = listedSpace(raw);
        if (space?.type !== 'personal') continue;
        if (space.status === 'active') return { id: space.id };
        firstPersonal ??= { id: space.id };
      }
      nextId =
        page.next_id === '' ? undefined : (page.next_id as string | undefined);
      if (nextId !== undefined) {
        if (seenCursors.has(nextId)) throw protocolDrift();
        seenCursors.add(nextId);
      }
    } while (nextId !== undefined);
    if (firstPersonal) return firstPersonal;
    throw new AimeAcpError(
      'AIME_ACCESS_DENIED',
      'Access to AIME was denied.',
      false,
    );
  }

  async resolveModel(input: {
    spaceId: string;
    sessionId?: string;
    name?: string;
  }): Promise<{ name: string } | undefined> {
    const name = input.name ?? this.config.model;
    if (name === undefined) return undefined;
    if (name === 'auto' || name === 'auto-sota') return { name: '' };
    try {
      const models = await this.withManagedUser('model/list', () =>
        this.facade.api.aime.listModels({
          spaceId: input.spaceId,
          ...(input.sessionId === undefined
            ? {}
            : { sessionId: input.sessionId }),
        }),
      );
      if (
        !modelNames(models, this.config.executionMode ?? 'fast').includes(name)
      )
        throw modelMissing();
      return { name };
    } catch (error) {
      throw normalizeAimeError(error, 'model');
    }
  }

  async createSession(input: {
    spaceId: string;
    useInternalTools: true;
  }): Promise<{ id: string; sourceSpaceId: string }> {
    try {
      const session = record(
        await this.withManagedUser('session/create', () =>
          this.facade.api.aime.createSession(input.spaceId, {
            useInternalTool: input.useInternalTools,
          }),
        ),
      );
      const id = text(session?.id);
      const sourceSpaceId = text(session?.source_space_id);
      if (!id || !sourceSpaceId) throw protocolDrift();
      return { id, sourceSpaceId };
    } catch (error) {
      throw normalizeAimeError(error, 'create');
    }
  }

  async getSession(
    sessionId: string,
    options?: { withMessages?: boolean },
  ): Promise<AimeSession> {
    try {
      const session = record(
        await this.withManagedUser('session/get', () =>
          this.facade.api.aime.getSession(sessionId, options),
        ),
      );
      if (!session) throw protocolDrift();
      const id = text(session?.id);
      const status = text(session?.status);
      const sourceSpaceId = text(session?.source_space_id);
      if (!id || !status || !sourceSpaceId) throw protocolDrift();
      const messages = Array.isArray(session.messages)
        ? session.messages.flatMap((value) => {
            const message = record(value);
            const role = text(message?.role);
            const content = text(message?.content);
            return (role === 'user' || role === 'assistant') &&
              content !== undefined
              ? [{ role: role as 'user' | 'assistant', content }]
              : [];
          })
        : [];
      return { id, status, sourceSpaceId, messages };
    } catch (error) {
      throw normalizeAimeError(error, 'session-read');
    }
  }

  async sendMessage(input: {
    sessionId: string;
    spaceId?: string;
    content: string;
    modelResource?: { name: string };
    locale?: string;
    executionMode?: 'fast' | 'max';
  }): Promise<{ messageId: string; createdAt: string }> {
    try {
      const result = record(
        await this.withManagedUser('message/send', () =>
          this.facade.api.aime.sendMessage(input.sessionId, input.content, {
            modeType: 'auto',
            ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
            ...(input.modelResource === undefined
              ? {}
              : {
                  modelResource: input.modelResource,
                  enableModelSelection: true,
                }),
            ...(input.locale === undefined ? {} : { locale: input.locale }),
            ...(input.executionMode === undefined
              ? {}
              : { executionMode: input.executionMode }),
          }),
        ),
      );
      const messageId = text(result?.message_id);
      const createdAt = text(result?.created_at);
      if (!messageId || !createdAt) throw protocolDrift();
      return { messageId, createdAt };
    } catch (error) {
      throw normalizeAimeError(error, 'send');
    }
  }

  async *streamEvents(input: {
    sessionId: string;
    eventOffset: number;
    signal: AbortSignal;
  }): AsyncIterable<NormalizedAimeEvent> {
    let stream: AsyncIterable<unknown>;
    try {
      stream = await this.withManagedUser('stream/connect', async () =>
        this.facade.api.aime.streamEvents(input.sessionId, {
          eventOffset: input.eventOffset,
          signal: input.signal,
          autoClose: false,
        }),
      );
    } catch (error) {
      throw normalizeAimeError(error, 'stream');
    }
    try {
      for await (const event of stream) yield normalizeAimeEvent(event);
    } catch (error) {
      throw normalizeAimeError(error, 'stream');
    }
  }
}

export async function createProductionAimeTransport(
  config: AimeTransportConfig,
  guard: ManagedUserAuthGuard,
  importer: ImportBytedcli = () => import('@bytedance-dev/bytedcli'),
): Promise<BytedcliAimeTransport> {
  return new BytedcliAimeTransport(asFacade(await importer()), guard, config);
}
