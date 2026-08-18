import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { AIME_ACP_PACKAGE_VERSION } from '../../src/package-info.js';

import {
  JsonRpcResponseError,
  spawnAcp,
  type SpawnedAcp,
} from '../helpers/spawn-acp.js';

function event(
  type: string,
  offset: number,
  data: Record<string, unknown>,
): unknown {
  return {
    type,
    data: {
      event_id: `event-${offset}`,
      event_offset: offset,
      timestamp: 2_000_000_000 + offset,
      event_key: type,
      ...data,
    },
  };
}

function turnEvents(startOffset = 0, answer = 'Hello world'): unknown[] {
  const userId = `user-${startOffset}`;
  const assistantId = `assistant-${startOffset}`;
  return [
    event('session.message.create', startOffset, {
      message: {
        message_id: userId,
        role: 'user',
        content: 'question',
      },
    }),
    event('session.message.create', startOffset + 1, {
      message: {
        message_id: assistantId,
        role: 'assistant',
        content: answer.slice(0, 6),
      },
      reply_message_id: userId,
    }),
    event('session.think.tips', startOffset + 2, {
      tips: ['Synthetic thought'],
    }),
    event('session.plan.update', startOffset + 3, {
      plan_id: 'plan-1',
      status: 'running',
    }),
    event('session.step.update', startOffset + 4, {
      agent_step_id: 'step-1',
      title: 'Check source',
      status: 'in_progress',
    }),
    event('session.action.use_tool', startOffset + 5, {
      agent_step_id: 'tool-1',
      tool_name: 'lookup',
      status: 'completed',
      summary: 'Checked a public guide',
    }),
    event('session.reference', startOffset + 6, {
      references: [
        {
          id: 1,
          title: 'Guide',
          uri: 'https://example.test/guide',
          snippet: 'safe snippet',
        },
      ],
    }),
    event('session.message.delta', startOffset + 7, {
      message_id: assistantId,
      content: answer.slice(6),
      is_finished: true,
    }),
    event('session.progress_notice', startOffset + 8, {
      status: 'waiting_for_next',
    }),
  ];
}

function baseScenario(overrides: Record<string, unknown> = {}): unknown {
  return {
    auth: {
      authenticated: true,
      identity: { field: 'employeeId', value: 'fake-user-1001' },
    },
    space: { id: 'remote-space' },
    newSessionId: 'remote-new-session',
    sessions: {},
    prompts: [],
    ...overrides,
  };
}

function updates(child: SpawnedAcp): Record<string, unknown>[] {
  return child.stdoutFrames().flatMap((frame) => {
    if (
      typeof frame === 'object' &&
      frame !== null &&
      (frame as { method?: unknown }).method === 'session/update'
    ) {
      return [(frame as { params: Record<string, unknown> }).params];
    }
    return [];
  });
}

