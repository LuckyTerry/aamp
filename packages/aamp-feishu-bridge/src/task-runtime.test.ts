import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildTaskProfileTaskFeishuConfig,
  buildTaskProfileFeishuConfig,
  dedupeTaskProfiles,
  normalizeTaskProfile,
  resolveTaskProfileName,
} from './task-runtime-profile.js'

test('resolveTaskProfileName uses the app id as the profile suffix', () => {
  assert.equal(resolveTaskProfileName(' cli_a123456 '), 'aamp-feishu-task-cli_a123456')
})

test('normalizeTaskProfile derives lark-cli profile config without app secret', () => {
  const profile = normalizeTaskProfile({
    app_id: ' cli_a123456 ',
    display_name: ' 飞书 CLI ',
  })

  assert.deepEqual(profile, {
    app_id: 'cli_a123456',
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

test('buildTaskProfileTaskFeishuConfig keeps runtime app secret out of profile metadata', () => {
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
  assert.deepEqual(dedupeTaskProfiles([
    {
      app_id: 'cli_a123456',
      profile: 'aamp-feishu-task-cli_a123456',
      display_name: '真实 Bot 名称',
      updated_at: '2026-07-03T00:00:00.000Z',
    },
    {
      app_id: 'cli_a123456',
      profile: 'aamp-feishu-task-cli_a123456',
      updated_at: '2026-07-03T00:01:00.000Z',
    },
  ])[0]?.display_name, '真实 Bot 名称')
})
