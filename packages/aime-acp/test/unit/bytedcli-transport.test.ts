import { describe, expect, it, vi } from 'vitest';

import { ManagedUserAuthGuard } from '../../src/auth/identity-guard.js';
import type { AimeTransportConfig } from '../../src/aime/bytedcli-transport.js';
import {
  BytedcliAimeTransport,
  createProductionAimeTransport,
  type BytedcliAimeFacade,
} from '../../src/aime/bytedcli-transport.js';
import { ScriptedAimeTransport } from '../helpers/fake-aime.js';
import { fakeAuth } from '../helpers/fake-auth.js';

function facade(): BytedcliAimeFacade & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    auth: {
      getExternalBytecloudAuthStatus: vi.fn(),
      byteCloudAuthEnsureAuth: vi.fn(),
      byteCloudAuthUserInfo: vi.fn(),
      byteCloudAuthLogin: vi.fn(),
      byteCloudAuthBeginLogin: vi.fn(),
      byteCloudAuthCompleteLogin: vi.fn(),
    },
    utils: {
      setCloudSite: vi.fn(),
      setAuthAs: vi.fn(),
      setHttpConfig: vi.fn(),
    },
    api: {
      aime: {
        listSpaces: vi.fn(async ({ nextId }: { nextId?: string }) => {
          order.push(`listSpaces:${nextId ?? 'first'}`);
          return nextId
            ? {
                spaces: [
                  { id: 'team-2', type: 'team', status: 'active' },
                  { id: 'personal-2', type: 'personal', status: 'active' },
                ],
              }
            : {
                spaces: [
                  { id: 'team-1', type: 'team', status: 'active' },
                  { id: 'personal-1', type: 'personal', status: 'inactive' },
                ],
                next_id: 'second',
              };
        }),
        listModels: vi.fn(async () => ({
          text_models: [{ model_resource: { name: 'fallback' } }],
          text_models_by_execution_mode: {
            fast: [{ model_resource: { name: 'model-1' } }],
          },
        })),
        createSession: vi.fn(async () => ({
          id: 'session-1',
          source_space_id: 'space-1',
        })),
        getSession: vi.fn(async () => ({
          id: 'session-1',
          status: 'waiting_for_next',
          source_space_id: 'space-1',
          messages: [{ role: 'assistant', content: 'hello' }],
        })),
        sendMessage: vi.fn(async () => ({
          message_id: 'message-1',
          created_at: '2030-01-01T00:00:00Z',
        })),
        streamEvents: vi.fn(async function* () {
          yield {
            type: 'session.message.delta',
            data: {
              event_offset: 18,
              event_id: 'event-1',
              timestamp: 1,
              event_key: 'message',
              message_id: 'message-1',
              content: 'hello',
              is_finished: false,
            },
          };
        }),
      },
    },
  };
}

function config(
  overrides: Partial<AimeTransportConfig> = {},
): AimeTransportConfig {
  return { executionMode: 'fast', ...overrides };
}

