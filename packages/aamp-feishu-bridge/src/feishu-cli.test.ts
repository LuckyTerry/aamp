import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLarkCliAppOwnerResponse, resolveLarkCliProfileCredentials } from './feishu-cli.js'

test('resolveLarkCliProfileCredentials reads app secret by profile name', () => {
  const credentials = resolveLarkCliProfileCredentials({
    apps: [{
      appId: 'cli_a123456',
      appSecret: 'secret-from-profile',
      name: 'aamp-feishu-task-cli_a123456',
    }],
  }, {
    appId: 'cli_a123456',
    profile: 'aamp-feishu-task-cli_a123456',
  })

  assert.deepEqual(credentials, {
    appId: 'cli_a123456',
    appSecret: 'secret-from-profile',
    profile: 'aamp-feishu-task-cli_a123456',
  })
})

test('resolveLarkCliProfileCredentials resolves env backed app secret', () => {
  process.env.TEST_LARK_CLI_APP_SECRET = 'secret-from-env'
  try {
    const credentials = resolveLarkCliProfileCredentials({
      apps: [{
        appId: 'cli_a123456',
        appSecret: { source: 'env', name: 'TEST_LARK_CLI_APP_SECRET' },
        profile: 'aamp-feishu-task-cli_a123456',
      }],
    }, {
      appId: 'cli_a123456',
      profile: 'aamp-feishu-task-cli_a123456',
    })

    assert.equal(credentials.appSecret, 'secret-from-env')
  } finally {
    delete process.env.TEST_LARK_CLI_APP_SECRET
  }
})

test('parseLarkCliAppOwnerResponse extracts the application owner open id', () => {
  assert.deepEqual(parseLarkCliAppOwnerResponse({
    code: 0,
    data: {
      app: {
        owner: { owner_id: 'ou_owner' },
      },
    },
  }), { ownerId: 'ou_owner' })
})

test('parseLarkCliAppOwnerResponse rejects responses without an owner id', () => {
  assert.equal(parseLarkCliAppOwnerResponse({ data: { app: {} } }), undefined)
})
