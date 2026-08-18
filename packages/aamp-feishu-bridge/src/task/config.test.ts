import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeBridgeConfig } from './config.js'

const mailbox = {
  email: 'bridge@meshmail.test',
  mailboxToken: 'mailbox-token',
  smtpPassword: 'smtp-password',
  baseUrl: 'https://meshmail.test',
}

test('normalizeBridgeConfig migrates a legacy Task config to a local fallback agent', () => {
  const legacy = normalizeBridgeConfig({
    version: 1,
    aampHost: 'https://meshmail.test',
    targetAgentEmail: 'agent@meshmail.test',
    slug: 'feishu-runtime',
    feishu: {
      appId: 'cli_test',
      appSecret: 'secret',
      eventNames: ['task.task.update_user_access_v2'],
    },
    mailbox,
    behavior: { ackComment: true },
  }, 'aime')

  assert.deepEqual(legacy.agent, { type: 'aime', executionLocation: 'local' })
  assert.equal(legacy.feishu.authMode, 'lark-cli')
})

test('normalizeBridgeConfig makes remote execution use app-secret credentials only', () => {
  const config = normalizeBridgeConfig({
    version: 1,
    aampHost: 'https://meshmail.test',
    targetAgentEmail: 'agent@meshmail.test',
    slug: 'feishu-runtime',
    agent: { type: 'aime', executionLocation: 'remote' },
    feishu: {
      appId: 'cli_test',
      appSecret: 'secret',
      authMode: 'lark-cli',
      cliProfile: 'local-profile',
      cliBin: '/local/lark-cli',
      domain: 'https://open.feishu-pre.cn',
      headers: { 'x-tt-env': 'boe' },
      eventNames: ['task.task.update_user_access_v2'],
    },
    mailbox,
    behavior: { ackComment: true },
  })

  assert.deepEqual(config.agent, { type: 'aime', executionLocation: 'remote' })
  assert.deepEqual(config.feishu, {
    appId: 'cli_test',
    appSecret: 'secret',
    authMode: 'app-secret',
    domain: 'https://open.feishu-pre.cn',
    headers: { 'x-tt-env': 'boe' },
    userIdType: 'open_id',
    eventNames: ['task.task.update_user_access_v2'],
  })
})

test('normalizeBridgeConfig rejects invalid execution locations and remote configs without an app secret', () => {
  const base = {
    version: 1 as const,
    aampHost: 'https://meshmail.test',
    targetAgentEmail: 'agent@meshmail.test',
    slug: 'feishu-runtime',
    feishu: { appId: 'cli_test', eventNames: ['task.task.update_user_access_v2'] },
    mailbox,
    behavior: { ackComment: true },
  }

  assert.throws(
    () => normalizeBridgeConfig({ ...base, agent: { type: 'aime', executionLocation: 'elsewhere' as never } }),
    /Agent execution location must be local or remote/,
  )
  assert.throws(
    () => normalizeBridgeConfig({ ...base, agent: { type: 'aime', executionLocation: 'remote' } }),
    /Feishu App Secret is required for remote Task execution/,
  )
})

test('normalizeBridgeConfig directs stale configs to the merged package command', () => {
  assert.throws(() => normalizeBridgeConfig({}), /aamp-feishu-bridge start --enable-task/)
})