async function waitForUpdate(
  child: SpawnedAcp,
  predicate: (update: Record<string, unknown>) => boolean,
): Promise<void> {
  const started = Date.now();
  while (!updates(child).some(predicate)) {
    if (Date.now() - started > 2_000)
      throw new Error('timed out waiting for ACP update');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('built ACP subprocess contract', () => {
  it('uses the shipped entrypoint for initialize, new, and an ordered rich prompt', async () => {
    const child = await spawnAcp({
      scenario: baseScenario({
        prompts: [
          {
            messageId: 'user-0',
            createdAt: '2033-05-18T03:33:20.000Z',
            streamErrorOnceAtOffset: 6,
            events: turnEvents(),
          },
        ],
      }),
    });
    try {
      await expect(
        child.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
      ).resolves.toEqual({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {},
        },
        agentInfo: { name: 'aime-acp', version: AIME_ACP_PACKAGE_VERSION },
      });
      await expect(
        child.request('session/new', {
          cwd: '/workspace/ignored',
          mcpServers: [],
        }),
      ).resolves.toEqual({ sessionId: 'remote-new-session' });
      await expect(
        child.request('session/prompt', {
          sessionId: 'remote-new-session',
          prompt: [{ type: 'text', text: 'question' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });

      expect(
        updates(child).map(
          (params) =>
            (params.update as { sessionUpdate: string }).sessionUpdate,
        ),
      ).toEqual([
        'agent_message_chunk',
        'agent_thought_chunk',
        'plan',
        'tool_call',
        'agent_message_chunk',
        'agent_message_chunk',
      ]);
      expect(JSON.stringify(updates(child).at(-1))).toContain(
        'https://example.test/guide',
      );
      expect(child.stdoutFrames()).toHaveLength(9);
      expect(
        child
          .stdoutFrames()
          .flatMap((frame) =>
            typeof frame === 'object' &&
            frame !== null &&
            typeof (frame as { id?: unknown }).id === 'number'
              ? [(frame as { id: number }).id]
              : [],
          ),
      ).toEqual([1, 2, 3]);
    } finally {
      await child.close();
    }
  });

  it('soft-cancels a gated built stream and returns cancelled', async () => {
    const child = await spawnAcp({
      scenario: baseScenario({
        prompts: [
          {
            messageId: 'cancel-user',
            createdAt: '2033-05-18T03:33:20.000Z',
            gateAfterOffset: 1,
            events: [
              event('session.message.create', 0, {
                message: {
                  message_id: 'cancel-user',
                  role: 'user',
                  content: 'cancel me',
                },
              }),
              event('session.message.create', 1, {
                message: {
                  message_id: 'cancel-assistant',
                  role: 'assistant',
                  content: 'started',
                },
                reply_message_id: 'cancel-user',
              }),
              event('session.progress_notice', 2, {
                status: 'waiting_for_next',
              }),
            ],
          },
        ],
      }),
    });
    try {
      await child.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await child.request('session/new', {
        cwd: '/workspace/ignored',
        mcpServers: [],
      });
      const prompt = child.request('session/prompt', {
        sessionId: 'remote-new-session',
        prompt: [{ type: 'text', text: 'cancel me' }],
      });
      await waitForUpdate(child, (params) =>
        JSON.stringify(params).includes('started'),
      );
      child.notify('session/cancel', { sessionId: 'remote-new-session' });
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
      expect(child.stdoutFrames()).toHaveLength(4);
    } finally {
      await child.close();
    }
  });

  it('loads in a fresh process, replays history, catches up, and accepts the next prompt', async () => {
    const child = await spawnAcp({
      scenario: baseScenario({
        sessions: {
          'remote-loaded-session': {
            status: 'completed',
            sourceSpaceId: 'remote-space',
            messages: [
              { role: 'user', content: 'historic question' },
              { role: 'assistant', content: 'historic answer' },
            ],
            events: [
              event('session.progress_notice', 0, {
                status: 'waiting_for_next',
              }),
            ],
          },
        },
        prompts: [
          {
            messageId: 'user-1',
            createdAt: '2033-05-18T03:33:20.000Z',
            events: turnEvents(1, 'Second answer'),
          },
        ],
      }),
    });
    try {
      await child.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        child.request('session/load', {
          sessionId: 'remote-loaded-session',
          cwd: '/workspace/ignored',
          mcpServers: [],
        }),
      ).resolves.toEqual({});
      expect(updates(child).slice(0, 2)).toMatchObject([
        {
          sessionId: 'remote-loaded-session',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'historic question' },
          },
        },
        {
          sessionId: 'remote-loaded-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'historic answer' },
          },
        },
      ]);
      await expect(
        child.request('session/prompt', {
          sessionId: 'remote-loaded-session',
          prompt: [{ type: 'text', text: 'next question' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      expect(
        updates(child)
          .flatMap((params) => {
            const update = params.update as {
              sessionUpdate?: string;
              content?: { type?: string; text?: string };
            };
            return update.sessionUpdate === 'agent_message_chunk' &&
              update.content?.type === 'text'
              ? [update.content.text ?? '']
              : [];
          })
          .join(''),
      ).toContain('Second answer');
      expect(child.stdoutFrames()).toHaveLength(11);
    } finally {
      await child.close();
    }
  });

  it('returns exact safe AUTH_REQUIRED guidance without naming global bytedcli', async () => {
    const child = await spawnAcp({
      scenario: baseScenario({
        auth: { authenticated: false },
      }),
    });
    try {
      await child.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const failure = await child
        .request('session/new', {
          cwd: '/workspace/ignored',
          mcpServers: [],
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(JsonRpcResponseError);
      expect(failure).toMatchObject({
        code: -32001,
        message:
          'Managed user authentication is required. Run `aime-acp auth login --site cn`.',
        data: { code: 'AUTH_REQUIRED', retryable: false },
      });
      expect(JSON.stringify(failure)).not.toMatch(/(^|[^-])\bbytedcli\b/);
      expect(child.stdoutFrames()).toHaveLength(2);
    } finally {
      await child.close();
    }
  });

  it('derives i18n AUTH_REQUIRED guidance only from the parsed supported site', async () => {
    const child = await spawnAcp({
      argv: ['--site', 'i18n-tt'],
      scenario: baseScenario({ auth: { authenticated: false } }),
    });
    try {
      await child.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        child.request('session/new', {
          cwd: '/workspace/ignored',
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: -32001,
        message:
          'Managed user authentication is required. Run `aime-acp auth login --site i18n-tt`.',
        data: { code: 'AUTH_REQUIRED', retryable: false },
      });
      expect(child.stdoutFrames()).toHaveLength(2);
    } finally {
      await child.close();
    }
  });
});