function buildTransport(
  value = facade(),
  options: Partial<AimeTransportConfig> = {},
) {
  const guard = new ManagedUserAuthGuard(fakeAuth(), Buffer.alloc(32, 1));
  return {
    value,
    guard,
    transport: new BytedcliAimeTransport(value, guard, config(options)),
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('BytedcliAimeTransport', () => {
  it('maps createSession and sends it exactly once', async () => {
    const { value, transport } = buildTransport();
    await expect(
      transport.createSession({ spaceId: 'space-1', useInternalTools: true }),
    ).resolves.toEqual({ id: 'session-1', sourceSpaceId: 'space-1' });
    expect(value.api.aime.createSession).toHaveBeenCalledTimes(1);
    expect(value.api.aime.createSession).toHaveBeenCalledWith('space-1', {
      useInternalTool: true,
    });
  });

  it('verifies the pinned version and every required AIME export', async () => {
    const { value, transport } = buildTransport();
    await expect(transport.checkCompatibility()).resolves.toBeUndefined();
    (value.api.aime as unknown as { getSession?: unknown }).getSession =
      undefined;
    await expect(transport.checkCompatibility()).rejects.toMatchObject({
      code: 'AIME_SDK_INCOMPATIBLE',
    });
  });

  it('accepts the pinned SDK lazy AIME getter export', async () => {
    const value = facade();
    const aime = value.api.aime;
    let getterThis: unknown;
    const getter = vi.fn(function (this: unknown) {
      getterThis = this;
      return aime;
    });
    Object.defineProperty(value.api, 'aime', {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    const guard = new ManagedUserAuthGuard(fakeAuth(), Buffer.alloc(32, 1));

    const transport = await createProductionAimeTransport(
      config(),
      guard,
      async () => value,
    );
    await expect(transport.checkCompatibility()).resolves.toBeUndefined();
    expect(getter).toHaveBeenCalledTimes(2);
    expect(getterThis).toBe(value.api);
  });

  it('maps sendMessage options literally and does not retry failure', async () => {
    const { value, transport } = buildTransport();
    (
      value.api.aime.sendMessage as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce({ code: 'ECONNRESET' });
    await expect(
      transport.sendMessage({
        sessionId: 'session-1',
        spaceId: 'space-1',
        content: 'hello',
        modelResource: { name: 'model-1' },
        executionMode: 'fast',
      }),
    ).rejects.toMatchObject({ code: 'AIME_NETWORK_UNREACHABLE' });
    expect(value.api.aime.sendMessage).toHaveBeenCalledTimes(1);
    expect(value.api.aime.sendMessage).toHaveBeenCalledWith(
      'session-1',
      'hello',
      {
        modeType: 'auto',
        spaceId: 'space-1',
        modelResource: { name: 'model-1' },
        enableModelSelection: true,
        executionMode: 'fast',
      },
    );
  });

  it('guards immediately before every paged AIME request and chooses active personal space', async () => {
    const { value, guard, transport } = buildTransport();
    const assertStable = vi
      .spyOn(guard, 'assertStable')
      .mockImplementation(async (operation) => {
        value.order.push(`guard:${operation}`);
      });
    await expect(transport.resolveSpace()).resolves.toEqual({
      id: 'personal-2',
    });
    expect(value.order).toEqual([
      'guard:space/list',
      'listSpaces:first',
      'guard:space/list',
      'listSpaces:second',
    ]);
    expect(assertStable).toHaveBeenCalledTimes(2);
  });

  it('honors an explicit space without listing spaces', async () => {
    const { value, transport } = buildTransport(undefined, {
      spaceId: 'explicit',
    });
    await expect(transport.resolveSpace()).resolves.toEqual({ id: 'explicit' });
    expect(value.api.aime.listSpaces).not.toHaveBeenCalled();
  });

  it('uses the first personal space only if no active personal space exists', async () => {
    const { value, transport } = buildTransport();
    (
      value.api.aime.listSpaces as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      spaces: [
        { id: 'team', type: 'team', status: 'active' },
        { id: 'personal-first', type: 'personal', status: 'inactive' },
      ],
    });
    await expect(transport.resolveSpace()).resolves.toEqual({
      id: 'personal-first',
    });
  });

  it.each([
    ['a non-array spaces response', { spaces: 'not-an-array' }],
    ['a non-string next_id', { spaces: [], next_id: 7 }],
  ])('rejects %s without selecting a fallback space', async (_label, page) => {
    const { value, transport } = buildTransport();
    (
      value.api.aime.listSpaces as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(page);
    await expect(transport.resolveSpace()).rejects.toMatchObject({
      code: 'AIME_PROTOCOL_DRIFT',
    });
  });

  it('rejects a repeated page cursor without selecting a prior personal space', async () => {
    const { value, transport } = buildTransport();
    (value.api.aime.listSpaces as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        spaces: [
          { id: 'personal-first', type: 'personal', status: 'inactive' },
        ],
        next_id: 'repeat',
      })
      .mockResolvedValueOnce({ spaces: [], next_id: 'repeat' });
    await expect(transport.resolveSpace()).rejects.toMatchObject({
      code: 'AIME_PROTOCOL_DRIFT',
    });
  });

  it('maps auto models and validates named models against the selected execution mode', async () => {
    const { value, transport } = buildTransport();
    await expect(
      transport.resolveModel({ spaceId: 'space-1', name: 'auto-sota' }),
    ).resolves.toEqual({ name: '' });
    await expect(
      transport.resolveModel({ spaceId: 'space-1', name: 'model-1' }),
    ).resolves.toEqual({ name: 'model-1' });
    await expect(
      transport.resolveModel({ spaceId: 'space-1', name: 'fallback' }),
    ).rejects.toMatchObject({ code: 'AIME_MODEL_NOT_FOUND' });
    expect(value.api.aime.listModels).toHaveBeenCalledTimes(2);
  });

  it('uses text_models only when the selected mode list is absent', async () => {
    const { value, transport } = buildTransport();
    (
      value.api.aime.listModels as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      text_models: [{ model_resource: { name: 'fallback' } }],
    });
    await expect(
      transport.resolveModel({ spaceId: 'space-1', name: 'fallback' }),
    ).resolves.toEqual({ name: 'fallback' });
  });

  it('creates the SDK stream only after the guard and maps its options literally', async () => {
    const { value, guard, transport } = buildTransport();
    const signal = new AbortController().signal;
    vi.spyOn(guard, 'assertStable').mockImplementation(async () => {
      expect(value.api.aime.streamEvents).not.toHaveBeenCalled();
    });
    await expect(
      collect(
        transport.streamEvents({
          sessionId: 'session-1',
          eventOffset: 17,
          signal,
        }),
      ),
    ).resolves.toMatchObject([
      { kind: 'message.delta', offset: 18, content: 'hello' },
    ]);
    expect(value.api.aime.streamEvents).toHaveBeenCalledWith('session-1', {
      eventOffset: 17,
      signal,
      autoClose: false,
    });
  });

  it('uses the C06 normalizer for every pinned production stream variant', async () => {
    const { value, transport } = buildTransport();
    (
      value.api.aime.streamEvents as unknown as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(async function* () {
      yield {
        type: 'session.message.create',
        data: {
          event_id: 'create-1',
          event_offset: 1,
          timestamp: 1,
          event_key: 'message',
          message: {
            message_id: 'message-1',
            role: 'assistant',
            content: 'Synthetic',
            session_id: 's',
            attachments: [],
            creator: 'd',
            created_at: '',
            updated_at: '',
            mode_type: 'auto',
          },
        },
      };
      yield {
        type: 'session.progress_notice',
        data: {
          event_id: 'progress-1',
          event_offset: 2,
          timestamp: 2,
          event_key: 'progress',
          status: 'thinking',
          session_id: 's',
        },
      };
      yield {
        type: 'session.think.tips',
        data: {
          event_id: 'think-1',
          event_offset: 3,
          timestamp: 3,
          event_key: 'think',
          tips: ['Synthetic thought'],
          session_id: 's',
        },
      };
      yield {
        type: 'session.reference',
        data: {
          event_id: 'reference-1',
          event_offset: 4,
          timestamp: 4,
          event_key: 'reference',
          references: [],
          session_id: 's',
          task_id: 't',
        },
      };
      yield {
        type: 'session.plan.update',
        data: {
          event_id: 'plan-1',
          event_offset: 5,
          timestamp: 5,
          event_key: 'plan',
          status: 'running',
        },
      };
      yield {
        type: 'session.step.update',
        data: {
          event_id: 'step-event',
          event_offset: 6,
          timestamp: 6,
          event_key: 'step',
          agent_step_id: 'step-agent',
          step_id: 'step-fallback',
          title: 'Synthetic step',
        },
      };
      yield {
        type: 'session.action.use_tool',
        data: {
          event_id: 'tool-event',
          event_offset: 7,
          timestamp: 7,
          event_key: 'tool',
          agent_step_id: 'tool-agent',
          tool_name: 'lookup',
        },
      };
      yield {
        type: 'unknown',
        data: {
          eventType: 'session.action.tool_call_required',
          raw: {
            event_id: 'help-1',
            event_offset: 8,
            timestamp: 8,
            event_key: 'help',
            question: 'Choose synthetic input.',
            options: ['One'],
          },
        },
      };
    });
    await expect(
      collect(
        transport.streamEvents({
          sessionId: 'session-1',
          eventOffset: 0,
          signal: new AbortController().signal,
        }),
      ),
    ).resolves.toMatchObject([
      { kind: 'message.create' },
      { kind: 'progress' },
      { kind: 'think.tips' },
      { kind: 'reference' },
      { kind: 'plan.update' },
      { kind: 'step.update', step: { id: 'step-agent' } },
      { kind: 'action.use_tool' },
      { kind: 'action.tool_call_required' },
    ]);
  });

  it('keeps scripted events deterministic without clock sleeps', async () => {
    const scripted = new ScriptedAimeTransport([
      { kind: 'ping' },
      new Error('stop'),
    ]);
    const iterator = scripted
      .streamEvents({
        sessionId: 'scripted-session',
        eventOffset: 0,
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: 'ping' },
    });
    await expect(iterator.next()).rejects.toThrow('stop');
    expect(scripted.calls).toEqual([{ method: 'streamEvents' }]);
  });
});
