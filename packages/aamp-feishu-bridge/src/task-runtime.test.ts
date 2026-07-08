import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildTaskProfileTaskFeishuConfig,
  buildTaskProfileFeishuConfig,
  dedupeTaskProfiles,
  normalizeTaskProfile,
  resolveTaskProfileSelection,
  resolveTaskProfileName,
} from './task-runtime-profile.js'
import { isRetryableAampNetworkError, isSmtpAuthError } from './task-runtime-errors.js'
import { resolveTaskRuntimeBehavior } from './task-runtime.js'

test('resolveTaskProfileName uses the app id as the profile suffix', () => {
  assert.equal(resolveTaskProfileName(' cli_a123456 '), 'aamp-feishu-task-cli_a123456')
})

test('normalizeTaskProfile derives lark-cli profile config', () => {
  const profile = normalizeTaskProfile({
    app_id: ' cli_a123456 ',
    app_secret: ' runtime-secret ',
    display_name: ' 飞书 CLI ',
  })

  assert.deepEqual(profile, {
    app_id: 'cli_a123456',
    app_secret: 'runtime-secret',
    profile: 'aamp-feishu-task-cli_a123456',
    display_name: '飞书 CLI',
    auth_mode: 'lark-cli',
    capabilities: ['im', 'task'],
    domains: [
      'base',
      'calendar',
      'contact',
      'docs',
      'im',
      'mail',
      'mindnotes',
      'minutes',
      'note',
      'sheets',
      'slides',
      'task',
      'vc',
      'wiki',
    ],
    updated_at: profile.updated_at,
  })
  assert.match(profile.updated_at, /^\d{4}-\d{2}-\d{2}T/)
})

test('buildTaskProfileFeishuConfig stores cli profile when runtime app secret is unavailable', () => {
  assert.deepEqual(buildTaskProfileFeishuConfig({
    app_id: 'cli_a123456',
    profile: 'aamp-feishu-task-cli_a123456',
    auth_mode: 'lark-cli',
    capabilities: ['im', 'task'],
    domains: ['task'],
    updated_at: '2026-07-03T00:00:00.000Z',
  }), {
    appId: 'cli_a123456',
    authMode: 'lark-cli',
    cliProfile: 'aamp-feishu-task-cli_a123456',
  })
})

test('buildTaskProfileFeishuConfig uses app-secret websocket when runtime app secret is available', () => {
  assert.deepEqual(buildTaskProfileFeishuConfig({
    app_id: 'cli_a123456',
    profile: 'aamp-feishu-task-cli_a123456',
    auth_mode: 'lark-cli',
    capabilities: ['im', 'task'],
    domains: ['task'],
    updated_at: '2026-07-03T00:00:00.000Z',
  }, {
    appSecret: 'runtime-secret',
  }), {
    appId: 'cli_a123456',
    authMode: 'app-secret',
    appSecret: 'runtime-secret',
    cliProfile: 'aamp-feishu-task-cli_a123456',
  })
})

test('buildTaskProfileTaskFeishuConfig passes runtime app secret to Feishu bridge config', () => {
  assert.deepEqual(buildTaskProfileTaskFeishuConfig({
    app_id: 'cli_a123456',
    profile: 'aamp-feishu-task-cli_a123456',
    auth_mode: 'lark-cli',
    capabilities: ['im', 'task'],
    domains: ['task'],
    updated_at: '2026-07-03T00:00:00.000Z',
  }, {
    appSecret: 'runtime-secret',
  }), {
    appId: 'cli_a123456',
    authMode: 'lark-cli',
    cliProfile: 'aamp-feishu-task-cli_a123456',
    appSecret: 'runtime-secret',
  })
})

test('dedupeTaskProfiles preserves existing display name when updating by app id', () => {
  const profiles = dedupeTaskProfiles([
    {
      app_id: 'cli_a123456',
      app_secret: 'cached-secret',
      profile: 'aamp-feishu-task-cli_a123456',
      display_name: '真实 Bot 名称',
      updated_at: '2026-07-03T00:00:00.000Z',
    },
    {
      app_id: 'cli_a123456',
      profile: 'aamp-feishu-task-cli_a123456',
      updated_at: '2026-07-03T00:01:00.000Z',
    },
  ])
  assert.deepEqual(profiles[0]?.display_name, '真实 Bot 名称')
  assert.deepEqual(profiles[0]?.app_secret, 'cached-secret')
})

test('resolveTaskProfileSelection preserves saved app secret in non-interactive app id path', () => {
  const selected = resolveTaskProfileSelection([
    {
      app_id: 'cli_a123456',
      app_secret: 'cached-secret',
      profile: 'aamp-feishu-task-cli_a123456',
      display_name: '缓存 Bot',
      updated_at: '2026-07-03T00:00:00.000Z',
    },
  ], {
    app_id: 'cli_a123456',
    profile: 'aamp-feishu-task-cli_a123456',
    updated_at: '2026-07-03T00:01:00.000Z',
  })

  assert.equal(selected.app_secret, 'cached-secret')
  assert.equal(selected.display_name, '缓存 Bot')
})

test('resolveTaskRuntimeBehavior does not inherit debug from previous runs', () => {
  assert.deepEqual(resolveTaskRuntimeBehavior({}, {
    ackComment: false,
    debug: true,
  }), {
    ackComment: false,
    debug: false,
  })
})

test('resolveTaskRuntimeBehavior enables debug only for the current --debug run', () => {
  assert.deepEqual(resolveTaskRuntimeBehavior({ debug: true }, {
    ackComment: false,
    debug: false,
  }), {
    ackComment: false,
    debug: true,
  })
})

test('isRetryableAampNetworkError detects transient AAMP connect timeout errors', () => {
  const error = new Error('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    }),
  })

  assert.equal(isRetryableAampNetworkError(error), true)
  assert.equal(isRetryableAampNetworkError(new Error('400 bad request')), false)
})

test('isSmtpAuthError detects stale mailbox SMTP credentials', () => {
  assert.equal(isSmtpAuthError(new Error('Invalid login: 535 5.7.8 Authentication credentials invalid.')), true)
  assert.equal(isSmtpAuthError(new Error('fetch failed')), false)
})
