import { PassThrough, Writable } from 'node:stream';

import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  type AgentContext,
  type LoadSessionRequest,
  type NewSessionRequest,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  RequestScopedNotifications,
  createAcpApp,
  createAcpHandlers,
  type HandlerDependencies,
} from '../../src/acp/handlers.js';
import type { AimeTransport } from '../../src/aime/transport.js';
import { AimeAcpError } from '../../src/errors.js';
import { AIME_ACP_PACKAGE_VERSION } from '../../src/package-info.js';
import { runServer } from '../../src/server.js';
import { SessionManager } from '../../src/session/session-manager.js';

function captureStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = '';
  let stderrText = '';
  stdout.on('data', (chunk: Buffer) => {
    stdoutText += chunk.toString('utf8');
  });
  stderr.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8');
  });
  return {
    streams: { stdin, stdout, stderr },
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
  };
}

const consoleMethodNames = ['log', 'info', 'warn', 'error'] as const;
type ConsoleSnapshot = Record<
  (typeof consoleMethodNames)[number],
  typeof console.log
>;

function snapshotConsole(): ConsoleSnapshot {
  return Object.fromEntries(
    consoleMethodNames.map((method) => [method, console[method]]),
  ) as ConsoleSnapshot;
}

function restoreConsole(snapshot: ConsoleSnapshot): void {
  for (const method of consoleMethodNames) console[method] = snapshot[method];
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('bounded operation timed out')),
      2_000,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function dependencies(
  overrides: Partial<HandlerDependencies> = {},
): HandlerDependencies {
  return {
    transport: {
      checkCompatibility: vi.fn(async () => undefined),
    },
    manager: {
      create: vi.fn(async () => ({
        sessionId: 'remote-session',
        sourceSpaceId: 'remote-space',
      })),
    },
    runtime: {
      load: vi.fn(async () => ({ session: {}, history: [] })),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' as const })),
      cancel: vi.fn(() => true),
    },
    notifications: new RequestScopedNotifications(),
    warnIgnoredMcp: vi.fn(),
    ...overrides,
  };
}

function inertTransport() {
  const calls: string[] = [];
  const transport: AimeTransport = {
    async checkCompatibility() {
      calls.push('checkCompatibility');
    },
    async resolveSpace() {
      calls.push('resolveSpace');
      return { id: 'remote-space' };
    },
    async resolveModel() {
      throw new Error('unexpected resolveModel');
    },
    async createSession(input) {
      calls.push(`createSession:${JSON.stringify(input)}`);
      return { id: 'remote-session', sourceSpaceId: 'remote-space' };
    },
    async getSession() {
      throw new Error('unexpected getSession');
    },
    async sendMessage() {
      throw new Error('unexpected sendMessage');
    },
    async *streamEvents() {
      yield* [];
      throw new Error('unexpected streamEvents');
    },
  };
  return { calls, transport };
}

