import { describe, expect, it } from 'vitest';

import {
  parseBootstrapConfig,
  redactProxyForLog,
  sanitizePackageEnvironment,
  validatePreImportEnvironment,
} from '../../src/config.js';

describe('bootstrap config', () => {
  it.each(['cn', 'i18n-tt'] as const)('accepts site %s', (site) => {
    expect(parseBootstrapConfig(['--site', site], {}).site).toBe(site);
  });

  it.each([
    [[]],
    [['doctor']],
    [['--help']],
    [['--version']],
    [['auth', 'status']],
  ])('rejects raw resume token in every bootstrap mode: %j', (prefix) => {
    expect(() =>
      parseBootstrapConfig([...prefix, '--resume-token', 'secret'], {}),
    ).toThrow(/resume token|invalid command/i);
  });

  it('rejects a raw resume token hidden after the argument separator', () => {
    expect(() =>
      parseBootstrapConfig(
        ['auth', 'login', '--', '--resume-token', 'secret'],
        {},
      ),
    ).toThrow(/resume token/i);
  });

  it.each([[['auth', 'login', '--complete', '--resume-token-stdin']]])(
    'accepts stdin resume token only for login complete: %j',
    (argv) => {
      expect(parseBootstrapConfig(argv, {}).mode).toBe('auth');
    },
  );

  it.each([
    [['--resume-token-stdin']],
    [['doctor', '--resume-token-stdin']],
    [['--help', '--resume-token-stdin']],
    [['--version', '--resume-token-stdin']],
    [['auth', 'status', '--resume-token-stdin']],
    [['--help', 'auth', 'login', 'complete', '--resume-token-stdin']],
    [['--version', 'auth', 'login', 'complete', '--resume-token-stdin']],
    [['doctor', '--', '--resume-token-stdin']],
    [['auth', 'login', 'begin', '--complete', '--resume-token-stdin']],
    [['auth', 'login', '--begin', '--complete', '--resume-token-stdin']],
    [['auth', 'login', '--begin', '--resume-token-stdin']],
    [['auth', 'login', '--complete']],
    [['auth', 'login', 'complete', '--resume-token-stdin']],
    [['auth', 'login', 'begin', '--complete']],
    [['auth', 'login', 'begin', '--begin']],
    [['auth', 'login', 'extra']],
    [['auth', 'status', 'extra']],
    [['auth', 'logout', 'extra']],
    [['auth', 'login', '--complete', '--complete', '--resume-token-stdin']],
    [['auth', 'login', '--begin', '--begin']],
  ])('rejects stdin resume token outside auth login complete: %j', (argv) => {
    expect(() => parseBootstrapConfig(argv, {})).toThrow(/resume token/i);
  });

  it('allows safe global options around the exact stdin completion form', () => {
    expect(
      parseBootstrapConfig(
        [
          '--site',
          'i18n-tt',
          'auth',
          '--json',
          'login',
          '--complete',
          '--resume-token-stdin',
        ],
        {},
      ),
    ).toMatchObject({ mode: 'auth', site: 'i18n-tt' });
  });

  it.each(['boe', 'i18n-bd', 'us-ttp'])(
    'rejects unsupported site %s',
    (site) => {
      expect(() => parseBootstrapConfig(['--site', site], {})).toThrow(
        /cn.*i18n-tt/,
      );
    },
  );

  it.each([
    'https://user:secret@proxy.example',
    'https://proxy.example/path?token=x',
    'socks5://proxy.example',
  ])('rejects unsafe proxy %s', (proxy) => {
    expect(() => parseBootstrapConfig(['--proxy', proxy], {})).toThrow(
      /proxy/i,
    );
  });

  it.each([
    'BYTEDCLI_AIME_API_BASE_URL',
    'BYTEDCLI_BYTECLOUD_AUTH_FALLBACK',
    'BYTECLOUD_AUTH_AS',
    'AIME_WORKSPACE_PATH',
    'AIME_CURRENT_USER',
    'AIME_USER_CLOUD_JWT',
    'BYTEDCLI_USER_CLOUD_JWT',
    'BYTEDCLI_SERVICE_ACCOUNT_JWT',
    'BYTEDCLI_SERVICE_ACCOUNT_CN_SECRET_ACCESS_KEY',
    'BYTECLOUD_AUTH_ACCESS_KEY_ID',
    'BYTECLOUD_AUTH_SECRET_ACCESS_KEY',
    'BYTECLOUD_AUTH_RPC_BINARY',
    'BYTECLOUD_CORE_RPC_BINARY',
    'AIME_ACP_RESUME_TOKEN',
  ])('fails closed on %s', (name) => {
    expect(() => validatePreImportEnvironment({ [name]: 'SENTINEL' })).toThrow(
      name,
    );
  });

  it('uses CLI values over non-empty environment values and treats empty values as unset', () => {
    const config = parseBootstrapConfig(
      ['--site', 'i18n-tt', '--model', 'cli-model', '--log-level', 'debug'],
      {
        AIME_ACP_SITE: 'cn',
        AIME_ACP_MODEL: 'env-model',
        AIME_ACP_SPACE_ID: '',
        AIME_ACP_EXECUTION_MODE: 'fast',
        AIME_ACP_LOCALE: '',
        AIME_ACP_LOG_LEVEL: 'error',
      },
    );

    expect(config).toMatchObject({
      mode: 'server',
      site: 'i18n-tt',
      model: 'cli-model',
      executionMode: 'fast',
      logLevel: 'debug',
    });
    expect(config.spaceId).toBeUndefined();
    expect(config.locale).toBeUndefined();
  });

  it('redacts proxy credentials, paths, queries, and fragments for logs', () => {
    expect(redactProxyForLog('https://proxy.example:8443/')).toBe(
      'https://proxy.example:8443',
    );
  });

  it('removes inherited package controls after parsing', () => {
    const env: NodeJS.ProcessEnv = {
      BYTEDCLI_CLOUD_SITE: 'unsafe',
      BYTEDCLI_AUTH_SITE: 'unsafe',
      BYTEDCLI_SOCKS5_PROXY: 'unsafe',
      BYTEDCLI_HTTP_PROXY: 'unsafe',
      HTTP_PROXY: 'unsafe',
      HTTPS_PROXY: 'unsafe',
      ALL_PROXY: 'unsafe',
      http_proxy: 'unsafe',
      https_proxy: 'unsafe',
      all_proxy: 'unsafe',
      AIME_ACP_SITE: 'cn',
    };

    sanitizePackageEnvironment(env);

    expect(env).toEqual({ AIME_ACP_SITE: 'cn' });
  });
});
