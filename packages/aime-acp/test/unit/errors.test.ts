import { describe, expect, it } from 'vitest';

import { normalizeAimeError, toSafeError } from '../../src/errors.js';

describe('safe errors', () => {
  it('redacts nested credentials, prompts, paths, and tool payloads', () => {
    const error = Object.assign(new Error('untrusted'), {
      status: 502,
      requestId: 'request-123',
      code: 'ECONNRESET',
      errno: 'ECONNRESET',
      syscall: 'connect',
      url: 'https://api.example.test/private?token=JWT_SENTINEL',
      cause: {
        cookie: 'COOKIE_SENTINEL',
        prompt: 'PROMPT_SENTINEL',
        cwd: 'CWD_SENTINEL',
        tool: 'TOOL_SENTINEL',
      },
    });

    const serialized = JSON.stringify(toSafeError(error));

    for (const sentinel of [
      'JWT_SENTINEL',
      'COOKIE_SENTINEL',
      'PROMPT_SENTINEL',
      'CWD_SENTINEL',
      'TOOL_SENTINEL',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(JSON.parse(serialized)).toMatchObject({
      safeMetadata: {
        status: 502,
        requestId: 'request-123',
        errno: 'ECONNRESET',
        syscall: 'connect',
        host: 'api.example.test',
      },
    });
  });

  it.each([
    ['guard', {}, 'AUTH_REQUIRED'],
    ['external-auth', {}, 'AUTH_SOURCE_UNSUPPORTED'],
    ['external-auth', { status: 401 }, 'AUTH_SOURCE_UNSUPPORTED'],
    ['send', { status: 401 }, 'AUTH_REQUIRED'],
    ['send', { status: 403 }, 'AIME_ACCESS_DENIED'],
    ['session-read', { status: 404 }, 'AIME_SESSION_NOT_FOUND'],
    ['model', { code: 'MODEL_NOT_FOUND' }, 'AIME_MODEL_NOT_FOUND'],
    ['model', { code: 'ENOTFOUND' }, 'AIME_NETWORK_UNREACHABLE'],
    ['send', { code: 'ENOTFOUND' }, 'AIME_NETWORK_UNREACHABLE'],
    ['send', { code: 'ECONNREFUSED' }, 'AIME_NETWORK_UNREACHABLE'],
    [
      'send',
      { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
      'AIME_NETWORK_UNREACHABLE',
    ],
    [
      'send',
      { code: 'ERR_PROXY_CONNECTION_FAILED' },
      'AIME_NETWORK_UNREACHABLE',
    ],
    ['create', {}, 'AIME_SEND_FAILED'],
    ['stream', {}, 'AIME_STREAM_INTERRUPTED'],
    ['recovery', {}, 'AIME_STREAM_INTERRUPTED'],
    ['schema', {}, 'AIME_PROTOCOL_DRIFT'],
    ['offset', {}, 'AIME_PROTOCOL_DRIFT'],
    ['text', {}, 'AIME_PROTOCOL_DRIFT'],
    ['compatibility', {}, 'AIME_SDK_INCOMPATIBLE'],
  ] as const)('normalizes %s failures to %s', (operation, error, code) => {
    expect(normalizeAimeError(error, operation).code).toBe(code);
  });

  it('keeps only allowed metadata during normalization', () => {
    const normalized = normalizeAimeError(
      {
        status: 503,
        requestId: 'request-456',
        errno: 'ETIMEDOUT',
        syscall: 'connect',
        url: 'https://aime.example.test/private?JWT_SENTINEL',
        body: 'PROMPT_SENTINEL',
      },
      'send',
    );

    expect(normalized.safeMetadata).toEqual({
      status: 503,
      requestId: 'request-456',
      errno: 'ETIMEDOUT',
      syscall: 'connect',
      host: 'aime.example.test',
    });
  });
});
