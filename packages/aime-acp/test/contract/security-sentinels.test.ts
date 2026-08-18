import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import {
  JsonRpcResponseError,
  permissionModelSupport,
  spawnAcp,
  type SpawnedAcp,
} from '../helpers/spawn-acp.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function sentinel(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function rawEvent(
  type: string,
  offset: number,
  data: Record<string, unknown>,
): unknown {
  return {
    type,
    data: {
      event_id: `security-${offset}`,
      event_offset: offset,
      timestamp: 2_000_000_000 + offset,
      event_key: type,
      ...data,
    },
  };
}

function transcript(child: SpawnedAcp, error?: unknown): string {
  return `${JSON.stringify(child.stdoutFrames())}\n${child.stderrText()}\n${
    error === undefined ? '' : JSON.stringify(error)
  }`;
}

function notificationTexts(child: SpawnedAcp): string[] {
  return child.stdoutFrames().flatMap((frame) => {
    if (
      typeof frame !== 'object' ||
      frame === null ||
      (frame as { method?: unknown }).method !== 'session/update'
    ) {
      return [];
    }
    const params = (frame as { params?: unknown }).params;
    return [JSON.stringify(params)];
  });
}

async function initialize(child: SpawnedAcp): Promise<void> {
  await child.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
}

describe('built ACP security sentinels', () => {
  it.each([
    {
      version: '22.12.9',
      flags: ['--permission'],
      expected: { supported: false },
    },
    {
      version: '22.13.0',
      flags: ['--permission', '--experimental-permission'],
      expected: { supported: true, flag: '--permission' },
    },
    {
      version: '22.13.0',
      flags: ['--permission'],
      expected: { supported: true, flag: '--permission' },
    },
    {
      version: '25.1.0',
      flags: ['--experimental-permission'],
      expected: { supported: true, flag: '--experimental-permission' },
    },
    {
      version: '25.1.0',
      flags: [],
      expected: { supported: false },
    },
  ])(
    'selects permission syntax by runtime capability for Node $version with $flags',
    ({ version, flags, expected }) => {
      expect(
        permissionModelSupport({
          version,
          allowedFlags: new Set(flags),
        }),
      ).toMatchObject(expected);
    },
  );

  it('selects a permission flag accepted by the current supported runtime', () => {
    const support = permissionModelSupport();
    expect(support).toMatchObject({ supported: true });
    if (support.supported) {
      expect(process.allowedNodeEnvironmentFlags.has(support.flag)).toBe(true);
    }
  });

  it('awaits operational child stream closure before reporting its trailing failure', async () => {
    const tail = sentinel('TRAILING_STDERR_SENTINEL');
    const child = await spawnAcp({
      argv: ['auth', 'login', '--begin', '--json'],
      returnAfterExitForTest: true,
      deferStderrUntilCloseForTest: true,
      scenario: {
        exitCode: 7,
        exitStderr: `${'x'.repeat(8 * 1024)}${tail}\n`,
        auth: { authenticated: false },
        space: { id: 'remote-space' },
        sessions: {},
        prompts: [],
      },
    });

    await expect(child.close()).rejects.toThrow(tail);
    expect(child.stderrText()).toContain(tail);
  });

  it('emits a resume token only in login begin JSON stdout', async () => {
    const resumeToken = sentinel('RESUME_SENTINEL');
    const child = await spawnAcp({
      argv: ['auth', 'login', '--begin', '--json'],
      scenario: {
        resumeToken,
        auth: {
          authenticated: false,
          identity: { field: 'employeeId', value: 'safe-identity' },
        },
        space: { id: 'remote-space' },
        sessions: {},
        prompts: [],
      },
    });
    try {
      await child.close();
      expect(child.stdoutFrames()).toEqual([
        {
          schemaVersion: 1,
          ok: true,
          command: 'auth.login.begin',
          site: 'cn',
          status: 'pending',
          url: 'https://login.example.test/verify',
          displayCode: 'SAFE-CODE',
          expiresAt: '2035-01-02T03:04:05.000Z',
          resumeToken,
        },
      ]);
      expect(child.stderrText()).not.toContain(resumeToken);
    } finally {
      await child.close();
    }
  });

  it('redacts nested auth/tool data, identity, cwd contents, and prompt outside permitted ACP fields', async () => {
    const jwt = sentinel('JWT_SENTINEL');
    const cookie = sentinel('COOKIE_SENTINEL');
    const cwdContent = sentinel('CWD_SENTINEL');
    const prompt = sentinel('PROMPT_SENTINEL');
    const tool = sentinel('TOOL_SENTINEL');
    const identity = sentinel('IDENTITY_SENTINEL');
    const identityFingerprint = sentinel('IDENTITY_FINGERPRINT_SENTINEL');
    const cwd = await mkdtemp(join(tmpdir(), 'aime-acp-denied-cwd-'));
    temporaryPaths.push(cwd);
    await writeFile(join(cwd, 'private.txt'), cwdContent);

    const permission = permissionModelSupport();
    if (!permission.supported) {
      expect(permission.reason).toMatch(/below the required 22\.13 target/);
      return;
    }

    const child = await spawnAcp({
      cwd,
      permissionModel: true,
      scenario: {
        auth: {
          authenticated: true,
          identity: { field: 'employeeId', value: identity },
        },
        space: { id: 'remote-space' },
        newSessionId: 'security-session',
        sessions: {
          'security-session': {
            status: 'completed',
            sourceSpaceId: 'remote-space',
            messages: [{ role: 'user', content: prompt }],
            events: [
              rawEvent('session.progress_notice', 0, {
                status: 'waiting_for_next',
              }),
            ],
          },
        },
        prompts: [
          {
            messageId: 'security-user',
            createdAt: '2033-05-18T03:33:20.000Z',
            events: [
              rawEvent('session.message.create', 1, {
                message: {
                  message_id: 'security-user',
                  role: 'user',
                  content: prompt,
                },
              }),
              rawEvent('session.message.create', 2, {
                message: {
                  message_id: 'security-assistant',
                  role: 'assistant',
                  content: 'safe answer',
                },
                reply_message_id: 'security-user',
              }),
              rawEvent('session.action.use_tool', 3, {
                agent_step_id: 'safe-tool',
                tool_name: 'lookup',
                status: 'completed',
                summary: 'safe bounded summary',
                raw_tool_payload: {
                  authorization: jwt,
                  cookie,
                  value: tool,
                  identityFingerprint,
                },
              }),
              rawEvent('session.progress_notice', 4, {
                status: 'waiting_for_next',
              }),
            ],
          },
        ],
      },
    });
    try {
      await initialize(child);
      await child.request('session/new', { cwd, mcpServers: [] });
      await child.request('session/prompt', {
        sessionId: 'security-session',
        prompt: [{ type: 'text', text: prompt }],
      });
      await child.request('session/load', {
        sessionId: 'security-session',
        cwd,
        mcpServers: [],
      });

      const output = transcript(child);
      for (const forbidden of [
        jwt,
        cookie,
        cwdContent,
        tool,
        identity,
        identityFingerprint,
      ]) {
        expect(output).not.toContain(forbidden);
      }
      expect(child.stderrText()).not.toContain(prompt);
      expect(
        notificationTexts(child).filter((text) => text.includes(prompt)),
      ).toHaveLength(1);
    } finally {
      await child.close();
    }
  });

  it('redacts raw nested authentication failures from stdout, stderr, and JSON-RPC error data', async () => {
    const jwt = sentinel('JWT_SENTINEL');
    const cookie = sentinel('COOKIE_SENTINEL');
    const child = await spawnAcp({
      scenario: {
        auth: {
          authenticated: true,
          identity: { field: 'employeeId', value: 'safe-identity' },
          statusError: {
            status: 401,
            response: {
              headers: { cookie },
              credentials: { jwt },
            },
          },
        },
        space: { id: 'remote-space' },
        newSessionId: 'never-created',
        sessions: {},
        prompts: [],
      },
    });
    let failure: unknown;
    try {
      await initialize(child);
      failure = await child
        .request('session/new', {
          cwd: '/workspace/ignored',
          mcpServers: [],
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(JsonRpcResponseError);
      expect(failure).toMatchObject({ data: { code: 'AUTH_REQUIRED' } });
      expect(transcript(child, failure)).not.toContain(jwt);
      expect(transcript(child, failure)).not.toContain(cookie);
    } finally {
      await child.close();
    }
  });

  it('never connects to supplied MCP endpoints or logs their values', async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (typeof address === 'string' || address === null)
      throw new Error('loopback sentinel did not bind TCP');
    const url = `http://127.0.0.1:${address.port}/${sentinel('MCP_URL')}`;
    const header = sentinel('MCP_HEADER');
    const child = await spawnAcp({
      scenario: {
        auth: {
          authenticated: true,
          identity: { field: 'employeeId', value: 'safe-identity' },
        },
        space: { id: 'remote-space' },
        newSessionId: 'mcp-session',
        sessions: {
          'mcp-session': {
            status: 'completed',
            sourceSpaceId: 'remote-space',
            messages: [],
            events: [],
          },
        },
        prompts: [],
      },
    });
    try {
      await initialize(child);
      const mcpServers = [
        {
          type: 'http',
          name: sentinel('MCP_NAME'),
          url,
          headers: [{ name: 'Authorization', value: header }],
        },
      ];
      await child.request('session/new', {
        cwd: '/workspace/ignored',
        mcpServers,
      });
      await child.request('session/load', {
        sessionId: 'mcp-session',
        cwd: '/workspace/ignored',
        mcpServers,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(connections).toBe(0);
      expect(child.stderrText()).not.toContain(url);
      expect(child.stderrText()).not.toContain(header);
      expect(child.stderrText()).toContain('"count":1');
    } finally {
      await child.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