describe('typed ACP app', () => {
  it('initializes with the exact minimal capability surface and only checks compatibility', async () => {
    const checkCompatibility = vi.fn(async () => undefined);
    const auth = vi.fn();
    const network = vi.fn();
    const deps = dependencies({ transport: { checkCompatibility } });

    await expect(
      client({ name: 'contract-client' }).connectWith(
        createAcpApp(Object.assign(deps, { auth, network })),
        (agent) =>
          agent.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          }),
      ),
    ).resolves.toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
      },
      agentInfo: { name: 'aime-acp', version: AIME_ACP_PACKAGE_VERSION },
    });

    expect(checkCompatibility).toHaveBeenCalledOnce();
    expect(deps.manager.create).not.toHaveBeenCalled();
    expect(deps.runtime.load).not.toHaveBeenCalled();
    expect(deps.runtime.prompt).not.toHaveBeenCalled();
    expect(deps.runtime.cancel).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('creates one remote session through the manager and returns the remote ID', async () => {
    const { calls, transport } = inertTransport();
    const manager = new SessionManager(transport);
    const deps = dependencies({ transport, manager });

    await expect(
      client({ name: 'contract-client' }).connectWith(
        createAcpApp(deps),
        (agent) =>
          agent.request('session/new', {
            cwd: '/ignored/workspace',
            additionalDirectories: ['/ignored/additional'],
            mcpServers: [],
          }),
      ),
    ).resolves.toEqual({ sessionId: 'remote-session' });

    expect(calls).toEqual([
      'resolveSpace',
      'createSession:{"spaceId":"remote-space","useInternalTools":true}',
    ]);
  });

  it('replays loaded history in order with remote message IDs', async () => {
    const updates: SessionNotification[] = [];
    const load = vi.fn(async () => ({
      session: {},
      history: [
        {
          role: 'user' as const,
          messageId: 'remote-user',
          text: 'question',
        },
        {
          role: 'assistant' as const,
          messageId: 'remote-agent',
          text: 'answer',
        },
      ],
    }));
    const deps = dependencies({
      runtime: {
        load,
        prompt: vi.fn(),
        cancel: vi.fn(),
      },
    });
    const appClient = client({ name: 'contract-client' }).onNotification(
      'session/update',
      ({ params }) => {
        updates.push(params);
      },
    );

    await expect(
      appClient.connectWith(createAcpApp(deps), (agent) =>
        agent.request('session/load', {
          sessionId: 'remote-session',
          cwd: '/ignored/workspace',
          additionalDirectories: ['/ignored/additional'],
          mcpServers: [],
        }),
      ),
    ).resolves.toEqual({});

    expect(load).toHaveBeenCalledWith('remote-session');
    expect(updates).toEqual([
      {
        sessionId: 'remote-session',
        update: {
          sessionUpdate: 'user_message_chunk',
          messageId: 'remote-user',
          content: { type: 'text', text: 'question' },
        },
      },
      {
        sessionId: 'remote-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'remote-agent',
          content: { type: 'text', text: 'answer' },
        },
      },
    ]);
  });

  it('serializes gated load replay with another session prompt update', async () => {
    const notifications = new RequestScopedNotifications();
    const order: string[] = [];
    let releaseFirstLoad!: () => void;
    const firstLoadGate = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    let firstLoadEntered!: () => void;
    const firstLoadStarted = new Promise<void>((resolve) => {
      firstLoadEntered = resolve;
    });
    const loadClient = {
      notify: vi.fn(async (_method: string, params: SessionNotification) => {
        const text =
          params.update.sessionUpdate === 'user_message_chunk' &&
          params.update.content.type === 'text'
            ? params.update.content.text
            : 'unexpected';
        order.push(`load:${text}`);
        if (text === 'load-one') {
          firstLoadEntered();
          await firstLoadGate;
        }
      }),
    } as unknown as AgentContext;
    const promptClient = {
      notify: vi.fn(async (_method: string, params: SessionNotification) => {
        const text =
          params.update.sessionUpdate === 'agent_message_chunk' &&
          params.update.content.type === 'text'
            ? params.update.content.text
            : 'unexpected';
        order.push(`prompt:${text}`);
      }),
    } as unknown as AgentContext;
    const runtimePrompt = vi.fn(async (sessionId: string) => {
      await notifications.notifications.send(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'prompt-update' },
      });
      return { stopReason: 'end_turn' as const };
    });
    const handlers = createAcpHandlers(
      dependencies({
        notifications,
        runtime: {
          load: vi.fn(async () => ({
            history: [
              {
                role: 'user' as const,
                messageId: 'load-1',
                text: 'load-one',
              },
              {
                role: 'user' as const,
                messageId: 'load-2',
                text: 'load-two',
              },
            ],
          })),
          prompt: runtimePrompt,
          cancel: vi.fn(),
        },
      }),
    );

    const load = handlers.loadSession(
      {
        sessionId: 'session-a',
        cwd: '/ignored',
        mcpServers: [],
      },
      loadClient,
    );
    await firstLoadStarted;
    const prompt = handlers.prompt(
      {
        sessionId: 'session-b',
        prompt: [{ type: 'text', text: 'prompt' }],
      },
      promptClient,
    );
    await Promise.resolve();
    expect(order).toEqual(['load:load-one']);
    releaseFirstLoad();

    await expect(Promise.all([load, prompt])).resolves.toEqual([
      {},
      { stopReason: 'end_turn' },
    ]);
    expect(order).toEqual([
      'load:load-one',
      'prompt:prompt-update',
      'load:load-two',
    ]);
  });

  it('releases load notifier ownership and recovers after replay rejection', async () => {
    const notifications = new RequestScopedNotifications();
    const load = vi.fn(async () => ({
      history: [
        {
          role: 'assistant' as const,
          messageId: 'remote-agent',
          text: 'answer',
        },
      ],
    }));
    const handlers = createAcpHandlers(
      dependencies({
        notifications,
        runtime: { load, prompt: vi.fn(), cancel: vi.fn() },
      }),
    );
    const failingClient = {
      notify: vi.fn(async () => {
        throw new Error('load replay failed');
      }),
    } as unknown as AgentContext;
    const recovered = vi.fn(async () => undefined);
    const recoveredClient = { notify: recovered } as unknown as AgentContext;
    const params = {
      sessionId: 'remote-session',
      cwd: '/ignored',
      mcpServers: [],
    };

    await expect(handlers.loadSession(params, failingClient)).rejects.toThrow(
      'load replay failed',
    );
    await expect(
      handlers.loadSession(params, recoveredClient),
    ).resolves.toEqual({});
    expect(recovered).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('converts a prompt before the turn and routes updates to that request client', async () => {
    const updates: SessionNotification[] = [];
    const notifications = new RequestScopedNotifications();
    const prompt = vi.fn(async (sessionId: string, content: string) => {
      await notifications.notifications.send(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'remote-agent',
        content: { type: 'text', text: `reply:${content}` },
      });
      return { stopReason: 'end_turn' as const };
    });
    const deps = dependencies({
      notifications,
      runtime: { load: vi.fn(), prompt, cancel: vi.fn() },
    });
    const appClient = client({ name: 'contract-client' }).onNotification(
      'session/update',
      ({ params }) => {
        updates.push(params);
      },
    );

    await expect(
      appClient.connectWith(createAcpApp(deps), (agent) =>
        agent.request('session/prompt', {
          sessionId: 'remote-session',
          prompt: [
            { type: 'text', text: 'hello' },
            {
              type: 'resource_link',
              name: 'docs',
              uri: 'https://example.com/a_(b)',
            },
          ],
        }),
      ),
    ).resolves.toEqual({ stopReason: 'end_turn' });

    expect(prompt).toHaveBeenCalledWith(
      'remote-session',
      'hello\n[docs](https://example.com/a_\\(b\\))',
    );
    expect(updates).toEqual([
      {
        sessionId: 'remote-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'remote-agent',
          content: {
            type: 'text',
            text: 'reply:hello\n[docs](https://example.com/a_\\(b\\))',
          },
        },
      },
    ]);
  });

  it('delivers cancellation as a notification with no response payload', async () => {
    const cancel = vi.fn(() => true);
    const deps = dependencies({
      runtime: { load: vi.fn(), prompt: vi.fn(), cancel },
    });

    await client({ name: 'contract-client' }).connectWith(
      createAcpApp(deps),
      async (agent) => {
        await expect(
          agent.notify('session/cancel', { sessionId: 'remote-session' }),
        ).resolves.toBeUndefined();
        expect(cancel).toHaveBeenCalledWith('remote-session');
      },
    );
  });

  it.each([
    ['authenticate', {}],
    ['session/set_mode', { sessionId: 'remote-session', modeId: 'mode' }],
    ['session/list', {}],
    ['session/delete', { sessionId: 'remote-session' }],
    ['session/close', { sessionId: 'remote-session' }],
  ] as const)(
    'leaves unsupported method %s unregistered',
    async (method, params) => {
      const deps = dependencies();

      await client({ name: 'contract-client' }).connectWith(
        createAcpApp(deps),
        async (agent) => {
          await expect(agent.request(method, params)).rejects.toMatchObject({
            code: -32601,
          });
        },
      );
    },
  );

  it('maps only AimeAcpError to the stable application RequestError', async () => {
    const deps = dependencies({
      manager: {
        create: vi.fn(async () => {
          throw new AimeAcpError(
            'AIME_ACCESS_DENIED',
            'Access to AIME was denied.',
            false,
            { status: 403, requestId: 'safe-request' },
          );
        }),
      },
    });

    await client({ name: 'contract-client' }).connectWith(
      createAcpApp(deps),
      async (agent) => {
        const error = await agent
          .request('session/new', {
            cwd: '/ignored/workspace',
            mcpServers: [],
          })
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(RequestError);
        expect(error).toMatchObject({
          code: -32001,
          message: 'Access to AIME was denied.',
          data: {
            code: 'AIME_ACCESS_DENIED',
            retryable: false,
            status: 403,
            requestId: 'safe-request',
          },
        });
      },
    );
  });
});

