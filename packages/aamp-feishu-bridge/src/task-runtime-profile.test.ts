import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildTaskProfileFeishuConfig,
  buildTaskProfileTaskFeishuConfig,
  dedupeTaskProfiles,
  normalizeTaskProfile,
} from './task-runtime-profile.js'

test('normalizeTaskProfile keeps app-secret profiles independent of lark-cli', () => {
  const remote = normalizeTaskProfile({
    app_id: 'cli_remote',
    app_secret: 'remote-secret',
    auth_mode: 'app-secret',
  })

  assert.equal(remote.auth_mode, 'app-secret')
  assert.equal(remote.profile, undefined)
  assert.deepEqual(buildTaskProfileFeishuConfig(remote), {
    appId: 'cli_remote',
    appSecret: 'remote-secret',
    authMode: 'app-secret',
  })
  assert.deepEqual(buildTaskProfileTaskFeishuConfig(remote), {
    appId: 'cli_remote',
    appSecret: 'remote-secret',
    authMode: 'app-secret',
  })
})

test('normalizeTaskProfile defaults legacy profiles to lark-cli', () => {
  const local = normalizeTaskProfile({ app_id: 'cli_local' })

  assert.equal(local.profile, 'aamp-feishu-task-cli_local')
  assert.equal(local.auth_mode, 'lark-cli')
  assert.deepEqual(local.domains, ['task'])
  assert.deepEqual(buildTaskProfileTaskFeishuConfig(local), {
    appId: 'cli_local',
    authMode: 'lark-cli',
    cliProfile: 'aamp-feishu-task-cli_local',
  })
})

test('normalizeTaskProfile removes legacy non-Task domains during migration', () => {
  const local = normalizeTaskProfile({
    app_id: 'cli_legacy',
    domains: ['base', 'calendar', 'mail', 'task', 'vc'],
  })

  assert.deepEqual(local.domains, ['task'])
})

test('normalizeTaskProfile rejects app-secret profiles without an App Secret', () => {
  assert.throws(
    () => normalizeTaskProfile({ app_id: 'cli_remote', auth_mode: 'app-secret' }),
    /Feishu App Secret is required for app-secret profile cli_remote/,
  )
})

test('dedupeTaskProfiles removes a stale lark-cli profile when upgrading to app-secret', () => {
  const profiles = dedupeTaskProfiles([
    {
      app_id: 'cli_remote',
      app_secret: 'saved-secret',
      profile: 'saved-lark-cli-profile',
      auth_mode: 'lark-cli',
    },
    {
      app_id: 'cli_remote',
      app_secret: 'saved-secret',
      auth_mode: 'app-secret',
    },
  ])

  assert.equal(profiles[0]?.auth_mode, 'app-secret')
  assert.equal(profiles[0]?.profile, undefined)
})