describe('direct typed handlers', () => {
  it('does not replace an active same-session prompt notifier', async () => {
    const notifications = new RequestScopedNotifications();
    const firstNotify = vi.fn(async () => undefined);
    const secondNotify = vi.fn(async () => undefined);
    const firstClient = { notify: firstNotify } as unknown as AgentContext;
    const secondClient = { notify: secondNotify } as unknown as AgentContext;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runtimePrompt = vi.fn(async () => {
      await firstGate;
      return { stopReason: 'end_turn' as const };
    });
    const handlers = createAcpHandlers(
      dependencies({
        notifications,
        runtime: {
          load: vi.fn(),
          prompt: runtimePrompt,
          cancel: vi.fn(),
        },
      }),
    );
    const first = handlers.prompt(
      {
        sessionId: 'remote-session',
        prompt: [{ type: 'text', text: 'first prompt' }],
      },
      firstClient,
    );
    await expect(
      handlers.prompt(
        {
          sessionId: 'remote-session',
          prompt: [{ type: 'text', text: 'second prompt' }],
        },
        secondClient,
      ),
    ).rejects.toMatchObject({
      code: -32001,
      data: { code: 'SESSION_BUSY', retryable: false },
    });
    await notifications.notifications.send('remote-session', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'first request' },
    });
    releaseFirst();
    await first;

    expect(firstNotify).toHaveBeenCalledOnce();
    expect(secondNotify).not.toHaveBeenCalled();
    expect(runtimePrompt).toHaveBeenCalledOnce();
    await expect(
      notifications.notifications.send('remote-session', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'after both requests' },
      }),
    ).rejects.toMatchObject({ code: 'AIME_PROTOCOL_DRIFT' });
  });

  it('continues notification serialization after one client write fails', async () => {
    const notify = vi
      .fn<AgentContext['notify']>()
      .mockRejectedValueOnce(new Error('client write failed'))
      .mockResolvedValue(undefined);
    const notifications = new RequestScopedNotifications();
    const clientContext = { notify } as unknown as AgentContext;

    await notifications.withClient(
      'remote-session',
      clientContext,
      async () => {
        await expect(
          notifications.notifications.send('remote-session', {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'first' },
          }),
        ).rejects.toThrow('client write failed');
        await expect(
          notifications.notifications.send('remote-session', {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'second' },
          }),
        ).resolves.toBeUndefined();
      },
    );

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('does not inspect workspace or MCP entries and only warns with the count', async () => {
    const sentinel = 'WORKSPACE_MCP_SENTINEL';
    const managerCreate = vi.fn(async () => ({
      sessionId: 'remote-session',
      sourceSpaceId: 'remote-space',
    }));
    const warnIgnoredMcp = vi.fn();
    const deps = dependencies({
      manager: { create: managerCreate },
      warnIgnoredMcp,
    });
    const params = {
      get cwd(): never {
        throw new Error(sentinel);
      },
      get additionalDirectories(): never {
        throw new Error(sentinel);
      },
      mcpServers: new Proxy([{}], {
        get(target, property, receiver) {
          if (property === 'length')
            return Reflect.get(target, property, receiver);
          throw new Error(sentinel);
        },
      }),
    } as unknown as NewSessionRequest;

    await expect(createAcpHandlers(deps).newSession(params)).resolves.toEqual({
      sessionId: 'remote-session',
    });

    expect(managerCreate).toHaveBeenCalledOnce();
    expect(managerCreate).toHaveBeenCalledWith();
    expect(warnIgnoredMcp).toHaveBeenCalledWith(1);
    expect(JSON.stringify(warnIgnoredMcp.mock.calls)).not.toContain(sentinel);
  });

  it('converts every block before beginning a prompt turn', async () => {
    const prompt = vi.fn();
    const deps = dependencies({
      runtime: { load: vi.fn(), prompt, cancel: vi.fn() },
    });
    const clientContext = {
      notify: vi.fn(),
    } as unknown as AgentContext;

    await expect(
      createAcpHandlers(deps).prompt(
        {
          sessionId: 'remote-session',
          prompt: [
            { type: 'text', text: 'valid prefix' },
            { type: 'image', mimeType: 'image/png', data: 'sentinel' },
          ],
        },
        clientContext,
      ),
    ).rejects.toMatchObject({
      code: -32001,
      data: { code: 'AIME_UNSUPPORTED_CONTENT', retryable: false },
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('ignores load workspace values without evaluating them', async () => {
    const runtimeLoad = vi.fn(async () => ({ session: {}, history: [] }));
    const deps = dependencies({
      runtime: { load: runtimeLoad, prompt: vi.fn(), cancel: vi.fn() },
    });
    const params = {
      sessionId: 'remote-session',
      mcpServers: [],
      get cwd(): never {
        throw new Error('LOAD_WORKSPACE_SENTINEL');
      },
      get additionalDirectories(): never {
        throw new Error('LOAD_WORKSPACE_SENTINEL');
      },
    } as unknown as LoadSessionRequest;
    const clientContext = {
      notify: vi.fn(),
    } as unknown as AgentContext;

    await expect(
      createAcpHandlers(deps).loadSession(params, clientContext),
    ).resolves.toEqual({});
    expect(runtimeLoad).toHaveBeenCalledWith('remote-session');
  });
});

describe('ACP stdio server', () => {
  it('flushes an initialized response when stdin ends immediately after the request', async () => {
    const io = captureStreams();
    const running = runServer(
      { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
      io.streams,
      vi.fn(async () => dependencies()),
    );
    io.streams.stdin.end(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        },
      })}\n`,
    );

    await expect(running).resolves.toBe(0);
    expect(JSON.parse(io.stdoutText())).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: PROTOCOL_VERSION },
    });
  });

  it.each([
    [
      'notification',
      {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: 'missing-session' },
      },
    ],
    ['null', null],
    ['number', 17],
    ['string', 'malformed'],
    ['array batch', [{ jsonrpc: '2.0', id: 1, method: 'initialize' }]],
    ['malformed object', { jsonrpc: '2.0', id: 1, method: 42 }],
  ] as const)(
    'does not track or hang on immediate-EOF %s input',
    async (_label, payload) => {
      const io = captureStreams();
      const running = runServer(
        { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
        io.streams,
        vi.fn(async () => dependencies()),
      );
      io.streams.stdin.end(`${JSON.stringify(payload)}\n`);

      await expect(bounded(running)).resolves.toBe(0);
      expect(io.stdoutText()).toBe('');
    },
  );

  it('rejects without hanging when the raw stdout response writer fails after EOF', async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('raw stdout failed'));
      },
    });
    const running = runServer(
      { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
      { stdin, stdout, stderr },
      vi.fn(async () => dependencies()),
    );
    stdin.end(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        },
      })}\n`,
    );

    await expect(bounded(running)).rejects.toThrow('raw stdout failed');
  });

  it('gives raw stdout exclusively to NDJSON and builds dependencies once', async () => {
    const io = captureStreams();
    const deps = dependencies();
    const factory = vi.fn(async () => {
      console.log('APPLICATION_STDOUT_SENTINEL');
      return deps;
    });
    const running = runServer(
      { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
      io.streams,
      factory,
    );
    const responseWritten = new Promise<void>((resolve) => {
      io.streams.stdout.once('data', () => resolve());
    });
    io.streams.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        },
      })}\n`,
    );
    await responseWritten;
    io.streams.stdin.end();

    await expect(running).resolves.toBe(0);
    expect(factory).toHaveBeenCalledOnce();
    expect(io.stdoutText()).not.toContain('APPLICATION_STDOUT_SENTINEL');
    expect(io.stderrText()).toContain('application console output suppressed');
    expect(io.stdoutText().trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(io.stdoutText())).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {},
        },
        agentInfo: { name: 'aime-acp', version: AIME_ACP_PACKAGE_VERSION },
      },
    });
  });

  it('preserves console suppression when overlapping servers close out of order', async () => {
    const originals = snapshotConsole();
    const first = captureStreams();
    const second = captureStreams();
    try {
      const firstRun = runServer(
        { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
        first.streams,
        vi.fn(async () => dependencies()),
      );
      const secondRun = runServer(
        { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
        second.streams,
        vi.fn(async () => dependencies()),
      );

      first.streams.stdin.end();
      await firstRun;
      console.log('OVERLAPPING_CONSOLE_SENTINEL');
      expect(second.stderrText()).toContain(
        'application console output suppressed',
      );
      expect(console.log).not.toBe(originals.log);

      second.streams.stdin.end();
      await secondRun;
      expect(console.log).toBe(originals.log);
    } finally {
      restoreConsole(originals);
      first.streams.stdin.end();
      second.streams.stdin.end();
    }
  });

  it.each(['first-owner-first', 'second-owner-first'] as const)(
    'reowns externally replaced console methods and restores them with %s close order',
    async (closeOrder) => {
      const methods = consoleMethodNames;
      const originals = snapshotConsole();
      const external = {
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const first = captureStreams();
      const second = captureStreams();

      try {
        const firstRun = runServer(
          { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
          first.streams,
          vi.fn(async () => dependencies()),
        );
        for (const method of methods) console[method] = external[method];
        const secondRun = runServer(
          { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
          second.streams,
          vi.fn(async () => dependencies()),
        );
        for (const method of methods) console[method](`sentinel:${method}`);
        expect(second.stderrText().match(/suppressed/g)).toHaveLength(4);
        expect(
          Object.values(external).every((fn) => fn.mock.calls.length === 0),
        ).toBe(true);
        expect(first.stdoutText()).toBe('');
        expect(second.stdoutText()).toBe('');

        if (closeOrder === 'first-owner-first') {
          first.streams.stdin.end();
          await firstRun;
          second.streams.stdin.end();
          await secondRun;
        } else {
          second.streams.stdin.end();
          await secondRun;
          first.streams.stdin.end();
          await firstRun;
        }

        for (const method of methods)
          expect(console[method]).toBe(external[method]);
      } finally {
        restoreConsole(originals);
        first.streams.stdin.end();
        second.streams.stdin.end();
      }
    },
  );

  it.each(['first-owner-first', 'second-owner-first'] as const)(
    'reowns post-acquisition console replacements when %s closes',
    async (closeOrder) => {
      const methods = consoleMethodNames;
      const originals = snapshotConsole();
      const external = {
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const first = captureStreams();
      const second = captureStreams();
      let firstRun: Promise<number> | undefined;
      let secondRun: Promise<number> | undefined;

      try {
        firstRun = runServer(
          { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
          first.streams,
          vi.fn(async () => dependencies()),
        );
        secondRun = runServer(
          { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
          second.streams,
          vi.fn(async () => dependencies()),
        );
        for (const method of methods) console[method] = external[method];

        const survivor = closeOrder === 'first-owner-first' ? second : first;
        const closed = closeOrder === 'first-owner-first' ? first : second;
        if (closeOrder === 'first-owner-first') {
          first.streams.stdin.end();
          await firstRun;
        } else {
          second.streams.stdin.end();
          await secondRun;
        }

        for (const method of methods) console[method](`sentinel:${method}`);
        expect(survivor.stderrText().match(/suppressed/g)).toHaveLength(4);
        expect(closed.stderrText()).not.toContain('suppressed');
        expect(
          Object.values(external).every((fn) => fn.mock.calls.length === 0),
        ).toBe(true);
        expect(first.stdoutText()).toBe('');
        expect(second.stdoutText()).toBe('');

        survivor.streams.stdin.end();
        await (closeOrder === 'first-owner-first' ? secondRun : firstRun);
        for (const method of methods)
          expect(console[method]).toBe(external[method]);
      } finally {
        first.streams.stdin.end();
        second.streams.stdin.end();
        await Promise.allSettled(
          [firstRun, secondRun].filter(
            (run): run is Promise<number> => run !== undefined,
          ),
        );
        restoreConsole(originals);
      }
    },
  );

  it('restores console ownership when stream connection setup throws', async () => {
    const methods = consoleMethodNames;
    const originals = snapshotConsole();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    try {
      await expect(
        runServer(
          { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
          {
            stdin: {} as NodeJS.ReadableStream,
            stdout,
            stderr,
          },
          vi.fn(async () => dependencies()),
        ),
      ).rejects.toThrow();

      for (const method of methods)
        expect(console[method]).toBe(originals[method]);
      expect(stdout.readableLength).toBe(0);
    } finally {
      restoreConsole(originals);
    }
  });

  it('restores owned console methods when server construction fails', async () => {
    const originals = snapshotConsole();
    const io = captureStreams();
    try {
      await expect(
        runServer(
          { argv: [], mode: 'server', site: 'cn', logLevel: 'info' },
          io.streams,
          vi.fn(async () => {
            console.log('CONSTRUCTION_FAILURE_SENTINEL');
            throw new Error('construction failed');
          }),
        ),
      ).rejects.toThrow('construction failed');

      expect(io.stdoutText()).toBe('');
      expect(io.stderrText()).toContain(
        'application console output suppressed',
      );
      expect(console.log).toBe(originals.log);
    } finally {
      restoreConsole(originals);
      io.streams.stdin.end();
    }
  });
});
